/**
 * Earlier messages, recalled into the composer with the arrow keys the way a shell recalls commands.
 *
 * The list belongs to this browser, not to a session: a prompt written in one task is often the
 * start of the next. It holds what was sent and nothing else, so recalling never invents text, and
 * a draft in progress is stashed when browsing starts and handed back when it ends.
 *
 * Pure apart from the two storage accessors, which is what lets `tests/chat-composer.test.ts` reach
 * the stepping rules under plain node:test.
 */

export const HISTORY_MAX_ENTRIES = 100;
/** A pasted file is not a message worth recalling, and it would crowd the storage quota. */
export const HISTORY_MAX_CHARACTERS = 4000;
const HISTORY_KEY = "clio-coder-prompt-history";

/** Oldest first. A message sent twice in a row is kept once. */
export function appendHistory(entries: readonly string[], text: string): readonly string[] {
	const sent = text.trim();
	if (sent === "" || sent.length > HISTORY_MAX_CHARACTERS || entries.at(-1) === sent) return entries;
	return [...entries, sent].slice(-HISTORY_MAX_ENTRIES);
}

export interface HistoryBrowse {
	/** Index into the entries of the message on screen. */
	readonly index: number;
	/** What the field held when browsing began. */
	readonly stash: string;
}

export interface HistoryStep {
	readonly browse: HistoryBrowse | null;
	readonly text: string;
}

/**
 * One arrow press. `null` means the key is not history's to take and the caret moves as usual.
 * Stepping past the newest entry ends browsing and returns the stashed draft.
 */
export function stepHistory(
	entries: readonly string[],
	browse: HistoryBrowse | null,
	direction: "older" | "newer",
	draft: string,
): HistoryStep | null {
	if (direction === "older") {
		const index = browse === null ? entries.length - 1 : browse.index - 1;
		const text = entries[index];
		if (text === undefined) return null;
		return { browse: { index, stash: browse?.stash ?? draft }, text };
	}
	if (browse === null) return null;
	const text = entries[browse.index + 1];
	if (text === undefined) return { browse: null, text: browse.stash };
	return { browse: { index: browse.index + 1, stash: browse.stash }, text };
}

export function readHistory(): readonly string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
		return Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string").slice(-HISTORY_MAX_ENTRIES)
			: [];
	} catch {
		return [];
	}
}

export function rememberPrompt(text: string): void {
	try {
		const entries = readHistory();
		const next = appendHistory(entries, text);
		if (next !== entries) localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
	} catch {
		// Recall is a convenience; a browser without storage still sends the message.
	}
}
