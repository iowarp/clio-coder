import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { countRender } from "../render/render-probe.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { boardView, type PlanRow } from "./board-model.js";
import { branchView } from "./branch-model.js";
import { changeCounts, summarizeChanges } from "./changes-model.js";
import { FLEET_STATE_LABELS, FLEET_STATE_TONES, fleetEvidence, foldFleetRuns, isLiveRun } from "./fleet-facts.js";
import { compactDuration, contextMeter, contextSegments, taskOverview } from "./overview-model.js";
import type { PaneSession, PaneView } from "./pane-model.js";
import type { RouteFacts } from "./route.js";
import {
	sessionSpend,
	settledTurns,
	spendLine,
	useContextLedger,
	useSessionCapabilities,
	useSessionUsage,
} from "./session-telemetry.js";

function PlanGlyph({ tone }: { tone: PlanRow["tone"] }) {
	if (tone === "success")
		return (
			<span className="pane-step__glyph is-done" aria-hidden="true">
				<Icon name="check" />
			</span>
		);
	// One moving mark per column: the Task state carries it, so a running step is a still glyph.
	if (tone === "running") return <span className="pane-step__glyph is-running" aria-hidden="true" />;
	if (tone === "fail" || tone === "warn") return <span className="pane-step__glyph is-blocked" aria-hidden="true" />;
	return <span className="pane-step__glyph" aria-hidden="true" />;
}

/** The target's reported health as one word beside the route. */
const ROUTE_HEALTH_WORDS: Readonly<Record<RouteFacts["tone"], string>> = {
	success: "Healthy",
	unverified: "Not checked",
	warn: "Degraded",
	fail: "Unavailable",
	running: "Checking",
	neutral: "Reported",
};

/** A section of the Session column. A section with more to show names itself as the way in. */
function Section({
	id,
	title,
	aside,
	open,
	children,
}: {
	id: string;
	title: string;
	aside?: ReactNode;
	open?: () => void;
	children: ReactNode;
}) {
	return (
		<section className="pane-card" aria-labelledby={id}>
			<header>
				<h2 id={id}>
					{open ? (
						<button type="button" className="pane-card__open" onClick={open}>
							<span>{title}</span>
							<Icon name="chevronRight" />
						</button>
					) : (
						title
					)}
				</h2>
				{aside}
			</header>
			{children}
		</section>
	);
}

/**
 * Everything about the open chat, top to bottom: how it is going, how full the window is, what it has
 * used, the plan, what changed, who is helping. Nothing here is measured by the browser; each line is
 * a value the session reported, and each section opens the view that says the rest.
 */
