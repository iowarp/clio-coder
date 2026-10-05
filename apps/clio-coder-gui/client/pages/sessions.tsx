import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useOutletContext, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { ApiProblem, emptyInput } from "../api/client.js";
import { clock, formatDuration } from "../api/clock.js";
import type { ConnectionState } from "../api/events.js";
import { SESSION_CACHES, sessionBuffer } from "../api/sessions.js";
import { ApprovalBanner, pendingPermission } from "../chat/Approval.js";
import { ChatTurnView } from "../chat/ChatTurn.js";
import { Composer, fillComposer, focusComposer } from "../chat/Composer.js";
import { ContextWorkCard } from "../chat/ContextWorkCard.js";
import { STARTER_PROMPTS, TRUNCATION_NOTE } from "../chat/chat-turn.js";
import { useContextOperationRef, useStopContext } from "../chat/context-command.js";
import { contextWorkView } from "../chat/context-work-model.js";
import { LiveWorkers, workerCount } from "../chat/FleetStrip.js";
import { foldFleetRuns, isLiveRun } from "../chat/fleet-facts.js";
import type { HealthRow } from "../chat/health.js";
import { summarizeHealth } from "../chat/health.js";
import { Interview } from "../chat/Interview.js";
import { LiveJobs } from "../chat/JobStrip.js";
import { PaneContext, type PaneTarget } from "../chat/pane-context.js";
import { usePaneState } from "../chat/pane-state.js";
import { routeFacts } from "../chat/route.js";
import { PaneToggles, SessionPane } from "../chat/SessionPane.js";
import { ConversationBanner, TaskSkeleton, TaskUnavailable } from "../chat/SessionStates.js";
import { TelemetryChips } from "../chat/TelemetryChips.js";
import { memoryGuardianMark } from "../chat/telemetry-model.js";
import { type ChatTurn, groupTurns, turnStatuses } from "../chat/turns.js";
import { useShown } from "../chat/use-shown.js";
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
import { rememberedWorkspace, useRenameTask } from "../shell/tasks.js";
import { openAppWindow } from "../shell/windows.js";
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

export interface LocatedTask {
	/** The project whose ledger holds the task, or null when none of the projects read has it. */
	workspace: { id: string; name: string } | null;
	/** Projects whose ledger could not be read, so "not found" is not a fact about them. */
	unread: number;
}

/**
 * Find the project a task is saved in, for a link to a task this server has not opened.
 *
 * The link carries only the task id, and resuming needs the project. The projects are read one at a
 * time, the last one used first, and the search stops at the first ledger that has the task. Leaving
 * the page cancels the read in flight and reads no further project.
 */
