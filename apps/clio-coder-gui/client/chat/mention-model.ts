/**
 * The `@path` reference under the caret, by the grammar the agent expands (`src/core/file-references.ts`):
 * an `@` at the start of the text or after whitespace, then a path that runs to the next whitespace,
 * or a double-quoted path that may hold spaces.
 */

export interface MentionQuery {
	/** Index of the `@`. */
	readonly start: number;
	/** The path typed so far, without the `@` or an opening quote. */
	readonly path: string;
}

const MENTION = /(?:^|\s)@(?:"((?:[^"\\]|\\.)*)|([^\s"']*))$/u;

export function mentionQuery(text: string, caret: number): MentionQuery | null {
	const match = MENTION.exec(text.slice(0, caret));
	if (match === null) return null;
	const path = match[1] !== undefined ? match[1].replace(/\\(.)/gu, "$1") : (match[2] ?? "");
	// The list is this workspace's files; a path that starts outside it has nothing to offer.
	if (path.startsWith("/") || path.startsWith("~") || path.startsWith("../")) return null;
	return { start: match.index + match[0].indexOf("@"), path };
}

/** A bare word after `@` at the start of a message names a running agent to steer, not a file. */
const STEER_TARGET = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** The spelling the agent's scanner reads back as exactly this path. A folder keeps its trailing slash. */
export function mentionReference(path: string): string {
	if (!/[\s"'\\]/u.test(path) && !STEER_TARGET.test(path)) return `@${path}`;
	return `@"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface MentionEdit {
	readonly text: string;
	readonly caret: number;
}

/**
 * Replaces the reference under the caret with the picked path. A folder leaves the caret after its
 * slash, inside the quotes when it is quoted, so the next list opens in it; a file closes the
 * reference with a space.
 */
export function applyMention(
	text: string,
	caret: number,
	query: MentionQuery,
	path: string,
	directory: boolean,
): MentionEdit {
	const before = text.slice(0, query.start);
	const after = text.slice(caret);
	const reference = mentionReference(path);
	if (directory) {
		const open = reference.endsWith('"') ? reference.slice(0, -1) : reference;
		return { text: `${before}${open}${after}`, caret: before.length + open.length };
	}
	// The closing space is not doubled when the text already continues with one.
	const tail = after.startsWith(" ") ? after.slice(1) : after;
	return { text: `${before}${reference} ${tail}`, caret: before.length + reference.length + 1 };
}

/**
 * `@agent text` at the start of a message steers a running worker, the terminal's own operator
 * syntax (`src/interactive/editor-steer.ts`). The target is a bare word, which is why a file
 * reference that could be read as one is written quoted.
 */
export interface SteerMention {
	readonly target: string;
	readonly text: string;
}

export function parseSteerMention(text: string): SteerMention | null {
	const match = /^@(\S+)\s+(\S[\s\S]*)$/u.exec(text.trim());
	if (!match?.[1] || !match[2] || !STEER_TARGET.test(match[1])) return null;
	return { target: match[1], text: match[2].trim() };
}

export interface RunningRun {
	readonly runId: string;
	readonly agentId: string;
}

export type SteerTarget =
	| { readonly kind: "match"; readonly run: RunningRun }
	| { readonly kind: "ambiguous"; readonly candidates: readonly RunningRun[] }
	| { readonly kind: "none" };

/** The agent's name first, then a run id prefix. One hit steers; several ask for the run id. */
export function resolveSteerTarget(target: string, running: readonly RunningRun[]): SteerTarget {
	for (const hits of [
		running.filter((run) => run.agentId === target),
		running.filter((run) => run.runId.startsWith(target)),
	]) {
		if (hits.length === 1 && hits[0]) return { kind: "match", run: hits[0] };
		if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
	}
	return { kind: "none" };
}

export function steerCandidates(runs: readonly RunningRun[]): string {
	return runs.map((run) => `${run.agentId} (${run.runId.slice(0, 8)})`).join(", ");
}
