import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { SessionEntry } from "./entries.js";

/**
 * Output obligations (M-4): an operator prompt line `output: <path>` names a file the session owes. The marker is the
 * whole contract, typed on every surface that files a user turn (TUI, headless `run` and its repeatable `--output`
 * flag, ACP, GUI); no other wording in the prompt names one. The obligation is read back from the ledger's user turns,
 * so it lasts the whole session, across compaction, resume and later prompts, and is discharged only when the file
 * exists when a turn is sealed.
 */

const OUTPUT_LINE = /^output:[ \t]*(\S(?:.*\S)?)[ \t]*$/gmu;

/** One prompt's `output: <path>` lines, each path as written, a pair of enclosing backticks or quotes removed. */
function outputMarkerPaths(text: string): string[] {
	const paths: string[] = [];
	for (const match of text.matchAll(OUTPUT_LINE)) {
		const raw = match[1] ?? "";
		const quoted = /^([`'"])(.+)\1$/u.exec(raw);
		const path = (quoted?.[2] ?? raw).trim();
		if (path.length > 0 && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** The text the operator typed in a filed user turn: `operatorText` over `text` over the first text block; null for a host turn. */
function operatorPromptText(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const record = payload as { synthetic?: unknown; operatorText?: unknown; text?: unknown; content?: unknown };
	if (record.synthetic === true) return null;
	if (typeof record.operatorText === "string") return record.operatorText;
	if (typeof record.text === "string") return record.text;
	if (!Array.isArray(record.content)) return null;
	const block = record.content.find(
		(item: { type?: unknown; text?: unknown } | null) => item?.type === "text" && typeof item.text === "string",
	) as { text: string } | undefined;
	return block?.text ?? null;
}

/** Every output the session's operator prompts named, in the order first named, from the ledger entries given. */
export function namedOutputs(entries: ReadonlyArray<SessionEntry>): string[] {
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.kind !== "message" || (entry as { role?: unknown }).role !== "user") continue;
		const text = operatorPromptText((entry as { payload?: unknown }).payload);
		if (text === null) continue;
		for (const path of outputMarkerPaths(text)) if (!paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** The named outputs that do not exist: `~/` is the home directory and a relative path resolves against `cwd`. */
export function absentOutputs(paths: ReadonlyArray<string>, cwd: string): string[] {
	return paths.filter((path) => {
		const expanded = path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
		return !existsSync(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	});
}

/** The refusal of a `finish(done)` while named outputs are absent: once per operator prompt, naming each path. */
export function missingOutputRefusal(paths: ReadonlyArray<string>): string {
	return `finish did not run: the operator named ${paths.length === 1 ? "an output that does" : "outputs that do"} not exist: ${paths.join(", ")}. Write ${paths.length === 1 ? "it" : "them"}, or declare partly_done or not_done naming what is missing; then write your reply and call finish again.`;
}
