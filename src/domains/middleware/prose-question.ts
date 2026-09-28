import { ToolNames } from "../../core/tool-names.js";
import { type TurnConstraints, turnAllowsTool } from "../../core/turn-constraints.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import { isSubstantiveUserTurn } from "./skills-reminder.js";
import { isNormalStopReason } from "./stalled-turn.js";
import type { MiddlewareEffect } from "./types.js";

export const PROSE_QUESTION_REGISTRATION_ID = "nudge.prose-question";

export const PROSE_QUESTION_CONTINUATION_MESSAGE =
	"Your reply ended by asking the operator something in prose: a question, a menu of options, or a wait for approval. Questions for the operator go through ask_user. Call it now with that question, the context needed to answer it, and two to four options with one-line descriptions, recommended first. Do not repeat the rest of your reply.";

export const PLAN_APPROVAL_CONTINUATION_MESSAGE =
	'You finished a plan without asking whether to proceed. Close the turn with ask_user: one question on whether to carry out this plan, with options such as "Proceed as planned", "Proceed with changes" (the operator types them) and "Revise the plan first", each with a one-line description. Do not repeat the plan.';

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

// The operator asked for a plan; the turn's deliverable is a proposal awaiting a go-ahead.
const PLAN_REQUEST_PATTERN =
	/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:plan\b|(?:draft|write|make|create|give me)\s+(?:a\s+|the\s+)?(?:plan|proposal)\b|propose\b|outline\s+(?:a\s+|the\s+)?plan\b)/iu;
// A plan short enough to be a clarifying reply is not a finished plan.
const PLAN_MIN_CHARS = 400;
const WRITE_TOOLS: ReadonlySet<string> = new Set([ToolNames.Edit, ToolNames.Write]);

/** How much of the reply's end is read: the closing paragraph plus a short trailing option list. */
const TAIL_LINES = 6;
const TAIL_CHARS = 700;

