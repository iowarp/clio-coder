import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { HomeAside } from "../shell/HomeAside.js";
import { STATE_LABELS, shortAge, type TaskRow, taskRows } from "../shell/shell-model.js";
import { TopBar } from "../shell/TopBar.js";
import { useMinuteClock, useTaskActions } from "../shell/tasks.js";
import { DeleteSession } from "./session-controls.js";
import "./tasks.css";

function Glyph({ state }: { state: TaskRow["state"] }) {
	if (state === "working" || state === "starting") return <ClioPulse size={PULSE_SIZE.row} />;
	if (state === "approval") return <span className="wb-dot wb-dot--approval" aria-hidden="true" />;
	if (state === "failed") return <span className="wb-dot wb-dot--failed" aria-hidden="true" />;
	return null;
}

/** Every task in one project: the ones open now and the ones saved on disk, newest first. */
export function Sessions({ client }: { client: Client }) {
	const { workspaceId = "" } = useParams();
	const searchId = useId();
	const now = useMinuteClock();
	const actions = useTaskActions(client);
	const [search, setSearch] = useState("");
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
	const rows = useMemo(
		() => taskRows(workspaceId, sessions.data ?? [], history.data ?? []),
		[workspaceId, sessions.data, history.data],
	);
	const saved = useMemo(() => new Map((history.data ?? []).map((row) => [row.id, row])), [history.data]);
	const needle = search.trim().toLocaleLowerCase();
	const shown = needle
		? rows.filter((row) => {
				const summary = saved.get(row.id);
				return [row.title, summary?.model, summary?.target, summary?.firstMessagePreview].some((value) =>
					value?.toLocaleLowerCase().includes(needle),
				);
			})
		: rows;
	const error = workspace.error ?? history.error ?? sessions.error ?? actions.error;
	const name = workspace.data?.name ?? "Tasks";
	return (
		<>
			{/* The project overview fills the right sidebar here too, so the shell never shows an empty column. */}
			<HomeAside client={client} workspace={workspace.data ?? null} />
			<TopBar title={name}>
				{workspace.data ? (
					<span className="wb-chip" title={workspace.data.path}>
						<Icon name="folder" />
						<span>{workspace.data.path}</span>
					</span>
				) : null}
				<span className="wb-bar__spacer" />
				<button
					type="button"
					className="primary"
					disabled={!workspaceId || actions.launch.busy}
					onClick={() => actions.newTask(workspaceId)}
				>
					{actions.launch.busy ? <ClioPulse size={PULSE_SIZE.row} /> : <Icon name="compose" />}
					{actions.launch.busy ? "Starting…" : "New task"}
				</button>
			</TopBar>
			<div className="taskpage">
				<div className="taskpage__inner">
					<header className="taskpage__head">
						<h2>
							All tasks <span>{rows.length > 0 ? rows.length : ""}</span>
						</h2>
						{rows.length > 0 ? (
							<>
								<label className="sr-only" htmlFor={searchId}>
									Find a task
								</label>
								<input
									id={searchId}
									type="search"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									placeholder="Find by name, message, model or target"
								/>
							</>
						) : null}
					</header>
					{error ? <p role="alert">{error.message}</p> : null}
					{history.isPending && sessions.isPending ? <p className="taskpage__note">Reading this project's tasks…</p> : null}
					{shown.length > 0 ? (
						<ul className="taskpage__list">
							{shown.map((row) => {
								const summary = saved.get(row.id);
								const age = shortAge(row.at, now);
								const meta = [
									summary?.model ?? null,
									summary?.messageCount == null
										? null
										: `${summary.messageCount.toLocaleString("en-US")} ${summary.messageCount === 1 ? "message" : "messages"}`,
									STATE_LABELS[row.state] || null,
									row.open ? "open" : null,
								].filter(Boolean);
								const body = (
									<>
										<span className="taskpage__glyph">
											<Glyph state={row.state} />
										</span>
										<span className="taskpage__text">
											<strong>{actions.resuming === row.id ? "Opening…" : row.title}</strong>
											{meta.length > 0 ? <small>{meta.join(" · ")}</small> : null}
										</span>
										<time className="taskpage__age" dateTime={row.at} title={formatTime(row.at)}>
											{age}
										</time>
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
												title="Load this saved task"
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
					) : null}
					{needle && shown.length === 0 && !history.isPending ? (
						<p className="taskpage__note">No task matches that search.</p>
					) : null}
					{!needle && rows.length === 0 && !history.isPending && !sessions.isPending ? (
						<p className="taskpage__note">No tasks in {name} yet. Start one with New task.</p>
					) : null}
				</div>
			</div>
		</>
	);
}
