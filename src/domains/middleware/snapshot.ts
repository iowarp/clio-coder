import type { MiddlewareContract } from "./contract.js";
import { listMiddlewareRules } from "./rules.js";
import type {
	MiddlewareEffectKind,
	MiddlewareHook,
	MiddlewareHookInput,
	MiddlewareHookResult,
	MiddlewareRule,
	MiddlewareSnapshot,
} from "./types.js";

export function createMiddlewareSnapshot(
	rules: ReadonlyArray<MiddlewareRule> = listMiddlewareRules(),
): MiddlewareSnapshot {
	return {
		version: 1,
		rules: rules.map(cloneRule),
	};
}

export function createMiddlewareContractFromSnapshot(snapshot: MiddlewareSnapshot): MiddlewareContract {
	const rules = snapshot.rules.map(cloneRule);
	return {
		runHook(input) {
			return runSnapshotHook(input, rules);
		},
		listRules() {
			return rules.map(cloneRule);
		},
		snapshot() {
			return createMiddlewareSnapshot(rules);
		},
	};
}

function runSnapshotHook(input: MiddlewareHookInput, rules: ReadonlyArray<MiddlewareRule>): MiddlewareHookResult {
	return {
		hook: input.hook,
		input: cloneHookInput(input),
		effects: [],
		ruleIds: ruleIdsForHook(rules, input.hook),
	};
}

function ruleIdsForHook(rules: ReadonlyArray<MiddlewareRule>, hook: MiddlewareHook): string[] {
	const ids: string[] = [];
	for (const rule of rules) {
		if (rule.enabled && rule.hooks.includes(hook)) ids.push(rule.id);
	}
	return ids;
}

function cloneRule(rule: MiddlewareRule): MiddlewareRule {
	return {
		id: rule.id,
		source: rule.source,
		description: rule.description,
		enabled: rule.enabled,
		hooks: [...rule.hooks],
		effectKinds: [...rule.effectKinds] as MiddlewareEffectKind[],
	};
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
