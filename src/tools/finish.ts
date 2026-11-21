import { Type } from "typebox";
import {
	COMPLETION_LIMITATION_REASONS,
	COMPLETION_STATES,
	type CompletionDeclaration,
	type CompletionState,
	parseCompletionDeclaration,
} from "../core/completion.js";
import { ToolNames } from "../core/tool-names.js";
import type { CompletionFact } from "../domains/middleware/index.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { effectiveToolCall } from "./surface.js";

/**
 * The main agent's completion declaration (fleet design 4.3). The model writes its reply text and calls `finish` alone
 * in the same response; the result ends the turn (`terminate`), so no further round is spent. The declaration is the
 * typed signal every reader takes: the run envelope, `run --exit-code`, the finish gate and the open-tasks nudge. It is
 * never read from the reply text. The tool is pure: the tool_call and tool_result pair in the session ledger is its
 * whole effect.
 */

/**
 * How a turn ended as the host seals it (fleet design 4.3): the claim as given beside the host's assessment.
 * `assessed` is min(claimed, facts): a `done` claim over any open coordinator obligation is `partly_done`; an
 * undeclared turn is `unknown`.
 */
export interface SealedCompletion {
	declared: boolean;
	claimed: CompletionState | null;
	assessed: CompletionState | "unknown";
	facts: CompletionFact[];
	limitations: CompletionDeclaration["limitations"];
	unverified: string[];
	remaining?: string[];
}

export function sealCompletion(
	declaration: CompletionDeclaration | null,
	facts: ReadonlyArray<CompletionFact>,
): SealedCompletion {
	const unique = [...new Set(facts)];
	if (declaration === null)
		return { declared: false, claimed: null, assessed: "unknown", facts: unique, limitations: [], unverified: [] };
	return {
		declared: true,
		claimed: declaration.state,
		assessed: declaration.state === "done" && unique.length > 0 ? "partly_done" : declaration.state,
		facts: unique,
		limitations: declaration.limitations,
		unverified: declaration.unverified,
		...(declaration.remaining !== undefined ? { remaining: declaration.remaining } : {}),
	};
}

/** The declaration in a `finish` call's arguments or result details, or null when it is not one. */
function parseCompletion(value: unknown): CompletionDeclaration | null {
	const parsed = parseCompletionDeclaration(value, { closed: false });
	return parsed.ok ? parsed.completion : null;
}

/** The declaration a settled tool result carries, read from its details; null for any other result. */
export function completionOfToolResult(toolName: string, result: unknown): CompletionDeclaration | null {
	if (toolName !== ToolNames.Finish) return null;
	const details = (result as { details?: { completion?: unknown } } | null | undefined)?.details;
	return parseCompletion(details?.completion);
}

/**
 * `finish` declares how the reply it closes ended, so it runs alone: a call beside it would settle after the turn
 * ended. Only the finish call is refused; its siblings run, and the model declares once it has their results.
 */
export function finishSiblingRefusal(
	toolCall: { name: string; arguments: unknown },
	assistantMessage: { content: ReadonlyArray<{ type: string }> },
): { block: true; reason: string } | undefined {
	if (effectiveToolCall(toolCall.name, toolCall.arguments).toolName !== ToolNames.Finish) return undefined;
	if (assistantMessage.content.filter((block) => block.type === "toolCall").length === 1) return undefined;
	return {
		block: true,
		reason:
			"finish must be the only tool call in its response: it did not run, and the other calls in this batch did. Use their results, then write your reply to the user as text and, in that same response, call finish as the only tool call.",
	};
}

/**
 * Nobody watches the turn: a headless run, a job, or a yolo continuation (fleet design 4.3, ruling 11) of a prompt
 * nobody watches. A continuation is judged by the prompt that owns its chain, so a roll of an operator's or a peer's
 * prompt in an attended session stays attended (CLI-P46); an unknown owner keeps it unattended.
 */
function unattendedTurn(turn: {
	headless: boolean;
	origin: string | undefined;
	promptOrigin?: string | null | undefined;
}): boolean {
	if (turn.headless) return true;
	if (turn.origin !== "continuation") return turn.origin === "job";
	return turn.promptOrigin !== "operator" && turn.promptOrigin !== "peer";
}

/**
 * On an attended turn `finish` closes the reply the operator reads, so a response that carries no assistant text is
 * refused before it runs and declares nothing (FX-40). The refusal runs before the registry, where no loop guard or
 * turn budget sees it, so it happens at most once per user turn: a later bare finish in that turn runs, and its
 * declaration records the missing reply as a limitation. The check is typed: a non-empty text block in that response,
 * never its wording. A headless main run is held to the same rule over its whole user turn (CLI-P49): its first bare
 * finish is refused only when no response since the prompt carried text, so the pinned declaration round after a
 * written reply still declares. Any other unattended turn (a job, a continuation nobody watches) keeps a bare finish.
 */
export function bareFinishVerdict(
	toolCall: { name: string; arguments: unknown },
	assistantMessage: { content: ReadonlyArray<{ type: string; text?: unknown }> },
	turn: {
		headless: boolean;
		origin: string | undefined;
		promptOrigin?: string | null;
		refusedThisTurn: boolean;
		repliedThisTurn?: boolean;
	},
): "refuse" | "admit" | null {
	if (turn.headless) {
		if (turn.repliedThisTurn === true) return null;
	} else if (unattendedTurn(turn)) return null;
	if (effectiveToolCall(toolCall.name, toolCall.arguments).toolName !== ToolNames.Finish) return null;
	if (hasReplyText(assistantMessage)) return null;
	return turn.refusedThisTurn ? "admit" : "refuse";
}

