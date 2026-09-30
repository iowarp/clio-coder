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

/**
 * The in-run steer for a reply held back on its closing question. The operator
 * already sees the reply without that question, so the model must not restate
 * it, and an answer that declines needs no further text at all.
 */
export const PROSE_QUESTION_STEER_MESSAGE =
	"[Clio Coder] Your reply ended by asking the operator something in prose. The operator already has the rest of that reply; only the closing question was withheld. Call ask_user now with that question, the context needed to answer it, and two to four options with one-line descriptions, recommended first. After the answer, do not restate or summarize your earlier reply: act on the answer, and if the operator declines or says what you gave is sufficient, end the turn without further text.";

export const PLAN_APPROVAL_STEER_MESSAGE =
	'[Clio Coder] You finished a plan without asking whether to proceed. The operator already has the plan. Close the turn with ask_user: one question on whether to carry it out, with options such as "Proceed as planned", "Proceed with changes" (the operator types them) and "Revise the plan first", each with a one-line description. After the answer, do not repeat or summarize the plan: act on the answer, and if the operator declines, end the turn without further text.';

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

/**
 * The reply with its closing question removed: whole trailing paragraphs while
 * the remainder still ends on a question, or only the last sentences of a
 * single closing paragraph that also carries the answer. A reply that is all
 * question yields "". A closing paragraph that holds a fence is kept whole,
 * because cutting a code block to drop one question costs more than it saves.
 */
