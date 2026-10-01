/**
 * Output hygiene for the in-turn memory pass.
 *
 * The pass runs on whatever background model the operator routed it to, and a
 * small local model can derail mid-completion: it emits a chat-template control
 * token, keeps writing its own deliberation, and repeats the answer it already
 * gave. The reminder text reaches two places that cannot tell garbage from
 * advice, the operator's memory card and the main model's next turn, and the
 * operation contents are persisted into the bank. Everything the pass produces
 * is therefore checked here before it goes anywhere, and anything that fails is
 * dropped whole. Repairing it would pick which part of a derailed completion to
 * trust, and nothing in the text says which part that is.
 */

/** Longest reminder body, in characters. The prompt asks for "one concise reminder". */
export const TASK_MEMORY_REMINDER_MAX_CHARS = 500;
/** Non-empty lines a reminder may span before it stops being a reminder. */
const REMINDER_MAX_LINES = 3;

/**
 * Chat-template control tokens across the families a local route serves:
 * ChatML and Qwen (`<|im_start|>`), Llama 3 (`<|eot_id|>`, `<|start_header_id|>`),
 * Gemma (`<start_of_turn>`, `<end_of_turn>`), GPT-style `<|endoftext|>`,
 * sentence-piece `<s>`/`</s>`, and Llama 2's `[INST]`. Any `<|name|>` shape is a
 * template token; ordinary prose never contains one.
 */
const CONTROL_TOKEN_SOURCE = String.raw`<\|[A-Za-z0-9_.\- ]{1,48}\|>|</?(?:start_of_turn|end_of_turn|bos|eos|pad|unk|s)>|\[/?INST\]|<</?SYS>>`;
const CONTROL_TOKEN = new RegExp(CONTROL_TOKEN_SOURCE, "iu");
const ENVELOPE_TAG = String.raw`<operations>|</operations>|<context_for_action>|</context_for_action>|<no_intervention\s*/?>`;
// A model that ends its turn right after a structural tag leaves its stop token
// there. That token carries no content and removing it loses nothing; a token in
// the middle of a sentence marks a derailment and stays visible so validation can
// reject the text it sits in.
const BOUNDARY_CONTROL_TOKENS = new RegExp(
	`(?:${CONTROL_TOKEN_SOURCE})+(?=\\s*(?:${ENVELOPE_TAG}|$))|(?<=(?:${ENVELOPE_TAG}|^)\\s*)(?:${CONTROL_TOKEN_SOURCE})+`,
	"giu",
);
const ENVELOPE_TAG_SHAPE = /<\/?(?:operations|context_for_action|no_intervention)\b[^>]*>/iu;

function containsControlToken(text: string): boolean {
	return CONTROL_TOKEN.test(text);
}

/** Remove stop tokens that sit directly against the envelope's own tags or either end of the text. */
export function stripBoundaryControlTokens(text: string): string {
	return text.replace(BOUNDARY_CONTROL_TOKENS, "");
}

/**
 * Reasoning that leaked into the answer. These are first-person or
 * instruction-referencing sentences about the output format itself, which no
 * reminder written for the action agent would contain.
 */
const REASONING_PHRASES = [
	/\bwe (?:need|should|must|did|have done)\b/iu,
	/\blet(?:'|\u2019)?s\b/iu,
	/\blet me\b/iu,
	/\bi (?:need|should|must|will|think|am asked)\b/iu,
	/\b(?:the )?(?:task|user|prompt|instructions?) (?:asks|says|wants|requires|bank says)\b/iu,
	/\bbut (?:the )?task\b/iu,
	/\b(?:valid|ensure|output) json\b/iu,
	/\boutput formatt?ing\b/iu,
	/\bexactly (?:two|2) lines\b/iu,
	/\bno extra\b/iu,
	/\bmemory agent\b/iu,
];
/** Phrases that only a model deliberating over its own answer format writes, safe to refuse in stored content too. */
const FORMAT_DELIBERATION = [
	/\bexactly (?:two|2) lines\b/iu,
	/\b(?:valid|ensure|output) json\b/iu,
	/\boutput formatt?ing\b/iu,
	/\bwe need must\b/iu,
	/\bwe did operations\b/iu,
];
const JSON_SHAPES = [/\{\s*"/u, /\[\s*\{/u, /"\s*[}\]]/u, /"\s*:\s*["[{\d]/u];

/**
 * Script blocks a stray multilingual token comes from. A weak model drifting
 * into another language writes a word or two of it; a reminder in a script that
 * appears nowhere in the task, the bank or the trajectory did not come from the
 * session.
 */
const FOREIGN_SCRIPTS: ReadonlyArray<RegExp> = [
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u,
	/[\u1100-\u11ff\uac00-\ud7af]/u,
	/[\u0400-\u04ff]/u,
	/[\u0600-\u06ff]/u,
	/[\u0e00-\u0e7f]/u,
	/[\u0900-\u097f]/u,
];

function introducesForeignScript(text: string, reference: string): boolean {
	return FOREIGN_SCRIPTS.some((script) => script.test(text) && !script.test(reference));
}

function repeatsASentence(text: string): boolean {
	const seen = new Set<string>();
	for (const piece of text.split(/(?<=[.!?])\s+|\n+/u)) {
		const key = piece
			.replace(/\[[\w-]+\]/gu, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, "")
			.replace(/\s+/gu, " ")
			.trim();
		if (key.length < 24) continue;
		if (seen.has(key)) return true;
		seen.add(key);
	}
	return false;
}

/**
 * Check a reminder body before it becomes the operator's card and the main
 * model's context. `raw` is the text exactly as the model wrote it between the
 * tags, so a line count and a template token survive the whitespace collapsing
 * that produces `text`. Returns the first reason it is unfit, or null.
 */
export function rejectReminder(raw: string, text: string, reference: string): string | null {
	if (containsControlToken(raw)) return "a chat-template control token inside the reminder";
	if (ENVELOPE_TAG_SHAPE.test(raw)) return "envelope tags inside the reminder";
	if (raw.split("\n").filter((line) => line.trim().length > 0).length > REMINDER_MAX_LINES) {
		return "more than three lines";
	}
	if (text.length > TASK_MEMORY_REMINDER_MAX_CHARS) return `longer than ${TASK_MEMORY_REMINDER_MAX_CHARS} characters`;
	if (JSON_SHAPES.some((shape) => shape.test(text))) return "JSON-shaped text";
	if (REASONING_PHRASES.some((phrase) => phrase.test(text))) return "reasoning about the task or the answer format";
	if (introducesForeignScript(text, reference)) return "a script that appears nowhere in the session";
	if (repeatsASentence(text)) return "a repeated sentence";
	return null;
}

/**
 * Check one operation's content before the bank stores it. Looser than a
 * reminder on purpose: a knowledge entry can legitimately quote JSON or the
 * memory grammar itself when the session is working on the memory tier.
 */
export function rejectStoredContent(content: string, reference: string): string | null {
	if (containsControlToken(content)) return "a chat-template control token";
	if (FORMAT_DELIBERATION.some((phrase) => phrase.test(content))) return "reasoning about the answer format";
	if (introducesForeignScript(content, reference)) return "a script that appears nowhere in the session";
	return null;
}
