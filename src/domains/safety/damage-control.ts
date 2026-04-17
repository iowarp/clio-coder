import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";

/**
 * Rule-driven hard-block interceptor. Rules are seeded from
 * `damage-control-rules.yaml` at the repo root and compiled once at load. Slice
 * 3 wires the matcher into dispatch; this module is pure data + matching.
 */

export interface DamageControlRule {
	id: string;
	description: string;
	pattern: RegExp;
	class: string;
	block: boolean;
}

export interface DamageControlRuleset {
	version: number;
	rules: ReadonlyArray<DamageControlRule>;
}

export interface DamageControlMatch {
	ruleId: string;
	reason: string;
	actionClass: string;
	block: boolean;
}

interface RawRule {
	id?: unknown;
	description?: unknown;
	pattern?: unknown;
	class?: unknown;
	block?: unknown;
}

interface RawRuleset {
	version?: unknown;
	rules?: unknown;
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
	let pattern: RegExp;
	try {
		pattern = new RegExp(patternString, "i");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`damage-control rule '${id}': invalid pattern — ${msg}`);
	}
	return { id, description, pattern, class: klass, block: raw.block };
}

export function loadRuleset(path: string): DamageControlRuleset {
	const raw = readFileSync(path, "utf8");
	const parsed = parseYaml(raw) as RawRuleset | null;
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`damage-control rules at ${path}: expected mapping at document root`);
	}
	const version = typeof parsed.version === "number" ? parsed.version : 0;
	if (version !== 1) {
		throw new Error(`damage-control rules at ${path}: unsupported version ${String(parsed.version)}`);
	}
	if (!Array.isArray(parsed.rules)) {
		throw new Error(`damage-control rules at ${path}: expected array at 'rules'`);
	}
	const rules = parsed.rules.map((r, i) => compileRule(r as RawRule, i));
	return { version, rules };
}

export function loadDefaultRuleset(): DamageControlRuleset {
	const path = join(resolvePackageRoot(), "damage-control-rules.yaml");
	return loadRuleset(path);
}

export function match(commandString: string, ruleset: DamageControlRuleset): DamageControlMatch | null {
	if (commandString.length === 0) return null;
	for (const rule of ruleset.rules) {
		if (rule.pattern.test(commandString)) {
			return {
				ruleId: rule.id,
				reason: `matched ${rule.id}: ${rule.description}`,
				actionClass: rule.class,
				block: rule.block,
			};
		}
	}
	return null;
}
