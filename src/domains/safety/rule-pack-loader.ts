/**
 * Layered rule pack loader for damage-control-rules.yaml (schema v2).
 *
 * v2 stores the always-on hard blocks in a named base pack.
 *
 * v1 schema is tolerated for backward compatibility: a top-level `rules:`
 * array is mapped to packs[base].
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { DamageControlRule, DamageControlRuleset } from "./damage-control.js";
import { compileDamageControlRule } from "./rule-compiler.js";

export type PackId = "base";

export interface RulePacks {
	base: DamageControlRuleset;
}

interface RawPack {
	id?: unknown;
	rules?: unknown;
}

interface RawDocument {
	version?: unknown;
	packs?: unknown;
	rules?: unknown;
}

function compilePackRules(rawRules: unknown, packId: string): DamageControlRule[] {
	if (rawRules === undefined || rawRules === null) return [];
	if (!Array.isArray(rawRules)) {
		throw new Error(`damage-control pack '${packId}': expected array at 'rules'`);
	}
	return rawRules.map((rule, index) => compileDamageControlRule(rule as Record<string, unknown>, index));
}

function emptyRuleset(version: number): DamageControlRuleset {
	return { version, rules: [] };
}

export function loadRulePacks(yamlPath: string): RulePacks {
	const raw = readFileSync(yamlPath, "utf8");
	const parsed = parseYaml(raw) as RawDocument | null;
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`damage-control rules at ${yamlPath}: expected mapping at document root`);
	}
	const version = typeof parsed.version === "number" ? parsed.version : 0;

	if (version === 1) {
		// v1: flat `rules:` becomes the base pack.
		const baseRules = compilePackRules(parsed.rules, "base");
		return {
			base: { version: 1, rules: baseRules },
		};
	}

	if (version !== 2) {
		throw new Error(`damage-control rules at ${yamlPath}: unsupported version ${String(parsed.version)}`);
	}

	if (!Array.isArray(parsed.packs)) {
		throw new Error(`damage-control rules at ${yamlPath}: expected array at 'packs'`);
	}
	const out: RulePacks = {
		base: emptyRuleset(2),
	};
	for (const rawPack of parsed.packs as RawPack[]) {
		const packId = rawPack.id;
		if (packId !== "base") {
			throw new Error(`damage-control rules at ${yamlPath}: unknown pack id ${String(packId)}`);
		}
		const rules = compilePackRules(rawPack.rules, packId);
		out[packId] = { version: 2, rules };
	}
	return out;
}

export function loadDefaultRulePacks(): RulePacks {
	return loadRulePacks(join(resolvePackageRoot(), "damage-control-rules.yaml"));
}

let cachedPacks: RulePacks | null = null;

export function getCachedDefaultRulePacks(): RulePacks {
	if (cachedPacks === null) cachedPacks = loadDefaultRulePacks();
	return cachedPacks;
}

export function resetRulePackCache(): void {
	cachedPacks = null;
}
