import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { DynamicToolName } from "../core/tool-names.js";
import { extensionIdentity } from "../domains/extensions/activity.js";
import { extensionToolName } from "../domains/extensions/command-schema.js";
import type { ExtensionRuntimeHookBridge } from "../domains/extensions/runtime-hook-bridge.js";
import { type InstalledExtension, isLoadableExtension } from "../domains/extensions/types.js";
import type { ToolResult, ToolSpec } from "./registry.js";

/** What a tool returns to the model is bounded like a command tool's output. */
const RUNTIME_TOOL_OUTPUT_BYTES = 256 * 1024;

function bounded(text: string): string {
	return Buffer.byteLength(text) > RUNTIME_TOOL_OUTPUT_BYTES
		? `${Buffer.from(text).subarray(0, RUNTIME_TOOL_OUTPUT_BYTES).toString("utf8")}\n[output truncated]`
		: text;
}

/**
 * Gateway specs for the tools the running api 2 runtimes of one extension
 * generation serve. Registering one never runs package code: a call goes to
 * the live runtime through the bridge the terminal binds, so with no runtime
 * the call fails instead of starting one. Placement is the gateway, so the
 * provider's tool schema set is the same before and after a reload.
 *
 * A result that asks for an interview parks the call until the operator
 * finishes or cancels it, and the answers become the result.
 */
export function buildExtensionRuntimeToolSpecs(
	packages: ReadonlyArray<InstalledExtension>,
	bridge: ExtensionRuntimeHookBridge,
): ToolSpec[] {
	const specs: ToolSpec[] = [];
	for (const entry of packages) {
		if (!isLoadableExtension(entry) || entry.runtimeV2 === undefined) continue;
		const extensionId = entry.id;
		const owner = extensionIdentity(entry);
		for (const tool of entry.runtimeV2.tools) {
			const name = extensionToolName(extensionId, tool.name) as DynamicToolName;
			specs.push({
				name,
				description: `${tool.description}\nServed by the running ${extensionId}@${entry.version} extension runtime.`,
				parameters: tool.inputSchema as TSchema,
				baseActionClass: tool.actionClass,
				executionMode: "sequential",
				placement: "gateway",
				sourceInfo: { path: entry.manifestPath, scope: "domain", extension: entry.provenance, owner },
				metadata: {
					objective: tool.description,
					uiLabel: `${extensionId}/${tool.name}`,
					retrySafety: "not_retry_safe",
					resultSizePolicy: { kind: "bounded", maxBytes: RUNTIME_TOOL_OUTPUT_BYTES },
					costLatency: "local_slow",
				},
				async run(args, options): Promise<ToolResult> {
					if (!Value.Check(tool.inputSchema as TSchema, args))
						return { kind: "error", message: `${name}: input does not match its declared JSON schema`, details: { owner } };
					const executor = bridge.current();
					if (!executor?.tool)
						return { kind: "error", message: `${name}: the ${extensionId} runtime is not running`, details: { owner } };
					try {
						const result = await executor.tool(extensionId, tool.name, args, options?.signal);
						if (result.interview) {
							if (!executor.interview)
								return { kind: "error", message: `${name}: no operator can answer an interview here`, details: { owner } };
							const parked = await executor.interview(extensionId, result.interview, options?.signal);
							const output = bounded(
								JSON.stringify({ interview: parked.outcome, answers: parked.answers, text: parked.text }),
							);
							return parked.outcome === "done"
								? { kind: "ok", output, details: { owner } }
								: { kind: "error", message: output, details: { owner } };
						}
						const output = bounded(
							result.data === undefined ? result.text : `${result.text}\n${JSON.stringify(result.data)}`,
						);
						return result.isError === true
							? { kind: "error", message: output, details: { owner } }
							: { kind: "ok", output, details: { owner } };
					} catch (error) {
						return {
							kind: "error",
							message: `${name}: ${error instanceof Error ? error.message : String(error)}`,
							details: { owner },
						};
					}
				},
			});
		}
	}
	return specs;
}
