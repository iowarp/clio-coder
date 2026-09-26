import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { sessionBuffer } from "../api/sessions.js";
import { isAwaitingAnswer } from "../chat/approval-model.js";
import { draftStore } from "../chat/composer-model.js";
import { Icon } from "../design/icons.js";
import { StatusMark, type StatusTone } from "../design/status.js";
import { HomeLaunch, type HomeProject } from "./home-launch.js";
import { useProjectLaunch } from "./project-open.js";
import { WorkspaceBrowser } from "./workspace-browser.js";
import "./home.css";

// Keep the chosen folder with an unsent task when moving between application pages.
let rememberedProject: { id: string | null; path: string } | null = null;

function sessionState(session: SessionSnapshot): { tone: StatusTone; label: string } {
	const last = session.turns.at(-1);
	if (session.permissions.some(isAwaitingAnswer)) return { tone: "warn", label: "Approval needed" };
	if (session.state === "starting") return { tone: "running", label: "Starting" };
	if (last?.status === "running") return { tone: "running", label: "Working" };
	if (last?.status === "failed") return { tone: "fail", label: "Last turn failed" };
	if (last?.status === "cancelled") return { tone: "neutral", label: "Last turn stopped" };
	return { tone: "neutral", label: "Ready" };
}

export function Home({ client }: { client: Client }) {
	const launch = useProjectLaunch(client);
	const taskLaunch = useRef(new HomeLaunch(client));
	const queries = useQueryClient();
	const navigate = useNavigate();
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const projects = [...(workspaces.data ?? [])].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
	const starterDraft = draftStore("overview");
	const [projectId, setProjectId] = useState<string | null>(
		() => rememberedProject?.id ?? (starterDraft.snapshot().text ? "" : null),
	);
	const [path, setPath] = useState(() => rememberedProject?.path ?? "");
	const [draft, setDraft] = useState(() => starterDraft.snapshot().text);
	const [pathVisible, setPathVisible] = useState(projectId === "path");
	const [browsing, setBrowsing] = useState(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const browseButton = useRef<HTMLButtonElement>(null);
	const inFlight = useRef(false);
	const pathId = useId();
	const project = projects.find((item) => item.id === (projectId ?? projects[0]?.id));
	const target: HomeProject =
		projectId === "path" ? { id: null, path } : { id: project?.id ?? null, path: project?.path ?? "" };
	const busy = sending || launch.busy;
	const ready = !!(target.id || target.path.trim());
	const open = sessions.data?.filter((session) => session.state === "open" || session.state === "starting") ?? [];
	const names = new Map(projects.map((workspace) => [workspace.id, workspace.name]));

	async function start(text: string, selected = target) {
		if (inFlight.current || launch.busy) return;
		inFlight.current = true;
		setSending(true);
		setError(null);
		try {
			const session = await taskLaunch.current.start(selected, text);
			rememberedProject = { id: session.workspaceId, path: selected.path };
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void queries.invalidateQueries({ queryKey: ["workspaces"] });
			if (text.trim()) void queries.invalidateQueries({ queryKey: ["session", session.id] });
			else if (draft.trim()) draftStore(session.id).write(draft);
			starterDraft.clear();
			void navigate(`/sessions/${session.id}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause : new Error(String(cause)));
			requestAnimationFrame(() => field.current?.focus());
		} finally {
			inFlight.current = false;
			setSending(false);
		}
	}

	function choosePath(selected: string) {
		rememberedProject = { id: "path", path: selected };
		setPath(selected);
		setProjectId("path");
		setPathVisible(true);
		setBrowsing(false);
		setError(null);
		field.current?.focus();
	}

	return (
		<section className="home agent-home">
			<div className="agent-home__start">
				<div className="agent-home__heading">
					<p className="eyebrow">New conversation</p>
					<h1>What are we working on?</h1>
				</div>
				<form
					className="home-prompt"
					onSubmit={(event) => {
						event.preventDefault();
						if (draft.trim()) void start(draft);
					}}
				>
					<label className="sr-only" htmlFor={`${pathId}-message`}>
						Message Clio Coder
					</label>
					<textarea
						id={`${pathId}-message`}
						ref={field}
						value={draft}
						onChange={(event) => {
							setDraft(event.target.value);
							starterDraft.write(event.target.value);
							rememberedProject = { id: projectId ?? project?.id ?? null, path: target.path };
						}}
						placeholder="Describe a task, ask a question, or explore an idea…"
						rows={4}
						maxLength={32000}
						disabled={busy}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
								event.preventDefault();
								if (draft.trim() && ready && !busy) void start(draft);
							}
						}}
					/>
					<div className="home-prompt__toolbar">
						<div className="home-prompt__project">
							<Icon name="sessions" />
							<select
								aria-label="Project"
								value={projectId === "path" ? "path" : (project?.id ?? "")}
								disabled={busy}
								onChange={(event) => {
									rememberedProject = { id: event.target.value, path };
									setProjectId(event.target.value);
									setPathVisible(event.target.value === "path");
									setError(null);
								}}
							>
								<option value="">Choose a project</option>
								{projects.map((workspace) => (
									<option key={workspace.id} value={workspace.id}>
										{workspace.name}
									</option>
								))}
								<option value="path">Enter a path…</option>
							</select>
						</div>
						<button
							ref={browseButton}
							type="button"
							className="home-prompt__browse"
							disabled={busy}
							onClick={() => setBrowsing((current) => !current)}
							aria-expanded={browsing}
						>
							Browse folders
						</button>
						<button type="submit" className="home-prompt__send" aria-label="Send" disabled={busy || !ready || !draft.trim()}>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
								<path d="m6 12 6-6 6 6M12 6v12" />
							</svg>
						</button>
					</div>
					{pathVisible && (
						<div className="home-prompt__path">
							<label htmlFor={pathId}>Project folder</label>
							<input
								id={pathId}
								value={path}
								autoComplete="off"
								spellCheck={false}
								placeholder="/absolute/path/to/project"
								disabled={busy}
								onChange={(event) => {
									setPath(event.target.value);
									rememberedProject = { id: "path", path: event.target.value };
									setError(null);
								}}
							/>
						</div>
					)}
				</form>
				<div className="agent-home__hint">
					<span>
						{sending ? (
							"Starting your conversation…"
						) : target.path ? (
							<span title={target.path}>{target.path}</span>
						) : (
							"Choose a project folder to begin."
						)}
					</span>
					<button type="button" disabled={busy || !ready} onClick={() => void start("")}>
						Start conversation
					</button>
				</div>
				{error && (
					<div className="agent-home__error" role="alert">
						<p>{error.message}</p>
						{taskLaunch.current.session && (
							<Link
								to={`/sessions/${taskLaunch.current.session.id}`}
								onClick={() => {
									const session = taskLaunch.current.session;
									if (session) draftStore(session.id).write(draft);
									starterDraft.clear();
								}}
							>
								Open conversation to review its configuration
							</Link>
						)}
					</div>
				)}
				{browsing && (
					<WorkspaceBrowser
						client={client}
						initialPath={target.path}
						onChoose={choosePath}
						onStart={(selected) => {
							setBrowsing(false);
							void start("", { id: null, path: selected });
						}}
						onClose={() => {
							setBrowsing(false);
							browseButton.current?.focus();
						}}
					/>
				)}
			</div>
			<section className="home-recent" aria-labelledby="home-recent-title">
				<div className="home-recent__heading">
					<h2 id="home-recent-title">Recent work</h2>
					<Link to="/sessions">
						All conversations <span aria-hidden="true">→</span>
					</Link>
				</div>
				{sessions.isPending || workspaces.isPending ? <p className="home-recent__empty">Loading your work…</p> : null}
				{sessions.error || workspaces.error || launch.error ? (
					<p role="alert">{sessions.error?.message ?? workspaces.error?.message ?? launch.error?.message}</p>
				) : null}
				{open.length > 0 && (
					<ul className="home-recent__list">
						{open.slice(0, 6).map((session) => {
							const state = sessionState(session);
							return (
								<li key={session.id}>
									<Link to={`/sessions/${session.id}`}>
										<Icon name="sessions" />
										<span className="home-recent__text">
											<strong>{session.label ?? session.turns[0]?.prompt ?? "New conversation"}</strong>
											<span>{names.get(session.workspaceId) ?? "Project"}</span>
										</span>
										<StatusMark tone={state.tone} label={state.label} />
									</Link>
								</li>
							);
						})}
					</ul>
				)}
				{projects.length > 0 && (
					<div className="home-recent__projects">
						<span>Projects</span>
						{projects.slice(0, 5).map((workspace) => (
							<button
								key={workspace.id}
								type="button"
								title={workspace.path}
								disabled={busy}
								aria-label={`New conversation in ${workspace.name}`}
								onClick={() => launch.start(workspace.id)}
							>
								{workspace.name}
								<Icon name="plus" />
							</button>
						))}
					</div>
				)}
				{!sessions.isPending && !workspaces.isPending && !sessions.error && !workspaces.error && open.length === 0 && (
					<p className="home-recent__empty">
						Your conversations will appear here. Start with a task or open a conversation in your project.
					</p>
				)}
				{projects.length > 0 && (
					<span className="home-recent__time">Last project opened {formatTime(projects[0]?.openedAt ?? "")}</span>
				)}
			</section>
		</section>
	);
}
