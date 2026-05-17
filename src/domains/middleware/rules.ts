import type { MiddlewareHook, MiddlewareRule } from "./types.js";

export const BUILTIN_MIDDLEWARE_RULE_IDS = [] as const;

const BUILTIN_MIDDLEWARE_RULES: ReadonlyArray<MiddlewareRule> = [];

export function listMiddlewareRules(): MiddlewareRule[] {
	return BUILTIN_MIDDLEWARE_RULES.map(cloneRule);
}

export function middlewareRuleIdsForHook(hook: MiddlewareHook): string[] {
	const ids: string[] = [];
	for (const rule of BUILTIN_MIDDLEWARE_RULES) {
		const hooks: ReadonlyArray<MiddlewareHook> = rule.hooks;
		if (rule.enabled && hooks.includes(hook)) ids.push(rule.id);
	}
	return ids;
}

function cloneRule(rule: MiddlewareRule): MiddlewareRule {
	return {
		id: rule.id,
		source: rule.source,
		description: rule.description,
		enabled: rule.enabled,
		hooks: [...rule.hooks],
		effectKinds: [...rule.effectKinds],
	};
}
