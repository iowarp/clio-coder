import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot, Workspace } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { sessionBuffer } from "../api/sessions.js";
import { useProjectLaunch } from "../pages/project-open.js";
import { Icon } from "./icons.js";
import "./project-navigation.css";

const PROJECT_PAGE = 8;
const CONVERSATION_PAGE = 10;

/** Mounted on Sessions routes. Only expanded projects read their canonical saved history. */
export function ProjectNavigation({
	client,
	activeWorkspace,
	close,
}: {
	client: Client;
	activeWorkspace?: string | undefined;
	close?: (() => void) | undefined;
}) {
	const location = useLocation();
	const launch = useProjectLaunch(client);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const selectedSession = /^\/sessions\/([^/]+)$/.exec(location.pathname)?.[1];
	const selectedWorkspace =
		activeWorkspace ??
		/^\/workspaces\/([^/]+)/.exec(location.pathname)?.[1] ??
		sessions.data?.find((session) => session.id === selectedSession)?.workspaceId;
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [search, setSearch] = useState("");
	const [visibleProjects, setVisibleProjects] = useState(PROJECT_PAGE);
	const searchId = useId();
	useEffect(() => {
		if (selectedWorkspace) setExpanded((current) => ({ ...current, [selectedWorkspace]: true }));
	}, [selectedWorkspace]);
	const projects = [...(workspaces.data ?? [])].sort(
		(a, b) =>
			Number(b.id === selectedWorkspace) - Number(a.id === selectedWorkspace) || b.openedAt.localeCompare(a.openedAt),
	);
	const selected = projects.find((project) => project.id === selectedWorkspace);
	const query = search.trim().toLocaleLowerCase();
	const matching = projects.filter(
		(project) => project.id === selectedWorkspace || project.name.toLocaleLowerCase().includes(query),
	);
	const defaultExpanded = selectedWorkspace ?? projects[0]?.id;
	return (
		<section className="sidebar-projects" aria-label="Projects and conversations">
			<div className="sidebar-projects__toolbar">
				{selected ? (
					<button
						type="button"
						className="sidebar-projects__compose"
						disabled={launch.busy}
						title={`New conversation in ${selected.name}`}
						onClick={() => launch.start(selected.id)}
					>
						<Icon name="plus" />
						{launch.busy ? "Starting conversation…" : "New conversation"}
					</button>
				) : (
					<Link
						className="sidebar-projects__compose"
						to="/sessions"
						onClick={() => {
							close?.();
							requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#main .project-open input")?.focus());
						}}
					>
						<Icon name="plus" />
						New conversation
					</Link>
				)}
				<label className="sr-only" htmlFor={searchId}>
					Filter project names
				</label>
				<div className="sidebar-projects__search">
					<Icon name="search" />
					<input
						id={searchId}
						type="search"
						placeholder="Filter projects"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setVisibleProjects(PROJECT_PAGE);
						}}
					/>
				</div>
				<div className="sidebar-section-heading">
					<span>Projects</span>
					<Link to="/sessions" onClick={close}>
						Manage projects
					</Link>
				</div>
				{launch.error ? (
					<p className="sidebar-note" role="alert">
						{launch.error.message}
					</p>
				) : null}
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll the project list independently. */}
			<section className="sidebar-projects__list" tabIndex={0} aria-label="Project conversations">
				{workspaces.isPending ? (
					<p className="sidebar-note" role="status">
						Loading projects…
					</p>
				) : null}
				{workspaces.error ? (
					<p className="sidebar-note" role="alert">
						{workspaces.data ? "Project list could not refresh." : "Projects unavailable."}{" "}
						<button type="button" disabled={workspaces.isFetching} onClick={() => void workspaces.refetch()}>
							Retry
						</button>
					</p>
				) : null}
				{sessions.isPending ? (
					<p className="sidebar-note" role="status">
						Loading open conversations…
					</p>
				) : null}
				{sessions.error ? (
					<p className="sidebar-note" role="alert">
						{sessions.data ? "Open conversations could not refresh." : "Open conversations unavailable."}{" "}
						<button type="button" disabled={sessions.isFetching} onClick={() => void sessions.refetch()}>
							Retry
						</button>
					</p>
				) : null}
				{!workspaces.isPending && !workspaces.error && !projects.length ? (
					<p className="sidebar-note">Choose a project folder to start a conversation.</p>
				) : null}
				{projects.length > 0 && matching.length === 0 ? <p className="sidebar-note">No project names match.</p> : null}
				{matching.slice(0, visibleProjects).map((project) => {
					const open = expanded[project.id] ?? project.id === defaultExpanded;
					return (
						<ProjectGroup
							key={project.id}
							client={client}
							project={project}
							sessions={sessions.data ?? []}
							selectedSession={selectedSession}
							current={project.id === selectedWorkspace}
							expanded={open}
							expand={() => setExpanded((previous) => ({ ...previous, [project.id]: !open }))}
							close={close}
						/>
					);
				})}
				{matching.length > visibleProjects ? (
					<button
						className="sidebar-show-more"
						type="button"
						onClick={() => setVisibleProjects((count) => count + PROJECT_PAGE)}
					>
						Show more projects <span>{matching.length - visibleProjects} remaining</span>
					</button>
				) : null}
			</section>
		</section>
	);
}

