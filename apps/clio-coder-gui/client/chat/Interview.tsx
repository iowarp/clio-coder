import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { InterviewRound, InterviewSubmission } from "../../contracts/interviews.js";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { useShortcut, useShortcutLayer } from "../interaction/use-shortcut.js";
import { MarkdownContent } from "../render/Markdown.js";
import {
	answerReady,
	blankInterview,
	type InterviewDraft,
	interviewSubmission,
	selectInterviewChoice,
} from "./interview-model.js";
import "./interview.css";

function savedAnswers(round: InterviewRound): InterviewDraft[] {
	try {
		const saved: unknown = JSON.parse(sessionStorage.getItem(`clio-coder-gui-interview:${round.id}`) ?? "null");
		if (
			Array.isArray(saved) &&
			saved.length === round.questions.length &&
			saved.every(
				(answer, index) =>
					typeof answer?.text === "string" &&
					answer.text.length <= 8192 &&
					Array.isArray(answer.selected) &&
					new Set(answer.selected).size === answer.selected.length &&
					(round.questions[index]?.multi_select || answer.selected.length <= 1) &&
					answer.selected.every(
						(choice: unknown) =>
							Number.isInteger(choice) && Number(choice) >= 0 && !!round.questions[index]?.options?.[Number(choice)],
					),
			)
		)
			return saved as InterviewDraft[];
	} catch {
		/* A draft in this tab still works without storage. */
	}
	return blankInterview(round.questions);
}

