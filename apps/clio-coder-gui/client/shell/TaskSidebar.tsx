import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot, Workspace } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import type { ConnectionState } from "../api/events.js";
import { Icon } from "../design/icons.js";
import { countRender } from "../render/render-probe.js";
import { ClioLogo, ClioPulse, PULSE_SIZE } from "./ClioMark.js";
import { chordHint } from "./chords.js";
import { InlineRename } from "./InlineRename.js";
import { Menu, MenuItem } from "./Menu.js";
import { STATE_LABELS, sessionIdFromPath, shortAge, type TaskRow, taskRows } from "./shell-model.js";
import { type TaskActions, useDeleteTask, useMinuteClock, useRenameTask } from "./tasks.js";

const TASKS_PER_PROJECT = 6;
const PROJECTS_SHOWN = 10;
export function TaskSidebar({
	client,
	actions,
	connection,
	activeWorkspaceId,
	onOpenWorkspace,
	onSearch,
	onToggle,
	onNavigate,
}: {
	client: Client;
	actions: TaskActions;
	connection: ConnectionState;
	activeWorkspaceId: string | null;
	onOpenWorkspace: () => void;
	onSearch: () => void;
	onToggle: () => void;
	/** Called after any navigation so a mobile drawer can close itself. */
	onNavigate: () => void;
}) {
	countRender("task-sidebar");
	const location = useLocation();
	const now = useMinuteClock();
	const [shown, setShown] = useState(PROJECTS_SHOWN);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const activeTask = sessionIdFromPath(location.pathname);
	const ordered = useMemo(
		() =>
			[...(workspaces.data ?? [])].sort(
				(a, b) =>
					Number(b.id === activeWorkspaceId) - Number(a.id === activeWorkspaceId) || b.openedAt.localeCompare(a.openedAt),
			),
		[workspaces.data, activeWorkspaceId],
	);
	const status =
		connection === "Connected"
			? { tone: "ok", label: "Connected" }
			: connection === "Reconnecting…"
				? { tone: "warn", label: "Reconnecting" }
				: { tone: "off", label: connection === "Connecting…" ? "Connecting" : "Offline" };
	return (
		<div className="wb-side">
			<div className="wb-side__top">
				<Link className="wb-brand" to="/" onClick={onNavigate} aria-label="Clio Coder home">
					<ClioLogo size={22} />
					<span>Clio Coder</span>
				</Link>
				<button
					type="button"
					className="wb-icon"
					onClick={onToggle}
					aria-label="Collapse sidebar"
					title={`Collapse sidebar (${chordHint("sidebar")})`}
				>
					<Icon name="sidebar" />
				</button>
			</div>

			<nav className="wb-side__actions" aria-label="Start">
				<button
					type="button"
					className="wb-action wb-action--primary"
					disabled={!activeWorkspaceId || actions.launch.busy}
					onClick={() => activeWorkspaceId && actions.newTask(activeWorkspaceId)}
					title={activeWorkspaceId ? "Start a new task in the current project" : "Open a project first"}
				>
					{actions.launch.busy ? <ClioPulse size={PULSE_SIZE.row} /> : <Icon name="compose" />}
					<span>{actions.launch.busy ? "Starting…" : "New task"}</span>
					<kbd>{chordHint("newTask")}</kbd>
				</button>
				<button type="button" className="wb-action" onClick={onOpenWorkspace}>
					<Icon name="folderOpen" />
					<span>Open workspace</span>
					<kbd>{chordHint("openWorkspace")}</kbd>
				</button>
				<NavLink to="/skills" className="wb-action" onClick={onNavigate}>
					<Icon name="skills" />
					<span>Skills</span>
				</NavLink>
			</nav>

			<div className="wb-side__heading">
				<h2>Tasks</h2>
				<button
					type="button"
					className="wb-icon wb-icon--small"
					aria-label="Search tasks and commands"
					title={`Search tasks and commands (${chordHint("palette")})`}
					onClick={onSearch}
				>
					<Icon name="search" />
				</button>
			</div>

			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the task list independently. */}
			<section className="wb-side__tasks" tabIndex={0} aria-label="Tasks by project">
				{workspaces.isPending ? <p className="wb-note">Loading projects…</p> : null}
				{workspaces.error ? (
					<p className="wb-note" role="alert">
						Projects unavailable.{" "}
						<button type="button" className="wb-link" onClick={() => void workspaces.refetch()}>
							Retry
						</button>
					</p>
				) : null}
				{!workspaces.isPending && !workspaces.error && ordered.length === 0 ? (
					<p className="wb-note">Open a workspace to start your first task.</p>
				) : null}
				{ordered.slice(0, shown).map((workspace) => (
					<ProjectGroup
						key={workspace.id}
						client={client}
						workspace={workspace}
						sessions={sessions.data ?? []}
						current={workspace.id === activeWorkspaceId}
						activeTask={activeTask}
						actions={actions}
						now={now}
						onNavigate={onNavigate}
					/>
				))}
				{ordered.length > shown ? (
					<button type="button" className="wb-more" onClick={() => setShown((count) => count + PROJECTS_SHOWN)}>
						Show {ordered.length - shown} more projects
					</button>
				) : null}
			</section>

			<div className="wb-side__foot">
				<span className="wb-me" aria-hidden="true">
					<ClioLogo size={18} />
				</span>
				<span className="wb-side__who">
					<strong>Clio Coder</strong>
					<span className="wb-status" role="status" data-tone={status.tone}>
						<span className="wb-status__dot" aria-hidden="true" />
						{status.label}
					</span>
				</span>
				<NavLink to="/settings/general" className="wb-icon" aria-label="Settings" title="Settings" onClick={onNavigate}>
					<Icon name="gear" />
				</NavLink>
			</div>
		</div>
	);
}

