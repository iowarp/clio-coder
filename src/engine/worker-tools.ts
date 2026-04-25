/**
 * Worker-subprocess tool resolver.
 *
 * Converts Clio `ToolSpec` registrations into pi-agent-core `AgentTool`
 * instances the agent can execute. Every wrapper routes through a
 * `ToolRegistry.invoke(...)` call so interactive and worker runs share the
 * same safety + mode admission path instead of calling `spec.run(...)`
 * directly.
 */

import type { TSchema } from "typebox";
import type { ToolName } from "../core/tool-names.js";
import type { ModesContract } from "../domains/modes/contract.js";
import { MODE_MATRIX, type ModeName } from "../domains/modes/matrix.js";
import { classify as classifyAction } from "../domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import { formatRejection } from "../domains/safety/rejection-feedback.js";
import { DEFAULT_SCOPE, isSubset, READONLY_SCOPE, SUPER_SCOPE } from "../domains/safety/scope.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../tools/registry.js";
import { validateEngineToolArguments } from "./ai.js";
import type { AgentTool, AgentToolResult } from "./types.js";

export interface ResolveAgentToolsInput {
	registry: ToolRegistry;
	allowedTools?: ReadonlyArray<ToolName>;
	mode: ModeName;
}

function toAgentTool(spec: ToolSpec, registry: ToolRegistry): AgentTool<TSchema> {
	const validateArguments = (params: unknown): Record<string, unknown> =>
		validateEngineToolArguments(
			{ name: spec.name, description: spec.description, parameters: spec.parameters },
			{ type: "toolCall", id: "", name: spec.name, arguments: params as Record<string, unknown> },
		) as Record<string, unknown>;

	const tool: AgentTool<TSchema> = {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		label: spec.name,
		prepareArguments: validateArguments,
		async execute(
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
		): Promise<AgentToolResult<{ kind: "ok" } | { kind: "error" }>> {
			const args = validateArguments(params);
			const verdict = await registry.invoke({ tool: spec.name, args }, signal ? { signal } : undefined);
			if (verdict.kind === "ok") {
				if (verdict.result.kind === "ok") {
					const result: AgentToolResult<{ kind: "ok" }> = {
						content: [{ type: "text", text: verdict.result.output }],
						details: { kind: "ok" },
					};
					if (verdict.result.terminate === true) {
						result.terminate = true;
					}
					return result;
				}
				throw new Error(verdict.result.message);
			}
			throw new Error(verdict.reason);
		},
	};
	if (spec.executionMode) {
		tool.executionMode = spec.executionMode;
	}
	return tool;
}

function createWorkerModes(mode: ModeName): ModesContract {
	const profile = MODE_MATRIX[mode];
	return {
		current: () => mode,
		setMode: () => mode,
		cycleNormal: () => mode,
		visibleTools: () => profile.tools,
		isToolVisible: (tool) => profile.tools.has(tool),
		isActionAllowed: (action) => profile.allowedActions.has(action),
		requestSuper: () => {},
		confirmSuper: () => mode,
		// Workers have no Alt+S pathway; parking requires interactive
		// confirmation. Returning null forces the registry to reject
		// mode-gate blocks synchronously.
		elevatedModeFor: () => null,
	};
}

function createWorkerSafety(): SafetyContract {
	return {
		classify: (call) => classifyAction(call),
		evaluate(call, mode) {
			const classification = classifyAction(call);
			if (classification.actionClass === "git_destructive") {
				const rejection = formatRejection({
					tool: call.tool,
					actionClass: classification.actionClass,
					reasons: classification.reasons,
					...(mode ? { mode } : {}),
				});
				return { kind: "block", classification, rejection };
			}
			const decision: SafetyDecision = { kind: "allow", classification };
			return decision;
		},
		observeLoop: (key) => ({ looping: false, key, count: 1 }),
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
}

export function createWorkerToolRegistry(mode: ModeName): ToolRegistry {
	const registry = createRegistry({
		safety: createWorkerSafety(),
		modes: createWorkerModes(mode),
	});
	registerAllTools(registry);
	return registry;
}

/**
 * Build the AgentTool array the agent should expose. Caller supplies the
 * registered tool set plus:
 *
 *   1. the explicit `allowedTools` list (typically from the agent recipe)
 *   2. the active `mode`
 *
 * The returned tool set is the intersection of:
 *   1. tools registered on the supplied registry
 *   2. tools whose allowedModes admits `mode`
 *   3. tools whose id appears in `allowedTools`
 *
 * When `allowedTools` is undefined, step 3 is skipped.
 */
export function resolveAgentTools(input: ResolveAgentToolsInput): AgentTool[] {
	const modeIds = new Set(input.registry.listForMode(input.mode));
	const allowed = input.allowedTools ? new Set(input.allowedTools) : null;
	const specs: ToolSpec[] = [];
	for (const name of modeIds) {
		if (allowed && !allowed.has(name)) continue;
		const spec = input.registry.get(name);
		if (spec) specs.push(spec);
	}
	return specs.map((spec) => toAgentTool(spec, input.registry)) as unknown as AgentTool[];
}
