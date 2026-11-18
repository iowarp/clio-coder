/**
 * YAML the package ships, parsed once at build time (Astra r8-3). Every CLI process and every single-use worker
 * used to run the YAML parser over the same package-owned bytes: prompt fragment frontmatter, the damage-control
 * rules, the bundled model catalog and the model profiles. The build records each parse as JSON keyed by the
 * sha256 of the exact text, and a loader hands its text here. A digest match returns the recorded value and
 * anything else, including an edited source, a missing asset or a source checkout that never built one, parses
 * as before. The raw text stays authoritative, so content hashes, ordering and reloads are untouched. Only
 * loaders outside the Stage 0 closure import this module.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "./package-root.js";

const ASSET_VERSION = 1;
/** Package-relative path of the asset `scripts/build-preparsed-yaml.ts` writes. */
export const PREPARSED_YAML_ASSET = "dist/assets/preparsed-yaml.json";

let table: ReadonlyMap<string, string> | null | undefined;
let recording: Map<string, string> | null = null;

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function preparsedTable(): ReadonlyMap<string, string> | null {
	if (table !== undefined) return table;
	table = null;
	try {
		const body = JSON.parse(readFileSync(join(resolvePackageRoot(), PREPARSED_YAML_ASSET), "utf8")) as {
			version?: unknown;
			entries?: unknown;
		};
		if (body.version === ASSET_VERSION && body.entries !== null && typeof body.entries === "object") {
			const entries = Object.entries(body.entries as Record<string, unknown>);
			table = new Map(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		}
	} catch {
		// No asset or an unreadable one only costs speed: every text then parses as YAML.
	}
	return table;
}

/**
 * Parses package-owned YAML, using the build's result when `text` is byte for byte what the build parsed. Each call
 * returns a fresh value, so a caller may mutate what it gets.
 */
export function parsePackagedYaml(text: string): unknown {
	if (recording !== null) {
		const parsed: unknown = parseYaml(text);
		const json = JSON.stringify(parsed);
		// A value JSON cannot carry exactly (.nan, .inf) stays out of the asset and keeps parsing at runtime.
		if (json !== undefined && isDeepStrictEqual(JSON.parse(json), parsed)) recording.set(digest(text), json);
		return parsed;
	}
	const hit = preparsedTable()?.get(digest(text));
	return hit === undefined ? parseYaml(text) : JSON.parse(hit);
}

/** Build only: runs `load`, which reaches the package's loaders, and returns the asset body for what they parsed. */
export function preparsePackagedYaml(load: () => void): string {
	recording = new Map();
	try {
		load();
		const entries = Object.fromEntries([...recording].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		return `${JSON.stringify({ version: ASSET_VERSION, entries })}\n`;
	} finally {
		recording = null;
	}
}
