import type { DomainBundle } from "../../core/domain-loader.js";
import type { MiddlewareContract } from "./contract.js";
import { cloneMiddlewareRule, listMiddlewareRuleDefinitions } from "./rules.js";
import { type MiddlewareRuleDefinition, runMiddlewareHook } from "./runtime.js";
import { createMiddlewareSnapshot } from "./snapshot.js";

export interface MiddlewareBundleOptions {
	/**
	 * In-process rule definitions registered by the composition root, appended
	 * after the builtin definitions. A definition whose rule id collides with
	 * an earlier one is dropped so `ruleIds` stays unambiguous.
	 */
	ruleDefinitions?: ReadonlyArray<MiddlewareRuleDefinition>;
}

export function createMiddlewareBundle(options: MiddlewareBundleOptions = {}): DomainBundle<MiddlewareContract> {
	const definitions = combineRuleDefinitions(listMiddlewareRuleDefinitions(), options.ruleDefinitions ?? []);
	const contract: MiddlewareContract = {
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
	return {
		extension: {
			start() {
				return undefined;
			},
		},
		contract,
	};
}

function combineRuleDefinitions(
	builtin: ReadonlyArray<MiddlewareRuleDefinition>,
	registered: ReadonlyArray<MiddlewareRuleDefinition>,
): MiddlewareRuleDefinition[] {
	const seen = new Set<string>();
	const combined: MiddlewareRuleDefinition[] = [];
	for (const definition of [...builtin, ...registered]) {
		if (seen.has(definition.rule.id)) continue;
		seen.add(definition.rule.id);
		combined.push(definition);
	}
	return combined;
}
