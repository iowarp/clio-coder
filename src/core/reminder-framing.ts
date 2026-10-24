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
 * The `details` key where the registry records the exact notes it appended to
 * a tool result. Tool output is arbitrary bytes and can end in anything that
 * looks like a note, so the text alone never proves the host wrote it; the
 * registry overwrites this key on every result, so a tool cannot set it.
 */
export const TOOL_RESULT_HOST_NOTES_KEY = "hostNotes";

/**
 * The texts the host framed inside a submitted request: the bodies of the
 * `<system-reminder>` blocks that open a user message and the middleware notes
 * the registry recorded appending to a tool result. Text a tool merely
 * returned (a session ledger, a trace, a file quoting an old reminder, operator
 * shell output replayed as a user message) is not host framing, so a reminder
 * it happens to contain was not delivered by it.
 */
export function hostFramedTexts(messages: readonly { role: string; content: unknown; details?: unknown }[]): string[] {
	const framed: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "toolResult") continue;
		const blocks =
			typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content : [];
		const texts = blocks.flatMap((block) => {
			const text =
				typeof block === "string"
					? block
					: block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text"
						? (block as { text?: unknown }).text
						: null;
			return typeof text === "string" ? [text] : [];
		});
		if (message.role === "user") framed.push(...leadingSystemReminderBodies(texts[0] ?? ""));
		else framed.push(...hostAppendedToolResultNotes(texts, message.details));
	}
	return framed;
}

const LEADING_SYSTEM_REMINDER = /^<system-reminder>\n([\s\S]*?)\n<\/system-reminder>(?:\n\n|$)/u;

/**
 * The host composes every reminder-carrying user message with its blocks
 * first and appends operator words, orientation findings or replayed shell
 * output after them. A block anywhere later came from that appended text, so
 * only the run of blocks opening the message counts.
 */
function leadingSystemReminderBodies(text: string): string[] {
	const bodies: string[] = [];
	let rest = text;
	for (let match = LEADING_SYSTEM_REMINDER.exec(rest); match; match = LEADING_SYSTEM_REMINDER.exec(rest)) {
		bodies.push(match[1] ?? "");
		rest = rest.slice(match[0].length);
	}
	return bodies;
}

/**
 * The well-formed note lines a `details.hostNotes` value holds; anything else
 * there invalidates the whole record.
 */
export function recordedToolResultNotes(details: unknown): string[] {
	const recorded =
		details !== null && typeof details === "object"
			? (details as Record<string, unknown>)[TOOL_RESULT_HOST_NOTES_KEY]
			: undefined;
	if (!Array.isArray(recorded)) return [];
	const notes = recorded.filter(
		(note): note is string => typeof note === "string" && TOOL_RESULT_NOTE_PREFIX.test(note),
	);
	return notes.length === recorded.length ? notes : [];
}

/**
 * Whether `text` still carries `note` as whole lines. A gateway call keeps
 * the capability's notes ahead of its own, and a chain keeps each step's notes
 * at the end of that step's section, so a recorded note need not be the last
 * line; it must only have survived shaping intact.
 */
export function carriesToolResultNote(text: string, note: string): boolean {
	for (let at = text.indexOf(`\n${note}`); at >= 0; at = text.indexOf(`\n${note}`, at + 1)) {
		const end = at + 1 + note.length;
		if (end === text.length || text[end] === "\n") return true;
	}
	return false;
}

/**
 * Notes count only when the registry recorded appending them and the text
 * still carries them; a result shaped or cut after the append does not.
 */
function hostAppendedToolResultNotes(texts: readonly string[], details: unknown): string[] {
	return recordedToolResultNotes(details)
		.filter((note) => texts.some((text) => carriesToolResultNote(text, note)))
		.map((note) => note.replace(TOOL_RESULT_NOTE_PREFIX, ""));
}