/** Whether an assistant response carries a non-empty text block: the typed reply fact, never its wording. */
function hasReplyText(message: { content?: unknown }): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some(
			(block: { type?: unknown; text?: unknown } | null) =>
				block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
		)
	);
}

export const FINISH_WITHOUT_REPLY_REFUSAL =
	"finish did not run: this response has no reply text. Write your reply to the user as text first; then, in that same response, call finish as the only tool call.";

/**
 * The declaration of a bare finish admitted after its turn's one refusal, with the missing reply on record (FX-40). A
 * headless run has no operator to read anything else (CLI-P49), so its claim drops from done to partly_done and the
 * reply is listed unverified.
 */
export function withoutReplyLimitation(completion: CompletionDeclaration, headless = false): CompletionDeclaration {
	const limited: CompletionDeclaration = {
		...completion,
		limitations: [
			...completion.limitations,
			{ what: "the response that declared completion carried no reply text for the operator", why: "other" },
		],
	};
	if (!headless) return limited;
	return {
		...limited,
		state: completion.state === "done" ? "partly_done" : completion.state,
		unverified: [...completion.unverified, "no reply text: the run wrote no answer for the request"],
	};
}

/** What a declaration's result says: its state and how many limitations it records. */
function declarationText(completion: CompletionDeclaration): string {
	const count = completion.limitations.length;
	const suffix = count > 0 ? ` (${count} limitation${count === 1 ? "" : "s"})` : "";
	return `completion declared: ${completion.state}${suffix}\n`;
}

/**
 * The settled result of an admitted bare finish with the missing reply in the declaration it carries (FX-40). The
 * host amends the result itself, so the transcript, the session ledger and every reader of the declaration see the
 * limitation, not only the turn's seal. Undefined for a result that carries no declaration.
 */
export function withoutReplyResult(
	result: unknown,
	headless = false,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } | undefined {
	const completion = completionOfToolResult(ToolNames.Finish, result);
	if (completion === null) return undefined;
	const amended = withoutReplyLimitation(completion, headless);
	const details = (result as { details?: Record<string, unknown> }).details;
	return { content: [{ type: "text", text: declarationText(amended) }], details: { ...details, completion: amended } };
}

/** The host's note on the one round an unattended turn spends to declare; it rides the request tail, never the prefix. */
export const FINISH_DECLARATION_REMINDER =
	"<system-reminder>Nobody is watching this turn and it ended without a completion declaration. Call finish now with the state the work is in (done, partly_done or not_done), its limitations and anything left unverified. Do not repeat your reply.</system-reminder>";

/**
 * Whether a turn that just ended gets the one round pinned to `finish` (fleet design 4.3, ruling 11): only an unattended
 * turn (a headless run, a job, a yolo continuation of a prompt nobody watches) that did work and ended without
 * declaring, once per operator prompt, while tools are not locked and `finish` is attached. An attended turn may leave
 * its declaration out.
 */
export function finishRoundDue(turn: {
	headless: boolean;
	origin: string | undefined;
	promptOrigin?: string | null;
	declared: boolean;
	calledWork: boolean;
	spent: boolean;
	toolsLocked: boolean;
	endedOnTerminalTool: boolean;
	finishAttached: boolean;
}): boolean {
	return (
		unattendedTurn(turn) &&
		turn.calledWork &&
		!turn.declared &&
		!turn.spent &&
		!turn.toolsLocked &&
		!turn.endedOnTerminalTool &&
		turn.finishAttached
	);
}

/** A model that writes the reason as prose still declares; the prose stays in `what`. */
function normalizeLimitations(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => {
		const entry = item as { what?: unknown; why?: unknown } | null;
		if (
			entry === null ||
			typeof entry !== "object" ||
			(COMPLETION_LIMITATION_REASONS as ReadonlyArray<unknown>).includes(entry.why)
		)
			return item;
		const why = typeof entry.why === "string" ? entry.why.trim() : "";
		const what = typeof entry.what === "string" ? entry.what.trim() : "";
		return { ...entry, what: why.length > 0 && what.length > 0 ? `${what} (${why})` : what || why, why: "other" };
	});
}

export const finishTool: ToolSpec = {
	name: ToolNames.Finish,
	// The schema stays at its floor (fleet design open question 10): the enums carry the meaning, and the operating
	// fragments carry the guidance on when and how to declare. The wording is measured (CLI-P49): "call it alone"
	// read to some models as "the response is only this call", so the description says the reply text comes first.
	description:
		"Declare how the turn ended. Write your reply to the user as text first; then, in that same response, call finish as the only tool call. finish adds no text of its own and ends the turn.",
	parameters: Type.Object({
		state: StringEnum(COMPLETION_STATES),
		limitations: Type.Optional(
			Type.Array(Type.Object({ what: Type.String(), why: StringEnum(COMPLETION_LIMITATION_REASONS) })),
		),
		unverified: Type.Optional(Type.Array(Type.String())),
		remaining: Type.Optional(Type.Array(Type.String())),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
	prepareArguments(args) {
		return args.limitations === undefined ? args : { ...args, limitations: normalizeLimitations(args.limitations) };
	},
	async run(args): Promise<ToolResult> {
		const completion = parseCompletion(args);
		if (completion === null)
			return {
				kind: "error",
				message: `finish: state must be one of ${COMPLETION_STATES.join(", ")}, each limitation needs what and why (${COMPLETION_LIMITATION_REASONS.join(", ")}), and unverified and remaining are string arrays`,
			};
		return {
			kind: "ok",
			output: declarationText(completion),
			details: { completion },
			terminate: true,
		};
	},
};