function withoutClosingQuestion(text: string): string {
	let body = text.trimEnd();
	for (let cuts = 0; cuts < 3 && endsOnProseQuestion(body); cuts += 1) {
		const breakMatch = /\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/u.exec(body);
		const start = breakMatch === null ? 0 : breakMatch.index + breakMatch[0].length;
		const paragraph = body.slice(start);
		if (/^\s*(?:```|~~~)/mu.test(paragraph)) return text;
		// Keep the answer sentences of a one-line paragraph that ends on its
		// question. A multi-line paragraph is a list or a block and goes whole.
		const lastBreak = paragraph.includes("\n")
			? undefined
			: [...paragraph.matchAll(/(?<=[^\d\s])[.!][*_"'’)\]]*[ \t]+(?=\S)/gu)].at(-1);
		if (lastBreak?.index !== undefined) {
			const head = paragraph.slice(0, lastBreak.index + lastBreak[0].trimEnd().length);
			if (!endsOnProseQuestion(head) && endsOnProseQuestion(paragraph.slice(head.length))) {
				return `${body.slice(0, start)}${head}`.trimEnd();
			}
		}
		body = body.slice(0, start).trimEnd();
		if (body.length === 0) return "";
	}
	return endsOnProseQuestion(body) ? text : body;
}

/** A final reply held back before the run settles, and the steer that replaces it. */
export interface FinalReplyHold {
	/** Model-only instruction, delivered inside the same run. */
	steer: string;
	/** What the operator's transcript keeps of the held reply. */
	visibleText: string;
}

export interface FinalReplyGateInput {
	userTurnId?: string | undefined;
	text: string;
	stopReason?: string | undefined;
	/** The reply closed on a terminating tool (a plan artifact), so there is no prose to trim. */
	terminalTool: boolean;
	toolNames: ReadonlyArray<string>;
}

export interface ProseQuestionRegistration extends MiddlewareHookRegistration {
	/**
	 * Decide on a final reply before the run settles. A hold carries the steer
	 * that asks the model for the interview inside the same run, so the
	 * operator sees one turn and one completion. At most one hold per operator
	 * turn: a reply that still ends on a question after the steer goes through.
	 * Once consulted, the turn_end fallback stays silent for that reply.
	 */
	holdFinalReply(input: FinalReplyGateInput): Promise<FinalReplyHold | null>;
	/**
	 * Whether a reply streaming now could still be held. The chat loop keeps a
	 * streaming reply's unfinished last sentence off the transcript only then,
	 * so a question it may withhold never flashes on screen.
	 */
	mayHoldFinalReply(): boolean;
}

export interface ProseQuestionDeps {
	getTurnConstraints?: () => TurnConstraints | undefined;
	/** True only where an operator can answer an interview (interactive, with ask_user registered). */
	askUserAvailable: () => boolean;
	/**
	 * True when a turn-end reading is bound. Bound, a reply the regex reads as a
	 * question waits for that reading before it earns a continuation.
	 */
	turnEndBound?: () => boolean;
	/**
	 * Whether the closing text stops on a decision the operator must make. False
	 * says it is an invitation or an offer of further help, which needs no
	 * interview, and the continuation is dropped. Null means unbound, unfitted or
	 * too slow, and the regex reading stands exactly as it does without System One.
	 */
	blocksOnOperator?: (turn: {
		userTurnId: string;
		request: string;
		message: string;
		toolNames: ReadonlyArray<string>;
	}) => Promise<boolean | null>;
}

interface DeferredContinuation {
	readonly userTurnId: string;
	readonly request: string;
	readonly message: string;
	readonly toolNames: ReadonlyArray<string>;
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
 *
 * A trailing question mark or an offer phrase is only a proxy for a reply that
 * blocks on the operator, so "What are you looking to do?" after a greeting
 * reads the same as "Which of these two should I pick?". With a turn-end site
 * bound, the regex proposes and the site disposes: it reads whether the message
 * stops on a required decision, and an invitation is left alone.
 */
export function createProseQuestionRegistration(deps: ProseQuestionDeps): ProseQuestionRegistration {
	let substantiveTurn = false;
	let planRequested = false;
	let wroteThisTurn = false;
	let planArtifactWritten = false;
	let askedThisTurn = false;
	let requestText = "";
	let deferred: DeferredContinuation | null = null;
	// The in-run gate already read this turn's final reply, or already steered it.
	let finalChecked = false;
	let steered = false;
	const gateOpen = (stopReason: unknown): boolean => {
		if (!isNormalStopReason(stopReason)) return false;
		if (!turnAllowsTool(deps.getTurnConstraints?.(), ToolNames.AskUser)) return false;
		try {
			return deps.askUserAvailable();
		} catch {
			return false;
		}
	};
	const needsPlanApproval = (text: string): boolean =>
		planRequested && !wroteThisTurn && !askedThisTurn && (planArtifactWritten || text.trim().length >= PLAN_MIN_CHARS);
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
				requestText = input.text ?? "";
				deferred = null;
				finalChecked = false;
				steered = false;
				return NO_EFFECTS;
			}
			if (input.hook === "after_tool") {
				// A tool ran after the gate read a reply, so the run goes on and a
				// later reply is the final one.
				finalChecked = false;
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
			// The in-run gate owns every reply it saw. What remains below is the
			// fallback for a host that never consults it: a continuation after settle.
			if (steered || finalChecked) return NO_EFFECTS;
			if (!gateOpen(input.metadata?.stopReason)) return NO_EFFECTS;
			// An interview earlier in the turn does not cover a question the
			// closing text asks after it.
			const text = input.text ?? "";
			if (endsOnProseQuestion(text)) {
				const userTurnId = input.metadata?.userTurnId;
				if (deps.blocksOnOperator !== undefined && deps.turnEndBound?.() === true && typeof userTurnId === "string") {
					// This phase cannot wait for the reading, so the async phase decides.
					const names = input.metadata?.turnToolNames;
					deferred = {
						userTurnId,
						request: requestText,
						message: text,
						toolNames: typeof names === "string" ? names.split(",").filter((name) => name.length > 0) : [],
					};
					return NO_EFFECTS;
				}
				return [{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE }];
			}
			// A planning turn ends on the operator's go-ahead, which is itself a
			// question even when the plan never phrases one. A plan already carried
			// out needs none, and neither does one the operator already answered an
			// interview about: an approved plan may be implemented by dispatch,
			// which leaves no write in this run.
			if (needsPlanApproval(text)) {
				return [{ kind: "request_continuation", message: PLAN_APPROVAL_CONTINUATION_MESSAGE }];
			}
			return NO_EFFECTS;
		},
		mayHoldFinalReply(): boolean {
			return substantiveTurn && !steered && gateOpen("stop");
		},
		async holdFinalReply(input): Promise<FinalReplyHold | null> {
			if (!substantiveTurn || steered) return null;
			finalChecked = true;
			if (!gateOpen(input.stopReason)) return null;
			if (!input.terminalTool && endsOnProseQuestion(input.text)) {
				if (deps.blocksOnOperator !== undefined && deps.turnEndBound?.() === true && input.userTurnId) {
					let blocks: boolean | null = null;
					try {
						blocks = await deps.blocksOnOperator({
							userTurnId: input.userTurnId,
							request: requestText,
							message: input.text,
							toolNames: input.toolNames,
						});
					} catch {
						// An unreadable verdict is no verdict, and the regex reading stands.
					}
					if (blocks === false) return null;
				}
				steered = true;
				return { steer: PROSE_QUESTION_STEER_MESSAGE, visibleText: withoutClosingQuestion(input.text) };
			}
			if (needsPlanApproval(input.text)) {
				steered = true;
				return { steer: PLAN_APPROVAL_STEER_MESSAGE, visibleText: input.text };
			}
			return null;
		},
		async evaluateAsync(): Promise<ReadonlyArray<MiddlewareEffect>> {
			const pending = deferred;
			deferred = null;
			if (pending === null || deps.blocksOnOperator === undefined) return NO_EFFECTS;
			let blocks: boolean | null = null;
			try {
				blocks = await deps.blocksOnOperator(pending);
			} catch {
				// An unreadable verdict is no verdict, and the regex reading stands.
			}
			return blocks === false
				? NO_EFFECTS
				: [{ kind: "request_continuation", message: PROSE_QUESTION_CONTINUATION_MESSAGE }];
		},
	};
}
