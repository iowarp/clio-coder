import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { countRender } from "../render/render-probe.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { boardView, type PlanRow } from "./board-model.js";
import { changeCounts, summarizeChanges } from "./changes-model.js";
import { FLEET_STATE_LABELS, FLEET_STATE_TONES, foldFleetRuns, isLiveRun, isWorkingRun } from "./fleet-facts.js";
import { compactDuration, contextMeter, contextSegments, taskOverview } from "./overview-model.js";
import type { PaneSession, PaneView } from "./pane-model.js";
import {
	sessionSpend,
	settledTurns,
	spendLine,
	useContextLedger,
	useSessionCapabilities,
	useSessionUsage,
} from "./session-telemetry.js";

function PlanGlyph({ tone, live }: { tone: PlanRow["tone"]; live: boolean }) {
	if (tone === "success")
		return (
			<span className="pane-step__glyph is-done" aria-hidden="true">
				<Icon name="check" />
			</span>
		);
	// A step the plan records as running spins only while the task is working; afterwards it is a record.
	if (tone === "running")
		return live ? (
			<ClioPulse size={PULSE_SIZE.step} />
		) : (
			<span className="pane-step__glyph is-blocked" aria-hidden="true" />
		);
	if (tone === "fail" || tone === "warn") return <span className="pane-step__glyph is-blocked" aria-hidden="true" />;
	return <span className="pane-step__glyph" aria-hidden="true" />;
}

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
}: {
	client: Client;
	session: PaneSession;
	title: string;
	workspaceRoot: string | undefined;
	nowMs: number;
	onOpen: (view: PaneView) => void;
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
	});
	const ledger = useContextLedger(client, session.id, settled, open && !!capabilities.data?.context);
	const usage = useSessionUsage(client, session.id, settled, open && !!capabilities.data?.usage);
	const view = board.data ? boardView(board.data) : null;
	const plan = view?.plan ?? null;
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const segments = ledger.data ? contextSegments(ledger.data) : [];
	const overview = useMemo(() => taskOverview(session.turns, nowMs), [session.turns, nowMs]);
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const runs = useMemo(() => foldFleetRuns(session.fleet), [session.fleet]);
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
								<PlanGlyph tone={row.tone} live={working} />
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
									<StatusMark
										live={open && isWorkingRun(run)}
										tone={FLEET_STATE_TONES[run.state]}
										label={FLEET_STATE_LABELS[run.state]}
									/>
								</li>
							))}
						</ul>
					) : (
						<p className="pane-empty">Every worker has settled.</p>
					)}
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
