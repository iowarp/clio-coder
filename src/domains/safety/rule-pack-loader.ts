/**
 * Layered rule pack loader for damage-control-rules.yaml (schema v2).
 *
 * v2 splits the flat v1 rule list into named packs:
 *   - base: always-on hard blocks (rm -rf /, dd of=/dev/, fork bombs, ...).
 *   - dev: self-development extras (git push, git reset --hard, gh pr merge).
 *   - super: privileged-mode extras (currently empty placeholder).
 *
 * The safety domain consumes the base pack; self-dev guards pull the dev
 * pack; an opt-in super pack lands in a future iteration. v1 schema is
 * tolerated for backward compatibility: a top-level `rules:` array is
 * mapped to packs[base].
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { DamageControlRule, DamageControlRuleset } from "./damage-control.js";

export type PackId = "base" | "dev" | "super";

export interface RulePacks {
	base: DamageControlRuleset;
	dev: DamageControlRuleset;
	super: DamageControlRuleset;
}

interface RawRule {
	id?: unknown;
	description?: unknown;
	pattern?: unknown;
	class?: unknown;
	block?: unknown;
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
		throw new Error(`damage-control rule '${id}': invalid pattern: ${msg}`);
	}
	return { id, description, pattern, class: klass, block: raw.block };
}

function compilePackRules(rawRules: unknown, packId: string): DamageControlRule[] {
	if (rawRules === undefined || rawRules === null) return [];
	if (!Array.isArray(rawRules)) {
		throw new Error(`damage-control pack '${packId}': expected array at 'rules'`);
	}
	return rawRules.map((r, i) => compileRule(r as RawRule, i));
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
		// v1: flat `rules:` becomes the base pack; dev and super are empty.
		const baseRules = compilePackRules(parsed.rules, "base");
		return {
			base: { version: 1, rules: baseRules },
			dev: emptyRuleset(1),
			super: emptyRuleset(1),
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
		dev: emptyRuleset(2),
		super: emptyRuleset(2),
	};
	for (const rawPack of parsed.packs as RawPack[]) {
		const packId = rawPack.id;
		if (packId !== "base" && packId !== "dev" && packId !== "super") {
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

export interface ApplicablePacksOptions {
	selfDev: boolean;
	safetyMode: "default" | "advise" | "super" | string;
}

/**
 * Combine the rules from each active pack into a single flat list.
 * The base pack always applies. The dev pack applies when self-dev is
 * active. The super pack applies when the active safety mode is `super`.
 */
export function applicablePacks(packs: RulePacks, options: ApplicablePacksOptions): DamageControlRule[] {
	const out: DamageControlRule[] = [...packs.base.rules];
	if (options.selfDev) out.push(...packs.dev.rules);
	if (options.safetyMode === "super") out.push(...packs.super.rules);
	return out;
}

let cachedPacks: RulePacks | null = null;

export function getCachedDefaultRulePacks(): RulePacks {
	if (cachedPacks === null) cachedPacks = loadDefaultRulePacks();
	return cachedPacks;
}

export function resetRulePackCache(): void {
	cachedPacks = null;
}
