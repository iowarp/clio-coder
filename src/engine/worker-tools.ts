/**
 * Worker-subprocess tool resolver.
 *
 * Converts Clio `ToolSpec` registrations into pi-agent-core `AgentTool`
 * instances the worker Agent can execute. Mode-filtering uses the
 * `ToolIndex.listForMode` primitive so the worker never needs a live
 * ModesContract or SafetyContract; invocation safety at the worker layer is
 * the Agent's responsibility today, with the orchestrator-side admission
 * gate already enforced at dispatch time.
 */

import type { TSchema } from "@sinclair/typebox";
import type { ToolName } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { type ToolSpec, createToolIndex } from "../tools/registry.js";
import type { AgentTool, AgentToolResult } from "./types.js";

function toAgentTool(spec: ToolSpec): AgentTool<TSchema> {
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		label: spec.name,
		async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<{ kind: "ok" } | { kind: "error" }>> {
			const args = (params && typeof params === "object" ? (params as Record<string, unknown>) : {}) as Record<
				string,
				unknown
			>;
			const result = await spec.run(args);
			if (result.kind === "ok") {
				return {
					content: [{ type: "text", text: result.output }],
					details: { kind: "ok" },
				};
			}
			throw new Error(result.message);
		},
	};
}

/**
 * Build the AgentTool array the worker Agent should expose. Caller supplies
 * the explicit `allowedTools` list (typically from the agent recipe) and the
 * active `mode`. The returned tool set is the intersection of:
 *   1. tools registered via registerAllTools()
 *   2. tools whose allowedModes admits `mode`
 *   3. tools whose id appears in `allowedTools`
 *
 * When `allowedTools` is undefined, step 3 is skipped (mode-matrix fallback).
 * The intersection can legitimately be empty (e.g. write under advise); in
 * that case the worker boots with no tools and any tool call the model
 * attempts surfaces as a pi-agent-core "Tool X not found" error.
 */
export function resolveAgentTools(allowedTools: ReadonlyArray<ToolName> | undefined, mode: ModeName): AgentTool[] {
	const index = createToolIndex();
	registerAllTools(index);
	const modeIds = new Set(index.listForMode(mode));
	const allowed = allowedTools ? new Set(allowedTools) : null;
	const specs: ToolSpec[] = [];
	for (const name of modeIds) {
		if (allowed && !allowed.has(name)) continue;
		const spec = index.get(name);
		if (spec) specs.push(spec);
	}
	return specs.map(toAgentTool) as unknown as AgentTool[];
}
