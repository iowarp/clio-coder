import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { compileDamageControlRules } from "./rule-compiler.js";

/**
 * Rule-driven hard-block interceptor. Rules are seeded from
 * `damage-control-rules.yaml` at the repo root and compiled once at load. Slice
 * 3 wires the matcher into dispatch; this module is pure data + matching.
 *
 * The on-disk file is layered into named rule packs (schema v2). For
 * backward compatibility this module exposes a flat ruleset built from the
 * `base` pack only; consumers that need the dev or super packs use
 * `src/domains/safety/rule-pack-loader.ts`.
 */

export interface DamageControlRule {
	id: string;
	description: string;
	pattern: RegExp;
	class: string;
	block: boolean;
	ask?: boolean;
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
	ask?: boolean;
}

interface RawPack {
	id?: unknown;
	rules?: unknown;
}

interface RawRuleset {
	version?: unknown;
	rules?: unknown;
	packs?: unknown;
}

export function loadRuleset(path: string): DamageControlRuleset {
	const raw = readFileSync(path, "utf8");
	const parsed = parseYaml(raw) as RawRuleset | null;
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`damage-control rules at ${path}: expected mapping at document root`);
	}
	const version = typeof parsed.version === "number" ? parsed.version : 0;

	if (version === 1) {
		return { version, rules: compileDamageControlRules(parsed.rules, `rules at ${path}`) };
	}

	if (version === 2) {
		if (!Array.isArray(parsed.packs)) {
			throw new Error(`damage-control rules at ${path}: expected array at 'packs'`);
		}
		const baseRaw = (parsed.packs as RawPack[]).find((p) => p.id === "base");
		const baseRules = baseRaw ? compileDamageControlRules(baseRaw.rules, `pack 'base' at ${path}`) : [];
		return { version, rules: baseRules };
	}

	throw new Error(`damage-control rules at ${path}: unsupported version ${String(parsed.version)}`);
}

export function loadDefaultRuleset(): DamageControlRuleset {
	const path = join(resolvePackageRoot(), "damage-control-rules.yaml");
	return loadRuleset(path);
}

export function match(commandString: string, ruleset: DamageControlRuleset): DamageControlMatch | null {
	if (commandString.length === 0) return null;
	for (const rule of ruleset.rules) {
		if (rule.pattern.test(commandString)) {
			const match: DamageControlMatch = {
				ruleId: rule.id,
				reason: `matched ${rule.id}: ${rule.description}`,
				actionClass: rule.class,
				block: rule.block,
			};
			if (rule.ask !== undefined) match.ask = rule.ask;
			return match;
		}
	}
	return null;
}
