/**
 * Hold docs/knobs.yaml against the source tree in both directions, and the
 * rendered docs/knobs.md against the registry. Returns the drift conditions
 * as strings; `scripts/check-hygiene.ts` reports them under `knob-registry`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, parseRegistry, REGISTRY_PATH } from "./registry.js";
import { KNOBS_DOC_PATH, normalizeRenderedDoc, renderKnobsDoc } from "./render.js";
import { collectSourceKnobs, projectFileSites } from "./sources.js";
import {
	entryKey,
	type Registry,
	type RegistryEntry,
	type SourceInventory,
	type SourceKnob,
	sourceKey,
} from "./types.js";

export interface RegistryMatch {
	entry: RegistryEntry;
	sources: SourceKnob[];
}

/** Pair every registry entry with the source knobs it covers, by key or by family pattern. */
export function matchRegistry(registry: Registry, inventory: SourceInventory): Map<string, RegistryMatch> {
	const matches = new Map<string, RegistryMatch>();
	const byKey = new Map<string, SourceKnob>();
	for (const knob of inventory.knobs) byKey.set(sourceKey(knob), knob);
	for (const entry of registry.entries) {
		const sources: SourceKnob[] = [];
		const direct = byKey.get(entryKey(entry));
		if (direct) sources.push(direct);
		if (entry.pattern) {
			const pattern = new RegExp(entry.pattern);
			for (const knob of inventory.knobs) {
				if (knob.kind === entry.kind && knob !== direct && pattern.test(knob.name)) sources.push(knob);
			}
		}
		matches.set(entryKey(entry), { entry, sources });
	}
	return matches;
}

function normalizeDefault(value: string): string {
	return value
		.trim()
		.replace(/^["'`](.*)["'`]$/, "$1")
		.replace(/_/g, "")
		.toLowerCase();
}

export async function checkKnobRegistry(root: string): Promise<string[]> {
	const errors: string[] = [];
	const registryPath = join(root, REGISTRY_PATH);
	if (!existsSync(registryPath)) return [`${REGISTRY_PATH} is missing`];
	const parsed = parseRegistry(readFileSync(registryPath, "utf8"));
	if (parsed.issues.length > 0) return parsed.issues.map((issue) => `${REGISTRY_PATH}: ${issue}`);
	const registry = parsed.registry;
	const inventory = await collectSourceKnobs(root, registry);

	for (const file of inventory.unmappedCliFiles) {
		errors.push(
			`${file} carries a --flag literal but CLI_FILE_COMMANDS in scripts/knobs/sources.ts maps it to no command`,
		);
	}

	const matches = matchRegistry(registry, inventory);
	const covered = new Set<SourceKnob>();
	for (const { entry, sources } of matches.values()) {
		const label = `${entry.kind} ${entry.command ?? entry.file ?? entry.source ?? ""} ${entry.name}`.replace(/\s+/g, " ");
		if (entry.kind === "project-file") {
			if (entry.file && projectFileSites(root, entry.file, entry.name).length === 0) {
				errors.push(`${REGISTRY_PATH} lists ${label} but no loader for ${entry.file} names its last key segment`);
			}
			continue;
		}
		if (sources.length === 0) {
			errors.push(`${REGISTRY_PATH} lists ${label} but the source tree no longer reads it`);
			continue;
		}
		for (const source of sources) covered.add(source);
		const direct = sources.find((s) => sourceKey(s) === entryKey(entry));
		if (
			direct?.default !== undefined &&
			entry.default !== undefined &&
			(entry.kind === "setting" || entry.kind === "constant")
		) {
			if (normalizeDefault(direct.default) !== normalizeDefault(entry.default)) {
				errors.push(`${label}: registry default '${entry.default}' disagrees with the code default '${direct.default}'`);
			}
		}
	}
	for (const knob of inventory.knobs) {
		if (covered.has(knob)) continue;
		const where = knob.sites
			.slice(0, 3)
			.map((s) => `${s.path}:${s.line}`)
			.join(", ");
		const scope = knob.command ?? knob.file ?? knob.source;
		errors.push(
			`source reads ${knob.kind} ${scope ? `${scope} ` : ""}${knob.name} (${where}) but ${REGISTRY_PATH} does not list it`,
		);
	}

	const docPath = join(root, KNOBS_DOC_PATH);
	if (!existsSync(docPath)) {
		errors.push(`${KNOBS_DOC_PATH} is missing; run: npm run knobs`);
	} else {
		const expected = normalizeRenderedDoc(renderKnobsDoc(root, registry, inventory));
		const actual = normalizeRenderedDoc(readFileSync(docPath, "utf8"));
		if (expected !== actual) errors.push(`${KNOBS_DOC_PATH} is stale against ${REGISTRY_PATH}; run: npm run knobs`);
	}
	return errors;
}

export { loadRegistry };
