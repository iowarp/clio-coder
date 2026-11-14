import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * The parsed YAML of a settings file, parsed once per content.
 *
 * Settings have many readers and no shared snapshot below the config domain: one interactive boot parsed the same
 * user file about 35 times, 8 ms each on a real home, most of them from code that only wanted one flag. The parse is
 * a pure function of the text, so each read still reads the file (tens of microseconds) and reuses the document only
 * when the text is byte-for-byte what was parsed last time. Every reader gets its own copy. Validation still runs per
 * read, because it also depends on what the process has registered by then.
 */
export type SettingsDocumentRead =
	| { kind: "parsed"; document: unknown }
	| { kind: "unreadable"; error: unknown }
	| { kind: "invalid"; error: unknown };

interface Kept {
	text: string;
	document: unknown;
}

/** User and project layers of one workspace; a process that walks many homes just reparses. */
const MAX_KEPT = 16;

const kept = new Map<string, Kept>();

/** Read and parse `path`. The two failures stay distinct because they point at different repairs. */
export function readSettingsDocument(path: string): SettingsDocumentRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "unreadable", error };
	}
	const hit = kept.get(path);
	if (hit?.text === text) return { kind: "parsed", document: structuredClone(hit.document) };
	let document: unknown;
	try {
		// The library default, stated because a settings file is untrusted input in a project layer.
		document = parseYaml(text, { maxAliasCount: 100 });
	} catch (error) {
		return { kind: "invalid", error };
	}
	kept.delete(path);
	kept.set(path, { text, document: structuredClone(document) });
	const oldest = kept.keys().next();
	if (kept.size > MAX_KEPT && !oldest.done) kept.delete(oldest.value);
	return { kind: "parsed", document };
}
