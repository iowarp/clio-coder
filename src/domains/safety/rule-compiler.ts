import type { DamageControlRule } from "./damage-control.js";

interface RawRule {
	id?: unknown;
	description?: unknown;
	pattern?: unknown;
	class?: unknown;
	block?: unknown;
}

function asString(value: unknown, ruleId: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`damage-control rule '${ruleId}': expected string for ${field}`);
	}
	return value;
}

export function compileDamageControlRule(raw: RawRule, index: number): DamageControlRule {
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

export function compileDamageControlRules(rawRules: unknown, ctx: string): DamageControlRule[] {
	if (rawRules === undefined || rawRules === null) return [];
	if (!Array.isArray(rawRules)) {
		throw new Error(`damage-control ${ctx}: expected array at 'rules'`);
	}
	return rawRules.map((rule, index) => compileDamageControlRule(rule as RawRule, index));
}
