import type { DomainBundle } from "../../core/domain-loader.js";
import { telemetryContext, withToolTelemetryContext } from "../../core/telemetry/context.js";
import { recordTelemetry } from "../../core/telemetry/producer.js";
import {
	createHookBudgetTracker,
	type HookBudgetTracker,
	resolveHookBudgetsFromEnv,
	resolveHookBudgetTunablesFromEnv,
} from "./budget.js";
import type { MiddlewareContract } from "./contract.js";
import { createMiddlewareRegistrationTable } from "./registrations.js";
import { listMiddlewareRuleDefinitions } from "./rules.js";
import {
	type MiddlewareDiagnosticSink,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	registrationFromRuleDefinition,
	registrationMatchesTool,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
	writeMiddlewareDiagnosticToStderr,
} from "./runtime.js";
import { createMiddlewareSnapshot } from "./snapshot.js";
import type { MiddlewareHookResult, MiddlewareReminderSeverity } from "./types.js";

const SEVERITY_ORDER: ReadonlyArray<MiddlewareReminderSeverity> = ["info", "advisory", "warn", "hard-block"];
/** The evidence class shape middleware.fired admits; a class built from an operator's id that misses it is dropped. */
const EVIDENCE_CLASS = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}(?:@[a-z][a-z0-9-]{0,31})?$/;

/**
 * One middleware.fired per rule that emitted, under the hook's own session, run, turn and tool call. Telemetry never
 * changes what the hook returns (#431, #434).
 */
function recordFiredRules(result: MiddlewareHookResult, phase: "sync" | "async" | "awaited"): MiddlewareHookResult {
	if (!result.fired?.length) return result;
	try {
		const { input } = result;
		const ctx = withToolTelemetryContext(
			{
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
				...(input.runId !== undefined ? { runId: input.runId } : {}),
				...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
				...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
			},
			telemetryContext,
		);
		if (!ctx) return result;
		let offset = 0;
		for (const rule of result.fired) {
			const own = result.effects.slice(offset, offset + rule.effects.length);
			offset += rule.effects.length;
			let severity = -1;
			for (const effect of own) {
				const level =
					effect.kind === "inject_reminder"
						? SEVERITY_ORDER.indexOf(effect.severity ?? "info")
						: effect.kind === "block_tool"
							? SEVERITY_ORDER.indexOf("hard-block")
							: -1;
				if (level > severity) severity = level;
			}
			recordTelemetry(
				"middleware.fired",
				{
					hook: result.hook,
					phase,
					ruleId: rule.ruleId,
					effects: rule.effects.slice(0, 32),
					...(severity >= 0 ? { severity: SEVERITY_ORDER[severity] as MiddlewareReminderSeverity } : {}),
					...(rule.evidence !== undefined && EVIDENCE_CLASS.test(rule.evidence) ? { evidence: rule.evidence } : {}),
					...(input.toolName !== undefined ? { tool: input.toolName } : {}),
				},
				ctx,
			);
		}
	} catch {
		// A rule's record is evidence about the hook, never part of its verdict (#434).
	}
	return result;
}

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
			return recordFiredRules(
				runMiddlewareRegistrations(input, registrations, {
					budgetTracker,
					...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
				}),
				"sync",
			);
		},
		async runAsyncHook(input, priorEffects = []) {
			const registrations = table.list();
			return recordFiredRules(
				await runMiddlewareAsyncRegistrations(input, registrations, priorEffects, {
					...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
				}),
				"async",
			);
		},
		hasAwaitedHook(hook, toolName) {
			return table
				.list()
				.some(
					(registration) =>
						registration.awaited === true &&
						registration.hooks.includes(hook) &&
						registrationMatchesTool(registration, toolName),
				);
		},
		async runAwaitedHook(input, priorEffects = []) {
			return recordFiredRules(
				await runMiddlewareAsyncRegistrations(input, table.list(), priorEffects, {
					include: (registration) => registration.awaited === true,
					...(diagnosticSink !== undefined ? { onDiagnostic: diagnosticSink } : {}),
				}),
				"awaited",
			);
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
