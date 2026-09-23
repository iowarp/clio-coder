import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { type AgentCapabilities, EMPTY_CAPABILITIES } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { clock, formatTime } from "../api/clock.js";
import type { ConnectionState } from "../api/events.js";
import { sessionBuffer } from "../api/sessions.js";
import { ApprovalBanner, pendingPermission } from "../chat/Approval.js";
import { ChatTurnView } from "../chat/ChatTurn.js";
import { CommandPanel } from "../chat/CommandPanel.js";
import { Composer, fillComposer } from "../chat/Composer.js";
import {
	CONTEXT_WARNING_LABEL,
	EMPTY_EYEBROW,
	EMPTY_GLYPH,
	EMPTY_HEADING,
	PROVIDER_UNREPORTED,
	placeHealthRows,
	STARTER_PROMPTS,
	TRUNCATION_NOTE,
} from "../chat/chat-turn.js";
import { FleetStrip } from "../chat/FleetStrip.js";
import { foldFleetRuns, isLiveRun } from "../chat/fleet-facts.js";
import { type HealthRow, summarizeHealth } from "../chat/health.js";
import { type ChatTurn, groupTurns, turnStatuses } from "../chat/turns.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { JumpToLatest } from "../render/FollowLatest.js";
import { useFollowLatest } from "../render/follow-latest.js";
import { DeleteSession, SessionControls } from "./session-controls.js";
import { WorkspaceBrowser } from "./workspace-browser.js";
import "../chat/chat-turn.css";
export function Workspaces({ client }: { client: Client }) {
	const navigate = useNavigate(),
		queries = useQueryClient(),
		[path, setPath] = useState("");
	const [browsing, setBrowsing] = useState(false);
	const pathField = useRef<HTMLInputElement>(null);
	const browseButton = useRef<HTMLButtonElement>(null);
	const launchInFlight = useRef(false);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const open = useMutation({
		mutationFn: ({ projectPath }: { projectPath: string; startConversation: boolean }) =>
			client.call(routes.openWorkspace, { ...emptyInput, body: { path: projectPath } }),
		onSuccess: (workspace, request) => {
			void queries.invalidateQueries({ queryKey: ["workspaces"] });
			if (request.startConversation) start.mutate(workspace.id);
			else {
				launchInFlight.current = false;
				void navigate(`/workspaces/${workspace.id}/sessions`);
			}
		},
		onError: () => {
			launchInFlight.current = false;
		},
	});
	const start = useMutation({
		mutationFn: (workspaceId: string) =>
			client.call(routes.newSession, { params: { id: workspaceId }, query: {}, body: {} }),
		onSuccess: (session) => {
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/sessions/${session.id}`);
		},
		onSettled: () => {
			launchInFlight.current = false;
		},
	});
	const beginOpen = (projectPath: string, startConversation: boolean) => {
		if (launchInFlight.current) return;
		launchInFlight.current = true;
		open.mutate({ projectPath, startConversation });
	};
	const beginStart = (workspaceId: string) => {
		if (launchInFlight.current) return;
		launchInFlight.current = true;
		start.mutate(workspaceId);
	};
	return (
		<section>
			<PanelHeading
				panel={PANELS.sessions}
				level={1}
				title={
					<>
						Sessions<span className="period">.</span>
					</>
				}
			/>
			<p className="intro">
				Choose a project folder on the machine running Clio Coder to start or continue a conversation.
			</p>
			<form
				className="workspace-open"
				onSubmit={(event) => {
					event.preventDefault();
					beginOpen(path.trim(), true);
				}}
			>
				<label>
					Workspace path
					<input
						ref={pathField}
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="/absolute/path/to/project"
						autoComplete="off"
						required
					/>
				</label>
				<button
					ref={browseButton}
					type="button"
					disabled={open.isPending || start.isPending}
					onClick={() => setBrowsing((current) => !current)}
				>
					{browsing ? "Hide folders" : "Browse folders"}
				</button>
				<button className="primary" type="submit" disabled={open.isPending || start.isPending || path.trim() === ""}>
					{open.isPending || start.isPending ? "Starting…" : "Start conversation"}
				</button>
				<button
					type="button"
					disabled={open.isPending || start.isPending || path.trim() === ""}
					onClick={() => beginOpen(path.trim(), false)}
				>
					View saved sessions
				</button>
			</form>
			{browsing && (
				<WorkspaceBrowser
					client={client}
					initialPath={path}
					onStart={(selected) => {
						setPath(selected);
						setBrowsing(false);
						beginOpen(selected, true);
					}}
					onClose={() => {
						setBrowsing(false);
						browseButton.current?.focus();
					}}
					onChoose={(selected) => {
						setPath(selected);
						setBrowsing(false);
						pathField.current?.focus();
					}}
				/>
			)}
			{open.error || start.error || workspaces.error ? (
				<p role="alert">{open.error?.message ?? start.error?.message ?? workspaces.error?.message}</p>
			) : null}
			<div className="workspace-list__heading">
				<h2>Recent projects</h2>
				<p>Pick up where you left off.</p>
			</div>
			{workspaces.isPending ? <p>Loading workspaces…</p> : null}
			<div className="workspace-list">
				{workspaces.data?.map((workspace) => (
					<article className="workspace-card" key={workspace.id}>
						<span className="workspace-card__mark" aria-hidden="true">
							{workspace.name.slice(0, 1).toUpperCase()}
						</span>
						<div>
							<h3>
								<Link to={`/workspaces/${workspace.id}/sessions`}>{workspace.name}</Link>
							</h3>
							<p>{workspace.path}</p>
							<small>Last opened {formatTime(workspace.openedAt)}</small>
							<div className="workspace-card__actions">
								<button type="button" disabled={open.isPending || start.isPending} onClick={() => beginStart(workspace.id)}>
									{start.isPending && start.variables === workspace.id ? "Starting…" : "New conversation"}
								</button>
								<Link to={`/workspaces/${workspace.id}/sessions`}>
									View sessions <span aria-hidden="true">→</span>
								</Link>
							</div>
						</div>
					</article>
				))}
			</div>
			{workspaces.data?.length === 0 ? (
				<PanelEmpty>No workspace has been opened here yet. Open your first one using its absolute path.</PanelEmpty>
			) : null}
			<Boundary panel={PANELS.sessions} />
		</section>
	);
}
export function Sessions({ client }: { client: Client }) {
	const { workspaceId = "" } = useParams(),
		navigate = useNavigate(),
		queries = useQueryClient();
	const [historySearch, setHistorySearch] = useState("");
	const input = { params: { id: workspaceId }, query: {}, body: {} };
	const workspace = useQuery({
		queryKey: ["workspace", workspaceId],
		queryFn: () => client.call(routes.workspace, input),
	});
	const history = useQuery({
		queryKey: ["session-history", workspaceId],
		queryFn: () => client.call(routes.sessionHistory, input),
	});
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const open = useMutation({
		mutationFn: (id: string | null) =>
			id
				? client.call(routes.loadSession, { params: { id }, query: {}, body: { workspaceId } })
				: client.call(routes.newSession, input),
		onSuccess: (session) => {
			// A loaded ledger may bind a new ACP child with a different command catalog.
			queries.removeQueries({ queryKey: ["session-capabilities", session.id] });
			queries.removeQueries({ queryKey: ["session-commands", session.id] });
			queries.removeQueries({ queryKey: ["session-queue", session.id] });
			queries.removeQueries({ queryKey: ["session-settings", session.id] });
			queries.removeQueries({ queryKey: ["session-targets", session.id] });
			queries.removeQueries({ queryKey: ["session-autonomy", session.id] });
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/sessions/${session.id}`);
		},
	});
	const active =
		sessions.data?.filter((session) => session.workspaceId === workspaceId && session.state === "open") ?? [];
	const historyQuery = historySearch.trim().toLocaleLowerCase();
	const activeIds = new Set(active.map((session) => session.id));
	const saved = (history.data ?? [])
		.filter((row) => !activeIds.has(row.id))
		.filter(
			(row) =>
				historyQuery === "" ||
				[row.name, row.firstMessagePreview, row.model, row.target].some((value) =>
					value?.toLocaleLowerCase().includes(historyQuery),
				),
		)
		.sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
	return (
		<section>
			<Link to="/sessions">← Workspaces</Link>
			<PanelHeading panel={PANELS.sessions} level={1} title={workspace.data?.name ?? "Sessions"} />
			<p className="workspace-path">{workspace.data?.path}</p>
			<button className="primary" type="button" disabled={open.isPending} onClick={() => open.mutate(null)}>
				{open.isPending && open.variables === null ? "Starting session…" : "New session"}
			</button>
			{open.error || history.error || workspace.error || sessions.error ? (
				<p role="alert">
					{open.error?.message ?? history.error?.message ?? workspace.error?.message ?? sessions.error?.message}
				</p>
			) : null}
			<section className="trace-panel session-list">
				<h2>Open in this server</h2>
				{active.map((session) => (
					<Link className="trace-run-card" key={session.id} to={`/sessions/${session.id}`}>
						<div>
							<h3>{session.label ?? session.turns[0]?.prompt ?? session.id}</h3>
							<p>
								{pendingPermission(session) ? (
									<StatusMark tone="warn" label="Approval needed" />
								) : session.turns.at(-1)?.status === "running" ? (
									<StatusMark tone="running" label="Working" />
								) : session.turns.at(-1)?.status === "failed" ? (
									<StatusMark tone="fail" label="Last turn failed" />
								) : session.turns.at(-1)?.status === "cancelled" ? (
									<StatusMark tone="neutral" label="Last turn stopped" />
								) : (
									<StatusMark tone="success" label="Ready for a prompt" />
								)}
							</p>
						</div>
					</Link>
				))}
				{!active.length ? <PanelEmpty>No session of this workspace is open in this server.</PanelEmpty> : null}
			</section>
			<section className="trace-panel session-list">
				<h2>Session history</h2>
				{history.isPending ? <p>Reading session history…</p> : null}
				{(history.data?.length ?? 0) > 0 ? (
					<label className="session-history__search">
						Find a conversation
						<input
							type="search"
							value={historySearch}
							onChange={(event) => setHistorySearch(event.target.value)}
							placeholder="Search name, message, model, or target"
						/>
					</label>
				) : null}
				{saved.map((session) => (
					<article className="trace-run-card" key={session.id}>
						<div>
							<h3>{session.name ?? session.firstMessagePreview ?? session.id}</h3>
							<p>
								{session.model ?? "Model not recorded"} ·{" "}
								{session.messageCount == null
									? "message count not recorded"
									: `${session.messageCount.toLocaleString("en-US")} ${session.messageCount === 1 ? "message" : "messages"}`}
							</p>
							<small>
								{formatTime(session.lastActivityAt ?? session.createdAt)} · {session.endedAt ? "closed" : "open in Clio"}
							</small>
						</div>
						<button type="button" disabled={open.isPending} onClick={() => open.mutate(session.id)}>
							{open.isPending && open.variables === session.id ? "Loading…" : "Load session"}
						</button>
						{session.endedAt ? <DeleteSession client={client} id={session.id} workspaceId={workspaceId} /> : null}
					</article>
				))}
				{historySearch.trim() && saved.length === 0 && !history.isPending ? (
					<PanelEmpty>No conversations match that search.</PanelEmpty>
				) : null}
				{!historySearch.trim() && saved.length === 0 && active.length > 0 && (history.data?.length ?? 0) > 0 ? (
					<PanelEmpty>All saved conversations from this project are already open.</PanelEmpty>
				) : null}
				{history.data?.length === 0 ? (
					<PanelEmpty>{emptyState.emptyStore("saved session", "for this workspace")}</PanelEmpty>
				) : null}
			</section>
			<Boundary panel={PANELS.sessions} />
		</section>
	);
}
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
			<span className="chat-empty__glyph" aria-hidden="true">
				{EMPTY_GLYPH}
			</span>
			<p className="eyebrow">{EMPTY_EYEBROW}</p>
			<h2>{EMPTY_HEADING}</h2>
			<div className="chat-empty__starters">
				{STARTER_PROMPTS.map((prompt) => (
					<button key={prompt} type="button" onClick={() => fillComposer(sessionId, prompt)}>
						{prompt}
					</button>
				))}
			</div>
		</div>
	);
}

