import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
	placeHealthRows,
	STARTER_PROMPTS,
	TRUNCATION_NOTE,
} from "../chat/chat-turn.js";
import { FleetStrip, LiveWorkers, workerCount } from "../chat/FleetStrip.js";
import { foldFleetRuns, isLiveRun } from "../chat/fleet-facts.js";
import { type HealthRow, type HealthSummary, summarizeHealth } from "../chat/health.js";
import { routeFacts } from "../chat/route.js";
import { type ChatTurn, groupTurns, turnStatuses } from "../chat/turns.js";
import { Icon } from "../design/icons.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark, type StatusTone } from "../design/status.js";
import { JumpToLatest } from "../render/FollowLatest.js";
import { useFollowLatest } from "../render/follow-latest.js";
import { DeleteSession, SessionControls } from "./session-controls.js";
import { WorkspaceBrowser } from "./workspace-browser.js";
import "../chat/chat-turn.css";
import "./projects.css";
export function Workspaces({ client }: { client: Client }) {
	const navigate = useNavigate(),
		queries = useQueryClient(),
		[path, setPath] = useState("");
	const [browsing, setBrowsing] = useState(false);
	const pathId = useId();
	const recentId = useId();
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
	const busy = open.isPending || start.isPending;
	return (
		<section className="projects">
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
				className="project-open"
				onSubmit={(event) => {
					event.preventDefault();
					beginOpen(path.trim(), true);
				}}
			>
				<label className="project-open__label" htmlFor={pathId}>
					Project folder
				</label>
				<div className="project-open__row">
					<input
						id={pathId}
						ref={pathField}
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="/absolute/path/to/project"
						autoComplete="off"
						spellCheck={false}
						required
					/>
					<button ref={browseButton} type="button" disabled={busy} onClick={() => setBrowsing((current) => !current)}>
						{browsing ? "Hide folders" : "Browse folders"}
					</button>
					<button className="primary" type="submit" disabled={busy || path.trim() === ""}>
						{busy ? "Starting…" : "Start conversation"}
					</button>
				</div>
				<p className="project-open__more">
					<button
						type="button"
						className="text-button"
						disabled={busy || path.trim() === ""}
						onClick={() => beginOpen(path.trim(), false)}
					>
						View saved sessions
					</button>{" "}
					for this folder instead of starting a new one.
				</p>
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
			<section className="projects__section" aria-labelledby={recentId}>
				<h2 id={recentId}>Recent projects</h2>
				{workspaces.isPending ? <p className="projects__note">Loading projects…</p> : null}
				{(workspaces.data?.length ?? 0) > 0 ? (
					<ul className="record-list">
						{workspaces.data?.map((workspace) => (
							<li className="record-row" key={workspace.id}>
								<div className="record-row__text">
									<Link className="record-row__title" to={`/workspaces/${workspace.id}/sessions`}>
										{workspace.name}
									</Link>
									<span className="record-row__meta">
										<span className="record-row__path" title={workspace.path}>
											{workspace.path}
										</span>
										<span>Opened {formatTime(workspace.openedAt)}</span>
									</span>
								</div>
								<div className="record-row__actions">
									<button
										type="button"
										disabled={busy}
										onClick={() => beginStart(workspace.id)}
										aria-label={`New conversation in ${workspace.name}`}
									>
										{start.isPending && start.variables === workspace.id ? "Starting…" : "New conversation"}
									</button>
								</div>
							</li>
						))}
					</ul>
				) : null}
				{workspaces.data?.length === 0 ? (
					<PanelEmpty>
						No project has been opened here yet. Choose its folder above to start the first conversation.
					</PanelEmpty>
				) : null}
			</section>
			<Boundary panel={PANELS.sessions} />
		</section>
	);
}
export function Sessions({ client }: { client: Client }) {
	const { workspaceId = "" } = useParams(),
		navigate = useNavigate(),
		queries = useQueryClient();
	const [historySearch, setHistorySearch] = useState("");
	const openId = useId();
	const historyId = useId();
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
	const name = workspace.data?.name ?? "This project";
	return (
		<section className="projects">
			<Link className="projects__back" to="/sessions">
				<span aria-hidden="true">←</span> All projects
			</Link>
			<PanelHeading panel={PANELS.sessions} level={1} title={workspace.data?.name ?? "Sessions"} />
			<div className="projects__lead">
				<p className="projects__path">{workspace.data?.path ?? "Reading the project path…"}</p>
				<button className="primary" type="button" disabled={open.isPending} onClick={() => open.mutate(null)}>
					{open.isPending && open.variables === null ? "Starting…" : "New conversation"}
				</button>
			</div>
			{open.error || history.error || workspace.error || sessions.error ? (
				<p role="alert">
					{open.error?.message ?? history.error?.message ?? workspace.error?.message ?? sessions.error?.message}
				</p>
			) : null}
			<section className="projects__section" aria-labelledby={openId}>
				<h2 id={openId}>Open now</h2>
				{active.length > 0 ? (
					<ul className="record-list">
						{active.map((session) => (
							<li className="record-row" key={session.id}>
								<div className="record-row__text">
									<Link className="record-row__title" to={`/sessions/${session.id}`}>
										{conversationTitle(session)}
									</Link>
								</div>
								<span className="record-row__status">
									<StatusMark {...openSessionStatus(session)} />
								</span>
							</li>
						))}
					</ul>
				) : (
					<PanelEmpty>No conversation from {name} is open in this server.</PanelEmpty>
				)}
			</section>
			<section className="projects__section" aria-labelledby={historyId}>
				<div className="projects__section-head">
					<h2 id={historyId}>Earlier conversations</h2>
					{(history.data?.length ?? 0) > 0 ? (
						<label className="projects__search">
							<span className="sr-only">Find a conversation</span>
							<input
								type="search"
								value={historySearch}
								onChange={(event) => setHistorySearch(event.target.value)}
								placeholder="Find by name, message, model or target"
							/>
						</label>
					) : null}
				</div>
				{history.isPending ? <p className="projects__note">Reading session history…</p> : null}
				{saved.length > 0 ? (
					<ul className="record-list">
						{saved.map((session) => {
							const title = session.name ?? session.firstMessagePreview ?? session.id;
							const loading = open.isPending && open.variables === session.id;
							return (
								<li className="record-row" key={session.id}>
									<div className="record-row__text">
										<button
											type="button"
											className="record-row__title"
											disabled={open.isPending}
											onClick={() => open.mutate(session.id)}
											title="Load this conversation into a new Clio Coder session"
										>
											{title}
										</button>
										<span className="record-row__meta">
											<span>{session.model ?? "Model not recorded"}</span>
											<span>
												{session.messageCount == null
													? "Message count not recorded"
													: `${session.messageCount.toLocaleString("en-US")} ${session.messageCount === 1 ? "message" : "messages"}`}
											</span>
											<span>{formatTime(session.lastActivityAt ?? session.createdAt)}</span>
											<span>{loading ? "Loading…" : session.endedAt ? "Closed" : "Not closed"}</span>
										</span>
									</div>
									{session.endedAt ? (
										<div className="record-row__actions">
											<DeleteSession client={client} id={session.id} workspaceId={workspaceId} name={title} />
										</div>
									) : null}
								</li>
							);
						})}
					</ul>
				) : null}
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

/** An open conversation's state in the list, in the conversation's own voice. */
function openSessionStatus(session: SessionSnapshot): { tone: StatusTone; label: string } {
	const last = session.turns.at(-1)?.status;
	if (pendingPermission(session)) return { tone: "warn", label: "Waiting for your approval" };
	if (last === "running") return { tone: "running", label: "Working" };
	if (last === "failed") return { tone: "fail", label: "Last turn failed" };
	if (last === "cancelled") return { tone: "neutral", label: "Last turn stopped" };
	return { tone: "success", label: "Ready" };
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

/** What the header calls the conversation: its reported label, else the first request, else nothing yet. */
function conversationTitle(snapshot: SessionSnapshot): string {
	if (snapshot.label) return snapshot.label;
	const prompt =
		snapshot.turns.find((turn) => turn.prompt.trim() !== "")?.prompt ??
		snapshot.timeline.find((item) => item.kind === "user" && item.text.trim() !== "")?.text;
	return prompt?.replace(/\s+/g, " ").trim() ?? "New conversation";
}

/**
 * Everything about the session that is not the conversation itself, behind one control: where it runs,
 * how it is configured, Clio Coder commands, dispatched workers, switching and closing. It opens on
 * demand so the header stays one line, and it closes on Escape or an outside press.
 */
function SessionTools({
	client,
	session,
	workspaceRoot,
	capabilities,
	capabilitiesError,
	openSessions,
	closing,
	onClose,
}: {
	client: Client;
	session: SessionSnapshot;
	workspaceRoot: string | undefined;
	capabilities: AgentCapabilities | undefined;
	capabilitiesError: Error | null;
	openSessions: readonly SessionSnapshot[];
	closing: boolean;
	onClose: () => void;
}) {
	const navigate = useNavigate();
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
	const others = openSessions.filter((entry) => entry.state === "open");
	return (
		<details className="conversation__tools" ref={panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				<Icon name="settings" />
				<span className="conversation__tools-label">Session tools</span>
			</summary>
			{open ? (
				<div className="conversation__tools-body">
					<section className="conversation__place" aria-label="Where this conversation runs">
						<p className="eyebrow">Project folder</p>
						<code title={workspaceRoot}>{workspaceRoot ?? "Reading the project path…"}</code>
						<Link className="conversation__settings-link" to={`/settings?workspace=${session.workspaceId}`}>
							Project settings <span aria-hidden="true">→</span>
						</Link>
					</section>
					{session.state === "open" && others.length > 1 ? (
						<label className="conversation__switch">
							Switch to another open conversation
							<select value={session.id} onChange={(event) => void navigate(`/sessions/${event.target.value}`)}>
								{others.map((entry) => (
									<option value={entry.id} key={entry.id}>
										{conversationTitle(entry)}
									</option>
								))}
							</select>
						</label>
					) : null}
					{capabilities || session.state !== "open" ? (
						<SessionControls client={client} session={session} capabilities={capabilities ?? EMPTY_CAPABILITIES} />
					) : capabilitiesError ? (
						<p role="alert">{capabilitiesError.message}</p>
					) : (
						<p>Checking session controls…</p>
					)}
					<CommandPanel client={client} sessionId={session.id} sessionOpen={session.state === "open"} />
					<FleetStrip client={client} session={session} />
					<div className="conversation__close">
						<p>
							Closing ends this Clio Coder session. The conversation stays in the project history and can be loaded again.
						</p>
						<button type="button" onClick={onClose} disabled={closing || session.state !== "open"}>
							{closing ? "Closing…" : "Close session"}
						</button>
					</div>
				</div>
			) : null}
		</details>
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
	const health = useMemo(() => summarizeHealth(snapshot?.health ?? []), [snapshot?.health]);
	const notices = useMemo(() => {
		const rows = [health.compaction, health.toolBudget].filter((row): row is HealthRow => row !== null);
		return placeHealthRows(rows, snapshot?.turns ?? []);
	}, [health, snapshot?.turns]);
	const running = snapshot?.turns.at(-1)?.status === "running";
	const now = useSecond(running || (snapshot?.permissions.some((item) => item.status === "pending") ?? false));
	// A deep link starts without a cached snapshot. Attach the observer only once
	// the transcript element exists; a ref becoming non-null does not rerun an effect.
	const follow = useFollowLatest(scroll, snapshot !== undefined, snapshot?.timeline);
	// One object per change of reported settings or health, so a streamed delta leaves the composer alone.
	const settings = snapshot?.state === "open" ? sessionSettings.data?.settings.chat : undefined;
	const route = useMemo(
		() =>
			routeFacts(
				settings
					? { target: settings.target ?? null, model: settings.model ?? null, thinking: settings.thinkingLevel }
					: undefined,
				health,
			),
		[settings, health],
	);
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
	const title = conversationTitle(snapshot);
	const activity = pending
		? { tone: "warn" as const, label: "Waiting for your approval" }
		: running
			? {
					tone: "running" as const,
					label: liveWorkers > 0 ? `Clio Coder is waiting on ${workerCount(liveWorkers)}` : "Clio Coder is working",
				}
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
				<div className="conversation__bar">
					<Link
						className="conversation__project"
						to={`/workspaces/${snapshot.workspaceId}/sessions`}
						title={workspaceRoot ? `Conversations in ${workspaceRoot}` : "Conversations in this project"}
					>
						<span aria-hidden="true">←</span>
						<span className="conversation__project-name">{workspace.data?.name ?? "Project"}</span>
						<span className="sr-only">: all conversations</span>
					</Link>
					<h1 className="conversation__title" title={title}>
						{title}
					</h1>
					<p className="session-status" role="status">
						<StatusMark tone={activity.tone} label={activity.label} />
						{snapshot.recoveredOrphan ? <span>Recovered after server interruption</span> : null}
					</p>
					<SessionTools
						client={client}
						session={snapshot}
						workspaceRoot={workspaceRoot}
						capabilities={capabilities.data}
						capabilitiesError={capabilities.error}
						openSessions={openSessions.data ?? []}
						closing={close.isPending}
						onClose={() => close.mutate()}
					/>
				</div>
				<SessionHealth summary={health} />
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
			</div>
		</section>
	);
}
