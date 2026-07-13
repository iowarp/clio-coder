import type { DomainBundle } from "../../core/domain-loader.js";
import {
	createHookBudgetTracker,
	type HookBudgetTracker,
	resolveHookBudgetsFromEnv,
	resolveHookBudgetTunablesFromEnv,
} from "./budget.js";
import type { MiddlewareContract } from "./contract.js";
import { cloneMiddlewareRule, listMiddlewareRuleDefinitions } from "./rules.js";
import {
	type MiddlewareDiagnosticSink,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	registrationFromRuleDefinition,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
} from "./runtime.js";
import { createMiddlewareSnapshot } from "./snapshot.js";

/**
 * One session-scoped budget tracker per contract, seeded from the environment so
 * an operator can loosen budgets (`CLIO_HOOK_BUDGET_*`) without a rebuild. The
 * persistent instance is what makes warmup grace and the steady-state rolling
 * window meaningful: state accumulates across every hook occurrence in the run.
 */
export function createEnvHookBudgetTracker(env: NodeJS.ProcessEnv = process.env): HookBudgetTracker {
	return createHookBudgetTracker({ budgets: resolveHookBudgetsFromEnv(env), ...resolveHookBudgetTunablesFromEnv(env) });
}

export interface MiddlewareBundleOptions {
	/**
	 * In-process rule definitions registered by the composition root, appended
	 * after the builtin definitions. A definition whose rule id collides with
	 * an earlier one is dropped so `ruleIds` stays unambiguous.
	 */
	ruleDefinitions?: ReadonlyArray<MiddlewareRuleDefinition>;
	/**
	 * Coded hook registrations, evaluated after every declarative rule, in
	 * array order. Ids share one namespace with rule ids; a registration whose
	 * id collides with an earlier rule or registration is dropped.
	 */
	registrations?: ReadonlyArray<MiddlewareHookRegistration>;
	/**
	 * Receives isolation and budget diagnostics from hook evaluation. Defaults
	 * to the stderr writer in runtime.ts.
	 */
	onDiagnostic?: MiddlewareDiagnosticSink;
	/**
	 * Budget tracker override. Defaults to an env-seeded session-scoped tracker;
	 * tests inject a deterministic one to drive warmup/rolling-window behaviour.
	 */
	budgetTracker?: HookBudgetTracker;
}

export function createMiddlewareBundle(options: MiddlewareBundleOptions = {}): DomainBundle<MiddlewareContract> {
	const ruleDefinitions = combineRuleDefinitions(listMiddlewareRuleDefinitions(), options.ruleDefinitions ?? []);
	const registrations = combineRegistrations(ruleDefinitions, options.registrations ?? []);
	const registeredIds = new Set(registrations.map((registration) => registration.id));
	let diagnosticSink = options.onDiagnostic;
	const budgetTracker = options.budgetTracker ?? createEnvHookBudgetTracker();
	const contract: MiddlewareContract = {
		runHook(input) {
			return runMiddlewareRegistrations(input, registrations, {
				budgetTracker,
				...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
			});
		},
		runAsyncHook(input, priorEffects = []) {
			return runMiddlewareAsyncRegistrations(input, registrations, priorEffects, {
				...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
			});
		},
		listRules() {
			return ruleDefinitions.map((definition) => cloneMiddlewareRule(definition.rule));
		},
		snapshot() {
			return createMiddlewareSnapshot(ruleDefinitions.map((definition) => definition.rule));
		},
		registerHook(registration) {
			if (registeredIds.has(registration.id)) return;
			registeredIds.add(registration.id);
			registrations.push(registration);
		},
		setDiagnosticSink(sink) {
			diagnosticSink = sink;
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

/**
 * One ordered evaluation list: declarative rules first (builtin, then
 * composition-root), then coded registrations, deduplicated across the shared
 * id namespace with the earlier entry winning.
 */
function combineRegistrations(
	ruleDefinitions: ReadonlyArray<MiddlewareRuleDefinition>,
	coded: ReadonlyArray<MiddlewareHookRegistration>,
): MiddlewareHookRegistration[] {
	const seen = new Set<string>(ruleDefinitions.map((definition) => definition.rule.id));
	const combined: MiddlewareHookRegistration[] = ruleDefinitions.map(registrationFromRuleDefinition);
	for (const registration of coded) {
		if (seen.has(registration.id)) continue;
		seen.add(registration.id);
		combined.push(registration);
	}
	return combined;
}
