import type { MiddlewareRuleDefinition } from "./runtime.js";
import { STALLED_TURN_RULE_DEFINITION } from "./stalled-turn.js";
import type { MiddlewareRule } from "./types.js";

/**
 * Builtin middleware rule definitions. Add entries here (declarative rule plus
 * effect payloads/pure predicates) to ship a builtin policy; the snapshot
 * channel delivers the declarative half to workers, which resolve payloads
 * from this table by rule id.
 */
const BUILTIN_MIDDLEWARE_RULE_DEFINITIONS: ReadonlyArray<MiddlewareRuleDefinition> = [STALLED_TURN_RULE_DEFINITION];

export const BUILTIN_MIDDLEWARE_RULE_IDS = BUILTIN_MIDDLEWARE_RULE_DEFINITIONS.map((definition) => definition.rule.id);

export function listMiddlewareRuleDefinitions(): MiddlewareRuleDefinition[] {
	return BUILTIN_MIDDLEWARE_RULE_DEFINITIONS.map(cloneRuleDefinition);
}

export function listMiddlewareRules(): MiddlewareRule[] {
	return BUILTIN_MIDDLEWARE_RULE_DEFINITIONS.map((definition) => cloneMiddlewareRule(definition.rule));
}

export function cloneMiddlewareRule(rule: MiddlewareRule): MiddlewareRule {
	return {
		id: rule.id,
		source: rule.source,
		description: rule.description,
		enabled: rule.enabled,
		hooks: [...rule.hooks],
		effectKinds: [...rule.effectKinds],
	};
}

function cloneRuleDefinition(definition: MiddlewareRuleDefinition): MiddlewareRuleDefinition {
	const cloned: MiddlewareRuleDefinition = {
		rule: cloneMiddlewareRule(definition.rule),
		effects: [...definition.effects],
	};
	if (definition.toolNames !== undefined) cloned.toolNames = [...definition.toolNames];
	if (definition.predicate !== undefined) cloned.predicate = definition.predicate;
	return cloned;
}
