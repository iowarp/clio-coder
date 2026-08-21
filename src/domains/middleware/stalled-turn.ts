import type { MiddlewareRuleDefinition } from "./runtime.js";
import type { MiddlewareHookInput } from "./types.js";

export const STALLED_TURN_REGISTRATION_ID = "nudge.stalled-turn";

export const STALLED_TURN_REQUEST_CONTINUATION_MESSAGE =
	"You ended your turn after announcing an action without executing it: no tools were called. Continue now and perform the announced action, or state plainly that you are finished and waiting for the user.";

const INTENT_PATTERN = /\b(let me|i['’]ll|i will|i am going to|i['’]m going to|now i|next i|let's|let us)\b/i;
const CONCRETE_ACTION_PATTERN =
	/\b(?:add|analy[sz]e|apply|audit|build|change|check|compare|compile|create|debug|delete|edit|execute|explore|find|fix|format|implement|inspect|install|investigate|list|load|modify|open|patch|query|read|refactor|remove|rename|replace|review|run|scan|search|test|trace|update|validate|verify|write)\b/iu;
const ACTION_OBJECT_CONNECTOR_PATTERN = /^(?:at|for|in|into|on|through|to)\s+/i;
const ACTION_OBJECT_DETERMINER_PATTERN = /^(?:a|an|my|our|that|the|their|these|this|those|your)\s+/i;
const ACTION_OBJECT_PATTERN = /^(?!(?:again|everyone|later|next|now|soon|then|you)\b)(?:[`"'./~]|[\p{L}\p{N}_-])/iu;
const CONDITIONAL_LEAD_IN_PATTERN = /\b(?:if|once|unless|until|when|whenever)\b/i;
const CONDITIONAL_INVITATION_PATTERN = /\b(?:ask|give|point|say|send|share|tell)\b[\s\S]*\b(?:and|then)\s*$/i;
const CONDITIONAL_OFFER_SUFFIX_PATTERN = /\b(?:if\s+(?:needed|necessary|requested|you\b)|when(?:ever)?\s+you\b)/i;
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

	return announcesConcreteAction(finalSentence);
}

function announcesConcreteAction(sentence: string): boolean {
	const intent = INTENT_PATTERN.exec(sentence);
	if (intent) {
		const leadIn = sentence.slice(0, intent.index);
		if (
			CONDITIONAL_LEAD_IN_PATTERN.test(leadIn) ||
			CONDITIONAL_INVITATION_PATTERN.test(leadIn) ||
			CONDITIONAL_OFFER_SUFFIX_PATTERN.test(sentence)
		) {
			return false;
		}
		return hasActionWithObject(sentence.slice(intent.index + intent[0].length));
	}

	// A trailing colon can still signal a cut-off action lead-in, but only when
	// the lead-in names work and its target instead of relying on punctuation.
	return sentence.endsWith(":") && hasActionWithObject(sentence);
}

function hasActionWithObject(clause: string): boolean {
	const action = CONCRETE_ACTION_PATTERN.exec(clause);
	if (!action) return false;

	const remainder = clause.slice(action.index + action[0].length).trimStart();
	const withoutConnector = remainder.replace(ACTION_OBJECT_CONNECTOR_PATTERN, "");
	const object = withoutConnector.replace(ACTION_OBJECT_DETERMINER_PATTERN, "");
	return ACTION_OBJECT_PATTERN.test(object);
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