export async function locateTask(
	client: Pick<Client, "call">,
	id: string,
	signal: AbortSignal,
	preferred: string | null = rememberedWorkspace(),
): Promise<LocatedTask> {
	const all = await client.call(routes.workspaces, emptyInput, undefined, signal);
	const projects = [...all.filter((row) => row.id === preferred), ...all.filter((row) => row.id !== preferred)];
	let unread = 0;
	for (const project of projects) {
		signal.throwIfAborted();
		try {
			const history = await client.call(
				routes.sessionHistory,
				{ params: { id: project.id }, query: {}, body: {} },
				undefined,
				signal,
			);
			if (history.some((row) => row.id === id)) {
				return { workspace: { id: project.id, name: project.name }, unread };
			}
		} catch {
			// A cancelled read is the page being left, not an unreadable project.
			signal.throwIfAborted();
			// One unreadable project must not hide the task in the next one; it is counted and reported.
			unread += 1;
		}
	}
	return { workspace: null, unread };
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

function SessionView({ client, id }: { client: Client; id: string }) {
	countRender("session-view");
	const navigate = useNavigate();
	const ids = { changes: useId(), pane: useId() };
	const pane = usePaneState(ids.pane);
	const paneActions = useMemo(
		() => ({ show: (target: PaneTarget) => pane.show(target, ids.pane) }),
		[pane.show, ids.pane],
	);
	useShortcut("sessionPanel", () => (pane.open ? pane.close() : pane.show(pane.view, ids.pane)));
	useShortcut("focusComposer", () => document.querySelector<HTMLTextAreaElement>(".composer__field")?.focus());
	useShortcut("agents", () => pane.show("agents", ids.pane));
	const connection = useOutletContext<ConnectionState>();
	const queries = useQueryClient();
	const input = { params: { id }, query: {}, body: {} };
	const session = useQuery({
		queryKey: ["session", id],
		queryFn: async ({ signal }) => {
			const snapshot = await client.call(routes.session, input, undefined, signal);
			return sessionBuffer(id).snapshot(snapshot) ?? snapshot;
		},
	});
	// A saved task this server has not opened answers not_found. Only that answer starts the search for
	// its project; a task that loads, and a server that cannot be reached, never do.
	const notOpen =
		session.data === undefined && session.error instanceof ApiProblem && session.error.problem.code === "not_found";
	const located = useQuery({
		queryKey: ["session-locate", id],
		queryFn: ({ signal }) => locateTask(client, id, signal),
		enabled: notOpen,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
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
	const resume = useMutation({
		mutationFn: (workspaceId: string) =>
			client.call(routes.loadSession, { params: { id }, query: {}, body: { workspaceId } }),
		onSuccess: (snapshot) => {
			for (const key of SESSION_CACHES) queries.removeQueries({ queryKey: [key, id] });
			queries.setQueryData(["session", id], sessionBuffer(id).snapshot(snapshot) ?? snapshot);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void queries.invalidateQueries({ queryKey: ["session-history", snapshot.workspaceId] });
		},
	});
	const closeSession = useCallback(() => close.mutate(), [close.mutate]);
	const renameTask = useRenameTask(client);
	const [renaming, setRenaming] = useState(false);
	const [dismissedContext, setDismissedContext] = useState<string | null>(null);
	const stopContext = useStopContext(client, id);
	const scroll = useRef<HTMLDivElement | null>(null);
	const previousTurns = useRef<readonly ChatTurn[]>([]);
	const snapshot = session.data;
	useShown(client, id, snapshot?.state);
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

	const running = snapshot?.turns.at(-1)?.status === "running";
	const contextActivity = snapshot?.contextWork?.active;
	const contextRunning = snapshot?.state === "open" && !!contextActivity;
	const contextOperationRef = useContextOperationRef(snapshot?.contextWork);
	const now = useSecond(
		running || contextRunning || (snapshot?.permissions.some((item) => item.status === "pending") ?? false),
	);
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
	if (notOpen && !snapshot && !located.error) {
		const found = located.data?.workspace ?? null;
		const unread = located.data?.unread ?? 0;
		return (
			<>
				<TopBar />
				<div className="task-state" role={located.data ? "alert" : "status"}>
					<Icon name="warn" />
					<h1>This task is not open</h1>
					{located.data === undefined ? (
						<p>Looking for it in your projects…</p>
					) : found ? (
						<p>It is saved in {found.name}. Resuming starts Clio for it and continues the conversation.</p>
					) : (
						<p>
							None of your projects has a saved task with this link.
							{unread > 0 ? ` ${unread} ${unread === 1 ? "project" : "projects"} could not be read.` : ""}
						</p>
					)}
					{resume.error ? <p>Could not resume this task. {resume.error.message}</p> : null}
					<div className="task-state__actions">
						{found ? (
							<button type="button" className="primary" disabled={resume.isPending} onClick={() => resume.mutate(found.id)}>
								{resume.isPending ? "Resuming…" : "Resume task"}
							</button>
						) : located.data ? (
							<button type="button" className="primary" disabled={located.isFetching} onClick={() => void located.refetch()}>
								{located.isFetching ? "Looking again…" : "Look again"}
							</button>
						) : null}
						<Link to="/">Back to a new task</Link>
					</div>
				</div>
			</>
		);
	}
	// The project list itself could not be read: that failure is the one to show and to retry.
	if (notOpen && !snapshot && located.error)
		return (
			<TaskUnavailable
				message={located.error.message}
				retrying={located.isFetching}
				onRetry={() => void located.refetch()}
			/>
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
	const canClose = snapshot.state === "open" && !running && !contextRunning;
	const contextOperation = contextActivity?.operation ?? snapshot.contextWork?.latest;
	const contextView = contextOperation
		? contextWorkView(contextOperation, contextActivity ?? undefined, now, snapshot.state === "open")
		: null;
	const paneOpen = pane.open;
	const chip: { tone: "working" | "approval" | "failed" | "quiet"; label: string } | null = pending
		? { tone: "approval", label: "Needs your approval" }
		: contextRunning && contextView
			? { tone: "working", label: contextView.title }
			: running && snapshot.state === "open"
				? turn?.queued
					? { tone: "quiet", label: "Waiting for a slot" }
					: {
							tone: "working",
							label: [liveWorkers > 0 ? `Waiting on ${workerCount(liveWorkers)}` : "Working", elapsed ?? null]
								.filter(Boolean)
								.join(" · "),
						}
				: snapshot.state === "starting"
					? { tone: "working", label: "Starting" }
					: snapshot.state === "parked"
						? { tone: "quiet", label: "Paused" }
						: snapshot.state === "closed"
							? { tone: "quiet", label: "Closed" }
							: snapshot.state === "unknown" || snapshot.state === "failed"
								? { tone: "failed", label: "Unavailable" }
								: turn?.status === "failed"
									? { tone: "failed", label: "Last turn failed" }
									: null;
	const memoryMark = memoryGuardianMark(
		snapshot.telemetry?.memory,
		snapshot.state !== "parked" &&
			snapshot.state !== "closed" &&
			snapshot.state !== "unknown" &&
			snapshot.state !== "failed",
	);
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
						{snapshot.telemetry?.eggs?.includes("duck") ? (
							<span
								className="conversation__duck"
								role="img"
								aria-label="Rubber duck badge active for this conversation"
								title="Rubber duck · /eggs off to let her sleep"
							>
								🦆
							</span>
						) : null}
						{memoryMark ? (
							<StatusMark tone={memoryMark.tone} label={memoryMark.label} title={memoryMark.title} live={memoryMark.live} />
						) : null}
						{/* The task's own actions sit with its name, not with the view controls at the far end. */}
						<Menu label="Task actions">
							<MenuItem icon="pencil" onClick={() => setRenaming(true)}>
								Rename task
							</MenuItem>
							<MenuItem icon="external" onClick={() => openAppWindow(`/sessions/${snapshot.id}`, client.token)}>
								Open in new window
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
						<Link
							className="wb-chip wb-chip--place"
							to={`/workspaces/${snapshot.workspaceId}/sessions`}
							title={workspaceRoot ? `All tasks in ${workspaceRoot}` : "All tasks in this project"}
						>
							<Icon name="folder" />
							<span>{workspaceName}</span>
						</Link>
						{chip ? (
							<span className="wb-chip wb-chip--status" data-tone={chip.tone} role="status">
								{chip.tone === "working" ? <ClioPulse size={PULSE_SIZE.inline} /> : null}
								<span>{chip.label}</span>
								{snapshot.recoveredOrphan ? <span>· recovered after a server interruption</span> : null}
							</span>
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
						</div>
					</TopBar>
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
						{snapshot.state === "parked" ? (
							<ConversationBanner
								tone="quiet"
								title="Paused. You can read the conversation below."
								action={
									<button type="button" disabled={resume.isPending} onClick={() => resume.mutate(snapshot.workspaceId)}>
										{resume.isPending ? "Resuming…" : "Resume task"}
									</button>
								}
							>
								Resume when you want to continue. New requests wait for a slot when other work is running.
							</ConversationBanner>
						) : null}
						{resume.error ? (
							<ConversationBanner tone="warn" title="Could not resume this task.">
								{resume.error.message}
							</ConversationBanner>
						) : null}
						<ApprovalBanner client={client} session={snapshot} />
					</div>
					<div className="chat-transcript" ref={scroll}>
						<div className="chat-transcript__content">
							{snapshot.timelineTruncated ? <p className="trace-warning">{TRUNCATION_NOTE}</p> : null}

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
									notices={NO_ROWS}
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
							<LiveJobs client={client} sessionId={snapshot.id} sessionOpen={snapshot.state === "open"} jobs={snapshot.jobs} />
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
						{contextView && (contextView.live || contextView.id !== dismissedContext) ? (
							<ContextWorkCard
								key={contextView.id}
								view={contextView}
								compact
								cancelling={stopContext.stopping === contextView.id}
								cancelLabel={running ? "Stop task and context work" : "Stop context work"}
								{...(contextView.live
									? { onCancel: () => stopContext.stop(contextView.id) }
									: {
											onDismiss: (keyboard: boolean) => {
												setDismissedContext(contextView.id);
												// The card holding focus is leaving; the composer is where the keyboard goes next.
												if (keyboard) focusComposer(snapshot.id);
											},
										})}
							/>
						) : null}
						{stopContext.error ? <p role="alert">{stopContext.error.message}</p> : null}
						<Composer
							client={client}
							sessionId={snapshot.id}
							workspaceId={snapshot.workspaceId}
							sessionState={snapshot.state}
							initialFocus={snapshot.timeline.length === 0}
							runningTurnId={turn?.status === "running" ? turn.id : null}
							contextRunning={contextRunning}
							contextOperation={contextOperationRef}
							route={route}
						/>
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
					route={route}
				/>
			</section>
		</PaneContext.Provider>
	);
}