// A sentence that ends in "?" outside inline code. Trailing markdown emphasis
// and closing quotes still count as the end of the sentence.
const QUESTION_SENTENCE_PATTERN = /\?[*_"'’)\]]*(?:\s|$)/u;
// Offers and approval waits that hand the operator a decision without a
// question mark: "let me know", "want me to", "for when you're ready to proceed".
const OFFER_PATTERN =
	/\b(?:let me know|would you like|do you want|want me to|shall i|should i|if you(?:'d| would) like|if you want(?: me to|,? i (?:can|could))|if you can (?:paste|share|send)|(?:please|could you) (?:paste|share|send)|which (?:one|option|approach) (?:do|would|should) you|when you(?:'re| are) ready|ready to proceed|(?:your|the) go-?ahead|(?:say|reply|type) ["'“]?(?:go|yes|proceed)|(?:after|pending|awaiting|upon) (?:your |the operator(?:'s)? )?(?:approval|confirmation|sign-?off)|once (?:you|the operator) (?:confirms?|approves?|agrees?)|if you approve)\b/iu;

// Courtesy closers invite the next request; they ask for no decision, and an
// interview built from one only adds a turn. Removed before the test below.
const COURTESY_CLOSER_PATTERN =
	/(?:^|(?<=[.!?]\s))(?:so,?\s+)?(?:what (?:would|do) you (?:like|want) to (?:work on|do|tackle)(?: next| today| in this session)?|how can i help(?: you)?(?: today| next)?|anything else(?: you need| i can help with)?|what(?:'s| is) next|what are we (?:working on|doing) today)\?/giu;

function stripInlineCode(line: string): string {
	return line.replace(/`[^`]*`/gu, "");
}

/**
 * True when a reply's closing lines ask the operator something: a question
 * sentence or an offer menu ("I can: 1. ... 2. ..."). Fenced code is skipped,
 * so a question mark inside a code sample never counts.
 */
function endsOnProseQuestion(text: string): boolean {
	const lines: string[] = [];
	let inFence = false;
	for (const raw of text.split(/\r?\n/u)) {
		if (/^\s*(?:```|~~~)/u.test(raw)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const line = stripInlineCode(raw).trim();
		if (line.length > 0) lines.push(line);
	}
	let tail = lines.slice(-TAIL_LINES).join("\n").replace(COURTESY_CLOSER_PATTERN, "").trim();
	if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
	const closingLines = tail.split("\n");
	const last = closingLines.at(-1) ?? "";
	const endsWithQuestion = /\?[*_"'’)\]]*$/u.test(last);
	const endsWithOptions =
		/^(?:[-*]|\d+[.)])\s/u.test(last) && QUESTION_SENTENCE_PATTERN.test(closingLines.slice(-3, -1).join("\n"));
	return endsWithQuestion || endsWithOptions || OFFER_PATTERN.test(closingLines.slice(-3).join("\n"));
}

export interface ProseQuestionDeps {
	getTurnConstraints?: () => TurnConstraints | undefined;
	/** True only where an operator can answer an interview (interactive, with ask_user registered). */
	askUserAvailable: () => boolean;
}

/**
 * The operator asked that every question reach them as an ask_user interview,
 * never as prose left at the end of a reply. The prompt says so; small local
 * models still close a turn on "Could you clarify...? I can: 1. 2." This
 * registration makes the rule hold whatever the model: a substantive turn
 * that ends on a question or an offer without calling ask_user gets one
 * automatic continuation to ask it properly, and a requested plan that ends
 * without a go-ahead question gets one to ask for approval.
 *
 * One operator submission is one turn_start and one turn_end. An ask_user
 * round runs inside that run and its answer returns as a tool result, so the
 * closing text checked here already follows every interview of the turn. The
 * runtime grants one continuation per operator prompt, so a continuation turn
 * is never checked: it could only report the spent cap. Greetings are left
 * alone.
 */
export function createProseQuestionRegistration(deps: ProseQuestionDeps): MiddlewareHookRegistration {
	let substantiveTurn = false;
	let planRequested = false;
	let wroteThisTurn = false;
	let planArtifactWritten = false;
	let askedThisTurn = false;
	return {
		id: PROSE_QUESTION_REGISTRATION_ID,
		description: "request one continuation when a substantive turn ends on a prose question instead of ask_user",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "turn_start") {
				substantiveTurn = input.metadata?.requestContinuation !== true && isSubstantiveUserTurn(input.text);
				planRequested = substantiveTurn && PLAN_REQUEST_PATTERN.test(input.text ?? "");
				wroteThisTurn = false;
				planArtifactWritten = false;
				askedThisTurn = false;
				return NO_EFFECTS;
			}
			if (input.hook === "after_tool") {
				if (input.toolName === ToolNames.AskUser) askedThisTurn = true;
				if (input.toolName !== undefined && WRITE_TOOLS.has(input.toolName)) wroteThisTurn = true;
				// A plan written as a terminal artifact is still a plan awaiting a
				// go-ahead. The terminal call closes the run with empty text.
				if (input.toolName === ToolNames.Artifact && input.toolArgs?.kind === "plan" && input.metadata?.resultKind === "ok")
					planArtifactWritten = true;
				return NO_EFFECTS;
			}
			if (input.hook !== "turn_end" || !substantiveTurn) return NO_EFFECTS;
			substantiveTurn = false;
			if (!isNormalStopReason(input.metadata?.stopReason)) return NO_EFFECTS;
			if (!turnAllowsTool(deps.getTurnConstraints?.(), ToolNames.AskUser)) return NO_EFFECTS;
			try {
				if (!deps.askUserAvailable()) return NO_EFFECTS;
			} catch {
				return NO_EFFECTS;
			}
			// An interview earlier in the turn does not cover a question the
			// closing text asks after it.
			const text = input.text ?? "";
			if (endsOnProseQuestion(text)) {
				return [{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE }];
			}
			// A planning turn ends on the operator's go-ahead, which is itself a
			// question even when the plan never phrases one. A plan already carried
			// out needs none, and neither does one the operator already answered an
			// interview about: an approved plan may be implemented by dispatch,
			// which leaves no write in this run.
			if (
				planRequested &&
				!wroteThisTurn &&
				!askedThisTurn &&
				(planArtifactWritten || text.trim().length >= PLAN_MIN_CHARS)
			) {
				return [{ kind: "request_continuation", message: PLAN_APPROVAL_CONTINUATION_MESSAGE }];
			}
			return NO_EFFECTS;
		},
	};
}
