import { createHookBudgetTracker, type HookBudgetStats, type HookBudgetTracker } from "./budget.js";
import type { MiddlewareRegistrationConflictTier, MiddlewareRegistrationOwner } from "./registrations.js";
import { listMiddlewareRuleDefinitions } from "./rules.js";
import {
	MIDDLEWARE_HOOK_TEXT_MAX_CHARS,
	type MiddlewareEffect,
	type MiddlewareHook,
	type MiddlewareHookInput,
	type MiddlewareHookResult,
	type MiddlewareRule,
} from "./types.js";

/**
 * Runtime pairing of a declarative middleware rule with the data it needs to
 * act. The declarative `MiddlewareRule` is what validate.ts validates and what
 * travels in `MiddlewareSnapshot`; it carries no payloads, so effect payloads
 * and tool scoping live here, in process, as plain data. Evaluation is a pure
 * function over the hook input; no subprocess, no I/O.
 */
export interface MiddlewareRuleDefinition {
	rule: MiddlewareRule;
	/**
	 * Exact tool names this rule applies to. Absent means the rule applies to
	 * every hook input, including hooks that carry no tool name. When present,
	 * inputs without a tool name never match.
	 */
	toolNames?: ReadonlyArray<string>;
	/**
	 * Effects emitted verbatim when the rule matches. Effects whose kind is not
	 * declared in `rule.effectKinds` are dropped at evaluation time.
	 */
	effects: ReadonlyArray<MiddlewareEffect>;
	/**
	 * Optional pure predicate for builtin rules that need hook input inspection
	 * beyond hook/tool matching while still travelling as visible snapshot
	 * rules. It must not mutate input or hold runtime state.
	 */
	predicate?: (input: MiddlewareHookInput) => boolean;
}

/**
 * Coded hook registration: the in-process counterpart of a declarative rule.
 * `evaluate` runs synchronously on the caller's stack and may hold internal
 * state it owns (loop windows, per-turn budgets), but it communicates with the
 * rest of the system exclusively through the returned effects. Registrations
 * share an id namespace with declarative rules; on collision the earlier
 * entry wins.
 */
export interface MiddlewareHookRegistration {
	id: string;
	description: string;
	hooks: ReadonlyArray<MiddlewareHook>;
	/** Exact tool names, same matcher semantics as `MiddlewareRuleDefinition.toolNames`. */
	toolNames?: ReadonlyArray<string>;
	/** Synchronous evaluation. A throw is isolated and contributes no effects. */
	evaluate(input: MiddlewareHookInput, context?: MiddlewareHookEvaluationContext): ReadonlyArray<MiddlewareEffect>;
	/**
	 * Optional serialized I/O phase for awaited turn boundaries. Tool callers
	 * continue to use only `evaluate`; no async work is detached from a hook.
	 */
	evaluateAsync?(
		input: MiddlewareHookInput,
		context?: MiddlewareHookEvaluationContext,
	): Promise<ReadonlyArray<MiddlewareEffect>>;
}

/**
 * Ordered-evaluation context. `priorEffects` carries the effects emitted by
 * earlier registrations in the same hook run, so a consumer registered last
 * (e.g. the protected-artifacts guard absorbing `protect_path`) can react to
 * them deterministically without any shared mutable state.
 */
export interface MiddlewareHookEvaluationContext {
	priorEffects: ReadonlyArray<MiddlewareEffect>;
}

export type MiddlewareDiagnostic =
	| { kind: "hook_failed"; registrationId: string; hook: MiddlewareHook; message: string }
	| {
			kind: "budget_exceeded";
			registrationId: string;
			hook: MiddlewareHook;
			elapsedMs: number;
			budgetMs: number;
			/**
			 * Steady-state signal: this post-warmup overrun is part of consistent
			 * slowness (≥N of the last M post-warmup calls over budget), not a lone
			 * spike. Only steady-state overruns surface as an operator notice; every
			 * post-warmup overrun still rides the bus for telemetry.
			 */
			steadyStateWarn: boolean;
			/** Rolling-window stats (p50/p95/over-count) for diagnosis. */
			stats: HookBudgetStats;
	  }
	| {
			/**
			 * An owned registration set offered an id already held by a builtin
			 * rule or a host registration (dropped), or a later host registration
			 * took an id an owner held (evicted). Bookkeeping only; nothing was
			 * evaluated.
			 */
			kind: "registration_conflict";
			registrationId: string;
			owner: MiddlewareRegistrationOwner;
			generation: number;
			conflictsWith: MiddlewareRegistrationConflictTier;
			action: "dropped" | "evicted";
	  };

