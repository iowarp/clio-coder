import type { MiddlewareContract } from "./contract.js";
import { cloneMiddlewareRule, listMiddlewareRuleDefinitions, listMiddlewareRules } from "./rules.js";
import { cloneMiddlewareEffect, type MiddlewareRuleDefinition, runMiddlewareHook } from "./runtime.js";
import type { MiddlewareRule, MiddlewareSnapshot } from "./types.js";

export function createMiddlewareSnapshot(
	rules: ReadonlyArray<MiddlewareRule> = listMiddlewareRules(),
): MiddlewareSnapshot {
	return {
		version: 1,
		rules: rules.map(cloneMiddlewareRule),
	};
}

/**
 * Rebuild a middleware contract from a declarative snapshot, typically inside
 * a worker subprocess. The snapshot carries no effect payloads, so each rule
 * is resolved against the builtin definition table by id; the snapshot's
 * declarative fields (enabled, hooks, effectKinds) stay authoritative. A rule
 * id with no builtin definition in this binary evaluates to no effects.
 */
export function createMiddlewareContractFromSnapshot(snapshot: MiddlewareSnapshot): MiddlewareContract {
	const builtinById = new Map(listMiddlewareRuleDefinitions().map((definition) => [definition.rule.id, definition]));
	const definitions: MiddlewareRuleDefinition[] = snapshot.rules.map((rule) => {
		const builtin = builtinById.get(rule.id);
		const definition: MiddlewareRuleDefinition = {
			rule: cloneMiddlewareRule(rule),
			effects: builtin === undefined ? [] : builtin.effects.map(cloneMiddlewareEffect),
		};
		if (builtin?.toolNames !== undefined) definition.toolNames = [...builtin.toolNames];
		return definition;
	});
	return {
		runHook(input) {
			return runMiddlewareHook(input, definitions);
		},
		listRules() {
			return definitions.map((definition) => cloneMiddlewareRule(definition.rule));
		},
		snapshot() {
			return createMiddlewareSnapshot(definitions.map((definition) => definition.rule));
		},
	};
}
