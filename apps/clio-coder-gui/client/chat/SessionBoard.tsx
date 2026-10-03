import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useId, useRef, useState } from "react";
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
import type { PaneSection } from "./pane-context.js";
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
	section = null,
	onSectionShown,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	/** Changes when a turn settles, which is when the plan and the decisions can have changed. */
	settledTurns: number;
	running: boolean;
	/** A section the pane was opened at, `/decisions`: scrolled to and focused once it has rendered. */
	section?: PaneSection | null;
	onSectionShown?: () => void;
}) {
	const [title, setTitle] = useState("");
	const titleId = useId();
	const panel = useRef<HTMLDivElement>(null);
	const queries = useQueryClient();
	const params = { params: { id: sessionId }, query: {}, body: {} };
	const supported = !!capabilities?.board;
	const board = useQuery({
		queryKey: ["session-board", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionBoard, params),
		enabled: sessionOpen && supported,
		retry: false,
		// The next settled turn changes the key; the last answer stays on screen until the new one lands,
		// so rows (and the focus a row holds) do not vanish between the two reads.
		placeholderData: (previous) => previous,
	});
	// The mutation is still pending inside onSuccess, so every row button is disabled there; a focus
	// call from that callback (or a frame after it) can land before the enabled rows commit and is lost.
	const handed = useRef<string | null>(null);
	const change = useMutation({
		mutationFn: (argv: string[]) =>
			client.call(routes.invokeSessionCommand, { ...params, body: { command: "tasks", argv } }, crypto.randomUUID()),
		onSuccess: async (result, argv) => {
			if (result.level !== "error") setTitle("");
			await queries.invalidateQueries({ queryKey: ["session-board", sessionId] });
			if (argv[0] === "hand") handed.current = argv[1] ?? null;
		},
	});
	useEffect(() => {
		const id = handed.current;
		if (id === null || change.isPending) return;
		handed.current = null;
		const active = document.activeElement;
		if (active !== document.body && active?.getAttribute("data-task-id") !== id) return;
		const next = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button[data-task-id]") ?? []).find(
			(button) => button.dataset.taskId === id && !button.disabled,
		);
		(next ?? panel.current?.querySelector<HTMLElement>("h3"))?.focus();
	}, [change.isPending]);
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
	const loaded = !!board.data;
	useEffect(() => {
		if (section === null || !loaded) return;
		// After the pane's own effects, which focus its title on a change of view and open the modal
		// slide-over; either would otherwise take focus back from the section.
		const frame = requestAnimationFrame(() => {
			const heading = panel.current?.querySelector<HTMLElement>(`[data-board-section="${section}"]`);
			if (!heading) return;
			heading.focus({ preventScroll: true });
			heading.scrollIntoView({ block: "start" });
			onSectionShown?.();
		});
		return () => cancelAnimationFrame(frame);
	}, [section, loaded, onSectionShown]);
	const act = (id: string, action: OperatorTaskAction) => change.mutate([action, id]);
	return (
		<div ref={panel} className="pane-drill drill board-panel">
			{!sessionOpen ? (
				<p className="pane-empty">This session is not open. Load it to read its tasks and decisions.</p>
			) : null}
			{sessionOpen && !supported ? (
				<p className="pane-empty">This Clio Coder session does not report tasks and decisions.</p>
			) : null}
			{board.isPending && sessionOpen && supported ? <p className="pane-empty">Reading the board…</p> : null}
			{board.error ? (
				<p role="alert" className="pane-empty">
					{board.error.message}
				</p>
			) : null}
			{view ? (
				<>
					<section className="drill__section" aria-labelledby={`${titleId}-tasks`}>
						<h3 id={`${titleId}-tasks`} tabIndex={-1}>
							Your tasks
						</h3>
						{view.tasks.length === 0 ? <p className="pane-empty">You have not added a task.</p> : null}
						{view.tasks.length > 0 ? (
							<ul className="drill__rows">
								{view.tasks.map((task) => (
									<li key={task.id}>
										<span className="drill__id">{task.id}</span>
										<span className="drill__main">
											<span>{task.title}</span>
											{task.acceptance ? <small>{task.acceptance}</small> : null}
										</span>
										<StatusMark tone={task.tone} label={task.word} />
										{task.actions.length > 0 ? (
											<span className="drill__actions">
												{task.actions.map((action) => (
													<button
														type="button"
														key={action}
														className={action === "hand" ? "drill__btn drill__btn--accent" : "drill__btn"}
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
						) : null}
						<form
							className="drill__form"
							onSubmit={(event) => {
								event.preventDefault();
								const text = title.trim();
								if (text) change.mutate(["add", text]);
							}}
						>
							<label htmlFor={`${titleId}-add`} className="sr-only">
								Add a task
							</label>
							<input
								id={`${titleId}-add`}
								value={title}
								maxLength={1024}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="Add a task"
							/>
							<button type="submit" className="drill__btn drill__btn--line" disabled={change.isPending || !title.trim()}>
								Add
							</button>
						</form>
						{view.tasks.some((task) => task.actions.includes("hand")) && capabilities?.commands?.promptTurns !== true ? (
							<p className="drill__note">Handing a task needs a Clio Coder build that records command turns.</p>
						) : null}
						{change.error ? (
							<p role="alert" className="drill__note drill__note--error">
								{change.error.message}
							</p>
						) : null}
						{change.data && change.data.level === "error" ? (
							<p role="alert" className="drill__note drill__note--error">
								{change.data.lines.join(" ")}
							</p>
						) : null}
					</section>
					<section className="drill__section" aria-labelledby={`${titleId}-plan`}>
						<h3 id={`${titleId}-plan`}>Clio Coder's plan</h3>
						{view.plan === null ? (
							<p className="pane-empty">Clio Coder has not made a plan in this session.</p>
						) : (
							<>
								<p className="board-panel__plan-title">{view.plan.title}</p>
								<ol className="drill__rows">
									{view.plan.rows.map((row) => (
										<li key={row.id}>
											<span className="drill__id">{row.id}</span>
											<span className="drill__main">
												<span>{row.title}</span>
												{row.reason ? <small>{row.reason}</small> : null}
											</span>
											<StatusMark tone={row.tone} label={row.word} />
										</li>
									))}
								</ol>
								<p className="drill__note">As Clio Coder reports it; a completed step is its claim, not a check.</p>
							</>
						)}
					</section>
					<section className="drill__section" aria-labelledby={`${titleId}-decisions`}>
						<h3 id={`${titleId}-decisions`} data-board-section="decisions" tabIndex={-1}>
							Decisions
						</h3>
						{decisionsEmptyLine(view) ? <p className="pane-empty">{decisionsEmptyLine(view)}</p> : null}
						{view.activeDecisions.length > 0 ? (
							<dl className="board-panel__decisions">
								{view.activeDecisions.map((row) => (
									<div key={row.ref}>
										<dt>{row.name}</dt>
										<dd>
											<span>{row.value}</span>
											<small>
												{row.who}
												{row.note ? ` · ${row.note}` : ""}
											</small>
											{canSupersede && row.target !== null ? (
												confirming === row.ref ? (
													<fieldset className="board-panel__confirm">
														<legend>Supersede {row.name}? It stays in the record, marked superseded.</legend>
														<span className="drill__actions">
															<button
																type="button"
																className="drill__btn drill__btn--line"
																disabled={supersede.isPending || running}
																onClick={() => supersede.mutate({ row })}
															>
																Supersede
															</button>
															<button
																type="button"
																className="drill__btn"
																// Keep is the safe answer, so the question puts focus on it.
																ref={(button) => button?.focus()}
																onClick={() => setConfirming(null)}
															>
																Keep
															</button>
														</span>
													</fieldset>
												) : correcting === row.ref ? (
													<form
														className="drill__form drill__form--stacked"
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
														<span className="drill__actions">
															<button
																type="submit"
																className="drill__btn drill__btn--line"
																disabled={supersede.isPending || running || !correction.trim()}
															>
																Supersede and tell Clio Coder
															</button>
															<button type="button" className="drill__btn" onClick={() => setCorrecting(null)}>
																Cancel
															</button>
														</span>
													</form>
												) : (
													<span className="drill__actions">
														<button
															type="button"
															className="drill__btn"
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
															className="drill__btn"
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
						) : null}
						{view.earlierDecisions.length > 0 ? (
							<details className="board-panel__earlier">
								<summary>
									{view.earlierDecisions.length} earlier {view.earlierDecisions.length === 1 ? "decision" : "decisions"}
								</summary>
								<dl className="board-panel__decisions">
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
						{decisionNote ? (
							<p
								role={decisionNote.tone === "error" ? "alert" : "status"}
								className={decisionNote.tone === "error" ? "drill__note drill__note--error" : "drill__note"}
							>
								{decisionNote.text}
							</p>
						) : null}
					</section>
					<section className="drill__section" aria-labelledby={`${titleId}-bank`}>
						<h3 id={`${titleId}-bank`}>{view.bank.length > 0 ? "What Clio Coder learned this session" : "Memory"}</h3>
						<p className="drill__note">{view.memory}</p>
						{view.bank.length > 0 ? (
							<>
								<p className="drill__note">
									Proposing makes a candidate for durable memory. Nothing is remembered until you approve it.
								</p>
								<ul className="drill__rows">
									{view.bank.map((entry) => (
										<li key={entry.id} className="board-panel__entry">
											<span className="drill__id">{entry.word}</span>
											<span className="drill__main">{entry.content}</span>
											{canPropose ? (
												<span className="drill__actions">
													<button
														type="button"
														className="drill__btn"
														disabled={propose.isPending}
														onClick={() => propose.mutate({ entryId: entry.id, scope: "repo" })}
														aria-label={`Propose for this repository: ${entry.content}`}
													>
														Propose for this repository
													</button>
													<button
														type="button"
														className="drill__btn"
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
									<p
										role={memoryNote.tone === "error" ? "alert" : "status"}
										className={memoryNote.tone === "error" ? "drill__note drill__note--error" : "drill__note"}
									>
										{memoryNote.text}
									</p>
								) : null}
							</>
						) : null}
					</section>
					{view.truncated ? (
						<p className="drill__note">Only the first 100 of a list are shown; the terminal shows the rest.</p>
					) : null}
				</>
			) : null}
		</div>
	);
});
