import { listMiddlewareRuleDefinitions } from "./rules.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookResult, MiddlewareRule } from "./types.js";

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

export function runMiddlewareHook(
	input: MiddlewareHookInput,
	definitions: ReadonlyArray<MiddlewareRuleDefinition> = listMiddlewareRuleDefinitions(),
): MiddlewareHookResult {
	const effects: MiddlewareEffect[] = [];
	const ruleIds: string[] = [];
	for (const definition of definitions) {
		const emitted = evaluateRuleDefinition(definition, input);
		if (emitted.length === 0) continue;
		effects.push(...emitted);
		if (!ruleIds.includes(definition.rule.id)) ruleIds.push(definition.rule.id);
	}
	return {
		hook: input.hook,
		input: cloneHookInput(input),
		effects,
		ruleIds,
	};
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
