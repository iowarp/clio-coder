import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useId, useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import {
	boardView,
	type DecisionRow,
	decisionsEmptyLine,
	memoryOutcome,
	type OperatorTaskAction,
	supersedeOutcome,
} from "./board-model.js";
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
	const [confirming, setConfirming] = useState<string | null>(null);
	const [correcting, setCorrecting] = useState<string | null>(null);
	const [correction, setCorrection] = useState("");
	const [decisionNote, setDecisionNote] = useState<{ tone: string; text: string } | null>(null);
	const [pendingGlobal, setPendingGlobal] = useState<string | null>(null);
	const [memoryNote, setMemoryNote] = useState<{ tone: string; text: string } | null>(null);
	const canSupersede = !!capabilities?.board?.supersede;
	const canPropose = !!capabilities?.board?.proposeMemory;
	const supersede = useMutation({
		mutationFn: async ({ row, text }: { row: DecisionRow; text?: string }) => {
			if (row.target === null) throw new Error("This decision cannot be named to Clio Coder.");
			const result = await client.call(
				routes.supersedeDecision,
				{ ...params, body: { ...row.target, ...(text === undefined ? {} : { correction: text }) } },
				crypto.randomUUID(),
			);
			// The correction reaches Clio Coder as the operator's own request, as the terminal sends it.
			if (result.status === "superseded" && result.correctionTurn !== undefined)
				await client.call(routes.turn, { ...params, body: { text: result.correctionTurn } }, crypto.randomUUID());
			return { result, corrected: text !== undefined };
		},
		onSuccess: async ({ result, corrected }) => {
			setConfirming(null);
			setCorrecting(null);
			setCorrection("");
			setDecisionNote(supersedeOutcome(result, corrected));
			await queries.invalidateQueries({ queryKey: ["session-board", sessionId] });
			// The row that held focus may have moved to earlier decisions; the section heading is where it lands.
			requestAnimationFrame(() => document.getElementById(`${titleId}-decisions`)?.focus());
		},
		onError: (error) => setDecisionNote({ tone: "error", text: error.message }),
	});
	const propose = useMutation({
		mutationFn: ({ entryId, scope }: { entryId: string; scope: "repo" | "global" }) =>
			client.call(
				routes.proposeMemory,
				{
					...params,
					body: { entryId, scope, ...(scope === "global" && pendingGlobal === entryId ? { acknowledgeGlobal: true } : {}) },
				},
				crypto.randomUUID(),
			),
		onSuccess: (result, input) => {
			setPendingGlobal(result.status === "needs_acknowledgement" ? input.entryId : null);
			setMemoryNote(memoryOutcome(result));
		},
		onError: (error) => setMemoryNote({ tone: "error", text: error.message }),
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
						<h3 id={`${titleId}-decisions`} tabIndex={-1}>
							Decisions
						</h3>
						{decisionsEmptyLine(view) ? <p className="session-board__empty">{decisionsEmptyLine(view)}</p> : null}
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
										{canSupersede && row.target !== null ? (
											confirming === row.ref ? (
												<fieldset className="session-board__actions session-board__confirm">
													<legend>Supersede {row.name}? It stays in the record, marked superseded.</legend>

													<button type="button" disabled={supersede.isPending || running} onClick={() => supersede.mutate({ row })}>
														Supersede
													</button>
													<button
														type="button"
														// Keep is the safe answer, so the question puts focus on it.
														ref={(button) => button?.focus()}
														onClick={() => setConfirming(null)}
													>
														Keep
													</button>
												</fieldset>
											) : correcting === row.ref ? (
												<form
													className="session-board__add"
													onSubmit={(event) => {
														event.preventDefault();
														const text = correction.trim();
														if (text) supersede.mutate({ row, text });
													}}
												>
													<label htmlFor={`${titleId}-correct-${row.ref}`}>New direction</label>
													<input
														id={`${titleId}-correct-${row.ref}`}
														value={correction}
														maxLength={2000}
														// biome-ignore lint/a11y/noAutofocus: the operator just asked to write the correction.
														autoFocus
														onChange={(event) => setCorrection(event.target.value.replace(/[\r\n]+/g, " "))}
													/>
													<button type="submit" disabled={supersede.isPending || running || !correction.trim()}>
														Supersede and tell Clio Coder
													</button>
													<button type="button" onClick={() => setCorrecting(null)}>
														Cancel
													</button>
												</form>
											) : (
												<span className="session-board__actions">
													<button
														type="button"
														disabled={supersede.isPending || running}
														onClick={() => {
															setDecisionNote(null);
															setCorrecting(null);
															setConfirming(row.ref);
														}}
														aria-label={`Supersede: ${row.name}`}
													>
														Supersede
													</button>
													<button
														type="button"
														disabled={supersede.isPending || running}
														onClick={() => {
															setDecisionNote(null);
															setConfirming(null);
															setCorrection("");
															setCorrecting(row.ref);
														}}
														aria-label={`Correct: ${row.name}`}
													>
														Correct
													</button>
												</span>
											)
										) : null}
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
					{decisionNote ? (
						<p role={decisionNote.tone === "error" ? "alert" : "status"} className="session-board__note">
							{decisionNote.text}
						</p>
					) : null}
					<p className="session-board__note">{view.memory}</p>
					{view.bank.length > 0 ? (
						<section aria-labelledby={`${titleId}-bank`}>
							<h3 id={`${titleId}-bank`}>What Clio Coder learned this session</h3>
							<p className="session-board__note">
								Proposing makes a candidate for durable memory. Nothing is remembered until you approve it.
							</p>
							<ul className="session-board__rows">
								{view.bank.map((entry) => (
									<li key={entry.id}>
										<span className="session-board__id">{entry.word}</span>
										<span className="session-board__title">{entry.content}</span>
										{canPropose ? (
											<span className="session-board__actions">
												<button
													type="button"
													disabled={propose.isPending}
													onClick={() => propose.mutate({ entryId: entry.id, scope: "repo" })}
													aria-label={`Propose for this repository: ${entry.content}`}
												>
													Propose for this repository
												</button>
												<button
													type="button"
													disabled={propose.isPending}
													onClick={() => propose.mutate({ entryId: entry.id, scope: "global" })}
													aria-label={`Propose for every project: ${entry.content}`}
												>
													{pendingGlobal === entry.id ? "Propose everywhere" : "Propose for every project"}
												</button>
											</span>
										) : null}
									</li>
								))}
							</ul>
							{memoryNote ? (
								<p role={memoryNote.tone === "error" ? "alert" : "status"} className="session-board__note">
									{memoryNote.text}
								</p>
							) : null}
						</section>
					) : null}
					{view.truncated ? (
						<p className="session-board__note">Only the first 100 of a list are shown; the terminal shows the rest.</p>
					) : null}
				</>
			) : null}
		</details>
	);
});
