import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { clock, formatTime } from "../api/clock.js";
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
import "../chat/chat-turn.css";
export function Workspaces({ client }: { client: Client }) {
	const navigate = useNavigate(),
		queries = useQueryClient(),
		[path, setPath] = useState("");
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const open = useMutation({
		mutationFn: () => client.call(routes.openWorkspace, { ...emptyInput, body: { path } }),
		onSuccess: (workspace) => {
			void queries.invalidateQueries({ queryKey: ["workspaces"] });
			void navigate(`/workspaces/${workspace.id}/sessions`);
		},
	});
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
			<p className="intro">Open a workspace and continue a conversation with Clio.</p>
			<form
				className="workspace-open"
				onSubmit={(event) => {
					event.preventDefault();
					open.mutate();
				}}
			>
				<label>
					Workspace path
					<input
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="/absolute/path/to/project"
						required
					/>
				</label>
				<button className="primary" type="submit" disabled={open.isPending}>
					{open.isPending ? "Opening…" : "Open workspace"}
				</button>
			</form>
			{open.error || workspaces.error ? <p role="alert">{open.error?.message ?? workspaces.error?.message}</p> : null}
			<h2>Recent workspaces</h2>
			{workspaces.isPending ? <p>Loading workspaces…</p> : null}
			{workspaces.data?.map((workspace) => (
				<Link className="trace-run-card" key={workspace.id} to={`/workspaces/${workspace.id}/sessions`}>
					<div>
						<h2>{workspace.name}</h2>
						<p>{workspace.path}</p>
						<small>Opened {formatTime(workspace.openedAt)}</small>
					</div>
					<span aria-hidden="true">→</span>
				</Link>
			))}
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
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/sessions/${session.id}`);
		},
	});
	const active =
		sessions.data?.filter((session) => session.workspaceId === workspaceId && session.state === "open") ?? [];
	return (
		<section>
			<Link to="/sessions">← Workspaces</Link>
			<PanelHeading panel={PANELS.sessions} level={1} title={workspace.data?.name ?? "Sessions"} />
			<p className="workspace-path">{workspace.data?.path}</p>
			<button className="primary" type="button" disabled={open.isPending} onClick={() => open.mutate(null)}>
				{open.isPending ? "Starting session…" : "New session"}
			</button>
			{open.error || history.error || workspace.error || sessions.error ? (
				<p role="alert">
					{open.error?.message ?? history.error?.message ?? workspace.error?.message ?? sessions.error?.message}
				</p>
			) : null}
			<section className="trace-panel">
				<h2>Open in this server</h2>
				{active.map((session) => (
					<Link className="trace-run-card" key={session.id} to={`/sessions/${session.id}`}>
						<div>
							<h3>{session.label ?? session.turns[0]?.prompt ?? session.id}</h3>
							<p>{session.turns.at(-1)?.status === "running" ? "Turn in progress" : "Ready for a prompt"}</p>
						</div>
					</Link>
				))}
				{!active.length ? <PanelEmpty>No session of this workspace is open in this server.</PanelEmpty> : null}
			</section>
			<section className="trace-panel">
				<h2>Session history</h2>
				{history.isPending ? <p>Reading session history…</p> : null}
				{history.data
					?.filter((row) => !active.some((session) => session.id === row.id))
					.map((session) => (
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
								Load session
							</button>
							{session.endedAt ? <DeleteSession client={client} id={session.id} workspaceId={workspaceId} /> : null}
						</article>
					))}
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
}: {
	client: Client;
	session: SessionSnapshot;
	liveWorkers: number;
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
				Session tools{liveWorkers > 0 ? ` · ${liveWorkers} ${liveWorkers === 1 ? "worker" : "workers"} running` : ""}
			</summary>
			<div className="conversation__tools-body">
				<SessionControls client={client} session={session} />
				<CommandPanel client={client} sessionId={session.id} sessionOpen={session.state === "open"} />
				<FleetStrip client={client} session={session} />
			</div>
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
	const follow = useFollowLatest(scroll, true, snapshot?.timeline);
	if (session.error)
		return (
			<div role="alert">
				<h1>Session unavailable</h1>
				<p>{session.error.message}</p>
				<Link to="/sessions">Open a workspace</Link>
			</div>
		);
	if (!snapshot) return <p>Loading session…</p>;
	const turn = snapshot.turns.at(-1);
	const pending = pendingPermission(snapshot) ?? null;
	const workspaceRoot = workspace.data?.path;
	return (
		<section className="conversation">
			<header className="conversation__header">
				<Link className="conversation__back" to={`/workspaces/${snapshot.workspaceId}/sessions`}>
					← Workspace sessions
				</Link>
				<div className="conversation__titlebar">
					<div>
						<p className="eyebrow">Conversation</p>
						<h1>{snapshot.label ?? "Clio Coder"}</h1>
					</div>
					<button type="button" onClick={() => close.mutate()} disabled={close.isPending || snapshot.state !== "open"}>
						Close session
					</button>
				</div>
				<div className="conversation__meta">
					<p className="session-status" role="status">
						{snapshot.recoveredOrphan ? "Recovered after server interruption · " : ""}
						{snapshot.state}
						{running ? " · Clio Coder is working…" : ""}
					</p>
					<SessionHealth session={snapshot} />
					<SessionTools client={client} session={snapshot} liveWorkers={liveWorkers} />
				</div>
			</header>
			<div className="conversation__approval">
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
							row={snapshot.turns.find((row) => row.id === item.turnId)}
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
					runningTurnId={turn?.status === "running" ? turn.id : null}
				/>
			</div>
		</section>
	);
}