function InterviewDialog({ client, sessionId, round }: { client: Client; sessionId: string; round: InterviewRound }) {
	const queries = useQueryClient();
	const [answers, setAnswers] = useState(() => savedAnswers(round));
	const [index, setIndex] = useState(0);
	const [review, setReview] = useState(false);
	const [cancelRequested, setCancelRequested] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const submitting = useRef(false);
	const submitted = useRef<{ body: string; key: string } | null>(null);
	const title = useId();
	const field = useId();
	useShortcutLayer("interview", true);
	useEffect(() => {
		const node = dialog.current;
		node?.showModal();
		return () => node?.close();
	}, []);
	// A newly displayed question or confirmation receives a readable focus target.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these state changes replace the visible heading.
	useEffect(() => heading.current?.focus(), [index, review, cancelRequested]);
	useEffect(() => {
		try {
			sessionStorage.setItem(`clio-coder-gui-interview:${round.id}`, JSON.stringify(answers));
		} catch {
			/* The form keeps its draft. */
		}
	}, [answers, round.id]);
	const completed = round.questions.filter((question, index) => answerReady(question, answers[index])).length;
	const submission = interviewSubmission(round.questions, answers);
	const send = useMutation({
		mutationFn: (body: InterviewSubmission) => {
			const encoded = JSON.stringify(body);
			if (submitted.current?.body !== encoded) submitted.current = { body: encoded, key: crypto.randomUUID() };
			return client.call(
				routes.answerInterview,
				{ params: { id: sessionId, roundId: round.id }, query: {}, body },
				submitted.current.key,
			);
		},
		onSuccess: () => {
			try {
				sessionStorage.removeItem(`clio-coder-gui-interview:${round.id}`);
			} catch {
				/* No stored draft. */
			}
			queries.setQueryData<InterviewRound | null>(["session-interview", sessionId], (current) =>
				current?.id === round.id ? null : current,
			);
			void queries.invalidateQueries({ queryKey: ["session-interview", sessionId] });
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
		},
		onError: (error) => {
			if (error instanceof ApiProblem && error.problem.code === "conflict")
				void queries.invalidateQueries({ queryKey: ["session-interview", sessionId] });
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const submit = (body: InterviewSubmission) => {
		if (submitting.current) return;
		submitting.current = true;
		send.mutate(body);
	};
	useShortcut("interviewSubmit", () => {
		if (review && submission && !cancelRequested) submit(submission);
	});
	const move = (next: number) => {
		setIndex(next);
		setReview(false);
		setCancelRequested(false);
	};
	const question = round.questions[index];
	const answer = answers[index];
	if (!question || !answer) return null;
	const edit = (next: InterviewDraft) =>
		setAnswers((previous) => previous.map((answer, at) => (at === index ? next : answer)));
	return createPortal(
		<dialog
			ref={dialog}
			className="interview-dialog"
			aria-labelledby={title}
			onCancel={(event) => {
				event.preventDefault();
				setCancelRequested(true);
			}}
		>
			<header className="interview-dialog__header">
				<div>
					<p className="eyebrow">Clio Coder needs your input</p>
					<h2 id={title}>
						Shape the next step<span className="period">.</span>
					</h2>
				</div>
				<button
					type="button"
					disabled={send.isPending}
					onClick={() => setCancelRequested(true)}
					aria-label="Cancel interview"
				>
					<Icon name="close" />
				</button>
			</header>
			<div className="interview-dialog__layout">
				<nav className="interview-dialog__steps" aria-label="Interview questions">
					<p>
						{completed} of {round.questions.length} answered
					</p>
					<ol>
						{round.questions.map((question, at) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: question indices are immutable within this runtime round.
							<li key={`${round.id}-${at}`}>
								<button
									type="button"
									aria-current={!review && at === index ? "step" : undefined}
									disabled={send.isPending}
									onClick={() => move(at)}
								>
									<span className="interview-dialog__step-number" data-complete={answerReady(question, answers[at])}>
										{answerReady(question, answers[at]) ? "✓" : at + 1}
									</span>
									<span>{question.header || `Question ${at + 1}`}</span>
								</button>
							</li>
						))}
					</ol>
					<button
						type="button"
						className="interview-dialog__review-link"
						disabled={!submission || send.isPending}
						onClick={() => setReview(true)}
						aria-current={review ? "step" : undefined}
					>
						<Icon name="evidence" />
						Review answers
					</button>
				</nav>
				<div className="interview-dialog__body">
					{cancelRequested ? (
						<section className="interview-dialog__cancel">
							<Icon name="warn" />
							<h3 ref={heading} tabIndex={-1}>
								End this interview?
							</h3>
							<p>Clio receives a cancellation. Your unanswered choices will stay undecided.</p>
							<div>
								<button type="button" disabled={send.isPending} onClick={() => submit({ cancelled: true })}>
									End interview
								</button>
								<button className="primary" type="button" disabled={send.isPending} onClick={() => setCancelRequested(false)}>
									Keep answering
								</button>
							</div>
						</section>
					) : review ? (
						<section className="interview-dialog__review">
							<p className="eyebrow">Ready for your review</p>
							<h3 ref={heading} tabIndex={-1}>
								These are your answers.
							</h3>
							{round.questions.map((question, at) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: the round is immutable and owns these question indices.
								<article key={`${round.id}-review-${at}`}>
									<div>
										<h4>{question.header || `Question ${at + 1}`}</h4>
										<button type="button" disabled={send.isPending} onClick={() => move(at)}>
											Edit
										</button>
									</div>
									<p>{question.question}</p>
									{answers[at]?.selected.map((choice) => (
										<span className="interview-dialog__chosen" key={choice}>
											{question.options?.[choice]?.label}
										</span>
									))}
									{answers[at]?.text.trim() ? <blockquote>{answers[at]?.text}</blockquote> : null}
								</article>
							))}
						</section>
					) : (
						<section className="interview-dialog__question">
							<p className="eyebrow">
								Question {index + 1} / {round.questions.length}
							</p>
							<h3 ref={heading} tabIndex={-1}>
								{question.header || "Your perspective"}
							</h3>
							<MarkdownContent source={question.question} complete deferDiagrams />
							{question.options?.length ? (
								<fieldset disabled={send.isPending} className="interview-dialog__choices">
									<legend>
										{question.multi_select
											? "Choose all that apply, or write your own answer"
											: "Choose an option, or write your own answer"}
									</legend>
									{question.options.map((option, choice) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: the runtime identifies choices by their immutable option indices.
										<label key={`${round.id}-${index}-${choice}`} data-selected={answer.selected.includes(choice)}>
											<input
												type={question.multi_select ? "checkbox" : "radio"}
												name={`${field}-${index}`}
												checked={answer.selected.includes(choice)}
												onChange={() => edit(selectInterviewChoice(question, answer, choice))}
											/>
											<span>
												<strong>{option.label}</strong>
												{option.description ? <small>{option.description}</small> : null}
											</span>
										</label>
									))}
								</fieldset>
							) : null}
							<label className="interview-dialog__text" htmlFor={field}>
								{answer.selected.length ? "Add details (optional)" : "Your answer"}
								<textarea
									id={field}
									rows={3}
									value={answer.text}
									maxLength={8192}
									disabled={send.isPending}
									placeholder={
										question.options?.length
											? "A different answer, a constraint, or a detail Clio should know…"
											: "Tell Clio what it needs to know…"
									}
									onChange={(event) => edit({ ...answer, text: event.target.value })}
								/>
							</label>
							{answer.selected.length ? (
								<button
									type="button"
									className="interview-dialog__clear"
									disabled={send.isPending}
									onClick={() => edit({ ...answer, selected: [] })}
								>
									Clear selected choices
								</button>
							) : null}
						</section>
					)}
				</div>
			</div>
			<footer className="interview-dialog__footer">
				{send.error ? <p role="alert">{send.error.message}</p> : <p>No answer is sent until you submit the round.</p>}
				{!cancelRequested ? (
					<div>
						<button
							type="button"
							disabled={send.isPending || (!review && index === 0)}
							onClick={() => (review ? setReview(false) : move(index - 1))}
						>
							Back
						</button>
						{review ? (
							<button
								className="primary"
								type="button"
								disabled={!submission || send.isPending}
								onClick={() => {
									if (submission) submit(submission);
								}}
							>
								{send.isPending ? "Sending answers…" : "Submit answers"}
								<Icon name="arrowUp" />
							</button>
						) : (
							<button
								className="primary"
								type="button"
								disabled={!answerReady(question, answer) || send.isPending}
								onClick={() => (index < round.questions.length - 1 ? move(index + 1) : setReview(true))}
							>
								{index < round.questions.length - 1 ? "Next question" : "Review answers"}
								<Icon name="chevronRight" />
							</button>
						)}
					</div>
				) : null}
			</footer>
		</dialog>,
		document.body,
	);
}

export function Interview({
	client,
	sessionId,
	sessionOpen,
	capabilities,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
}) {
	const enabled = sessionOpen && capabilities?.interviews?.version === 1;
	const pending = useQuery({
		queryKey: ["session-interview", sessionId],
		queryFn: () => client.call(routes.sessionInterview, { params: { id: sessionId }, query: {}, body: {} }),
		enabled,
		retry: false,
	});
	return enabled && pending.data ? (
		<InterviewDialog key={pending.data.id} client={client} sessionId={sessionId} round={pending.data} />
	) : null;
}
