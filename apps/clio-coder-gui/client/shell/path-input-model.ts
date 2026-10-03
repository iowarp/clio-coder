// What Tab and the arrow keys do in the Open workspace path box, kept free of React and of the request
// that produced the completion, so a stale answer can be recognized and ignored.

import type { PathCompletion } from "../../contracts/sessions.js";

/** A completion answers the text it was asked for; once the box has moved on it says nothing. */
export function isCurrent(completion: PathCompletion | undefined, input: string): completion is PathCompletion {
	return completion !== undefined && completion.input === input;
}

/**
 * Tab, the way a shell does it: extend to the longest common completion; with exactly one match,
 * finish it and add the separator so the next Tab lists its children.
 */
export function tabCompletion(completion: PathCompletion, input: string): string | null {
	if (completion.matches.length === 1) {
		const [only] = completion.matches;
		if (only) return `${only.display.replace(/[\\/]+$/, "")}${completion.separator}`;
	}
	if (completion.commonPrefix.length > input.length) return completion.commonPrefix;
	if (completion.isDirectory && completion.matches.length === 0 && !/[\\/]$/.test(input))
		return `${input}${completion.separator}`;
	return null;
}

/** The text a highlighted match puts in the box: the match as typed, ready to descend into. */
export function chosenText(completion: PathCompletion, index: number): string | null {
	const match = completion.matches[index];
	return match ? `${match.display.replace(/[\\/]+$/, "")}${completion.separator}` : null;
}

export function moveHighlight(current: number, count: number, step: 1 | -1): number {
	if (count === 0) return -1;
	if (current < 0) return step === 1 ? 0 : count - 1;
	return (current + step + count) % count;
}
