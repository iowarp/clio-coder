import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime, formatTokens } from "../api/clock.js";
import { sessionBuffer } from "../api/sessions.js";
import { MarkdownContent } from "../render/Markdown.js";
import { CancelTurn, DeleteSession, FleetStrip, PermissionCards, SessionControls } from "./session-controls.js";
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
			<p className="eyebrow">Your work</p>
			<h1>
				Sessions<span className="period">.</span>
			</h1>
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
			{workspaces.data?.length === 0 ? <p>Open your first workspace using its absolute path.</p> : null}
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
			<p className="eyebrow">Workspace</p>
			<h1>{workspace.data?.name ?? "Sessions"}</h1>
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
				{!active.length ? <p>No sessions open.</p> : null}
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
									{session.model ?? "Model not recorded"} · {session.messageCount ?? 0} messages
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
				{history.data?.length === 0 ? <p>No saved sessions in this workspace.</p> : null}
			</section>
		</section>
	);
}
function Timeline({ item }: { item: TimelineItem }) {
	const attribution = item.provenance
		?.map((agent) => `${agent.agentId}${agent.runId ? ` / ${agent.runId}` : ""}`)
		.join(", ");
	if (item.kind === "thought")
		return (
			<details className="chat-thought">
				<summary>
					Reasoning{attribution ? ` · ${attribution}` : ""}
					{item.origin === "replay" ? " · replay" : ""}
				</summary>
				<p>{item.text}</p>
			</details>
		);
	return (
		<article className={`chat-message ${item.kind}`}>
			<div className="chat-message-label">
				<strong>
					{item.kind === "user"
						? "You"
						: item.kind === "tool"
							? (item.title ?? "Tool")
							: item.kind === "notice"
								? "Session notice"
								: "Clio Coder"}
				</strong>
				<span>
					{attribution ?? (item.kind === "user" ? "" : "Attribution not recorded")}
					{item.origin === "replay" ? " · replay" : ""}
				</span>
			</div>
			{item.kind === "text" ? (
				<MarkdownContent source={item.text} complete={item.status !== "in_progress" && item.status !== "pending"} />
			) : (
				<p>{item.text}</p>
			)}
			{item.kind === "tool" ? (
				<>
					<span className="trace-badge">
						{item.toolKind} · {item.status}
					</span>
					{item.locations?.map((location) => (
						<p key={`${location.path}:${location.line}`}>
							{location.path}
							{location.line == null ? "" : `:${location.line + 1}`}
						</p>
					))}
					<details>
						<summary>Tool input and result</summary>
						<pre className="trace-json">{JSON.stringify({ input: item.rawInput, output: item.rawOutput }, null, 2)}</pre>
					</details>
				</>
			) : null}
		</article>
	);
}
export function Session({ client }: { client: Client }) {
	const { id = "" } = useParams();
	return <SessionView key={id} client={client} id={id} />;
}
function SessionView({ client, id }: { client: Client; id: string }) {
	const [text, setText] = useState(""),
		queries = useQueryClient();
	const input = { params: { id }, query: {}, body: {} };
	const session = useQuery({
		queryKey: ["session", id],
		queryFn: async () => {
			const snapshot = await client.call(routes.session, input);
			return sessionBuffer(id).snapshot(snapshot) ?? snapshot;
		},
	});
	const prompt = useMutation({
		mutationFn: () => client.call(routes.turn, { ...input, body: { text } }),
		onSuccess: () => setText(""),
	});
	const close = useMutation({
		mutationFn: () => client.call(routes.closeSession, input),
		onSuccess: (snapshot) => {
			queries.setQueryData(["session", id], sessionBuffer(id).snapshot(snapshot));
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void queries.invalidateQueries({ queryKey: ["session-history", snapshot.workspaceId] });
		},
	});
	if (session.error)
		return (
			<div role="alert">
				<h1>Session unavailable</h1>
				<p>{session.error.message}</p>
				<Link to="/sessions">Open a workspace</Link>
			</div>
		);
	if (!session.data) return <p>Loading session…</p>;
	const snapshot = session.data,
		turn = snapshot.turns.at(-1),
		busy = turn?.status === "running";
	return (
		<section className="conversation">
			<Link to={`/workspaces/${snapshot.workspaceId}/sessions`}>← Workspace sessions</Link>
			<div className="page-heading">
				<div>
					<p className="eyebrow">Conversation</p>
					<h1>{snapshot.label ?? "Clio Coder"}</h1>
				</div>
				<button type="button" onClick={() => close.mutate()} disabled={close.isPending || snapshot.state !== "open"}>
					Close session
				</button>
			</div>
			<p className="session-status" role="status">
				{snapshot.recoveredOrphan ? "Recovered after server interruption · " : ""}
				{snapshot.state}
				{busy ? " · Clio Coder is working…" : ""}
			</p>
			<SessionControls client={client} session={snapshot} />
			<CancelTurn client={client} session={snapshot} />
			<PermissionCards client={client} session={snapshot} />
			<FleetStrip session={snapshot} />
			{snapshot.timelineTruncated ? (
				<p className="trace-warning">
					Earlier conversation content was omitted from this view to keep it bounded. Clio retains its own session history.
				</p>
			) : null}
			<div className="chat-timeline">
				{snapshot.timeline.map((item) => (
					<Timeline key={item.id} item={item} />
				))}
				{snapshot.timeline.length === 0 ? <p className="chat-empty">What would you like to work on?</p> : null}
			</div>
			{turn?.usage ? (
				<p className="chat-usage">
					Input {formatTokens(turn.usage.input)} · Output {formatTokens(turn.usage.output)} · Cache read{" "}
					{formatTokens(turn.usage.cacheRead)} · Cache write {formatTokens(turn.usage.cacheWrite)} · Reasoning{" "}
					{formatTokens(turn.usage.reasoning)}
				</p>
			) : null}
			{turn?.problem || prompt.error || close.error ? (
				<p role="alert">{turn?.problem?.detail ?? prompt.error?.message ?? close.error?.message}</p>
			) : null}
			<form
				className="session-composer"
				onSubmit={(event) => {
					event.preventDefault();
					prompt.mutate();
				}}
			>
				<label htmlFor="prompt">Message Clio Coder</label>
				<textarea
					id="prompt"
					value={text}
					onChange={(event) => setText(event.target.value)}
					rows={4}
					maxLength={32000}
					disabled={busy || snapshot.state !== "open"}
					placeholder="Describe the change or investigation…"
				/>
				<button
					className="primary"
					type="submit"
					disabled={busy || prompt.isPending || !text.trim() || snapshot.state !== "open"}
				>
					{busy ? "Working…" : "Send message"}
				</button>
			</form>
		</section>
	);
}
