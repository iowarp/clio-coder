/**
 * The two frames the host puts around text it adds to a model request on its
 * own authority: a `<system-reminder>` block in a user message, and middleware
 * notes appended to a tool result. Producers and the submission reader share
 * this module so a receipt can only ever match the host's own framing.
 */

const TOOL_RESULT_NOTE_PREFIX = /^\[middleware:[a-z-]+\] /u;

/** One `<system-reminder>` block holding the given messages. */
export function systemReminderBlock(messages: readonly string[]): string {
	return `<system-reminder>\n${messages.join("\n\n")}\n</system-reminder>`;
}

/** One middleware note line; the notes of a result trail its output after a blank line. */
export function toolResultNote(severity: string, message: string): string {
	return `[middleware:${severity}] ${message}`;
}

/** Separator between a tool result's own output and the notes appended to it. */
export const TOOL_RESULT_NOTES_SEPARATOR = "\n\n";

/**
 * The texts the host framed inside a submitted request: the bodies of
 * `<system-reminder>` blocks in user messages and the trailing middleware notes
 * of tool results. Text a tool merely returned (a session ledger, a trace, a
 * file quoting an old reminder) is not host framing, so a reminder it happens
 * to contain was not delivered by it.
 */
export function hostFramedTexts(messages: readonly { role: string; content: unknown }[]): string[] {
	const framed: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "toolResult") continue;
		const blocks =
			typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			const text =
				typeof block === "string"
					? block
					: block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text"
						? (block as { text?: unknown }).text
						: null;
			if (typeof text !== "string") continue;
			if (message.role === "user") framed.push(...systemReminderBodies(text));
			else framed.push(...trailingToolResultNotes(text));
		}
	}
	return framed;
}

function systemReminderBodies(text: string): string[] {
	return [...text.matchAll(/<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/gu)].map((match) => match[1] ?? "");
}

/**
 * Notes are appended last, after a blank line, each starting with its own
 * severity tag; a note may span lines. The last blank-line-plus-tag boundary
 * opens the trailing run, so output that quotes a tag earlier is not read as
 * a note.
 */
function trailingToolResultNotes(text: string): string[] {
	const start = text.lastIndexOf(`${TOOL_RESULT_NOTES_SEPARATOR}[middleware:`);
	if (start < 0) return [];
	return text
		.slice(start + TOOL_RESULT_NOTES_SEPARATOR.length)
		.split(/\n(?=\[middleware:[a-z-]+\] )/u)
		.filter((note) => TOOL_RESULT_NOTE_PREFIX.test(note))
		.map((note) => note.replace(TOOL_RESULT_NOTE_PREFIX, ""));
}
