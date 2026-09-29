/**
 * `turnEnd`: how a System One engine reads the assistant's final message.
 *
 * Three turn-end judgments are regular expressions over English prose today:
 * whether the turn announced work and stopped (`nudge.stalled-turn`), whether
 * it claims a check passed, and whether it ended by asking the operator (the
 * clarification streak that gates the `direction` workflow and the prose
 * question nudge). Each is a reading of intent, which is the one thing a
 * regular expression cannot do and a decision model can. Two more readings
 * separate a question that blocks the work from an invitation that does not,
 * and four more say whether the work moved on, which a compaction policy can
 * use later.
 *
 * The message is the only evidence for what it claims: whether a tool, a
 * dispatch or a check actually happened is the harness's to prove, not the
 * model's to judge. The site asks after the turn settles, so it never delays
 * the turn. Under a build with no fitted cut the answers reach the ledger only,
 * and the caller keeps the regular expression it had.
 */

import { rating } from "../answers.js";
import { rate, yesNo } from "../questions.js";
import type { Question, SiteDefinition } from "../types.js";
import { boundedHead, boundedTailLines, probability, round2, withoutQuotedCode } from "./bounds.js";

/** Code points of the operator's request. Its opening is what it asked for. */
const MAX_REQUEST_CHARS = 300;
/** Code points of the message's tail sent; the ending carries what it asks or announces. */
const MAX_MESSAGE_CHARS = 1500;
/** Earlier operator requests sent, and code points of each. */
const MAX_EARLIER = 3;
const MAX_EARLIER_CHARS = 150;
const MAX_TOOLS = 24;

const ASKS_OPERATOR = yesNo(
	"Does `message` end by asking the operator something: a question, a choice among options, a confirmation, or a request for input?",
	"Asks the operator to answer, choose, confirm or supply something",
	"A statement: a report, a result, a summary or an announcement, including an open invitation to ask for more, with no particular answer requested",
);

const BLOCKS_ON_DECISION = yesNo(
	"Does `message` end by stopping on a decision the operator must make before the work can continue?",
	"Needs the operator's answer to go on: a required choice, an approval not yet given, or missing input",
	"A conversational invitation, an offer of further help, a greeting reply, a report that needs nothing, or a report that an action was refused or denied and will not be retried",
);

const ANNOUNCED_UNSTARTED = yesNo(
	"Does `message` end by announcing a concrete action the assistant is about to take now, such as running, editing, reading, searching or dispatching, rather than reporting finished work?",
	"Ends by saying it will now do a concrete action",
	"Ends by reporting results, asking a question, offering options, or waiting on the operator",
);

const CLAIMS_VERIFIED = yesNo(
	"Does `message` claim that tests, a build, a linter or another check passed?",
	"Claims a check passed",
	"Claims no check passed, or reports a failure",
);

const SWITCHED_GEARS = yesNo(
	"Is `request` a different task from the work in `earlier`?",
	"A new feature, a different file area, a different goal, or an unrelated question",
	"The same task continuing, a follow up, a fix to what was just done",
);

const FINISHED_UNIT = yesNo(
	"Did `message` finish a unit of work?",
	"Tests passed, a commit was made, or a summary of finished work was given",
	"Mid task: it says what comes next or leaves steps undone",
);

const MID_OPERATION = yesNo(
	"Is the assistant in the middle of a multi step edit whose partial state only exists in the conversation?",
	"Half applied changes, a plan being executed step by step, an unfinished refactor",
	"A clean point with nothing half done",
);

const NEEDS_HISTORY = rate("How much of `earlier` does the next step need?", [
	"None: the new work stands alone",
	"Some references, such as a file name or a decision",
	"Most of it: the work continues directly from it",
]);

export interface TurnEndObject {
	/** What the operator asked this turn. */
	readonly request: string;
	/** The assistant's final message. */
	readonly message: string;
	/** Up to three earlier operator requests, oldest first. Empty on a session's first turn. */
	readonly earlier: ReadonlyArray<string>;
	/** The tools the turn called. */
	readonly tools: ReadonlyArray<string>;
}

