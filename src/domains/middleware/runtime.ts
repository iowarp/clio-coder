import { listMiddlewareRuleDefinitions } from "./rules.js";
import type {
	MiddlewareEffect,
	MiddlewareHook,
	MiddlewareHookInput,
	MiddlewareHookResult,
	MiddlewareRule,
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
	evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect>;
}

/** Soft per-evaluation wall-time budget. Overruns are reported, never preempted. */
export const MIDDLEWARE_HOOK_BUDGET_MS = 10;

export type MiddlewareDiagnostic =
	| { kind: "hook_failed"; registrationId: string; hook: MiddlewareHook; message: string }
	| { kind: "budget_exceeded"; registrationId: string; hook: MiddlewareHook; elapsedMs: number; budgetMs: number };

export type MiddlewareDiagnosticSink = (diagnostic: MiddlewareDiagnostic) => void;

/**
 * Default diagnostic sink. stderr-only for now; once the typed bus lands a
 * `middleware.hookFailed` channel, the composition root supplies a sink that
 * also emits there.
 */
export function writeMiddlewareDiagnosticToStderr(diagnostic: MiddlewareDiagnostic): void {
	if (diagnostic.kind === "hook_failed") {
		process.stderr.write(
			`[clio:middleware] registration '${diagnostic.registrationId}' failed on '${diagnostic.hook}': ${diagnostic.message}\n`,
		);
		return;
	}
	process.stderr.write(
		`[clio:middleware] registration '${diagnostic.registrationId}' exceeded budget on '${diagnostic.hook}': ` +
			`${diagnostic.elapsedMs.toFixed(1)}ms > ${diagnostic.budgetMs}ms\n`,
	);
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
			emitted = registration.evaluate(cloneHookInput(input));
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
		if (elapsedMs > MIDDLEWARE_HOOK_BUDGET_MS) {
			emitDiagnostic(onDiagnostic, {
				kind: "budget_exceeded",
				registrationId: registration.id,
				hook: input.hook,
				elapsedMs,
				budgetMs: MIDDLEWARE_HOOK_BUDGET_MS,
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
		case "require_validation":
			return { kind: "require_validation", reason: effect.reason };
		case "record_memory_candidate":
			return { kind: "record_memory_candidate", lesson: effect.lesson, evidenceRefs: [...effect.evidenceRefs] };
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
	return cloned;
}