function ProjectGroup({
	client,
	workspace,
	sessions,
	current,
	activeTask,
	actions,
	now,
	onNavigate,
}: {
	client: Client;
	workspace: Workspace;
	sessions: readonly SessionSnapshot[];
	current: boolean;
	activeTask: string | null;
	actions: TaskActions;
	now: number;
	onNavigate: () => void;
}) {
	const listId = useId();
	const [open, setOpen] = useState<boolean | null>(null);
	const [limit, setLimit] = useState(TASKS_PER_PROJECT);
	const expanded = open ?? current;
	const hasLive = sessions.some((session) => session.workspaceId === workspace.id);
	// A project the operator never opened still lists its saved tasks once it is expanded or searched.
	const history = useQuery({
		queryKey: ["session-history", workspace.id],
		queryFn: () => client.call(routes.sessionHistory, { params: { id: workspace.id }, query: {}, body: {} }),
		enabled: expanded || hasLive,
		retry: false,
	});
	const rows = useMemo(
		() => taskRows(workspace.id, sessions, history.data ?? []),
		[workspace.id, sessions, history.data],
	);
	// Keep the selected task visible even when it is older than the page of rows shown.
	const visible = Math.max(limit, rows.findIndex((row) => row.id === activeTask) + 1);
	useEffect(() => {
		if (current) setOpen((value) => value ?? true);
	}, [current]);
	const showing = expanded;
	return (
		<section className="wb-project" data-current={current}>
			<div className="wb-project__head">
				<button
					type="button"
					className="wb-project__toggle"
					aria-expanded={showing}
					aria-controls={listId}
					onClick={() => setOpen(!showing)}
					title={workspace.path}
				>
					<Icon name={showing ? "folderOpen" : "folder"} />
					<span>{workspace.name}</span>
				</button>
				<button
					type="button"
					className="wb-icon wb-icon--small wb-project__new"
					aria-label={`New task in ${workspace.name}`}
					title={`New task in ${workspace.name}`}
					disabled={actions.launch.busy}
					onClick={() => actions.newTask(workspace.id)}
				>
					<Icon name="plus" />
				</button>
			</div>
			{showing ? (
				<ul className="wb-tasks" id={listId}>
					{rows.slice(0, visible).map((row) => (
						<li key={row.id}>
							<TaskItem
								client={client}
								row={row}
								selected={row.id === activeTask}
								actions={actions}
								now={now}
								onNavigate={onNavigate}
							/>
						</li>
					))}
					{history.isPending && history.fetchStatus !== "idle" && rows.length === 0 ? (
						<li className="wb-note">Loading…</li>
					) : null}
					{!history.isPending && rows.length === 0 ? <li className="wb-note">No tasks yet.</li> : null}
					{rows.length > visible ? (
						<li>
							<button type="button" className="wb-more" onClick={() => setLimit(visible + TASKS_PER_PROJECT)}>
								Show {rows.length - visible} more
							</button>
						</li>
					) : null}
				</ul>
			) : null}
		</section>
	);
}

