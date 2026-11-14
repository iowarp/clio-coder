import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * The parsed YAML of a settings file, read once per version of the file.
 *
 * Settings have many readers and no shared snapshot below the config domain: one interactive boot parsed the same
 * user file about 35 times, 8 ms each on a real home, most of them from code that only wanted one flag. The parse is
 * a pure function of the bytes, so it is kept per file identity and every reader gets its own copy of the document.
 * Validation still runs per read, because it also depends on what the process has registered by then.
 */
export type SettingsDocumentRead =
	| { kind: "parsed"; document: unknown }
	| { kind: "unreadable"; error: unknown }
	| { kind: "invalid"; error: unknown };

interface Kept {
	stamp: string;
	document: unknown;
}

/**
 * A file changed this recently can change again without moving a coarse timestamp, so it is parsed on every read
 * until it has been still this long (the same reasoning as git's racily-clean index entries).
 */
const SETTLED_MS = 2_000;
/** User and project layers of one workspace; a process that walks many homes just reparses. */
const MAX_KEPT = 16;

const kept = new Map<string, Kept>();

function settledStamp(path: string): string | null {
	try {
		const stats = statSync(path);
		if (Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) < SETTLED_MS) return null;
		// A rename-into-place write moves the inode; an edit in place moves size, mtime or ctime.
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
	} catch {
		// The read below states why the file cannot be used.
		return null;
	}
}

/** Read and parse `path`. The two failures stay distinct because they point at different repairs. */
export function readSettingsDocument(path: string): SettingsDocumentRead {
	// Taken before the read: a file replaced in between is kept under the old stamp and never served for the new one.
	const stamp = settledStamp(path);
	const hit = kept.get(path);
	if (stamp !== null && hit?.stamp === stamp) return { kind: "parsed", document: structuredClone(hit.document) };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "unreadable", error };
	}
	let document: unknown;
	try {
		// The library default, stated because a settings file is untrusted input in a project layer.
		document = parseYaml(text, { maxAliasCount: 100 });
	} catch (error) {
		return { kind: "invalid", error };
	}
	kept.delete(path);
	if (stamp !== null) {
		kept.set(path, { stamp, document: structuredClone(document) });
		const oldest = kept.keys().next();
		if (kept.size > MAX_KEPT && !oldest.done) kept.delete(oldest.value);
	}
	return { kind: "parsed", document };
}
