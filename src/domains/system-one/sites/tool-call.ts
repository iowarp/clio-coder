/**
 * `toolCall`: how far a proposed tool call reaches and whether it destroys
 * anything that cannot be brought back.
 *
 * Two sites judge the same object at two moments. The card site runs while the
 * operator reads an approval card that is already open: it adds one advisory
 * sentence when an answer arrives in time and nothing otherwise, and no build
 * cut applies because nothing acts on it. The gate site runs before the
 * classifier admits a call: under a fitted build a call that reads as reaching
 * far, or as destroying data, is escalated to the operator. It only ever adds
 * friction. A call the classifier already parks is unchanged, and an unfitted
 * build never escalates anything.
 *
 * The call is described by its allowlisted, secret-redacted one-line target
 * exactly as the card shows it, so the engine never sees raw arguments,
 * mutation text or a transcript.
 */

import { isTrue, rating } from "../answers.js";
import { rate, yesNo } from "../questions.js";
import type { Answer, Question, SiteDefinition } from "../types.js";
import { boundedHead, probability, round2 } from "./bounds.js";

/** Code points of the card target sent. The card itself bounds it well under this. */
const MAX_TARGET_CHARS = 240;
/** How certain the engine must be before the card says anything at all. */
const CARD_MIN_CERTAINTY = 0.25;

/**
 * The blast-radius ladder, lowest rung first.
 *
 * Rungs are written as what the call does to the world rather than as severity
 * words, because "medium risk" means nothing to an operator deciding about one
 * specific command and "changes state version control cannot restore" does.
 *
 * The top rung names changing remote state, not reaching a remote host. The v1
 * wording said "reaches another machine", and jev-latest followed it exactly:
 * a plain `curl` GET read as irreversible, so the card cried wolf on every
 * download.
 */
export const TOOL_CALL_RUNGS = [
	{
		label: "contained",
		criteria:
			"Only reads: lists, inspects, searches, or downloads for display, and changes nothing on this machine or any other.",
	},
	{
		label: "local",
		criteria:
			"Creates, changes or deletes files inside the workspace, including downloads, installed dependencies and build output, in a way version control, a reinstall or a rebuild can restore.",
	},
	{
		label: "broad",
		criteria:
			"Changes state outside the workspace on this machine, or throws away uncommitted changes, untracked files or history inside it that version control cannot bring back.",
	},
	{
		label: "irreversible",
		criteria:
			"Deletes or overwrites data outside the workspace for good, or changes state on another machine or a published service: pushes, publishes, deploys, uploads, or remote writes and deletes.",
	},
] as const;

export type ToolCallRung = (typeof TOOL_CALL_RUNGS)[number]["label"];

const RADIUS_QUESTION = rate(
	"How far does this call reach?",
	TOOL_CALL_RUNGS.map((rung) => rung.criteria),
);

const OUTSIDE_QUESTION = yesNo(
	"Does this call change anything outside the workspace directory?",
	"Touches state outside the workspace",
	"Stays inside the workspace",
);

const DESTROYS_QUESTION = yesNo(
	"Does this call delete, overwrite or discard data that version control, a reinstall or a rebuild cannot bring back?",
	"Deletes or overwrites files, throws away uncommitted changes, untracked files or commits, or rewrites or removes remote data, so that no copy remains",
	"Reads, adds, or changes only what version control, a reinstall or a rebuild can restore, including deleting build output or installed dependencies",
);

export interface ToolCallObject {
	readonly tool: string;
	readonly actionClass: string;
	/** The call's allowlisted, secret-redacted, sanitized one-line target, exactly as the card shows it. */
	readonly target: string;
	readonly moment: "card" | "gate";
}

export interface ToolCallCardValue {
	/** Expected position on the ladder, 0 (contained) to 3 (irreversible), interpolated between rungs. */
	readonly score: number;
	/** The nearest rung's short name. */
	readonly label: ToolCallRung;
	/** Null when the engine was undecided about reach, which is not a "no". */
	readonly outside: boolean | null;
	/** Null when the engine was undecided about destruction, which is not a "no". */
	readonly destroys: boolean | null;
	/** The advisory sentence the card shows. */
	readonly line: string;
}

