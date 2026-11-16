import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { VALID_THINKING_LEVELS } from "../providers/types/capability-flags.js";

/**
 * A campaign roster: the models one fixture is run across (WTF-P 0.8.3 C4). The file is
 *
 *   roster:
 *     - target: openai-codex
 *       model: gpt-6-luna
 *       thinking: high          # optional, one run's --thinking
 *       label: luna-high        # optional, defaults to <target>/<model>[@<thinking>]
 *
 * Labels name each entry's rows and directory, so they must be unique.
 */
export interface RosterEntry {
	target: string;
	model: string;
	thinking: string | null;
	label: string;
}

const ENTRY_KEYS = new Set(["target", "model", "thinking", "label"]);
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@/:+-]{0,79}$/u;

class RosterError extends Error {}

function fail(where: string, reason: string): never {
	throw new RosterError(`${where}: ${reason}`);
}

function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(where, "expected a non-empty string");
	return value.trim();
}

function parseEntry(raw: unknown, index: number): RosterEntry {
	const where = `roster[${index}]`;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(where, "expected a mapping");
	const entry = raw as Record<string, unknown>;
	for (const key of Object.keys(entry))
		if (!ENTRY_KEYS.has(key)) fail(`${where}.${key}`, "unknown key; an entry takes target, model, thinking and label");
	const target = text(entry.target, `${where}.target`);
	const model = text(entry.model, `${where}.model`);
	let thinking: string | null = null;
	if (entry.thinking !== undefined) {
		thinking = text(entry.thinking, `${where}.thinking`);
		if (!(VALID_THINKING_LEVELS as ReadonlyArray<string>).includes(thinking))
			fail(`${where}.thinking`, `expected one of ${VALID_THINKING_LEVELS.join(", ")}`);
	}
	const label =
		entry.label === undefined
			? `${target}/${model}${thinking === null ? "" : `@${thinking}`}`
			: text(entry.label, `${where}.label`);
	if (!LABEL_PATTERN.test(label))
		fail(`${where}.label`, "use at most 80 letters, digits and . _ @ / : + -, starting with a letter or digit");
	return { target, model, thinking, label };
}

/** Parse roster YAML; a bad file throws naming the offending entry. */
export function parseRoster(source: string): RosterEntry[] {
	let document: unknown;
	try {
		document = parseYaml(source);
	} catch (error) {
		fail("roster", `not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (document === null || typeof document !== "object" || Array.isArray(document))
		fail("roster", "expected a mapping with one key, roster");
	for (const key of Object.keys(document)) if (key !== "roster") fail(key, "unknown key; the file takes roster");
	const list = (document as { roster?: unknown }).roster;
	if (!Array.isArray(list) || list.length === 0) fail("roster", "expected a non-empty list of entries");
	const entries = list.map(parseEntry);
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (seen.has(entry.label))
			fail(`roster[${index}].label`, `"${entry.label}" names an earlier entry too; give each entry its own label`);
		seen.add(entry.label);
	}
	return entries;
}

/** Read and parse a roster file: the entries, or one error line naming the file and the offending entry. */
export function loadRoster(file: string): { entries: RosterEntry[] } | { error: string } {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		return { error: `--roster ${file}: cannot read the file: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		return { entries: parseRoster(source) };
	} catch (error) {
		if (error instanceof RosterError) return { error: `--roster ${file}: ${error.message}` };
		throw error;
	}
}
