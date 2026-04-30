import { middlewareRuleIdsForHook } from "./rules.js";
import type { MiddlewareHookInput, MiddlewareHookResult } from "./types.js";

export function runMiddlewareHook(input: MiddlewareHookInput): MiddlewareHookResult {
	return {
		hook: input.hook,
		input: cloneHookInput(input),
		effects: [],
		ruleIds: middlewareRuleIdsForHook(input.hook),
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