export type MiddlewareDiagnosticSink = (diagnostic: MiddlewareDiagnostic) => void;

/**
 * Default diagnostic sink. stderr-only for now; once the typed bus lands a
 * `middleware.hookFailed` channel, the composition root supplies a sink that
 * also emits there.
 */
export function writeMiddlewareDiagnosticToStderr(diagnostic: MiddlewareDiagnostic): void {
	if (diagnostic.kind === "hook_failed") {
		process.stderr.write(
			`[clio-coder:middleware] registration '${diagnostic.registrationId}' failed on '${diagnostic.hook}': ${diagnostic.message}\n`,
		);
		return;
	}
	if (diagnostic.kind === "registration_conflict") {
		process.stderr.write(`[clio-coder:middleware] ${formatRegistrationConflict(diagnostic)}\n`);
		return;
	}
	// A single post-warmup spike is telemetry, not operator-facing noise: only
	// consistent slowness prints, unless CLIO_CODER_HOOK_BUDGET_DEBUG=1 asks for all.
	if (!diagnostic.steadyStateWarn && process.env.CLIO_CODER_HOOK_BUDGET_DEBUG !== "1") return;
	const stats = diagnostic.stats;
	const trend =
		stats.window > 0
			? ` (slow on ${stats.overCount}/${stats.window} recent ${diagnostic.hook} calls, p95 ${stats.p95Ms.toFixed(1)}ms)`
			: "";
	process.stderr.write(
		`[clio-coder:middleware] registration '${diagnostic.registrationId}' exceeded budget on '${diagnostic.hook}': ` +
			`${diagnostic.elapsedMs.toFixed(1)}ms > ${diagnostic.budgetMs}ms${trend}\n`,
	);
}

/** One operator line for a registration_conflict diagnostic. */
export function formatRegistrationConflict(
	diagnostic: Extract<MiddlewareDiagnostic, { kind: "registration_conflict" }>,
): string {
	return diagnostic.action === "dropped"
		? `${diagnostic.owner} registration '${diagnostic.registrationId}' (generation ${diagnostic.generation}) dropped: id is held by a ${diagnostic.conflictsWith} registration`
		: `${diagnostic.owner} registration '${diagnostic.registrationId}' (generation ${diagnostic.generation}) evicted by a ${diagnostic.conflictsWith} registration with the same id`;
}

/**
 * Wrap a declarative rule definition as a degenerate coded registration so a
 * single ordered evaluation path serves both. The wrapped `evaluate` keeps the
 * rule's enabled flag, hook list, tool scoping, and declared-effect-kind
 * filtering exactly as `runMiddlewareHook` always applied them.
 */
export function registrationFromRuleDefinition(definition: MiddlewareRuleDefinition): MiddlewareHookRegistration {
	const registration: MiddlewareHookRegistration = {
		id: definition.rule.id,
		description: definition.rule.description,
		hooks: [...definition.rule.hooks],
		evaluate: (input) => evaluateRuleDefinition(definition, input),
	};
	if (definition.toolNames !== undefined) registration.toolNames = [...definition.toolNames];
	return registration;
}

export interface RunMiddlewareRegistrationsOptions {
	/** Receives isolation and budget diagnostics. Defaults to the stderr writer. */
	onDiagnostic?: MiddlewareDiagnosticSink;
	/** Millisecond clock, injectable for budget tests. */
	now?: () => number;
	/**
	 * Session-scoped budget tracker carrying phase budgets, warmup grace, and the
	 * rolling window. The bundle threads one persistent tracker across the run;
	 * when absent a fresh per-call tracker is used, so a lone direct call is
	 * always in warmup and never warns.
	 */
	budgetTracker?: HookBudgetTracker;
}

