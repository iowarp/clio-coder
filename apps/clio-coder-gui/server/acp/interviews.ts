import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
	InterviewRequest,
	type InterviewResult,
	type InterviewRound,
	InterviewSubmission,
	InterviewWithdrawal,
} from "../../contracts/interviews.js";
import { AppProblem } from "../services/problem.js";

/** A parked runtime callback, with no browser-owned decisions or automatic selection. */
export class Interviews {
	private pending: {
		round: InterviewRound;
		resolve: (result: InterviewResult) => void;
	} | null = null;
	constructor(private readonly changed: (round: InterviewRound | null) => void) {}
	current(): InterviewRound | null {
		return this.pending ? structuredClone(this.pending.round) : null;
	}
	request(sessionId: string, turnId: string | null, value: unknown): Promise<InterviewResult> {
		if (!Value.Check(InterviewRequest, value) || value.sessionId !== sessionId || !turnId || this.pending)
			throw new AppProblem("upstream_acp", "Interview does not match this session's active turn or question contract.");
		const round: InterviewRound = {
			id: randomUUID(),
			turnId,
			requestedAt: new Date().toISOString(),
			questions: structuredClone(value.questions),
			...(value.interviewId ? { interviewId: value.interviewId } : {}),
		};
		return new Promise((resolve) => {
			this.pending = { round, resolve };
			this.changed(round);
		});
	}
	answer(id: string, submission: InterviewSubmission) {
		const pending = this.pending;
		if (!pending || pending.round.id !== id)
			throw new AppProblem("conflict", "This interview round is no longer waiting.");
		if (!Value.Check(InterviewSubmission, submission))
			throw new AppProblem("validation", "The interview answer does not match its submission contract.");
		if ("cancelled" in submission) {
			this.cancel();
			return;
		}
		if (submission.answers.length !== pending.round.questions.length)
			throw new AppProblem("validation", "Answer every question before submitting this round.");
		const answers = pending.round.questions.map((question, index) => {
			const answer = submission.answers[index];
			if (
				!answer ||
				(!question.multi_select && answer.selected.length > 1) ||
				answer.selected.some((choice) => !question.options?.[choice])
			)
				throw new AppProblem("validation", "An interview answer names a choice this question does not offer.");
			const options = [...answer.selected].sort((a, b) => a - b).map((choice) => question.options?.[choice]?.label ?? "");
			const text = answer.text.trim();
			if (options.length === 0 && !text)
				throw new AppProblem("validation", "Answer every question before submitting this round.");
			return {
				question: question.question,
				answer: [...options, ...(text ? [text] : [])].join("; "),
				...(options.length ? { options } : {}),
				...(text ? { value: answer.text } : {}),
			};
		});
		this.finish({ answers });
	}
	cancel() {
		if (this.pending) this.finish({ answers: [], cancelled: true });
	}
	withdraw(sessionId: string, value: unknown): void {
		if (
			Value.Check(InterviewWithdrawal, value) &&
			value.sessionId === sessionId &&
			value.interviewId === this.pending?.round.interviewId
		)
			this.cancel();
	}
	private finish(result: InterviewResult) {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		this.changed(null);
		pending.resolve(result);
	}
}
