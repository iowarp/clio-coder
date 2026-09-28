/**
 * `turnEnd`: how a System One model reads the assistant's final message.
 *
 * Three turn-end judgments are regular expressions over English prose today:
 * whether the turn announced work and stopped (`nudge.stalled-turn`), whether
 * it credited findings to a worker it never dispatched (the unbacked-claim
 * advisory), and whether it ended by asking the operator (the clarification
 * streak that gates the `direction` workflow). Each is a reading of intent,
 * which is the one thing a regular expression cannot do and a decision model
 * can.
 *
 * The site runs in shadow. It asks after the turn settles, never delays or
 * changes anything, and its answers reach the ledger only as a recorded call
 * whose `ref` is the turn id, so each can be set against the turn's outcome
 * record and the regex verdicts before any of them is allowed to act. The
 * message is the only evidence: whether a tool, a dispatch or a check
 * actually happened is the harness's to prove, not the model's to judge.
 */

import type { ResolveDeciderInput } from "../decision-sites.js";
import { inspectDecisionSite } from "../decision-sites.js";
import { yesNo } from "../decisions.js";
import { withoutQuotedCode } from "../pre-turn-brief.js";
import type { DecisionQuestion } from "../types/inference.js";

/** Code points of the message's tail sent; the ending carries what it asks or announces. */
const MAX_MESSAGE_CHARS = 1_500;

const TURN_END_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
	announcedUnstarted: yesNo(
		"Does `message` end by announcing a concrete action the assistant is about to take now, such as running, editing, reading, searching or dispatching, rather than reporting finished work?",
		"Ends by saying it will now do a concrete action",
		"Ends by reporting results, asking a question, offering options, or waiting on the operator",
	),
	asksOperator: yesNo(
		"Does `message` end by asking the operator to decide, choose among options, confirm, or clarify before the work continues?",
		"Waits on the operator's choice or answer",
		"Needs nothing from the operator to continue, or only reports",
	),
	claimsWorkerResult: yesNo(
		"Does `message` present findings or results as coming from a worker, scout, subagent or dispatched run?",
		"Credits findings to a worker, scout, subagent or run",
		"Credits nothing to another agent",
	),
	claimsVerified: yesNo(
		"Does `message` claim that tests, a build, a linter or another check passed?",
		"Claims a check passed",
		"Claims no check passed, or reports a failure",
	),
};

function tail(value: string): string {
	const points = [...withoutQuotedCode(value).replace(/\s+/g, " ").trim()];
	return points.length <= MAX_MESSAGE_CHARS
		? points.join("")
		: `…${points.slice(points.length - MAX_MESSAGE_CHARS + 1).join("")}`;
}

/**
 * Ask the bound site about one final message. Never throws and returns
 * nothing: the recorded call is the whole result while the site is in shadow.
 */
export async function observeTurnEnd(
	input: ResolveDeciderInput,
	turn: { readonly turnId: string; readonly message: string },
	signal?: AbortSignal,
): Promise<void> {
	try {
		const status = inspectDecisionSite("turnEnd", input);
		if (!status.bound) return;
		const message = tail(turn.message);
		if (message.length === 0) return;
		await status.decider.askDetailed(
			{ message },
			{ ...TURN_END_QUESTIONS },
			{ ref: turn.turnId, ...(signal !== undefined ? { signal } : {}) },
		);
	} catch {
		// Shadow reading: an outage costs the record, never the turn.
	}
}