export interface TurnEndValue {
	/** Probability that the message ends by asking the operator something. */
	readonly asksOperator: number | null;
	/** `asksOperator` at the build's cut, or null when the build is unfitted so the caller keeps its regular expression. */
	readonly asks: boolean | null;
	/** Probability that the message ends on an action it has not started. */
	readonly announcedUnstarted: number | null;
	/** Probability that the message claims a check passed. */
	readonly claimsVerified: number | null;
	/** Probability that the message stops on a decision the work is blocked on. */
	readonly blocksOnDecision: number | null;
	/**
	 * True at or above the build's `blocksOnDecision` cut, false at or below its
	 * `blocksOnDecisionFloor`, null between them or when either is unfitted. The
	 * classes overlap, so only the two tails are decisions.
	 */
	readonly blocks: boolean | null;
	/** Whether the work moved on, for a compaction policy. Probabilities, and the 0..2 history score. */
	readonly movedOn: {
		readonly switchedGears: number | null;
		readonly finishedUnit: number | null;
		readonly midOperation: number | null;
		readonly needsHistory: number | null;
	};
}

export const TURN_END_SITE: SiteDefinition<TurnEndObject, TurnEndValue> = {
	id: "turnEnd",
	version: "turn-end-v3",
	deadlineMs: 5000,
	state(object) {
		const message = boundedTailLines(withoutQuotedCode(object.message), MAX_MESSAGE_CHARS);
		if (message.length === 0) return null;
		return {
			request: boundedHead(object.request, MAX_REQUEST_CHARS),
			message,
			earlier: object.earlier.slice(-MAX_EARLIER).map((entry) => boundedHead(entry, MAX_EARLIER_CHARS)),
			tools: object.tools.slice(0, MAX_TOOLS),
		};
	},
	questions(object) {
		const questions: Record<string, Question> = {
			asksOperator: ASKS_OPERATOR,
			blocksOnDecision: BLOCKS_ON_DECISION,
			announcedUnstarted: ANNOUNCED_UNSTARTED,
			claimsVerified: CLAIMS_VERIFIED,
			finishedUnit: FINISHED_UNIT,
			midOperation: MID_OPERATION,
		};
		// With no earlier work there is nothing to have switched from or to lean on.
		if (object.earlier.length > 0) {
			questions.switchedGears = SWITCHED_GEARS;
			questions.needsHistory = NEEDS_HISTORY;
		}
		return questions;
	},
	read(answers, _object, cuts) {
		const asksOperator = probability(answers.asksOperator);
		const blocksOnDecision = probability(answers.blocksOnDecision);
		const value: TurnEndValue = {
			asksOperator,
			asks: atCut(asksOperator, cuts.fitted ? cuts.cut("asksOperator") : undefined),
			announcedUnstarted: probability(answers.announcedUnstarted),
			claimsVerified: probability(answers.claimsVerified),
			blocksOnDecision,
			blocks: twoSided(
				blocksOnDecision,
				cuts.fitted ? cuts.cut("blocksOnDecisionFloor") : undefined,
				cuts.fitted ? cuts.cut("blocksOnDecision") : undefined,
			),
			movedOn: {
				switchedGears: probability(answers.switchedGears),
				finishedUnit: probability(answers.finishedUnit),
				midOperation: probability(answers.midOperation),
				needsHistory: rating(answers.needsHistory),
			},
		};
		const readings = [
			value.asksOperator,
			value.announcedUnstarted,
			value.claimsVerified,
			value.blocksOnDecision,
			...Object.values(value.movedOn),
		];
		return readings.every((reading) => reading === null) ? null : value;
	},
	summarize: (value) => ({
		asksOperator: rounded(value.asksOperator),
		asks: value.asks,
		announcedUnstarted: rounded(value.announcedUnstarted),
		claimsVerified: rounded(value.claimsVerified),
		blocksOnDecision: rounded(value.blocksOnDecision),
		blocks: value.blocks,
		switchedGears: rounded(value.movedOn.switchedGears),
		finishedUnit: rounded(value.movedOn.finishedUnit),
		midOperation: rounded(value.movedOn.midOperation),
		needsHistory: rounded(value.movedOn.needsHistory),
	}),
};

/** The probability against an unfitted or missing cut is no decision, which is null and not false. */
function atCut(p: number | null, cut: number | undefined): boolean | null {
	return p === null || cut === undefined ? null : p >= cut;
}

/** True at or above `bar`, false at or below `floor`, and no decision in between or when either is missing. */
function twoSided(p: number | null, floor: number | undefined, bar: number | undefined): boolean | null {
	if (p === null || floor === undefined || bar === undefined || floor >= bar) return null;
	if (p >= bar) return true;
	return p <= floor ? false : null;
}

function rounded(value: number | null): number | null {
	return value === null ? null : round2(value);
}
