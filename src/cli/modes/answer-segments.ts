import { readTrailingWrittenCalls, stripDeadToolCallMarkup } from "../../core/tool-call-markup.js";
import { ToolNames } from "../../core/tool-names.js";

/**
 * A headless run's answer is every reply of its final user turn, in order (CLI-P43): a reply is the text of an
 * assistant message that carries no typed tool call. A host-forced round after a reply (the finish declaration round)
 * adds its own reply after it instead of replacing it, and text written beside a tool call stays narration. Read from
 * the message's typed blocks only; nothing here reads what the prose says.
 */
export const ANSWER_SEGMENT_SEPARATOR = "\n\n";

/**
 * The reply one assistant message adds to the answer, or null when it adds none: a failed message, one that made a
 * tool call other than `finish` (whose reply is written beside it), one with no text, or text that is only a
 * written-out call. Calls the turn runtime stamped as written out (`clioCoderWrittenCalls`) are cut from its end, as
 * the receipt states them instead.
 */
export function replySegment(message: unknown): string | null {
	const record = message as {
		role?: unknown;
		content?: unknown;
		stopReason?: unknown;
		clioCoderWrittenCalls?: unknown;
	} | null;
	if (record?.role !== "assistant" || !Array.isArray(record.content)) return null;
	if (record.stopReason === "error" || record.stopReason === "aborted") return null;
	let text = "";
	for (const block of record.content as unknown[]) {
		const entry = block as { type?: unknown; text?: unknown; name?: unknown } | null;
		if (entry?.type === "toolCall" && entry.name !== ToolNames.Finish) return null;
		if (entry?.type === "text" && typeof entry.text === "string") text += entry.text;
	}
	text = text.trimEnd();
	if (text.length === 0 || stripDeadToolCallMarkup(text).trim().length === 0) return null;
	const written = Array.isArray(record.clioCoderWrittenCalls) ? (record.clioCoderWrittenCalls as unknown[]) : [];
	if (written.length === 0) return text;
	const prose = readTrailingWrittenCalls(text, (tool) => written.includes(tool))?.prose ?? text;
	return prose.length > 0 ? prose : null;
}
