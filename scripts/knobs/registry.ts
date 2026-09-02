/**
 * Load and validate docs/knobs.yaml, the one place a knob is declared.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { entryKey, KNOB_KINDS, KNOB_VERDICTS, type Registry, type RegistryEntry, TOOL_ARG_CLASSES } from "./types.js";

export const REGISTRY_PATH = "docs/knobs.yaml";
export const REGISTRY_SCHEMA_PATH = "docs/knobs.schema.json";

const ENTRY_FIELDS = new Set([
	"name",
	"kind",
	"owner",
	"command",
	"file",
	"source",
	"class",
	"default",
	"controls",
	"precedence",
	"verdict",
	"mergeWith",
	"pattern",
	"note",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEntry(raw: unknown, index: number, issues: string[]): RegistryEntry | null {
	const at = `entries[${index}]`;
	if (!isRecord(raw)) {
		issues.push(`${at}: must be a mapping`);
		return null;
	}
	for (const key of Object.keys(raw)) {
		if (!ENTRY_FIELDS.has(key)) issues.push(`${at}: unknown field '${key}'`);
	}
	const name = raw.name;
	const kind = raw.kind;
	const label = typeof name === "string" ? `${at} (${name})` : at;
	if (typeof name !== "string" || name.length === 0) issues.push(`${label}: name must be a non-empty string`);
	if (typeof kind !== "string" || !(KNOB_KINDS as ReadonlyArray<string>).includes(kind)) {
		issues.push(`${label}: kind must be one of ${KNOB_KINDS.join(", ")}`);
	}
	if (typeof raw.owner !== "string" || raw.owner.length === 0) issues.push(`${label}: owner must be a non-empty string`);
	if (typeof raw.controls !== "string" || raw.controls.trim().length === 0) {
		issues.push(`${label}: controls must be one non-empty sentence`);
	}
	if (typeof raw.verdict !== "string" || !(KNOB_VERDICTS as ReadonlyArray<string>).includes(raw.verdict)) {
		issues.push(`${label}: verdict must be one of ${KNOB_VERDICTS.join(", ")}`);
	}
	for (const optional of ["command", "file", "source", "default", "precedence", "mergeWith", "pattern", "note"]) {
		if (raw[optional] !== undefined && typeof raw[optional] !== "string")
			issues.push(`${label}: ${optional} must be a string`);
	}
	if (raw.class !== undefined && !(TOOL_ARG_CLASSES as ReadonlyArray<string>).includes(raw.class as string)) {
		issues.push(`${label}: class must be one of ${TOOL_ARG_CLASSES.join(", ")}`);
	}
	if (kind === "flag" && typeof raw.command !== "string") issues.push(`${label}: a flag names its command`);
	if (kind === "project-file" && typeof raw.file !== "string")
		issues.push(`${label}: a project-file key names its file`);
	if (kind === "constant" && typeof raw.source !== "string") issues.push(`${label}: a constant names its source file`);
	if (kind === "constant" && typeof raw.default !== "string") issues.push(`${label}: a constant states its value`);
	if (kind === "tool-arg" && raw.class === undefined) issues.push(`${label}: a tool argument is class policy or task`);
	if ((raw.verdict === "merge" || raw.verdict === "deprecate") && typeof raw.mergeWith !== "string") {
		issues.push(`${label}: verdict ${String(raw.verdict)} names the knob to fold into in mergeWith`);
	}
	if (raw.verdict === "remove" && typeof raw.note !== "string")
		issues.push(`${label}: verdict remove states why in note`);
	if (typeof raw.pattern === "string") {
		try {
			new RegExp(raw.pattern);
		} catch {
			issues.push(`${label}: pattern is not a regular expression`);
		}
	}
	return raw as unknown as RegistryEntry;
}

export function parseRegistry(text: string): { registry: Registry; issues: string[] } {
	const issues: string[] = [];
	const raw = parseYaml(text) as unknown;
	if (!isRecord(raw)) throw new Error(`${REGISTRY_PATH}: root must be a mapping`);
	if (raw.version !== 1) issues.push("version must be 1");
	const constantScopes = Array.isArray(raw.constantScopes)
		? raw.constantScopes.filter((v) => typeof v === "string")
		: [];
	const toolArgScopes = Array.isArray(raw.toolArgScopes) ? raw.toolArgScopes.filter((v) => typeof v === "string") : [];
	if (!Array.isArray(raw.entries)) issues.push("entries must be a list");
	const entries: RegistryEntry[] = [];
	const seen = new Set<string>();
	(Array.isArray(raw.entries) ? raw.entries : []).forEach((item, index) => {
		const entry = validateEntry(item, index, issues);
		if (!entry) return;
		const key = entryKey(entry);
		if (seen.has(key)) issues.push(`entries[${index}] (${entry.name}): duplicate of an earlier ${entry.kind} entry`);
		seen.add(key);
		entries.push(entry);
	});
	return { registry: { version: 1, constantScopes, toolArgScopes, entries }, issues };
}

export function loadRegistry(root: string): Registry {
	const { registry, issues } = parseRegistry(readFileSync(join(root, REGISTRY_PATH), "utf8"));
	if (issues.length > 0) throw new Error(`${REGISTRY_PATH}:\n  ${issues.join("\n  ")}`);
	return registry;
}
