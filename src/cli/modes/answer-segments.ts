import { readTrailingWrittenCalls, stripDeadToolCallMarkup } from "../../core/tool-call-markup.js";
import { ToolNames } from "../../core/tool-names.js";

/**
 * A headless run's answer is every reply of its final user turn, in order (CLI-P43): a reply is the text of an
 * assistant message that carries no typed tool call other than `finish`. One pure function, {@link turnAnswer}, reads
 * the turn's settled assistant messages and gives the answer to every output: text stdout, `-o`, and the v2 envelope's
 * `result.text`. Read from the messages' typed blocks only; nothing here reads what the prose says.
 */
const ANSWER_SEGMENT_SEPARATOR = "\n\n";

/** Share of the checked answer's lines a reply must repeat to count as restating it. */
const RESTATED_LINE_SHARE = 0.6;
/** Share of one line's words a reply must carry for that line to count as repeated. */
const RESTATED_WORD_SHARE = 0.6;

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * The answer to print after a citation check. A reply that restates the
 * checked answer stands alone; a reply that holds only the corrections follows
 * the answer it corrects, as the transcript shows them, so the caller never
 * receives the corrections without the answer.
 */
export function answerAfterCitationCheck(checked: string | null, reply: string): string {
	if (checked === null || checked.length === 0 || reply.length === 0 || reply === checked) return reply;
	const lines = checked
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	// A rewrite that inserts citations into each line repeats no line verbatim, so a line also counts
	// when the reply carries most of its words.
	const replyWords = new Set(words(reply));
	const repeated = lines.filter((line) => {
		if (reply.includes(line)) return true;
		const lineWords = new Set(words(line));
		if (lineWords.size === 0) return false;
		let carried = 0;
		for (const word of lineWords) if (replyWords.has(word)) carried++;
		return carried / lineWords.size >= RESTATED_WORD_SHARE;
	}).length;
	if (lines.length > 0 && repeated / lines.length >= RESTATED_LINE_SHARE) return reply;
	return `${checked}\n\n${reply}`;
}

interface MessageReading {
	/** The provider failed the message (an error or abort stop). */
	failed: boolean;
	/** The reply the message adds to the answer, or null. */
	reply: string | null;
	/** Whether the message wrote any text at all. */
	wrote: boolean;
	/** Its text as the operator reads it: the calls it only wrote out are cut from the end (`clioCoderWrittenCalls`). */
	text: string;
}

function readAssistantMessage(message: unknown): MessageReading | null {
	const record = message as {
		role?: unknown;
		content?: unknown;
		stopReason?: unknown;
		clioCoderWrittenCalls?: unknown;
	} | null;
	if (record?.role !== "assistant" || !Array.isArray(record.content)) return null;
	const failed = record.stopReason === "error" || record.stopReason === "aborted";
	let raw = "";
	let called = false;
	for (const block of record.content as unknown[]) {
		const entry = block as { type?: unknown; text?: unknown; name?: unknown } | null;
		if (entry?.type === "toolCall" && entry.name !== ToolNames.Finish) called = true;
		if (entry?.type === "text" && typeof entry.text === "string") raw += entry.text;
	}
	raw = raw.trimEnd();
	const written = Array.isArray(record.clioCoderWrittenCalls) ? (record.clioCoderWrittenCalls as unknown[]) : [];
	const text =
		written.length === 0 ? raw : (readTrailingWrittenCalls(raw, (tool) => written.includes(tool))?.prose ?? raw);
	const reply = !failed && !called && text.length > 0 && stripDeadToolCallMarkup(text).trim().length > 0 ? text : null;
	return { failed, reply, wrote: raw.length > 0, text };
}

/**
 * The reply one assistant message adds to the answer, or null when it adds none: a failed message, one that made a
 * tool call other than `finish` (the reply rides beside `finish`), one with no text, or text that is only a
 * written-out call.
 */
export function replySegment(message: unknown): string | null {
	return readAssistantMessage(message)?.reply ?? null;
}

/** One settled event of the final user turn that bears on its answer, in order. */
export type TurnAnswerEntry =
	/** An assistant message as it settled (`message_end`, or a stream's `turn_end`). */
	| { kind: "message"; message: unknown }
	/** The host's citation check sent the answer so far back for corrected line ranges. */
	| { kind: "citation_check" };

export interface TurnAnswer {
	text: string;
	/** The turn has a reply (or a checked answer), so a quiet closing round leaves it standing. */
	replied: boolean;
}

/**
 * The final user turn's answer: its replies joined in order. Narration (text beside a tool call) and a written-out
 * call never replace a reply; only a turn with no reply at all falls back to its last text, as before CLI-P43, and a
 * failed message clears that text. A citation check takes the answer so far as the checked answer, and the replies
 * after it are merged with it once by {@link answerAfterCitationCheck}.
 */
export function turnAnswer(entries: ReadonlyArray<TurnAnswerEntry>): TurnAnswer {
	let replies: string[] = [];
	let narration = "";
	let checked: string | null = null;
	const settle = (): string => {
		const own = replies.length > 0 ? replies.join(ANSWER_SEGMENT_SEPARATOR) : checked === null ? narration : "";
		if (checked === null) return own;
		return own.length === 0 ? checked : answerAfterCitationCheck(checked, own);
	};
	for (const entry of entries) {
		if (entry.kind === "citation_check") {
			const answer = settle();
			if (answer.length > 0) checked = answer;
			replies = [];
			narration = "";
			continue;
		}
		const reading = readAssistantMessage(entry.message);
		if (reading === null) continue;
		if (reading.failed) narration = "";
		else if (reading.reply !== null) replies.push(reading.reply);
		else if (reading.wrote) narration = reading.text;
	}
	return { text: settle(), replied: replies.length > 0 || checked !== null };
}
