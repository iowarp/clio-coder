import { ToolNames } from "../../core/tool-names.js";
import { type Classification, classify } from "./action-classifier.js";
import { type ShellToken, scanShellLike, splitSegments } from "./protected-artifacts.js";

/**
 * What a safety-judge refusal of a compound shell command names (cw-4): its
 * top-level sub-commands and the ones the block is about, so the agent can run
 * that part as its own call instead of guessing how to split it. This is
 * wording data only: the judge's verdict stands, and every split call is
 * admitted and judged again on its own.
 */
export interface RefusedCompound {
	/** Every top-level sub-command, in order, split at `;`, `&`, `&&`, `||`, `|`, newlines and parentheses. */
	parts: ReadonlyArray<string>;
	/** The sub-commands the refusal singles out; empty when nothing singles one out. */
	offending: ReadonlyArray<string>;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const QUOTE_MARKS = /["'`]/gu;
const CODE_SPAN = /`([^`]+)`|"([^"]+)"/gu;

/**
 * The compound a refused `command` is, or null for a simple command, which
 * keeps the judge's plain refusal. A sub-command the judge's reason quotes is
 * the one singled out; failing that, the sub-commands Clio's own classifier
 * flags when each is read alone (a write outside the workspace, an unresolved
 * delete, an outward push); failing that, none.
 */
export function refusedCompound(command: string, reason: string, cwd?: string): RefusedCompound | null {
	let segments: ShellToken[][];
	try {
		segments = splitSegments(scanShellLike(command, true));
	} catch {
		return null;
	}
	const parts: string[] = [];
	for (const segment of segments) {
		const first = segment[0];
		const last = segment.at(-1);
		if (first === undefined || last === undefined) continue;
		const text = command.slice(first.start, last.end).trim();
		if (text.length > 0) parts.push(text);
	}
	if (parts.length < 2) return null;
	const quoted = parts.filter((part) => reasonQuotes(reason, part));
	if (quoted.length > 0 && quoted.length < parts.length) return { parts, offending: quoted };
	const flagged = parts.filter((part) => flaggedAlone(part, cwd));
	if (flagged.length > 0 && flagged.length < parts.length) return { parts, offending: flagged };
	return { parts, offending: [] };
}

function normalized(text: string): string {
	return text.replace(QUOTE_MARKS, "").replace(/\s+/gu, " ").trim();
}

/** The program a sub-command runs: its first word past leading assignments, without a directory. */
function commandWord(part: string): string | undefined {
	const word = normalized(part)
		.split(" ")
		.find((token) => !ASSIGNMENT.test(token));
	return word?.split("/").at(-1);
}

/** `needle` occurs in `hay` with no word character directly before or after it. */
function containsWords(hay: string, needle: string): boolean {
	for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
		const before = hay[at - 1];
		const after = hay[at + needle.length];
		if ((before === undefined || !/\w/u.test(before)) && (after === undefined || !/\w/u.test(after))) return true;
	}
	return false;
}

/**
 * The judge's reason quotes `part`: its whole text, when it has more than one
 * word, so a lone `make` or `test` in plain prose does not count; or a code
 * span or quotation that starts with the part's program and lies inside it.
 */
function reasonQuotes(reason: string, part: string): boolean {
	const whole = normalized(part);
	if (whole.includes(" ") && containsWords(normalized(reason), whole)) return true;
	const program = commandWord(part);
	if (program === undefined || program.length === 0) return false;
	for (const span of reason.matchAll(CODE_SPAN)) {
		const quoted = normalized(span[1] ?? span[2] ?? "");
		if (quoted.length === 0 || !whole.includes(quoted)) continue;
		const head = quoted.split(" ")[0]?.split("/").at(-1);
		if (head === program) return true;
	}
	return false;
}

/** Clio's classifier, reading the sub-command alone, finds more than a plain command run. */
function flaggedAlone(part: string, cwd: string | undefined): boolean {
	let classification: Classification;
	try {
		classification = classify({ tool: ToolNames.Bash, args: { command: part, ...(cwd !== undefined ? { cwd } : {}) } });
	} catch {
		return false;
	}
	return (
		classification.actionClass !== "execute" || classification.reasons.length > 0 || classification.exposure !== undefined
	);
}