export function SessionOverview({
	client,
	session,
	title,
	workspaceRoot,
	nowMs,
	onOpen,
	route,
}: {
	client: Client;
	session: PaneSession;
	title: string;
	workspaceRoot: string | undefined;
	nowMs: number;
	onOpen: (view: PaneView) => void;
	/** The route the composer shows, so the column and the chip never disagree. */
	route?: RouteFacts;
}) {
	countRender("session-overview");
	const params = { params: { id: session.id }, query: {}, body: {} };
	const open = session.state === "open";
	const capabilities = useSessionCapabilities(client, session.id, open);
	const settled = settledTurns(session.turns);
	// The keys the drill-ins use, so opening one after the column costs no second request.
	const board = useQuery({
		queryKey: ["session-board", session.id, settled],
		queryFn: () => client.call(routes.sessionBoard, params),
		enabled: open && capabilities.data?.board !== undefined,
		retry: false,
		// The next settled turn changes the key; the last answer stays on screen until the new one lands,
		// so rows (and the focus a row holds) do not vanish between the two reads.
		placeholderData: (previous) => previous,
	});
	// The branches drill reads the same key, so its summary here costs no second request.
	const tree = useQuery({
		queryKey: ["session-tree", session.id, settled],
		queryFn: () => client.call(routes.sessionTree, params),
		enabled: open && !!capabilities.data?.branches,
		retry: false,
		placeholderData: (previous) => previous,
	});
	const branches = tree.data ? branchView(tree.data) : null;
	const tip = branches?.rows.filter((row) => row.tip && row.active).at(-1) ?? null;
	const ledger = useContextLedger(client, session.id, settled, open && !!capabilities.data?.context);
	const usage = useSessionUsage(client, session.id, settled, open && !!capabilities.data?.usage);
	const view = board.data ? boardView(board.data) : null;
	const plan = view?.plan ?? null;
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const segments = ledger.data ? contextSegments(ledger.data) : [];
	const overview = useMemo(() => taskOverview(session.turns, nowMs), [session.turns, nowMs]);
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const runs = useMemo(() => foldFleetRuns(session.fleet), [session.fleet]);
	const evidence = useMemo(() => fleetEvidence(session.fleet), [session.fleet]);
	const live = runs.filter(isLiveRun);
	const last = session.turns.at(-1);
	const working = open && overview.running;
	const state = overview.running
		? "Working"
		: last?.status === "failed"
			? "Failed"
			: last?.status === "cancelled"
				? "Stopped"
				: last
					? "Complete"
					: "Not started";
	const done = plan?.rows.filter((row) => row.tone === "success").length ?? 0;
	const openTasks = view?.tasks.filter((task) => task.actions.length > 0).length ?? 0;
	const decisions = view?.activeDecisions.length ?? 0;
	const used = spendLine(sessionSpend(session.turns, usage.data));
	return (
		<div className="pane-cards">
			<section className="pane-card" aria-labelledby="pane-goal">
				<header>
					<h2 id="pane-goal">Task</h2>
					<span className="pane-card__state" data-state={state}>
						{working ? <ClioPulse size={PULSE_SIZE.inline} /> : null}
						{state}
					</span>
				</header>
				<p className="pane-goal">{title}</p>
				{overview.turns > 0 ? (
					<p className="pane-card__facts">
						{[
							`${overview.turns} ${overview.turns === 1 ? "turn" : "turns"}`,
							overview.elapsedMs >= 1000 ? compactDuration(overview.elapsedMs) : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</p>
				) : null}
			</section>

			{route ? (
				<Section
					id="pane-model"
					title="Model"
					aside={<StatusMark tone={route.tone} label={ROUTE_HEALTH_WORDS[route.tone]} />}
				>
					<p className="pane-changes-line" title={route.title}>
						<span className="pane-mono">{route.text}</span>
					</p>
					{route.thinking ? <p className="pane-card__facts">Thinking {route.thinking}</p> : null}
				</Section>
			) : null}

			{meter || capabilities.data?.context ? (
				<Section
					id="pane-context"
					title="Context"
					open={() => onOpen("context")}
					aside={meter ? <span className="pane-card__state">{Math.round(meter.percent)}%</span> : null}
				>
					{meter ? (
						<div className="pane-meter" data-tone={meter.tone}>
							{/* biome-ignore lint/a11y/useSemanticElements: a native meter draws one fill; this one stacks the window's parts. */}
							<div
								className="pane-stack"
								role="meter"
								aria-label="Context window"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={Math.round(meter.percent)}
								aria-valuetext={meter.text}
							>
								{segments.map((segment, index) => (
									<span
										key={segment.key}
										className="pane-stack__part"
										data-index={index}
										style={{ width: `${segment.percent}%` }}
										title={`${segment.label} ${segment.percent.toFixed(1)}%`}
									/>
								))}
							</div>
							<p className="pane-card__facts">{meter.label}</p>
							{segments.length > 0 ? (
								<ul className="pane-legend" aria-label="What fills the window">
									{segments.map((segment, index) => (
										<li key={segment.key} data-index={index}>
											{segment.label} <span>{segment.percent < 1 ? "<1" : Math.round(segment.percent)}%</span>
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : (
						<p className="pane-empty">{ledger.isPending ? "Reading the context window…" : "Not reported yet."}</p>
					)}
				</Section>
			) : null}

			<Section id="pane-usage" title="Usage" {...(capabilities.data?.usage ? { open: () => onOpen("usage") } : {})}>
				<p className="pane-changes-line">{used ?? "Nothing used yet."}</p>
			</Section>

			<Section
				id="pane-plan"
				title="Plan"
				{...(capabilities.data?.board ? { open: () => onOpen("board") } : {})}
				aside={
					plan && plan.rows.length > 0 ? (
						<span className="pane-card__state">
							{done}/{plan.rows.length}
						</span>
					) : null
				}
			>
				{plan && plan.rows.length > 0 ? (
					<ol className="pane-steps">
						{plan.rows.map((row) => (
							<li key={row.id} data-tone={row.tone}>
								<PlanGlyph tone={row.tone} />
								<span>
									{row.title}
									{row.reason ? <small>{row.reason}</small> : null}
								</span>
							</li>
						))}
					</ol>
				) : (
					<p className="pane-empty">
						{capabilities.data?.board === undefined
							? "This session does not report a plan."
							: "Clio has not published a plan for this task yet."}
					</p>
				)}
				{openTasks > 0 || decisions > 0 ? (
					<p className="pane-card__facts">
						{[
							openTasks > 0 ? `${openTasks} ${openTasks === 1 ? "task" : "tasks"} of yours` : null,
							decisions > 0 ? `${decisions} ${decisions === 1 ? "decision" : "decisions"}` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</p>
				) : null}
			</Section>

			<Section
				id="pane-changes"
				title="Changes"
				{...(changes.files.length > 0 ? { open: () => onOpen("changes") } : {})}
				aside={
					changes.applied > 0 ? (
						<span className="diffstat">
							<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
						</span>
					) : null
				}
			>
				{changes.files.length > 0 ? (
					<p className="pane-changes-line">
						{changes.applied > 0 ? `${changes.applied} ${changes.applied === 1 ? "file" : "files"} changed` : null}
						<span className="sr-only">{changeCounts(changes)}</span>
						{changes.pending > 0 ? `${changes.applied > 0 ? " · " : ""}${changes.pending} waiting for approval` : null}
					</p>
				) : (
					<p className="pane-empty">No files changed yet.</p>
				)}
			</Section>

			{/* A session that can run fleets keeps the section with no runs, because its drill holds the
			    form that starts one. */}
			{branches ? (
				<Section
					id="pane-branches"
					title="Branches"
					open={() => onOpen("branches")}
					aside={
						branches.branchPoints > 0 ? (
							<span className="pane-card__state">
								{branches.branchPoints} {branches.branchPoints === 1 ? "fork point" : "fork points"}
							</span>
						) : null
					}
				>
					<p className="pane-changes-line">
						{branches.branchPoints === 0 ? "One line of conversation." : "Continuing on the current branch."}
						{branches.forkedFrom ? " Forked from an earlier task." : ""}
					</p>
					{tip ? <p className="pane-card__facts">Latest: {tip.label ?? tip.text}</p> : null}
				</Section>
			) : null}

			{runs.length > 0 || capabilities.data?.fleet ? (
				<Section
					id="pane-agents"
					title="Agents"
					open={() => onOpen("agents")}
					aside={
						runs.length > 0 ? (
							<span className="pane-card__state">
								{live.length > 0 ? `${live.length} live · ` : ""}
								{runs.length} {runs.length === 1 ? "run" : "runs"}
							</span>
						) : null
					}
				>
					{runs.length === 0 ? (
						<p className="pane-empty">No agents dispatched yet.</p>
					) : live.length > 0 ? (
						<ul className="pane-agents">
							{live.slice(0, 4).map((run) => (
								<li key={run.runId}>
									<strong>{run.agentId}</strong>
									<span>{run.taskPreview ?? "Task preview not reported"}</span>
									<StatusMark tone={FLEET_STATE_TONES[run.state]} label={FLEET_STATE_LABELS[run.state]} />
								</li>
							))}
						</ul>
					) : (
						<p className="pane-empty">Every worker has settled.</p>
					)}
				</Section>
			) : null}

			{evidence.length > 0 ? (
				<Section id="pane-evidence" title="Evidence" aside={<span className="pane-card__state">{evidence.length}</span>}>
					<ul className="pane-evidence">
						{evidence.slice(0, 6).map((row) => {
							const agent = runs.find((run) => run.runId === row.runId)?.agentId ?? "run";
							return (
								<li key={row.id}>
									<StatusMark
										tone={row.firstPassSuccess ? "success" : "warn"}
										label={row.firstPassSuccess ? "First pass" : "Retried"}
									/>
									<span>
										<strong>{agent}</strong>{" "}
										{row.findingCount === null
											? "findings not reported"
											: `${row.findingCount} ${row.findingCount === 1 ? "finding" : "findings"}`}
									</span>
									<span className="pane-evidence__links">
										<Link to={`/evidence/${encodeURIComponent(row.evidenceId)}`}>Evidence</Link>
										<Link to={`/fleet/dispatches/${encodeURIComponent(row.runId)}`}>Run</Link>
									</span>
								</li>
							);
						})}
					</ul>
				</Section>
			) : null}

			{open ? (
				<p className="pane-hint">
					Branches, handoff, side questions and commands: type <kbd>/</kbd> in the composer.
				</p>
			) : null}
		</div>
	);
}