/**
 * Evaluate every matching registration, in array order, against one hook
 * input. Every registration runs; effects accumulate; the caller decides what
 * the effects mean (the registry treats the first `block_tool` as the
 * verdict). A throwing registration is reported and skipped, never propagated.
 */
export function runMiddlewareRegistrations(
	input: MiddlewareHookInput,
	registrations: ReadonlyArray<MiddlewareHookRegistration>,
	options: RunMiddlewareRegistrationsOptions = {},
): MiddlewareHookResult {
	const onDiagnostic = options.onDiagnostic ?? writeMiddlewareDiagnosticToStderr;
	const now = options.now ?? (() => performance.now());
	const budgetTracker = options.budgetTracker ?? createHookBudgetTracker();
	const effects: MiddlewareEffect[] = [];
	const ruleIds: string[] = [];
	for (const registration of registrations) {
		if (!registration.hooks.includes(input.hook)) continue;
		if (registration.toolNames !== undefined) {
			if (input.toolName === undefined) continue;
			if (!registration.toolNames.includes(input.toolName)) continue;
		}
		let emitted: ReadonlyArray<MiddlewareEffect>;
		const startedAt = now();
		try {
			// Each evaluate gets its own clone so a misbehaving registration
			// cannot mutate the input seen by later registrations.
			emitted = registration.evaluate(cloneHookInput(input), { priorEffects: [...effects] });
		} catch (err) {
			emitDiagnostic(onDiagnostic, {
				kind: "hook_failed",
				registrationId: registration.id,
				hook: input.hook,
				message: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		const elapsedMs = now() - startedAt;
		// Record every evaluation so the rolling window has an accurate
		// denominator, but never surface warmup overruns (one-time JIT/module
		// warmup is not misbehavior). Post-warmup overruns ride the bus for
		// telemetry; only steady-state slowness carries steadyStateWarn.
		const outcome = budgetTracker.record(registration.id, input.hook, elapsedMs);
		if (outcome.exceeded && !outcome.warmup) {
			emitDiagnostic(onDiagnostic, {
				kind: "budget_exceeded",
				registrationId: registration.id,
				hook: input.hook,
				elapsedMs,
				budgetMs: outcome.budgetMs,
				steadyStateWarn: outcome.warn,
				stats: outcome.stats,
			});
		}
		if (emitted.length === 0) continue;
		for (const effect of emitted) {
			effects.push(cloneMiddlewareEffect(effect));
		}
		if (!ruleIds.includes(registration.id)) ruleIds.push(registration.id);
	}
	return {
		hook: input.hook,
		input: cloneHookInput(input),
		effects,
		ruleIds,
	};
}

/**
 * Run only registrations with an async phase. Callers await this after the
 * synchronous phase and pass its effects as prior context, preserving order
 * without changing the latency-sensitive tool-hook contract.
 */
export async function runMiddlewareAsyncRegistrations(
	input: MiddlewareHookInput,
	registrations: ReadonlyArray<MiddlewareHookRegistration>,
	priorEffects: ReadonlyArray<MiddlewareEffect> = [],
	options: Pick<RunMiddlewareRegistrationsOptions, "onDiagnostic"> = {},
): Promise<MiddlewareHookResult> {
	const onDiagnostic = options.onDiagnostic ?? writeMiddlewareDiagnosticToStderr;
	const effects: MiddlewareEffect[] = [];
	const ruleIds: string[] = [];
	for (const registration of registrations) {
		if (registration.evaluateAsync === undefined || !registration.hooks.includes(input.hook)) continue;
		if (registration.toolNames !== undefined) {
			if (input.toolName === undefined || !registration.toolNames.includes(input.toolName)) continue;
		}
		let emitted: ReadonlyArray<MiddlewareEffect>;
		try {
			emitted = await registration.evaluateAsync(cloneHookInput(input), {
				priorEffects: [...priorEffects, ...effects],
			});
		} catch (err) {
			emitDiagnostic(onDiagnostic, {
				kind: "hook_failed",
				registrationId: registration.id,
				hook: input.hook,
				message: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		for (const effect of emitted) effects.push(cloneMiddlewareEffect(effect));
		if (emitted.length > 0) ruleIds.push(registration.id);
	}
	return { hook: input.hook, input: cloneHookInput(input), effects, ruleIds };
}

function emitDiagnostic(sink: MiddlewareDiagnosticSink, diagnostic: MiddlewareDiagnostic): void {
	try {
		sink(diagnostic);
	} catch {
		// A diagnostics sink must never affect hook evaluation or the turn.
	}
}

export function runMiddlewareHook(
	input: MiddlewareHookInput,
	definitions: ReadonlyArray<MiddlewareRuleDefinition> = listMiddlewareRuleDefinitions(),
): MiddlewareHookResult {
	return runMiddlewareRegistrations(input, definitions.map(registrationFromRuleDefinition));
}

function evaluateRuleDefinition(definition: MiddlewareRuleDefinition, input: MiddlewareHookInput): MiddlewareEffect[] {
	const rule = definition.rule;
	if (!rule.enabled) return [];
	if (!rule.hooks.includes(input.hook)) return [];
	if (definition.toolNames !== undefined) {
		if (input.toolName === undefined) return [];
		if (!definition.toolNames.includes(input.toolName)) return [];
	}
	if (definition.predicate !== undefined && !definition.predicate(input)) return [];
	const declaredKinds = new Set(rule.effectKinds);
	const emitted: MiddlewareEffect[] = [];
	for (const effect of definition.effects) {
		if (!declaredKinds.has(effect.kind)) continue;
		emitted.push(cloneMiddlewareEffect(effect));
	}
	return emitted;
}

export function cloneMiddlewareEffect(effect: MiddlewareEffect): MiddlewareEffect {
	switch (effect.kind) {
		case "inject_reminder": {
			const cloned: MiddlewareEffect = { kind: "inject_reminder", message: effect.message };
			if (effect.severity !== undefined) cloned.severity = effect.severity;
			return cloned;
		}
		case "annotate_tool_result": {
			const cloned: MiddlewareEffect = { kind: "annotate_tool_result", message: effect.message };
			if (effect.severity !== undefined) cloned.severity = effect.severity;
			return cloned;
		}
		case "block_tool":
			return { kind: "block_tool", reason: effect.reason, severity: effect.severity };
		case "protect_path":
			return { kind: "protect_path", path: effect.path, reason: effect.reason };
		case "request_continuation":
			return { kind: "request_continuation", message: effect.message };
		case "require_tool":
			return { kind: "require_tool", toolName: effect.toolName };
		case "lock_tools":
			return { kind: "lock_tools" };
	}
}

function cloneHookInput(input: MiddlewareHookInput): MiddlewareHookInput {
	const cloned: MiddlewareHookInput = { hook: input.hook };
	if (input.runId !== undefined) cloned.runId = input.runId;
	if (input.sessionId !== undefined) cloned.sessionId = input.sessionId;
	if (input.turnId !== undefined) cloned.turnId = input.turnId;
	if (input.toolCallId !== undefined) cloned.toolCallId = input.toolCallId;
	if (input.correlationId !== undefined) cloned.correlationId = input.correlationId;
	if (input.toolName !== undefined) cloned.toolName = input.toolName;
	if (input.modelId !== undefined) cloned.modelId = input.modelId;
	if (input.metadata !== undefined) cloned.metadata = { ...input.metadata };
	if (input.toolArgs !== undefined) cloned.toolArgs = { ...input.toolArgs };
	if (input.toolResultDetails !== undefined) cloned.toolResultDetails = { ...input.toolResultDetails };
	if (input.toolResultDigest !== undefined) {
		cloned.toolResultDigest = {
			text: input.toolResultDigest.text,
			provenance: { ...input.toolResultDigest.provenance },
		};
	}
	if (input.text !== undefined) cloned.text = input.text.slice(0, MIDDLEWARE_HOOK_TEXT_MAX_CHARS);
	return cloned;
}