function SessionTools({
	client,
	session,
	liveWorkers,
	capabilities,
	capabilitiesError,
}: {
	client: Client;
	session: SessionSnapshot;
	liveWorkers: number;
	capabilities: AgentCapabilities | undefined;
	capabilitiesError: Error | null;
}) {
	const panel = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && !panel.current?.contains(event.target) && panel.current)
				panel.current.open = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
			event.preventDefault();
			panel.current.open = false;
			panel.current.querySelector("summary")?.focus();
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);
	return (
		<details className="conversation__tools" ref={panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				Controls &amp; settings
				{liveWorkers > 0 ? ` · ${liveWorkers} ${liveWorkers === 1 ? "worker" : "workers"} running` : ""}
			</summary>
			{open ? (
				<div className="conversation__tools-body">
					{capabilities || session.state !== "open" ? (
						<SessionControls client={client} session={session} capabilities={capabilities ?? EMPTY_CAPABILITIES} />
					) : capabilitiesError ? (
						<p role="alert">{capabilitiesError.message}</p>
					) : (
						<p>Checking session controls…</p>
					)}
					<Link className="conversation__settings-link" to={`/settings?workspace=${session.workspaceId}`}>
						Project settings <span aria-hidden="true">→</span>
					</Link>
					<CommandPanel client={client} sessionId={session.id} sessionOpen={session.state === "open"} />
					<FleetStrip client={client} session={session} />
				</div>
			) : null}
		</details>
	);
}