function ProjectGroup({
	client,
	project,
	sessions,
	selectedSession,
	current,
	expanded,
	expand,
	close,
}: {
	client: Client;
	project: Workspace;
	sessions: readonly SessionSnapshot[];
	selectedSession: string | undefined;
	current: boolean;
	expanded: boolean;
	expand: () => void;
	close?: (() => void) | undefined;
}) {
	const navigate = useNavigate();
	const chatsId = useId();
	const queries = useQueryClient();
	const launch = useProjectLaunch(client);
	const [visibleCount, setVisibleCount] = useState(CONVERSATION_PAGE);
	const history = useQuery({
		queryKey: ["session-history", project.id],
		queryFn: () => client.call(routes.sessionHistory, { params: { id: project.id }, query: {}, body: {} }),
		enabled: expanded,
		retry: false,
	});
	const resume = useMutation({
		mutationFn: (id: string) =>
			client.call(routes.loadSession, { params: { id }, query: {}, body: { workspaceId: project.id } }),
		onSuccess: (session) => {
			for (const key of [
				"session-capabilities",
				"session-commands",
				"session-queue",
				"session-settings",
				"session-targets",
				"session-autonomy",
			])
				queries.removeQueries({ queryKey: [key, session.id] });
			queries.setQueryData(["session", session.id], sessionBuffer(session.id).snapshot(session) ?? session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			close?.();
			void navigate(`/sessions/${session.id}`);
		},
	});
	const active = sessions.filter(
		(session) => session.workspaceId === project.id && ["open", "starting"].includes(session.state),
	);
	const activeIds = new Set(active.map((session) => session.id));
	const savedById = new Map((history.data ?? []).map((row) => [row.id, row]));
	const rows = [
		...active.map((session) => {
			const turn = session.turns.at(-1);
			const saved = savedById.get(session.id);
			return {
				id: session.id,
				title: session.label ?? session.turns[0]?.prompt ?? saved?.name ?? "New conversation",
				active: true,
				working: turn?.status === "running",
				starting: session.state === "starting",
				activity: turn?.finishedAt ?? turn?.startedAt ?? saved?.lastActivityAt ?? saved?.createdAt,
			};
		}),
		...(history.data ?? [])
			.filter((row) => !activeIds.has(row.id))
			.map((row) => ({
				id: row.id,
				title: row.name ?? row.firstMessagePreview ?? "Saved conversation",
				active: false,
				working: false,
				starting: false,
				activity: row.lastActivityAt ?? row.createdAt,
			})),
	].sort((a, b) => {
		const time = (value: string | undefined) => {
			const parsed = value ? Date.parse(value) : Number.NaN;
			return Number.isFinite(parsed) ? parsed : 0;
		};
		return time(b.activity) - time(a.activity) || a.id.localeCompare(b.id);
	});
	// Keep an older selected conversation visible without changing chronological order.
	const limit = Math.max(visibleCount, rows.findIndex((row) => row.id === selectedSession) + 1);
	return (
		<div className="sidebar-project" data-open={expanded} data-current={current}>
			<div className="sidebar-project-heading">
				<button
					type="button"
					onClick={expand}
					aria-expanded={expanded}
					aria-controls={expanded ? chatsId : undefined}
					title={project.path}
				>
					<Icon name={expanded ? "chevronDown" : "chevronRight"} />
					<Icon name="folder" />
					<span>{project.name}</span>
					{current ? (
						<span className="sidebar-project-current" aria-hidden="true">
							Current
						</span>
					) : null}
					{current ? <span className="sr-only">Current project</span> : null}
				</button>
				<button
					type="button"
					className="sidebar-new-chat"
					aria-label={`New conversation in ${project.name}`}
					title={`New conversation in ${project.name}`}
					disabled={launch.busy || resume.isPending}
					onClick={() => launch.start(project.id)}
				>
					<Icon name="plus" />
				</button>
			</div>
			{expanded ? (
				<div className="sidebar-conversations" id={chatsId}>
					{history.isFetching ? (
						<p className="sidebar-note" role="status">
							{history.data ? "Refreshing history…" : "Loading saved conversations…"}
						</p>
					) : null}
					{history.error ? (
						<p className="sidebar-note" role="alert">
							{history.data ? "Saved history could not refresh." : "Saved history unavailable."}{" "}
							<button type="button" disabled={history.isFetching} onClick={() => void history.refetch()}>
								Retry
							</button>
						</p>
					) : null}
					{rows.slice(0, limit).map((row) => {
						const title = `${row.title}${row.activity ? ` · ${formatTime(row.activity)}` : ""}${row.starting ? " · Starting" : row.working ? " · Working" : ""}`;
						const contents = (
							<>
								<span className="sidebar-chat-dot" data-working={row.working || row.starting} aria-hidden="true" />
								<span>{resume.isPending && resume.variables === row.id ? "Opening…" : row.title}</span>
								{row.working || row.starting ? <span className="sr-only">{row.starting ? "Starting" : "Working"}</span> : null}
							</>
						);
						return row.active ? (
							<NavLink key={row.id} to={`/sessions/${row.id}`} onClick={close} title={title} className="sidebar-conversation">
								{contents}
							</NavLink>
						) : (
							<button
								key={row.id}
								type="button"
								className="sidebar-conversation"
								aria-current={row.id === selectedSession ? "page" : undefined}
								title={title}
								disabled={resume.isPending || launch.busy}
								onClick={() => resume.mutate(row.id)}
							>
								{contents}
							</button>
						);
					})}
					{!rows.length && !history.isPending && !history.error ? (
						<p className="sidebar-note">No conversations yet.</p>
					) : null}
					{rows.length > limit ? (
						<button className="sidebar-show-more" type="button" onClick={() => setVisibleCount(limit + CONVERSATION_PAGE)}>
							Show more conversations <span>{rows.length - limit} remaining</span>
						</button>
					) : null}
					<Link className="sidebar-all-chats" to={`/workspaces/${project.id}/sessions`} onClick={close}>
						Project conversations <span aria-hidden="true">→</span>
					</Link>
				</div>
			) : null}
			{resume.error || launch.error ? (
				<p className="sidebar-note" role="alert">
					{resume.error?.message ?? launch.error?.message}
				</p>
			) : null}
		</div>
	);
}
