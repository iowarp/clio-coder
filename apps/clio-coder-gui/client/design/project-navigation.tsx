import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot, Workspace } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import { useProjectLaunch } from "../pages/project-open.js";
import { Icon } from "./icons.js";
import "./project-navigation.css";

/** Reads the existing bounded project/history routes. Opening a saved chat is an explicit ACP action. */
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
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const selectedWorkspace = activeWorkspace ?? /^\/workspaces\/([^/]+)/.exec(location.pathname)?.[1];
	const [expanded, setExpanded] = useState<string | null | undefined>();
	useEffect(() => {
		if (selectedWorkspace) setExpanded(selectedWorkspace);
	}, [selectedWorkspace]);
	const projects = [...(workspaces.data ?? [])]
		.sort(
			(a, b) =>
				Number(b.id === selectedWorkspace) - Number(a.id === selectedWorkspace) || b.openedAt.localeCompare(a.openedAt),
		)
		.slice(0, 6);
	const open = expanded === undefined ? (selectedWorkspace ?? projects[0]?.id) : expanded;
	return (
		<section className="sidebar-projects" aria-label="Projects and conversations">
			<div className="sidebar-section-heading">
				<span>Projects</span>
				<Link to="/sessions" onClick={close}>
					All
				</Link>
			</div>
			{workspaces.isPending ? <p className="sidebar-note">Loading projects…</p> : null}
			{workspaces.error ? (
				<p className="sidebar-note" role="alert">
					Projects unavailable.{" "}
					<button type="button" onClick={() => void workspaces.refetch()}>
						Retry
					</button>
				</p>
			) : null}
			{sessions.error ? (
				<p className="sidebar-note" role="alert">
					Current conversations unavailable.
				</p>
			) : null}
			{!workspaces.isPending && !workspaces.error && !projects.length ? (
				<p className="sidebar-note">Choose a project to keep your conversations together.</p>
			) : null}
			{projects.map((project) => (
				<ProjectGroup
					key={project.id}
					client={client}
					project={project}
					sessions={sessions.data ?? []}
					expanded={open === project.id}
					expand={() => setExpanded(open === project.id ? null : project.id)}
					close={close}
				/>
			))}
		</section>
	);
}

function ProjectGroup({
	client,
	project,
	sessions,
	expanded,
	expand,
	close,
}: {
	client: Client;
	project: Workspace;
	sessions: readonly SessionSnapshot[];
	expanded: boolean;
	expand: () => void;
	close?: (() => void) | undefined;
}) {
	const navigate = useNavigate();
	const chatsId = useId();
	const queries = useQueryClient();
	const launch = useProjectLaunch(client);
	const history = useQuery({
		queryKey: ["session-history", project.id],
		queryFn: () => client.call(routes.sessionHistory, { params: { id: project.id }, query: {}, body: {} }),
		enabled: expanded,
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
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			close?.();
			void navigate(`/sessions/${session.id}`);
		},
	});
	const active = sessions.filter(
		(session) => session.workspaceId === project.id && ["open", "starting"].includes(session.state),
	);
	const rows = [
		...active.map((session) => ({
			id: session.id,
			title: session.label ?? session.turns[0]?.prompt ?? "New conversation",
			active: true,
			working: session.turns.at(-1)?.status === "running",
		})),
		...(history.data ?? [])
			.filter((row) => !active.some((session) => session.id === row.id))
			.map((row) => ({
				id: row.id,
				title: row.name ?? row.firstMessagePreview ?? "Saved conversation",
				active: false,
				working: false,
			})),
	].slice(0, 4);
	return (
		<div className="sidebar-project" data-open={expanded}>
			<div className="sidebar-project-heading">
				<button
					type="button"
					onClick={expand}
					aria-expanded={expanded}
					aria-controls={expanded ? chatsId : undefined}
					title={project.path}
				>
					<Icon name="folder" />
					<span>{project.name}</span>
					<Icon name={expanded ? "chevronDown" : "chevronRight"} />
				</button>
				<button
					type="button"
					className="sidebar-new-chat"
					aria-label={`New conversation in ${project.name}`}
					disabled={launch.busy}
					onClick={() => launch.start(project.id)}
				>
					<Icon name="plus" />
				</button>
			</div>
			{expanded ? (
				<div className="sidebar-conversations" id={chatsId}>
					{rows.map((row) =>
						row.active ? (
							<NavLink
								key={row.id}
								to={`/sessions/${row.id}`}
								onClick={close}
								title={row.title}
								className="sidebar-conversation"
							>
								<span className="sidebar-chat-dot" data-working={row.working} aria-hidden="true" />
								<span>{row.title}</span>
								{row.working ? <span className="sr-only">Working</span> : null}
							</NavLink>
						) : (
							<button
								key={row.id}
								type="button"
								className="sidebar-conversation"
								title={row.title}
								disabled={resume.isPending}
								onClick={() => resume.mutate(row.id)}
							>
								<span className="sidebar-chat-dot" aria-hidden="true" />
								<span>{resume.isPending && resume.variables === row.id ? "Opening…" : row.title}</span>
							</button>
						),
					)}
					{!rows.length ? (
						<p className="sidebar-note">
							{history.isPending ? "Loading conversations…" : history.error ? "History unavailable." : "No conversations yet."}
						</p>
					) : null}
					{rows.length && history.error ? (
						<p className="sidebar-note" role="alert">
							Saved history unavailable.
						</p>
					) : null}
					<Link className="sidebar-all-chats" to={`/workspaces/${project.id}/sessions`} onClick={close}>
						View conversations <span aria-hidden="true">→</span>
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