function SessionHealth({ session }: { session: SessionSnapshot }) {
	const summary = useMemo(() => summarizeHealth(session.health), [session.health]);
	const providers = summary.providers;
	const unknown = summary.unknown;
	return (
		<>
			{summary.contextWarning ? (
				<p className="context-banner" role="status">
					<strong>{CONTEXT_WARNING_LABEL}</strong> {summary.contextWarning.detail ?? summary.contextWarning.label}
				</p>
			) : null}
			<div className="session-health">
				{providers.length === 0 ? (
					<StatusMark tone="unverified" label={PROVIDER_UNREPORTED} />
				) : (
					providers.map((row) => (
						<StatusMark
							key={row.id}
							tone={row.tone}
							label={row.label}
							{...(row.detail === null ? {} : { detail: row.detail })}
						/>
					))
				)}
				{unknown.map((row) => (
					<StatusMark key={row.id} tone={row.tone} label={row.label} />
				))}
			</div>
		</>
	);
}

function SessionView({ client, id }: { client: Client; id: string }) {
	const connection = useOutletContext<ConnectionState>();
	const queries = useQueryClient();
	const navigate = useNavigate();
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
	const openSessions = useQuery({
		queryKey: ["sessions"],
		queryFn: () => client.call(routes.sessions, emptyInput),
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
	const scroll = useRef<HTMLDivElement | null>(null);
	const previousTurns = useRef<readonly ChatTurn[]>([]);
	const snapshot = session.data;
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
	const notices = useMemo(() => {
		const health = summarizeHealth(snapshot?.health ?? []);
		const rows = [health.compaction, health.toolBudget].filter((row): row is HealthRow => row !== null);
		return placeHealthRows(rows, snapshot?.turns ?? []);
	}, [snapshot?.health, snapshot?.turns]);
	const running = snapshot?.turns.at(-1)?.status === "running";
	const now = useSecond(running || (snapshot?.permissions.some((item) => item.status === "pending") ?? false));
	// A deep link starts without a cached snapshot. Attach the observer only once
	// the transcript element exists; a ref becoming non-null does not rerun an effect.
	const follow = useFollowLatest(scroll, snapshot !== undefined, snapshot?.timeline);
	if (session.error && !snapshot)
		return (
			<div role="alert">
				<h1>Session unavailable</h1>
				<p>{session.error.message}</p>
				<button type="button" disabled={session.isFetching} onClick={() => void session.refetch()}>
					{session.isFetching ? "Trying again…" : "Try again"}
				</button>
				<Link to="/sessions">Open a workspace</Link>
			</div>
		);
	if (!snapshot) return <p>Loading session…</p>;
	const turn = snapshot.turns.at(-1);
	const pending = pendingPermission(snapshot) ?? null;
	const workspaceRoot = workspace.data?.path;
	const activity = pending
		? { tone: "warn" as const, label: "Waiting for your approval" }
		: running
			? { tone: "running" as const, label: "Clio Coder is working" }
			: snapshot.state === "open"
				? { tone: "success" as const, label: "Ready for your message" }
				: snapshot.state === "starting"
					? { tone: "running" as const, label: "Starting session" }
					: snapshot.state === "closed"
						? { tone: "neutral" as const, label: "Session closed" }
						: { tone: "fail" as const, label: "Session unavailable" };
	return (
		<section className="conversation">
			<header className="conversation__header">
				<Link className="conversation__back" to={`/workspaces/${snapshot.workspaceId}/sessions`}>
					← Workspace sessions
				</Link>
				<div className="conversation__titlebar">
					<div>
						<p className="eyebrow">{workspace.data?.name ?? "Conversation"} / Clio Coder</p>
						<h1>{snapshot.label ?? "Clio Coder"}</h1>
						{workspaceRoot ? (
							<p className="conversation__path" title={workspaceRoot}>
								{workspaceRoot}
							</p>
						) : null}
					</div>
					<button type="button" onClick={() => close.mutate()} disabled={close.isPending || snapshot.state !== "open"}>
						Close session
					</button>
				</div>
				<div className="conversation__meta">
					<p className="session-status" role="status">
						<StatusMark tone={activity.tone} label={activity.label} />
						{snapshot.recoveredOrphan ? <span>Recovered after server interruption</span> : null}
					</p>
					{snapshot.state === "open" && sessionSettings.data ? (
						<section className="conversation__routing" aria-label="Current session settings">
							<span title={sessionSettings.data.settings.chat.target ?? "Automatic routing"}>
								Target: {sessionSettings.data.settings.chat.target ?? "automatic"}
							</span>
							<span title={sessionSettings.data.settings.chat.model ?? "Configured default model"}>
								Model: {sessionSettings.data.settings.chat.model ?? "default"}
							</span>
							<span>Thinking: {sessionSettings.data.settings.chat.thinkingLevel}</span>
						</section>
					) : null}
					<SessionHealth session={snapshot} />
					{snapshot.state === "open" && (openSessions.data?.filter((entry) => entry.state === "open").length ?? 0) > 1 ? (
						<label className="conversation__switch">
							Switch conversation
							<select value={id} onChange={(event) => void navigate(`/sessions/${event.target.value}`)}>
								{openSessions.data
									?.filter((entry) => entry.state === "open")
									.map((entry) => (
										<option value={entry.id} key={entry.id}>
											{entry.label ?? entry.turns[0]?.prompt ?? "New conversation"}
										</option>
									))}
							</select>
						</label>
					) : null}
					<SessionTools
						client={client}
						session={snapshot}
						liveWorkers={liveWorkers}
						capabilities={capabilities.data}
						capabilitiesError={capabilities.error}
					/>
				</div>
			</header>
			<div className="conversation__approval">
				{connection === "Reconnecting…" || connection === "Not connected" || session.error ? (
					<div className="conversation__connection" role="status">
						<strong>{session.error ? "Conversation refresh failed." : "Live updates are reconnecting."}</strong>
						<span>
							{session.error
								? session.error.message
								: "The conversation below is the last state received. New activity will appear when the connection returns."}
						</span>
						<button type="button" disabled={session.isFetching} onClick={() => void session.refetch()}>
							{session.isFetching ? "Refreshing…" : "Refresh conversation"}
						</button>
					</div>
				) : null}
				{snapshot.state === "unknown" || snapshot.state === "failed" || snapshot.state === "closed" ? (
					<div className="conversation__recovery" role="status">
						<strong>
							{snapshot.state === "closed"
								? "This conversation is closed."
								: snapshot.state === "unknown"
									? "Clio Coder is no longer connected to this session."
									: "This session could not continue."}
						</strong>
						<span>The recorded conversation is still available below.</span>
						<Link to={`/workspaces/${snapshot.workspaceId}/sessions`}>Load or start a session →</Link>
					</div>
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
				/>
			</div>
		</section>
	);
}