function TaskItem({
	client,
	row,
	selected,
	actions,
	now,
	onNavigate,
}: {
	client: Client;
	row: TaskRow;
	selected: boolean;
	actions: TaskActions;
	now: number;
	onNavigate: () => void;
}) {
	const rename = useRenameTask(client);
	const remove = useDeleteTask(client);
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const age = shortAge(row.at, now);
	const label = STATE_LABELS[row.state];
	const busy = actions.resuming === row.id || actions.closing === row.id;
	const glyph =
		row.state === "working" || row.state === "starting" || actions.resuming === row.id ? (
			<ClioPulse size={PULSE_SIZE.row} />
		) : row.state === "approval" ? (
			<span className="wb-dot wb-dot--approval" aria-hidden="true" />
		) : row.state === "failed" ? (
			<span className="wb-dot wb-dot--failed" aria-hidden="true" />
		) : null;
	const body = (
		<>
			<span className="wb-task__glyph">{glyph}</span>
			<span className="wb-task__title">{actions.resuming === row.id ? "Opening…" : row.title}</span>
			{label ? <span className="sr-only">{label}</span> : null}
			{age ? <span className="wb-task__age">{age}</span> : null}
		</>
	);
	const title = `${row.title}${label ? ` · ${label}` : ""}`;
	const working = row.state === "working" || row.state === "starting";
	if (confirming)
		return (
			<div className="wb-task" data-selected={selected} data-state={row.state}>
				<fieldset className="wb-task__confirm">
					<legend className="sr-only">Delete {row.title}</legend>
					<span>Delete for good?</span>
					<button
						type="button"
						className="wb-task__delete"
						disabled={remove.isPending}
						onClick={() =>
							remove.mutate({ sessionId: row.id, workspaceId: row.workspaceId }, { onSettled: () => setConfirming(false) })
						}
					>
						{remove.isPending ? "Deleting…" : "Delete"}
					</button>
					<button
						type="button"
						onClick={() => setConfirming(false)}
						// biome-ignore lint/a11y/noAutofocus: the operator just asked to delete; the safe answer takes focus.
						autoFocus
					>
						Keep
					</button>
				</fieldset>
			</div>
		);
	return (
		<div className="wb-task" data-selected={selected} data-state={row.state} data-editing={editing}>
			{editing ? (
				<div className="wb-task__main">
					<span className="wb-task__glyph">{glyph}</span>
					<InlineRename
						value={row.title}
						label={`Rename ${row.title}`}
						onCancel={() => setEditing(false)}
						onCommit={(next) => {
							setEditing(false);
							rename.mutate({ sessionId: row.id, workspaceId: row.workspaceId, label: next });
						}}
					/>
				</div>
			) : row.open ? (
				<NavLink to={`/sessions/${row.id}`} className="wb-task__main" title={title} onClick={onNavigate}>
					{body}
				</NavLink>
			) : (
				<button
					type="button"
					className="wb-task__main"
					title={`${title} · Load this saved task`}
					disabled={busy || actions.launch.busy}
					onClick={() => actions.resume(row.id, row.workspaceId)}
				>
					{body}
				</button>
			)}
			{editing ? null : (
				<div className="wb-task__menu">
					<Menu label={`Actions for ${row.title}`} float>
						<MenuItem icon="pencil" disabled={busy} onClick={() => setEditing(true)}>
							Rename
						</MenuItem>
						{row.open ? (
							<MenuItem icon="close" disabled={busy || working} onClick={() => actions.close(row.id)}>
								Close task
							</MenuItem>
						) : (
							<MenuItem icon="trash" tone="danger" disabled={busy} onClick={() => setConfirming(true)}>
								Delete…
							</MenuItem>
						)}
					</Menu>
				</div>
			)}
		</div>
	);
}
