import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { InventoryMore } from "../interaction/InventoryMore.js";
import { useInventoryWindow } from "../interaction/use-inventory-window.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { HomeAside } from "../shell/HomeAside.js";
import { STATE_LABELS, shortAge, type TaskRow, taskRows } from "../shell/shell-model.js";
import { TopBar } from "../shell/TopBar.js";
import { useMinuteClock, useSessionOverview, useTaskActions } from "../shell/tasks.js";
import { PROJECT_TASK_FILTERS, PROJECT_TASK_SORTS, projectTaskInventory } from "./project-tasks-model.js";
import { DeleteSession } from "./session-controls.js";
import "./tasks.css";

const FILTER_NAMES = { all: "All work", open: "Open sessions", attention: "Needs you", saved: "Saved history" };
function Glyph({ state }: { state: TaskRow["state"] }) {
	if (state === "working" || state === "starting") return <ClioPulse size={PULSE_SIZE.row} />;
	if (state === "approval" || state === "question" || state === "unknown")
		return <span className="wb-dot wb-dot--approval" aria-hidden="true" />;
	if (state === "failed") return <span className="wb-dot wb-dot--failed" aria-hidden="true" />;
	return <Icon name="sessions" />;
}

export function Sessions({ client }: { client: Client }) {
	const { workspaceId = "" } = useParams();
	const [search, setSearch] = useSearchParams();
	const now = useMinuteClock();
	const actions = useTaskActions(client);
	const query = search.get("q") ?? "";
	const deferredQuery = useDeferredValue(query);
	const filter = PROJECT_TASK_FILTERS.find((item) => item === search.get("status")) ?? "all";
	const sort = PROJECT_TASK_SORTS.find((item) => item === search.get("sort")) ?? "recent";
	const page = useInventoryWindow(JSON.stringify([workspaceId, deferredQuery, filter, sort]));
	const list = useRef<HTMLUListElement>(null);
	const set = (key: string, value: string) =>
		setSearch(
			(previous) => {
				const next = new URLSearchParams(previous);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true },
		);
	const input = { params: { id: workspaceId }, query: {}, body: {} };
	const workspace = useQuery({
		queryKey: ["workspace", workspaceId],
		queryFn: ({ signal }) => client.call(routes.workspace, input, undefined, signal),
		meta: { errorSurface: "inline" },
	});
	const history = useQuery({
		queryKey: ["session-history", workspaceId],
		queryFn: ({ signal }) => client.call(routes.sessionHistory, input, undefined, signal),
		retry: false,
		meta: { errorSurface: "inline" },
	});
	const overview = useSessionOverview(client);
	const rows = useMemo(
		() => taskRows(workspaceId, overview.data?.sessions ?? [], history.data ?? []),
		[workspaceId, overview.data, history.data],
	);
	const inventory = useMemo(
		() => projectTaskInventory(rows, history.data ?? [], overview.data?.sessions ?? [], deferredQuery, filter, sort),
		[rows, history.data, overview.data, deferredQuery, filter, sort],
	);
	const saved = useMemo(() => new Map((history.data ?? []).map((row) => [row.id, row])), [history.data]);
	const held = useMemo(() => new Map((overview.data?.sessions ?? []).map((row) => [row.id, row])), [overview.data]);
	const unsupported = history.error instanceof ApiProblem && history.error.problem.code === "unsupported";
	const name = workspace.data?.name ?? "Project";
	const loading = overview.isPending || history.isPending;
	const refreshing = workspace.isFetching || overview.isFetching || history.isFetching;
	return (
		<>
			<HomeAside client={client} workspace={workspace.data ?? null} />
			<TopBar title={name}>
				<span className="wb-bar__spacer" />
				<Link className="wb-icon wb-icon--text" to={`/settings/models?workspace=${workspaceId}`}>
					<Icon name="models" />
					<span>Project settings</span>
				</Link>
				<button
					type="button"
					className="wb-icon wb-icon--text"
					disabled={refreshing}
					onClick={() => {
						void workspace.refetch();
						void overview.refetch();
						void history.refetch();
					}}
				>
					<Icon name="clock" />
					<span>{refreshing ? "Updating…" : "Refresh"}</span>
				</button>
				<button
					type="button"
					className="primary"
					disabled={!workspace.data || actions.launch.busy}
					onClick={() => actions.newTask(workspaceId)}
				>
					<Icon name="compose" />
					New task
				</button>
			</TopBar>
			<div className="taskpage">
				<div className="taskpage__inner">
					<header className="taskpage__heading">
						<p className="eyebrow">Project workspace</p>
						<h1>
							Your work in <em>{name}.</em>
						</h1>
						<p className="taskpage__path">
							<Icon name="folder" />
							{workspace.data?.path ?? "Reading project folder…"}
						</p>
					</header>
					{workspace.error ? (
						<div className="taskpage__notice" role="alert">
							<strong>This workspace could not be loaded.</strong>
							<p>{workspace.error.message}</p>
							<button type="button" onClick={() => void workspace.refetch()}>
								Retry workspace
							</button>
						</div>
					) : null}
					{history.error ? (
						<div className="taskpage__notice" role={unsupported ? "status" : "alert"}>
							<strong>
								{unsupported ? "Saved history is unavailable with this runtime" : "Saved history could not be refreshed"}
							</strong>
							<p>
								{unsupported
									? "You can still open and manage the sessions held by this server. Saved conversations may exist in the project’s history."
									: history.error.message}
							</p>
							{!unsupported ? (
								<button type="button" disabled={history.isFetching} onClick={() => void history.refetch()}>
									Retry history
								</button>
							) : null}
						</div>
					) : null}
					{overview.error || actions.error ? <p role="alert">{overview.error?.message ?? actions.error?.message}</p> : null}
					<div className="taskpage__toolbar">
						<label className="taskpage__search">
							<Icon name="search" />
							<span className="sr-only">Find a task</span>
							<input
								type="search"
								value={query}
								maxLength={256}
								onChange={(event) => set("q", event.target.value)}
								placeholder="Search tasks, models or connections…"
							/>
						</label>
						<label>
							<span className="sr-only">Sort tasks</span>
							<select
								value={sort}
								onChange={(event) => set("sort", event.target.value === "recent" ? "" : event.target.value)}
							>
								<option value="recent">Newest activity</option>
								<option value="oldest">Oldest activity</option>
								<option value="name">Name A–Z</option>
							</select>
						</label>
					</div>
					<nav className="taskpage__filters" aria-label="Project task activity">
						{PROJECT_TASK_FILTERS.map((item) => (
							<button
								type="button"
								key={item}
								aria-pressed={filter === item}
								onClick={() => set("status", item === "all" ? "" : item)}
							>
								{FILTER_NAMES[item]}
								<span>{item === "saved" && !history.data ? "—" : inventory.counts[item]}</span>
							</button>
						))}
					</nav>
					{loading ? (
						<p className="taskpage__note" role="status">
							Reading this project's work…
						</p>
					) : null}
					{inventory.shown.length ? (
						<ul className="taskpage__list" ref={list} aria-busy={query !== deferredQuery}>
							{inventory.shown.slice(0, page.limit).map((row) => {
								const summary = saved.get(row.id);
								const session = held.get(row.id);
								const meta = [
									session?.model ?? summary?.model,
									summary?.messageCount == null ? null : `${summary.messageCount.toLocaleString()} messages`,
									STATE_LABELS[row.state] || (row.open ? "Ready to continue" : "Saved conversation"),
								].filter(Boolean);
								const body = (
									<>
										<span className="taskpage__glyph">
											<Glyph state={row.state} />
										</span>
										<span className="taskpage__text">
											<strong>{actions.resuming === row.id ? "Opening…" : row.title}</strong>
											<small>{meta.join(" · ")}</small>
										</span>
										<time
											className="taskpage__age"
											dateTime={row.at || undefined}
											title={row.at ? formatTime(row.at) : undefined}
										>
											{shortAge(row.at, now)}
										</time>
										<Icon name="chevronRight" />
									</>
								);
								return (
									<li key={row.id} className="taskpage__row">
										{row.open ? (
											<Link to={`/sessions/${row.id}`} className="taskpage__main">
												{body}
											</Link>
										) : (
											<button
												type="button"
												className="taskpage__main"
												disabled={actions.resuming !== null || actions.launch.busy}
												onClick={() => actions.resume(row.id, row.workspaceId)}
												title="Resume this saved task"
											>
												{body}
											</button>
										)}
										{!row.open && summary?.endedAt ? (
											<DeleteSession client={client} id={row.id} workspaceId={workspaceId} name={row.title} />
										) : null}
									</li>
								);
							})}
						</ul>
					) : !loading ? (
						<div className="taskpage__empty">
							<Icon name="sessions" />
							<h2>
								{query || filter !== "all"
									? "No tasks match this view"
									: unsupported
										? "No open sessions here"
										: "Your next discovery starts here"}
							</h2>
							<p>
								{query || filter !== "all"
									? "Try another search or activity filter."
									: "Describe a task to start working in this project."}
							</p>
							{query || filter !== "all" ? (
								<button type="button" onClick={() => setSearch({})}>
									Clear filters
								</button>
							) : (
								<button
									type="button"
									className="primary"
									disabled={!workspace.data}
									onClick={() => actions.newTask(workspaceId)}
								>
									Start a task
									<Icon name="plus" />
								</button>
							)}
						</div>
					) : null}
					{!loading ? (
						<InventoryMore total={inventory.shown.length} limit={page.limit} label="tasks" list={list} onMore={page.more} />
					) : null}
					<footer className="taskpage__scope">
						<Link to="/sessions">All sessions</Link>
						<span>·</span>
						<Link to={`/machines?workspace=${workspaceId}`}>Project machines</Link>
						<span>·</span>
						<span>Open sessions and saved history are shown together when available.</span>
					</footer>
				</div>
			</div>
		</>
	);
}
