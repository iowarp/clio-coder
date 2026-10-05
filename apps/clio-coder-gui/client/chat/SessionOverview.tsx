import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import type { IconName } from "../design/icons.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { countRender } from "../render/render-probe.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { isHeld, STATE_LABELS, taskState, taskTitle } from "../shell/shell-model.js";
import { boardView, type PlanRow } from "./board-model.js";
import { branchView } from "./branch-model.js";
import { changeCounts, summarizeChanges } from "./changes-model.js";
import { FLEET_STATE_LABELS, FLEET_STATE_TONES, fleetEvidence, foldFleetRuns, isLiveRun } from "./fleet-facts.js";
import { summarizeHealth } from "./health.js";
import { compactCount, compactDuration, contextMeter, contextSegments, taskOverview } from "./overview-model.js";
import { ProjectTrustNotice } from "./ProjectTrustNotice.js";
import type { PaneSession, PaneView } from "./pane-model.js";
import { ReceiptLine } from "./ReceiptLine.js";
import type { RouteFacts } from "./route.js";
import { modelSessionFacts, sessionFacts } from "./session-facts-model.js";
import {
	sessionSpend,
	settledTurns,
	spendLine,
	useContextLedger,
	useSessionCapabilities,
	useSessionUsage,
} from "./session-telemetry.js";
import { livePlanView } from "./telemetry-model.js";

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
	icon,
	aside,
	open,
	summary,
	expanded = false,
	children,
}: {
	id: string;
	title: string;
	icon: IconName;
	aside?: ReactNode;
	open?: () => void;
	summary?: string;
	expanded?: boolean;
	children: ReactNode;
}) {
	if (summary !== undefined)
		return (
			<details className="pane-card pane-card--disclosure" open={expanded}>
				<summary>
					<span className="pane-card__symbol">
						<Icon name={icon} />
					</span>
					<span id={id} className="pane-card__label">
						{title}
					</span>
					<span className="pane-card__summary">{summary}</span>
					<Icon name="chevronRight" />
				</summary>
				<div className="pane-card__body">
					{children}
					{open ? (
						<button type="button" className="pane-card__details" onClick={open}>
							Open {title.toLowerCase()}
							<Icon name="chevronRight" />
						</button>
					) : null}
				</div>
			</details>
		);
	return (
		<section className="pane-card" aria-labelledby={id}>
			<header>
				<h2 id={id} className="pane-card__heading">
					{open ? (
						<button type="button" className="pane-card__open" onClick={open}>
							<span className="pane-card__symbol">
								<Icon name={icon} />
							</span>
							<span>{title}</span>
							<span className="pane-card__chevron">
								<Icon name="chevronRight" />
							</span>
						</button>
					) : (
						<>
							<span className="pane-card__symbol">
								<Icon name={icon} />
							</span>
							{title}
						</>
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
	onChangeModel,
	route,
}: {
	client: Client;
	session: PaneSession;
	title: string;
	workspaceRoot: string | undefined;
	nowMs: number;
	onOpen: (view: PaneView) => void;
	/** Opens the place this task's route is changed: the composer's picker, or the saved route. */
	onChangeModel?: () => void;
	/** The route the composer shows, so the column and the chip never disagree. */
	route?: RouteFacts;
}) {
	countRender("session-overview");
	const params = { params: { id: session.id }, query: {}, body: {} };
	const open = session.state === "open";
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const workspaceNames = new Map((workspaces.data ?? []).map((item) => [item.id, item.name]));
	const activity = (sessions.data ?? [])
		.filter(isHeld)
		.map((item) => ({ session: item, state: taskState(item) }))
		.filter(({ state }) => state === "working" || state === "waiting" || state === "starting" || state === "approval");
	const otherActivity = activity.filter((item) => item.session.id !== session.id);
	const workingCount = activity.filter((item) => item.state === "working" || item.state === "starting").length;
	const queuedCount = activity.filter((item) => item.state === "waiting").length;
	const approvalCount = activity.filter((item) => item.state === "approval").length;
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
	const plan = session.telemetry?.plan ? livePlanView(session.telemetry.plan) : (view?.plan ?? null);
	const workspace = session.telemetry?.workspace;
	const facts = sessionFacts(session.notices, session.telemetry?.notices);
	const health = summarizeHealth(session.health);
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const segments = ledger.data ? contextSegments(ledger.data) : [];
	const overview = useMemo(() => taskOverview(session.turns, nowMs), [session.turns, nowMs]);
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const runs = useMemo(() => foldFleetRuns(session.fleet), [session.fleet]);
	const evidence = useMemo(() => fleetEvidence(session.fleet), [session.fleet]);
	const live = runs.filter(isLiveRun);
	const receipts = runs.filter((run) => run.receipt);
	const last = session.turns.at(-1);
	const working = open && (overview.running || !!session.contextWork?.active);
	const state =
		session.state === "parked"
			? "Paused"
			: session.contextWork?.active && open
				? "Context work"
				: overview.running
					? "Working"
					: last?.queued
						? "Waiting for a slot"
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
	const spend = sessionSpend(
		session.turns,
		usage.data,
		overview.running || !usage.data || usage.isPlaceholderData ? session.telemetry?.usage : undefined,
	);
	const used = spendLine(spend);
	const healthSection =
		health.rows.length > 0 ? (
			<Section
				id="pane-health"
				title="Health"
				icon="shield"
				summary={
					health.attention ? "Needs attention" : `${health.rows.length} ${health.rows.length === 1 ? "report" : "reports"}`
				}
				expanded={health.attention}
			>
				{health.rows.map((row) => (
					<p key={row.id} className="pane-card__facts">
						<StatusMark tone={row.tone} label={row.label} {...(row.detail ? { detail: row.detail } : {})} />
					</p>
				))}
			</Section>
		) : null;
	return (
		<div className="pane-cards">
			<section className="pane-card pane-card--lead" aria-labelledby="pane-goal">
				<header>
					<h2 id="pane-goal" className="pane-card__heading">
						<span className="pane-card__symbol">
							<Icon name="compose" />
						</span>
						Task
					</h2>
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
			{session.telemetry?.trust?.ignored.length ? (
				<Section id="pane-trust" title="Project trust" icon="shield">
					<ProjectTrustNotice trust={session.telemetry.trust} />
				</Section>
			) : null}
			{health.attention ? healthSection : null}

			<Section
				id="pane-activity"
				title="App activity"
				icon="running"
				summary={
					sessions.data
						? `${workingCount} working · ${queuedCount} queued${approvalCount > 0 ? ` · ${approvalCount} need approval` : ""}`
						: sessions.error
							? "Unavailable"
							: "Loading…"
				}
				expanded={activity.length > 0 || !!sessions.error}
			>
				{sessions.data ? (
					<>
						<p className="pane-card__facts">
							{workingCount} working · {queuedCount} queued{approvalCount > 0 ? ` · ${approvalCount} need approval` : ""}
						</p>
						{otherActivity.length > 0 ? (
							<ul className="pane-agents">
								{otherActivity.map((item) => (
									<li key={item.session.id}>
										<Icon name={item.state === "approval" ? "shield" : "sessions"} />
										<Link to={`/sessions/${item.session.id}`}>{taskTitle(item.session)}</Link>
										<span>
											{[workspaceNames.get(item.session.workspaceId), STATE_LABELS[item.state]].filter(Boolean).join(" · ")}
										</span>
									</li>
								))}
							</ul>
						) : (
							<p className="pane-empty">
								{activity.length > 0 ? "This is the only active session." : "No work is running or queued."}
							</p>
						)}
						<p className="pane-card__facts">Across all workspaces in this app.</p>
					</>
				) : (
					<p className="pane-empty">{sessions.error ? "App activity could not be read." : "Reading app activity…"}</p>
				)}
			</Section>

			{workspace ? (
				<Section id="pane-workspace" title="Workspace" icon="folder">
					<p className="pane-path" title={workspace.cwd}>
						<bdi dir="ltr">{workspace.cwd}</bdi>
					</p>
					<p className="pane-card__facts">
						{workspace.isGit
							? [
									workspace.branch ?? "Detached HEAD",
									workspace.dirty === null
										? "Working tree not reported"
										: workspace.dirty
											? "Uncommitted changes"
											: "Clean working tree",
									workspace.ahead ? `${workspace.ahead} ahead` : null,
									workspace.behind ? `${workspace.behind} behind` : null,
								]
									.filter(Boolean)
									.join(" · ")
							: "No Git repository"}
					</p>
				</Section>
			) : null}

			{route ? (
				<Section
					id="pane-model"
					title="Model"
					icon="models"
					{...(onChangeModel ? { open: onChangeModel } : {})}
					aside={<StatusMark tone={route.tone} label={ROUTE_HEALTH_WORDS[route.tone]} />}
				>
					<p className="pane-changes-line" title={route.title}>
						<span className="pane-mono">{route.text}</span>
					</p>
					{route.thinking ? <p className="pane-card__facts">Thinking {route.thinking}</p> : null}
					{modelSessionFacts(route.config, facts.model).map((text) => (
						<p key={text} className="pane-card__facts">
							{text}
						</p>
					))}
				</Section>
			) : null}

			{meter || capabilities.data?.context || facts.context.length > 0 ? (
				<Section
					id="pane-context"
					title="Context"
					icon="layers"
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
					{facts.context.map((text) => (
						<p key={text} className="pane-card__facts">
							{text}
						</p>
					))}
				</Section>
			) : null}

			{!health.attention ? healthSection : null}
			{facts.other.length > 0 ? (
				<Section id="pane-notes" title="Session notes" icon="sessions">
					{facts.other.map((text) => (
						<p key={text} className="pane-card__facts">
							{text}
						</p>
					))}
				</Section>
			) : null}

			<Section
				id="pane-usage"
				title="Usage"
				icon="usage"
				summary={used || "No usage reported"}
				{...(capabilities.data?.usage ? { open: () => onOpen("usage") } : {})}
			>
				{used ? (
					<dl className="pane-usage-stats">
						<div>
							<dt>Tokens</dt>
							<dd title={`${spend.tokens.toLocaleString("en-US")} tokens`}>{compactCount(spend.tokens)}</dd>
						</div>
						<div>
							<dt>Cost</dt>
							<dd>{spend.cost ?? "Unpriced"}</dd>
						</div>
					</dl>
				) : (
					<p className="pane-empty">No usage reported yet.</p>
				)}
			</Section>

			<Section
				id="pane-plan"
				title="Plan"
				icon="listChecks"
				{...(!plan?.rows.length && !openTasks && !decisions ? { summary: "No published plan" } : {})}
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
						{capabilities.data?.board === undefined && !session.telemetry?.plan
							? "This session does not report a plan."
							: "No plan published yet."}
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

			{session.telemetry?.plan?.truncated ? <p className="pane-hint">The plan shows its first 100 steps.</p> : null}
			{capabilities.data?.artifacts ? (
				<Section id="pane-artifacts" title="Artifacts" icon="artifacts" summary="Browse" open={() => onOpen("artifacts")}>
					<p className="pane-empty">Receipts, outputs and session records.</p>
				</Section>
			) : null}
			<Section
				id="pane-changes"
				title="Changes"
				icon="fileDiff"
				{...(changes.files.length === 0 ? { summary: "No files changed" } : {})}
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
					icon="branch"
					{...(branches.branchPoints === 0 && !branches.forkedFrom ? { summary: "Current branch" } : {})}
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
					{tip ? <p className="pane-card__facts pane-card__preview">Latest: {tip.label ?? tip.text}</p> : null}
				</Section>
			) : null}

			{runs.length > 0 || capabilities.data?.fleet ? (
				<Section
					id="pane-agents"
					title="Agents"
					icon="fleet"
					{...(runs.length === 0 ? { summary: "None dispatched" } : {})}
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

			{evidence.length > 0 || receipts.length > 0 ? (
				<Section
					id="pane-evidence"
					title="Evidence"
					icon="evidence"
					aside={
						<span className="pane-card__state">
							{receipts.length > 0
								? `${receipts.length} ${receipts.length === 1 ? "receipt" : "receipts"}`
								: `${evidence.length} ${evidence.length === 1 ? "bundle" : "bundles"}`}
						</span>
					}
				>
					{receipts
						.slice(-6)
						.reverse()
						.map((run) => (
							<div key={run.runId}>
								<strong className="pane-card__facts">{run.agentId}</strong>
								{run.receipt ? <ReceiptLine receipt={run.receipt} /> : null}
							</div>
						))}
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
				<p className="pane-hint pane-hint--commands">
					<Icon name="bolt" />
					<span>
						Commands and side questions <kbd>/</kbd>
					</span>
				</p>
			) : null}
		</div>
	);
}
