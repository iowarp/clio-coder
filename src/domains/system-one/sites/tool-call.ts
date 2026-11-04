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

import type { ToolCallRung } from "../../safety/reach-ladder.js";
import { TOOL_CALL_RUNGS } from "../../safety/reach-ladder.js";
import { rating } from "../answers.js";
import { rate, yesNo } from "../questions.js";
import type { Answer, Question, SiteDefinition } from "../types.js";
import { boundedHead, probability, round2 } from "./bounds.js";

/** Code points of the card target sent. The card itself bounds it well under this. */
const MAX_TARGET_CHARS = 240;

export type { ToolCallRung };
export { TOOL_CALL_RUNGS };

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
	const reach = outside === true ? " It reaches outside the workspace." : "";
	return `Experimental advisory only, nothing below is gated on it: blast radius reads as ${label}.${reach} Judged by ${build}.`;
}

export const TOOL_CALL_CARD_SITE: SiteDefinition<ToolCallObject, ToolCallCardValue> = {
	id: "toolCall",
	version: "tool-call-v3",
	deadlineMs: 5000,
	moment: "card",
	// No request is spent on an advisory a build has no floor to show.
	requiredCut: "cardFloor",
	state,
	questions: () => ({ radius: RADIUS_QUESTION, outside: OUTSIDE_QUESTION, destroys: DESTROYS_QUESTION }),
	read(answers, _object, cuts) {
		// An undecided rating has no rung to name, so the card stays as it was.
		const floor = cuts.cut("cardFloor");
		if (floor === undefined) return null;
		const score = rating(answers.radius, floor);
		if (score === null) return null;
		const label = rungLabel(score);
		// Each reach and loss claim is made only past its own measured cut, and silence is not a claim of safety.
		const atCut = (answer: Answer | undefined, cut: number | undefined): boolean | null => {
			const p = probability(answer);
			return p !== null && cut !== undefined && p >= cut ? true : null;
		};
		const outside = atCut(answers.outside, cuts.cut("cardOutside"));
		return {
			score,
			label,
			outside,
			destroys: atCut(answers.destroys, cuts.cut("cardDestroys")),
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