export interface ToolCallGateValue {
	/** Whether the call should go to the operator whatever the classifier said. */
	readonly escalate: boolean;
	/** Why, for the operator and the ledger. */
	readonly reason: string;
}

function state(object: ToolCallObject): Readonly<Record<string, unknown>> | null {
	const target = boundedHead(object.target, MAX_TARGET_CHARS);
	if (object.tool.trim().length === 0) return null;
	return { tool: object.tool, action: object.actionClass, target };
}

function rungLabel(score: number): ToolCallRung {
	const index = Math.min(TOOL_CALL_RUNGS.length - 1, Math.max(0, Math.round(score)));
	return (TOOL_CALL_RUNGS[index] as (typeof TOOL_CALL_RUNGS)[number]).label;
}

/** The ladder position on a 0..1 scale, the scale a `toolCall.gateRadius` cut is written on. */
function normalizedRadius(score: number): number {
	return Math.min(1, Math.max(0, score / (TOOL_CALL_RUNGS.length - 1)));
}

/**
 * The advisory sentence. The wording leads with what it is not, because an
 * operator who reads a risk rating on an approval card will otherwise
 * reasonably assume the harness acted on it. Nothing here changes what allow
 * and deny do.
 */
function advisoryLine(label: ToolCallRung, outside: boolean | null, build: string): string {
	const reach =
		outside === true ? " It reaches outside the workspace." : outside === false ? " It stays inside the workspace." : "";
	return `Experimental advisory only, nothing below is gated on it: blast radius reads as ${label}.${reach} Judged by ${build}.`;
}

export const TOOL_CALL_CARD_SITE: SiteDefinition<ToolCallObject, ToolCallCardValue> = {
	id: "toolCall",
	version: "tool-call-v2",
	deadlineMs: 5000,
	moment: "card",
	state,
	questions: () => ({ radius: RADIUS_QUESTION, outside: OUTSIDE_QUESTION, destroys: DESTROYS_QUESTION }),
	read(answers, _object, cuts) {
		// An undecided rating has no rung to name, so the card stays as it was.
		const score = rating(answers.radius, CARD_MIN_CERTAINTY);
		if (score === null) return null;
		const label = rungLabel(score);
		const outside = decided(answers.outside);
		return {
			score,
			label,
			outside,
			destroys: decided(answers.destroys),
			line: advisoryLine(label, outside, cuts.build),
		};
	},
	summarize: (value) => ({
		score: round2(value.score),
		label: value.label,
		outside: value.outside,
		destroys: value.destroys,
	}),
};

function decided(answer: Answer | undefined): boolean | null {
	return answer !== undefined && answer.certainty >= CARD_MIN_CERTAINTY ? isTrue(answer) : null;
}

const GATE_QUESTIONS: Readonly<Record<string, Question>> = { radius: RADIUS_QUESTION, destroys: DESTROYS_QUESTION };

export const TOOL_CALL_GATE_SITE: SiteDefinition<ToolCallObject, ToolCallGateValue> = {
	id: "toolCall",
	version: "tool-call-v2",
	deadlineMs: 1500,
	moment: "gate",
	state,
	questions: () => GATE_QUESTIONS,
	read(answers, _object, cuts) {
		const score = rating(answers.radius);
		const destroys = probability(answers.destroys);
		if (score === null && destroys === null) return null;
		const radiusCut = cuts.fitted ? cuts.cut("gateRadius") : undefined;
		const destroysCut = cuts.fitted ? cuts.cut("gateDestroys") : undefined;
		if (score !== null && radiusCut !== undefined && normalizedRadius(score) >= radiusCut) {
			return {
				escalate: true,
				reason: `System One reads this call's blast radius as ${rungLabel(score)} (${cuts.build})`,
			};
		}
		if (destroys !== null && destroysCut !== undefined && destroys >= destroysCut) {
			return {
				escalate: true,
				reason: `System One reads this call as destroying data that version control or a reinstall cannot bring back (${cuts.build})`,
			};
		}
		return { escalate: false, reason: "below the escalation cuts" };
	},
	summarize: (value) => ({ escalate: value.escalate, reason: value.reason }),
};
