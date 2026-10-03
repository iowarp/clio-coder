import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useOutletContext, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { clock, formatDuration } from "../api/clock.js";
import type { ConnectionState } from "../api/events.js";
import { sessionBuffer } from "../api/sessions.js";
import { ApprovalBanner, pendingPermission } from "../chat/Approval.js";
import { ChatTurnView } from "../chat/ChatTurn.js";
import { Composer, fillComposer } from "../chat/Composer.js";
import { ComposerRail } from "../chat/ComposerRail.js";
import { CONTEXT_WARNING_LABEL, placeHealthRows, STARTER_PROMPTS, TRUNCATION_NOTE } from "../chat/chat-turn.js";
import { LiveWorkers, workerCount } from "../chat/FleetStrip.js";
import { foldFleetRuns, isLiveRun } from "../chat/fleet-facts.js";
import { type HealthRow, type HealthSummary, summarizeHealth } from "../chat/health.js";
import { Interview } from "../chat/Interview.js";
import { PaneContext } from "../chat/pane-context.js";
import type { PaneView } from "../chat/pane-model.js";
import { usePaneState } from "../chat/pane-state.js";
import { routeFacts } from "../chat/route.js";
import { PaneToggles, SessionPane } from "../chat/SessionPane.js";
import { ConversationBanner, TaskSkeleton, TaskUnavailable } from "../chat/SessionStates.js";
import { TelemetryChips } from "../chat/TelemetryChips.js";
import { type ChatTurn, groupTurns, turnStatuses } from "../chat/turns.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { setPageTitle } from "../interaction/announcer.js";
import { useShortcut } from "../interaction/use-shortcut.js";
import { JumpToLatest } from "../render/FollowLatest.js";
import { useFollowLatest } from "../render/follow-latest.js";
import { countRender } from "../render/render-probe.js";
import { ClioLogo, ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { Menu, MenuItem } from "../shell/Menu.js";
import { taskTitle } from "../shell/shell-model.js";
import { TopBar } from "../shell/TopBar.js";
import { useRenameTask } from "../shell/tasks.js";
import "../chat/chat-turn.css";
import "../chat/conversation.css";
/** The old projects page. Choosing and opening projects now lives in the rail and the Open workspace dialog. */
export function Workspaces() {
	return <Navigate to="/" replace />;
}
export { Sessions } from "./tasks.js";

export function Session({ client }: { client: Client }) {
	const { id = "" } = useParams();
	return <SessionView key={id} client={client} id={id} />;
}

/**
 * One shared second for the whole conversation. It ticks only while something is live, and it reads
 * the server-adopted clock rather than `Date.now()`, so an elapsed figure cannot disagree with the
 * server by the connection's clock offset.
 */
function useSecond(active: boolean): number {
	const [now, setNow] = useState(() => clock.now());
	useEffect(() => {
		if (!active) return;
		setNow(clock.now());
		const timer = setInterval(() => setNow(clock.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return active ? now : 0;
}

const NO_ROWS: readonly HealthRow[] = [];

function EmptyTranscript({ sessionId }: { sessionId: string }) {
	return (
		<div className="chat-empty">
			<ClioLogo size={40} />
			<h2>
				What are we <em>working on</em>?
			</h2>
			<ul className="chat-empty__starters" aria-label="Ways to start">
				{STARTER_PROMPTS.map((prompt) => (
					<li key={prompt}>
						<button type="button" onClick={() => fillComposer(sessionId, prompt)}>
							{prompt}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Session health that needs a reader. A healthy target is one glyph in the route chip; anything else,
 * and every fact kind this build does not recognise, is written out here in full.
 */
function SessionHealth({ summary }: { summary: HealthSummary }) {
	const concerns = summary.providers.filter((row) => row.tone !== "success");
	if (!summary.contextWarning && concerns.length === 0 && summary.unknown.length === 0) return null;
	return (
		<div className="conversation__health">
			{summary.contextWarning ? (
				<p className="context-banner" role="status">
					<strong>{CONTEXT_WARNING_LABEL}</strong> {summary.contextWarning.detail ?? summary.contextWarning.label}
				</p>
			) : null}
			{concerns.length > 0 || summary.unknown.length > 0 ? (
				<div className="session-health">
					{concerns.map((row) => (
						<StatusMark
							key={row.id}
							tone={row.tone}
							label={row.label}
							{...(row.detail === null ? {} : { detail: row.detail })}
						/>
					))}
					{summary.unknown.map((row) => (
						<StatusMark key={row.id} tone={row.tone} label={row.label} />
					))}
				</div>
			) : null}
		</div>
	);
}

function SessionView({ client, id }: { client: Client; id: string }) {
	countRender("session-view");
	const navigate = useNavigate();
	const ids = { changes: useId(), pane: useId() };
	const pane = usePaneState(ids.pane);
	const paneActions = useMemo(() => ({ show: (view: PaneView) => pane.show(view, ids.pane) }), [pane.show, ids.pane]);
	useShortcut("sessionPanel", () => (pane.open ? pane.close() : pane.show(pane.view, ids.pane)));
	useShortcut("focusComposer", () => document.querySelector<HTMLTextAreaElement>(".composer__field")?.focus());
	useShortcut("agents", () => pane.show("agents", ids.pane));
	const connection = useOutletContext<ConnectionState>();
	const queries = useQueryClient();
	const input = { params: { id }, query: {}, body: {} };
	const session = useQuery({
		queryKey: ["session", id],
		queryFn: async () => {
			const snapshot = await client.call(routes.session, input);
			return sessionBuffer(id).snapshot(snapshot) ?? snapshot;
		},
	});
	const workspaceId = session.data?.workspaceId ?? "";
	const workspace = useQuery({
		queryKey: ["workspace", workspaceId],
		queryFn: () => client.call(routes.workspace, { params: { id: workspaceId }, query: {}, body: {} }),
		enabled: workspaceId !== "",
	});

	const capabilities = useQuery({
		queryKey: ["session-capabilities", id],
		queryFn: () => client.call(routes.sessionCapabilities, input),
		enabled: session.data?.state === "open",
		staleTime: Number.POSITIVE_INFINITY,
	});
	const sessionSettings = useQuery({
		queryKey: ["session-settings", id],
		queryFn: () => client.call(routes.sessionSettings, input),
		enabled: session.data?.state === "open" && capabilities.data?.settings?.get_safe === true,
	});
	const close = useMutation({
		mutationFn: () => client.call(routes.closeSession, input),
		onSuccess: (snapshot) => {
			queries.setQueryData(["session", id], sessionBuffer(id).snapshot(snapshot));
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void queries.invalidateQueries({ queryKey: ["session-history", snapshot.workspaceId] });
		},
	});
	const closeSession = useCallback(() => close.mutate(), [close.mutate]);
	const renameTask = useRenameTask(client);
	const [renaming, setRenaming] = useState(false);
	const scroll = useRef<HTMLDivElement | null>(null);
	const previousTurns = useRef<readonly ChatTurn[]>([]);
	const snapshot = session.data;
	// The tab names the task, so several open tabs can be told apart.
	const pageTitle = snapshot ? taskTitle(snapshot) : null;
	useEffect(() => {
		setPageTitle(pageTitle);
		return () => setPageTitle(null);
	}, [pageTitle]);
	const statuses = useMemo(() => turnStatuses(snapshot?.turns ?? []), [snapshot?.turns]);
	const turnRows = useMemo(
		() => new Map((snapshot?.turns ?? []).map((row) => [row.id, row] as const)),
		[snapshot?.turns],
	);
	const turns = useMemo(() => {
		const next = groupTurns(snapshot?.timeline ?? [], statuses, previousTurns.current);
		previousTurns.current = next;
		return next;
	}, [snapshot?.timeline, statuses]);
	const fleet = snapshot?.fleet;
	const liveWorkers = useMemo(() => (fleet === undefined ? 0 : foldFleetRuns(fleet).filter(isLiveRun).length), [fleet]);
	const health = useMemo(() => summarizeHealth(snapshot?.health ?? []), [snapshot?.health]);
	const notices = useMemo(() => {
		const rows = [health.compaction, health.toolBudget, ...health.scopeNotices].filter(
			(row): row is HealthRow => row !== null,
		);
		return placeHealthRows(rows, snapshot?.turns ?? []);
	}, [health, snapshot?.turns]);
	const running = snapshot?.turns.at(-1)?.status === "running";
	const now = useSecond(running || (snapshot?.permissions.some((item) => item.status === "pending") ?? false));
	// A deep link starts without a cached snapshot. Attach the observer only once
	// the transcript element exists; a ref becoming non-null does not rerun an effect.
	const follow = useFollowLatest(scroll, snapshot !== undefined, snapshot?.timeline, running);
	// One object per change of reported settings or health, so a streamed delta leaves the composer alone.
	const settings = snapshot?.state === "open" ? sessionSettings.data?.settings.chat : undefined;
	const config = snapshot?.state === "open" ? snapshot.config : undefined;
	const route = useMemo(
		() =>
			routeFacts(
				settings
					? { target: settings.target ?? null, model: settings.model ?? null, thinking: settings.thinkingLevel }
					: undefined,
				health,
				config,
			),
		[settings, health, config],
	);
	if (session.error && !snapshot)
		return (
			<TaskUnavailable
				message={session.error.message}
				retrying={session.isFetching}
				onRetry={() => void session.refetch()}
			/>
		);
	if (!snapshot) return <TaskSkeleton />;
	const turn = snapshot.turns.at(-1);
	const pending = pendingPermission(snapshot) ?? null;
	const workspaceRoot = workspace.data?.path;
	const title = taskTitle(snapshot);
	const workspaceName = workspace.data?.name ?? "Project";
	const elapsedMs = running && turn?.startedAt && now > 0 ? Math.max(0, now - Date.parse(turn.startedAt)) : 0;
	// Sub-second figures ("0ms") say nothing; the chip shows time once it is a whole second.
	const elapsed = elapsedMs >= 1000 ? formatDuration(elapsedMs) : null;
	const canClose = snapshot.state === "open" && !running;
	const paneOpen = pane.open;
	const chip: { tone: "working" | "approval" | "failed" | "quiet"; label: string } | null = pending
		? { tone: "approval", label: "Needs your approval" }
		: running && snapshot.state === "open"
			? {
					tone: "working",
					label: [liveWorkers > 0 ? `Waiting on ${workerCount(liveWorkers)}` : "Working", elapsed ?? null]
						.filter(Boolean)
						.join(" · "),
				}
			: snapshot.state === "starting"
				? { tone: "working", label: "Starting" }
				: snapshot.state === "closed"
					? { tone: "quiet", label: "Closed" }
					: snapshot.state === "unknown" || snapshot.state === "failed"
						? { tone: "failed", label: "Unavailable" }
						: turn?.status === "failed"
							? { tone: "failed", label: "Last turn failed" }
							: null;
	return (
		<PaneContext.Provider value={paneActions}>
			<section className="conversation" data-pane={paneOpen ? "open" : "closed"}>
				<div className="conversation__main">
					<TopBar
						title={title}
						titleLabel={title}
						rename={{
							active: renaming,
							onStart: () => setRenaming(true),
							onCancel: () => setRenaming(false),
							onSave: (label) => {
								setRenaming(false);
								renameTask.mutate({ sessionId: snapshot.id, workspaceId: snapshot.workspaceId, label });
							},
						}}
					>
						<Link
							className="wb-chip"
							to={`/workspaces/${snapshot.workspaceId}/sessions`}
							title={workspaceRoot ? `All tasks in ${workspaceRoot}` : "All tasks in this project"}
						>
							<Icon name="folder" />
							<span>{workspaceName}</span>
						</Link>
						{chip ? (
							<p className="wb-chip wb-chip--status" data-tone={chip.tone} role="status">
								{chip.tone === "working" ? <ClioPulse size={PULSE_SIZE.inline} /> : null}
								<span>{chip.label}</span>
								{snapshot.recoveredOrphan ? <span>· recovered after a server interruption</span> : null}
							</p>
						) : null}
						<span className="wb-bar__spacer" />
						<TelemetryChips
							client={client}
							sessionId={snapshot.id}
							state={snapshot.state}
							turns={snapshot.turns}
							onOpen={pane.show}
						/>
						<div className="wb-bar__end">
							<PaneToggles
								client={client}
								sessionId={snapshot.id}
								workspaceRoot={workspaceRoot}
								open={pane.open}
								view={pane.view}
								ids={ids}
								onToggle={pane.toggle}
							/>
							<Menu label="Task actions">
								<MenuItem icon="pencil" onClick={() => setRenaming(true)}>
									Rename task
								</MenuItem>
								<MenuItem icon="sliders" onClick={() => void navigate(`/settings/advanced?workspace=${snapshot.workspaceId}`)}>
									Project settings
								</MenuItem>
								<MenuItem icon="folder" onClick={() => void navigate(`/workspaces/${snapshot.workspaceId}/sessions`)}>
									All tasks in {workspaceName}
								</MenuItem>
								<MenuItem icon="close" tone="danger" disabled={!canClose || close.isPending} onClick={closeSession}>
									Close task
								</MenuItem>
							</Menu>
						</div>
					</TopBar>
					<div className="conversation__notices">
						<SessionHealth summary={health} />
					</div>
					<div className="conversation__approval">
						{connection === "Reconnecting…" || connection === "Not connected" || session.error ? (
							<ConversationBanner
								tone="warn"
								title={session.error ? "Could not refresh this task." : "Live updates are reconnecting."}
								action={
									<button type="button" disabled={session.isFetching} onClick={() => void session.refetch()}>
										{session.isFetching ? "Refreshing…" : "Refresh"}
									</button>
								}
							>
								{session.error
									? session.error.message
									: "What you see is the last state received. New activity appears when the connection returns."}
							</ConversationBanner>
						) : null}
						{snapshot.state === "unknown" || snapshot.state === "failed" || snapshot.state === "closed" ? (
							<ConversationBanner
								tone="quiet"
								title={
									snapshot.state === "closed"
										? "This task is closed."
										: snapshot.state === "unknown"
											? "Clio is no longer connected to this task."
											: "This task could not continue."
								}
								action={<Link to={`/workspaces/${snapshot.workspaceId}/sessions`}>Reopen from the task list</Link>}
							>
								The recorded conversation is still available below.
							</ConversationBanner>
						) : null}
						<ApprovalBanner client={client} session={snapshot} />
					</div>
					<div className="chat-transcript" ref={scroll}>
						<div className="chat-transcript__content">
							{snapshot.timelineTruncated ? <p className="trace-warning">{TRUNCATION_NOTE}</p> : null}
							{notices.leading.length > 0 ? (
								<ul className="turn-health">
									{notices.leading.map((row) => (
										<li key={row.id}>
											<StatusMark tone={row.tone} label={row.label} {...(row.detail === null ? {} : { detail: row.detail })} />
										</li>
									))}
								</ul>
							) : null}
							{turns.map((item) => (
								<ChatTurnView
									key={item.turnId}
									turn={item}
									row={turnRows.get(item.turnId)}
									client={client}
									session={snapshot}
									pending={pending}
									pendingPermissionId={pending?.id ?? null}
									nowMs={item.settled ? 0 : now}
									stopping={false}
									notices={notices.after.get(item.turnId) ?? NO_ROWS}
									workspaceRoot={workspaceRoot}
									liveWorkers={item.settled ? 0 : liveWorkers}
								/>
							))}
							<LiveWorkers
								client={client}
								sessionId={snapshot.id}
								sessionOpen={snapshot.state === "open"}
								fleet={snapshot.fleet}
							/>
							{turns.length === 0 ? <EmptyTranscript sessionId={snapshot.id} /> : null}
						</div>
					</div>
					{/* `.jump-anchor` is the positioned, zero-height parent the pill is laid out against. Without
				    it the pill resolves against the viewport and pushes the document sideways. */}
					<div className="jump-anchor">
						<JumpToLatest follow={follow} />
					</div>
					<div className="conversation__dock">
						{close.error ? <p role="alert">{close.error.message}</p> : null}
						<Composer
							client={client}
							sessionId={snapshot.id}
							sessionState={snapshot.state}
							initialFocus={snapshot.timeline.length === 0}
							runningTurnId={turn?.status === "running" ? turn.id : null}
							route={route}
						/>
						<ComposerRail client={client} sessionId={snapshot.id} state={snapshot.state} turns={snapshot.turns} />
					</div>
					<Interview
						client={client}
						sessionId={snapshot.id}
						sessionOpen={snapshot.state === "open"}
						capabilities={capabilities.data}
					/>
				</div>
				<SessionPane
					open={pane.open}
					onClose={pane.close}
					client={client}
					sessionId={snapshot.id}
					title={title}
					workspaceRoot={workspaceRoot}
					nowMs={now}
					view={pane.view}
					onViewChange={pane.setView}
				/>
			</section>
		</PaneContext.Provider>
	);
}
