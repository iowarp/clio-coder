import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useId, useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { boardView, type OperatorTaskAction } from "./board-model.js";
import "./session-board.css";

/**
 * The terminal's /tasks, /decisions and /memory views, read from the session board. The operator's own
 * tasks change through the same `tasks` command family the terminal uses; the plan and the decisions
 * are Clio Coder's report and stay read-only here.
 */
export const SessionBoardPanel = memo(function SessionBoardPanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	settledTurns,
	running,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	/** Changes when a turn settles, which is when the plan and the decisions can have changed. */
	settledTurns: number;
	running: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const [title, setTitle] = useState("");
	const titleId = useId();
	const panel = useRef<HTMLDetailsElement>(null);
	const queries = useQueryClient();
	const params = { params: { id: sessionId }, query: {}, body: {} };
	const supported = !!capabilities?.board;
	const board = useQuery({
		queryKey: ["session-board", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionBoard, params),
		enabled: expanded && sessionOpen && supported,
		retry: false,
	});
	const change = useMutation({
		mutationFn: (argv: string[]) =>
			client.call(routes.invokeSessionCommand, { ...params, body: { command: "tasks", argv } }, crypto.randomUUID()),
		onSuccess: async (result, argv) => {
			if (result.level !== "error") setTitle("");
			await queries.invalidateQueries({ queryKey: ["session-board", sessionId] });
			if (argv[0] === "hand")
				requestAnimationFrame(() => {
					const active = document.activeElement;
					if (active !== document.body && active?.getAttribute("data-task-id") !== argv[1]) return;
					const next = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button[data-task-id]") ?? []).find(
						(button) => button.dataset.taskId === argv[1],
					);
					if (panel.current?.open) (next ?? panel.current.querySelector("summary"))?.focus();
				});
		},
	});
	const view = board.data ? boardView(board.data) : null;
	const act = (id: string, action: OperatorTaskAction) => change.mutate([action, id]);
	return (
		<details
			ref={panel}
			className="command-panel session-board"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>Tasks and decisions</summary>
			{!sessionOpen ? <p>This session is not open. Load it to read its tasks and decisions.</p> : null}
			{sessionOpen && !supported ? <p>This Clio Coder session does not report tasks and decisions.</p> : null}
			{board.isPending && expanded && sessionOpen && supported ? <p>Reading the board…</p> : null}
			{board.error ? <p role="alert">{board.error.message}</p> : null}
			{view ? (
				<>
					<section aria-labelledby={`${titleId}-tasks`}>
						<h3 id={`${titleId}-tasks`}>Your tasks</h3>
						{view.tasks.length === 0 ? <p className="session-board__empty">You have not added a task.</p> : null}
						<ul className="session-board__rows">
							{view.tasks.map((task) => (
								<li key={task.id}>
									<span className="session-board__id">{task.id}</span>
									<span className="session-board__title">
										{task.title}
										{task.acceptance ? <small>{task.acceptance}</small> : null}
									</span>
									<StatusMark tone={task.tone} label={task.word} />
									{task.actions.length > 0 ? (
										<span className="session-board__actions">
											{task.actions.map((action) => (
												<button
													type="button"
													key={action}
													data-task-id={task.id}
													disabled={
														change.isPending || (action === "hand" && (running || capabilities?.commands?.promptTurns !== true))
													}
													onClick={() => act(task.id, action)}
													aria-label={`${action === "hand" ? "Hand to Clio Coder" : action === "done" ? "Mark done" : "Drop"}: ${task.title}`}
												>
													{action === "hand" ? "Hand" : action === "done" ? "Done" : "Drop"}
												</button>
											))}
										</span>
									) : null}
								</li>
							))}
						</ul>
						<form
							className="session-board__add"
							onSubmit={(event) => {
								event.preventDefault();
								const text = title.trim();
								if (text) change.mutate(["add", text]);
							}}
						>
							<label htmlFor={`${titleId}-add`}>Add a task</label>
							<input
								id={`${titleId}-add`}
								value={title}
								maxLength={1024}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="What should be done"
							/>
							<button type="submit" disabled={change.isPending || !title.trim()}>
								Add
							</button>
						</form>
						{view.tasks.some((task) => task.actions.includes("hand")) && capabilities?.commands?.promptTurns !== true ? (
							<p className="session-board__note">Handing a task needs a Clio Coder build that records command turns.</p>
						) : null}
						{change.error ? <p role="alert">{change.error.message}</p> : null}
						{change.data && change.data.level === "error" ? <p role="alert">{change.data.lines.join(" ")}</p> : null}
					</section>
					<section aria-labelledby={`${titleId}-plan`}>
						<h3 id={`${titleId}-plan`}>Clio Coder's plan</h3>
						{view.plan === null ? (
							<p className="session-board__empty">Clio Coder has not made a plan in this session.</p>
						) : (
							<>
								<p className="session-board__note">
									{view.plan.title}. As Clio Coder reports it; a completed step is its claim, not a check.
								</p>
								<ol className="session-board__rows">
									{view.plan.rows.map((row) => (
										<li key={row.id}>
											<span className="session-board__id">{row.id}</span>
											<span className="session-board__title">
												{row.title}
												{row.reason ? <small>{row.reason}</small> : null}
											</span>
											<StatusMark tone={row.tone} label={row.word} />
										</li>
									))}
								</ol>
							</>
						)}
					</section>
					<section aria-labelledby={`${titleId}-decisions`}>
						<h3 id={`${titleId}-decisions`}>Decisions</h3>
						{view.activeDecisions.length === 0 ? (
							<p className="session-board__empty">No decision has been recorded in this session.</p>
						) : null}
						<dl className="session-board__decisions">
							{view.activeDecisions.map((row) => (
								<div key={row.ref}>
									<dt>{row.name}</dt>
									<dd>
										{row.value}
										<small>
											{row.who}
											{row.note ? ` · ${row.note}` : ""}
										</small>
									</dd>
								</div>
							))}
						</dl>
						{view.earlierDecisions.length > 0 ? (
							<details>
								<summary>
									{view.earlierDecisions.length} earlier {view.earlierDecisions.length === 1 ? "decision" : "decisions"}
								</summary>
								<dl className="session-board__decisions">
									{view.earlierDecisions.map((row) => (
										<div key={row.ref}>
											<dt>{row.name}</dt>
											<dd>
												<s>{row.value}</s>
												<small>
													Superseded
													{row.note ? ` · ${row.note}` : ""}
												</small>
											</dd>
										</div>
									))}
								</dl>
							</details>
						) : null}
					</section>
					<p className="session-board__note">{view.memory}</p>
					{view.truncated ? (
						<p className="session-board__note">Only the first 100 of a list are shown; the terminal shows the rest.</p>
					) : null}
				</>
			) : null}
		</details>
	);
});
