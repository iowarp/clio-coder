import type { MiddlewareRule } from "./types.js";

export const BUILTIN_MIDDLEWARE_RULE_IDS = [] as const;

const BUILTIN_MIDDLEWARE_RULES: ReadonlyArray<MiddlewareRule> = [];

export function listMiddlewareRules(): MiddlewareRule[] {
	return BUILTIN_MIDDLEWARE_RULES.map(cloneRule);
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
