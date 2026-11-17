/**
 * Author-declared ignorable manifest keys. The manifest is the consent
 * envelope the operator approves, so a host never drops a field on its own
 * judgment: it skips a key it does not know only when the author listed that
 * key's path under `ignorable`, and it says so in a discovery warning.
 *
 * A path is dotted from the manifest root with list elements unindexed, so
 * `runtime.tools.readOnly` covers that key on every declared tool. A key the
 * host knows is parsed normally whether or not it is listed. Ignored keys are
 * never read, so they never reach the capability envelope or its digest, and
 * the list itself stays out of the envelope: it grants nothing.
 */
import type { ExtensionDiagnostic } from "./types.js";

export const IGNORABLE_LIMITS = { entries: 32, chars: 160, segments: 8 } as const;

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** `runtime.tools[3].readOnly` is listed as `runtime.tools.readOnly`. */
function unindexedPath(path: string): string {
	return path.replace(/\[\d+\]/g, "");
}

export class ManifestKeyPolicy {
	private readonly listed: ReadonlySet<string>;
	private readonly skipped = new Set<string>();

	constructor(listed: Iterable<string> = []) {
		this.listed = new Set(listed);
	}

	/**
	 * The keys of `raw` outside `allowed` that the author did not list. Listed
	 * ones are recorded for the warning and left unread. `path` is the indexed
	 * path of `raw`, empty at the manifest root.
	 */
	unknown(raw: Record<string, unknown>, path: string, allowed: { has(key: string): boolean }): string[] {
		const refused: string[] = [];
		for (const key of Object.keys(raw)) {
			if (allowed.has(key)) continue;
			const parent = unindexedPath(path);
			const field = parent ? `${parent}.${key}` : key;
			// A key that is not one plain segment (`tools.readOnly`, `hint[0]`) would read as another field's path.
			if (SEGMENT.test(key) && this.listed.has(field)) this.skipped.add(field);
			else refused.push(key);
		}
		return refused;
	}

	/** One warning per ignored path, however many list elements carried it. */
	warnings(id: string | undefined, manifestPath: string): ExtensionDiagnostic[] {
		return [...this.skipped].sort().map((field) => ({
			type: "warning",
			message: `extension ${id ?? "<unknown>"} ignores ${field}: this Clio does not know the field and the manifest lists it under ignorable`,
			path: manifestPath,
		}));
	}
}

/** Parses the manifest's `ignorable` list. Each refusal names the entry, like every other manifest error. */
export function parseIgnorable(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("ignorable must be a list of field paths");
	if (value.length > IGNORABLE_LIMITS.entries)
		throw new Error(`ignorable allows at most ${IGNORABLE_LIMITS.entries} entries`);
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const at = `ignorable[${index}]`;
		const segments = typeof entry === "string" ? entry.split(".") : [];
		if (
			typeof entry !== "string" ||
			entry.length > IGNORABLE_LIMITS.chars ||
			segments.length > IGNORABLE_LIMITS.segments ||
			!segments.every((segment) => SEGMENT.test(segment))
		)
			throw new Error(
				`${at} must be a dotted field path of at most ${IGNORABLE_LIMITS.chars} characters such as runtime.tools.readOnly, with list elements unindexed`,
			);
		if (seen.has(entry)) throw new Error(`${at} repeats '${entry}'`);
		seen.add(entry);
	}
	return [...seen];
}
