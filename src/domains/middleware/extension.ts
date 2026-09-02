import type { DomainBundle } from "../../core/domain-loader.js";
import {
	createHookBudgetTracker,
	type HookBudgetTracker,
	resolveHookBudgetsFromEnv,
	resolveHookBudgetTunablesFromEnv,
} from "./budget.js";
import type { MiddlewareContract } from "./contract.js";
import { createMiddlewareRegistrationTable } from "./registrations.js";
import { cloneMiddlewareRule, listMiddlewareRuleDefinitions } from "./rules.js";
import {
	type MiddlewareDiagnosticSink,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	registrationFromRuleDefinition,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
	writeMiddlewareDiagnosticToStderr,
} from "./runtime.js";
import { createMiddlewareSnapshot } from "./snapshot.js";

/**
 * One session-scoped budget tracker per contract, seeded from the environment so
 * an operator can loosen budgets (`CLIO_CODER_HOOK_BUDGET_*`) without a rebuild. The
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
	let diagnosticSink = options.onDiagnostic;
	// Declarative rules are the fixed tier; construction-time coded
	// registrations are the first host entries, deduplicated first-wins across
	// the shared id namespace exactly as before.
	const table = createMiddlewareRegistrationTable({
		fixed: ruleDefinitions.map(registrationFromRuleDefinition),
		diagnosticSink: () => diagnosticSink ?? writeMiddlewareDiagnosticToStderr,
	});
	for (const registration of options.registrations ?? []) table.registerHook(registration);
	const budgetTracker = options.budgetTracker ?? createEnvHookBudgetTracker();
	const contract: MiddlewareContract = {
		runHook(input) {
			// Capture the list once; a replacement published mid-evaluation
			// takes effect for the next evaluation, never this one.
			const registrations = table.list();
			return runMiddlewareRegistrations(input, registrations, {
				budgetTracker,
				...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
			});
		},
		runAsyncHook(input, priorEffects = []) {
			const registrations = table.list();
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
