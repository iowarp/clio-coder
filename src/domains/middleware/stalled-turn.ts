import type { MiddlewareRuleDefinition } from "./runtime.js";
import type { MiddlewareHookInput } from "./types.js";

export const STALLED_TURN_REGISTRATION_ID = "nudge.stalled-turn";

export const STALLED_TURN_REQUEST_CONTINUATION_MESSAGE =
	"You ended your turn after announcing an action without executing it: no tools were called. Continue now and perform the announced action, or state plainly that you are finished and waiting for the user.";

const INTENT_PATTERN = /\b(let me|i['’]ll|i will|i am going to|i['’]m going to|now i|next i|let's|let us)\b/i;
const LET_ME_KNOW_PATTERN = /\blet me know\b/i;
const COMPLETION_PATTERN =
	/^\s*(?:all\s+done|done|complete|completed|all\s+set)\b|^\s*(?:here(?:'s| is)\s+)?(?:a\s+)?summary\b|^\s*summary\s*:?$/i;

export const STALLED_TURN_RULE_DEFINITION: MiddlewareRuleDefinition = {
	rule: {
		id: STALLED_TURN_REGISTRATION_ID,
		source: "builtin",
		description: "request an automatic continuation when a turn announces work but calls no tools",
		enabled: true,
		hooks: ["turn_end"],
		effectKinds: ["request_continuation"],
	},
	effects: [{ kind: "request_continuation", message: STALLED_TURN_REQUEST_CONTINUATION_MESSAGE }],
	predicate: shouldRequestStalledTurnContinuation,
};

export function shouldRequestStalledTurnContinuation(input: MiddlewareHookInput): boolean {
	if (input.hook !== "turn_end") return false;
	if (input.metadata?.turnToolCalls !== 0) return false;
	if (!isNormalStopReason(input.metadata?.stopReason)) return false;

	const lastLine = lastNonEmptyLine(input.text ?? "");
	if (lastLine === null) return false;
	const finalSentence = lastSentence(lastLine);
	if (finalSentence.length === 0) return false;

	if (isQuestion(finalSentence)) return false;
	if (LET_ME_KNOW_PATTERN.test(finalSentence)) return false;
	if (COMPLETION_PATTERN.test(lastLine) || COMPLETION_PATTERN.test(finalSentence)) return false;

	return finalSentence.endsWith(":") || INTENT_PATTERN.test(finalSentence);
}

function isNormalStopReason(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value !== "string") return false;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized === "stop" || normalized === "end_turn" || normalized.startsWith("stop_sequence");
}

function lastNonEmptyLine(text: string): string | null {
	const lines = text.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim();
		if (line && line.length > 0) return line;
	}
	return null;
}

function lastSentence(line: string): string {
	const matches = line.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g);
	const sentence = matches?.at(-1)?.trim() ?? line.trim();
	return sentence.replace(/^[\s"'([{-]+/, "").trim();
}

function isQuestion(sentence: string): boolean {
	return /[?]["')\]]*$/.test(sentence.trim());
}
