/**
 * Loader for the package-owned damage-control-rules.yaml (schema v2), whose
 * single `base` pack holds the always-on rules. Each rule compiles once here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { parsePackagedYaml } from "../../core/packaged-yaml.js";
import type { DamageControlRule, DamageControlRuleset } from "./damage-control.js";

interface RawRule {
	id?: unknown;
	description?: unknown;
	pattern?: unknown;
	class?: unknown;
	block?: unknown;
	ask?: unknown;
}

interface RawDocument {
	version?: unknown;
	packs?: unknown;
}

function asString(value: unknown, ruleId: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`damage-control rule '${ruleId}': expected string for ${field}`);
	}
	return value;
}

function compileRule(raw: RawRule, index: number): DamageControlRule {
	if (typeof raw.id !== "string" || raw.id.length === 0) {
		throw new Error(`damage-control rule at index ${index}: missing or non-string 'id'`);
	}
	const id = raw.id;
	const description = asString(raw.description, id, "description");
	const patternString = asString(raw.pattern, id, "pattern");
	const klass = asString(raw.class, id, "class");
	if (typeof raw.block !== "boolean") {
		throw new Error(`damage-control rule '${id}': expected boolean for block`);
	}
	if (raw.ask !== undefined && typeof raw.ask !== "boolean") {
		throw new Error(`damage-control rule '${id}': expected boolean for ask`);
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(patternString, "i");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`damage-control rule '${id}': invalid pattern: ${msg}`);
	}
	return {
		id,
		description,
		pattern,
		class: klass,
		block: raw.block,
		...(raw.ask !== undefined ? { ask: raw.ask } : {}),
	};
}

function loadBaseRuleset(yamlPath: string): DamageControlRuleset {
	const parsed = parsePackagedYaml(readFileSync(yamlPath, "utf8")) as RawDocument | null;
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`damage-control rules at ${yamlPath}: expected mapping at document root`);
	}
	if (parsed.version !== 2) {
		throw new Error(`damage-control rules at ${yamlPath}: unsupported version ${String(parsed.version)}`);
	}
	if (!Array.isArray(parsed.packs)) {
		throw new Error(`damage-control rules at ${yamlPath}: expected array at 'packs'`);
	}
	let rawRules: unknown;
	for (const pack of parsed.packs as Array<{ id?: unknown; rules?: unknown }>) {
		if (pack.id !== "base") {
			throw new Error(`damage-control rules at ${yamlPath}: unknown pack id ${String(pack.id)}`);
		}
		rawRules = pack.rules;
	}
	if (rawRules === undefined || rawRules === null) return { version: 2, rules: [] };
	if (!Array.isArray(rawRules)) throw new Error("damage-control pack 'base': expected array at 'rules'");
	return { version: 2, rules: rawRules.map((rule, index) => compileRule(rule as RawRule, index)) };
}

let cachedBase: DamageControlRuleset | null = null;

/** The shipped base ruleset, loaded and compiled on first use. */
export function getCachedBaseRuleset(): DamageControlRuleset {
	cachedBase ??= loadBaseRuleset(join(resolvePackageRoot(), "damage-control-rules.yaml"));
	return cachedBase;
}
