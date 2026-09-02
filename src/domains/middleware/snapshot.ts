import { createHookBudgetTracker, resolveHookBudgetsFromEnv, resolveHookBudgetTunablesFromEnv } from "./budget.js";
import type { MiddlewareContract } from "./contract.js";
import { createMiddlewareRegistrationTable } from "./registrations.js";
import { cloneMiddlewareRule, listMiddlewareRuleDefinitions, listMiddlewareRules } from "./rules.js";
import {
	cloneMiddlewareEffect,
	type MiddlewareDiagnosticSink,
	type MiddlewareRuleDefinition,
	registrationFromRuleDefinition,
	runMiddlewareRegistrations,
	writeMiddlewareDiagnosticToStderr,
} from "./runtime.js";
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
		if (builtin?.predicate !== undefined) definition.predicate = builtin.predicate;
		return definition;
	});
	let diagnosticSink: MiddlewareDiagnosticSink | undefined;
	// Workers never receive owned registrations; the table exists so the
	// worker contract satisfies the same interface with the same semantics.
	const table = createMiddlewareRegistrationTable({
		fixed: definitions.map(registrationFromRuleDefinition),
		diagnosticSink: () => diagnosticSink ?? writeMiddlewareDiagnosticToStderr,
	});
	const budgetTracker = createHookBudgetTracker({
		budgets: resolveHookBudgetsFromEnv(),
		...resolveHookBudgetTunablesFromEnv(),
	});
	return {
		runHook(input) {
			const registrations = table.list();
			return runMiddlewareRegistrations(input, registrations, {
				budgetTracker,
				...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
			});
		},
		listRules() {
			return definitions.map((definition) => cloneMiddlewareRule(definition.rule));
		},
		snapshot() {
			return createMiddlewareSnapshot(definitions.map((definition) => definition.rule));
		},
		registerHook(registration) {
			table.registerHook(registration);
		},
		setDiagnosticSink(sink) {
			diagnosticSink = sink;
		},
		prepareRegistrationReplacement(owner, generation, registrations) {
			return table.prepareReplacement(owner, generation, registrations);
		},
		replaceRegistrations(owner, generation, registrations) {
			return table.replaceRegistrations(owner, generation, registrations);
		},
		ownedGeneration(owner) {
			return table.ownedGeneration(owner);
		},
	};
}
