/**
 * Carries Clio tools that have no Claude preset alias (context, artifact,
 * verify) to a claude-sdk worker as an in-process SDK MCP server.
 *
 * Each tool's handler runs Clio's own implementation through a worker tool
 * registry built with the run's safety contract and read-only flag, so the
 * registry's admission holds behind the SDK permission gate (canUseTool and
 * PreToolUse), which has already mediated the call under the same names as a
 * preset tool. Only tools in the worker's admitted surface are registered, so
 * a tool outside it is never offered, and a read-only run denies a write or
 * execute call at both seams.
 */
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { PendingSkillToolPolicy } from "../../core/skill-activation.js";
import type { ToolName } from "../../core/tool-names.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import { resolveAgentTools } from "../../tools/agent-tools.js";
import type { ToolInvokeOptions, ToolRegistry } from "../../tools/registry.js";
import type { AgentToolResult } from "../types.js";
import type { WorkerEventEmit } from "../worker-runtime.js";
import { createWorkerToolRegistry } from "../worker-tools.js";
import { CLAUDE_SDK_BRIDGED_TOOLS, CLAUDE_SDK_CLIO_SERVER } from "./tool-safety.js";

type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;
// The SDK types a tool list by its zod input shape; a bridged tool has none.
// biome-ignore lint/suspicious/noExplicitAny: matches createSdkMcpServer's own tool list type.
type BridgedToolDefinition = SdkMcpToolDefinition<any>;
type CreateSdkMcpServer = (options: {
	name: string;
	version?: string;
	tools?: BridgedToolDefinition[];
	alwaysLoad?: boolean;
}) => McpSdkServerConfigWithInstance;

/** The bridged tools this worker's admitted surface holds, in a stable order. */
export function claudeSdkBridgedTools(allowedTools: ReadonlySet<string>): ToolName[] {
	return [...CLAUDE_SDK_BRIDGED_TOOLS].filter((tool) => allowedTools.has(tool)).sort() as ToolName[];
}

/**
 * An input schema the SDK's MCP server accepts that advertises a JSON Schema
 * as it is. The SDK takes zod schemas only and converts them through zod's own
 * `_zod.toJSONSchema` override and `_zod.run` hooks, so this object provides
 * those two and nothing else: the advertised schema is the tool's own, and
 * arguments pass through unchanged because the Clio tool validates them in
 * its own body, as it does for a native worker.
 */
function jsonSchemaInput(schema: Record<string, unknown>): never {
	return {
		_zod: {
			version: { major: 4, minor: 6, patch: 0 },
			def: { type: "object", shape: {} },
			traits: new Set(["$ZodType", "$ZodObject"]),
			toJSONSchema: () => structuredClone(schema),
			run: (payload: unknown) => payload,
		},
	} as never;
}

function plainSchema(schema: unknown): Record<string, unknown> {
	const plain = JSON.parse(JSON.stringify(schema ?? {})) as Record<string, unknown>;
	return typeof plain === "object" && plain !== null && plain.type === "object" ? plain : { type: "object" };
}

/** The MCP result for an executed Clio tool: its model-facing text, images and error flag. */
function toCallToolResult(result: AgentToolResult<unknown>): CallToolResult {
	const content: CallToolResult["content"] = [];
	for (const block of result.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return { content, ...(result.isError === true ? { isError: true } : {}) };
}

export interface ClioToolBridgeInput {
	allowedTools: ReadonlySet<string>;
	safety: SafetyContract;
	/** Worker event sink: execution events and the authoritative finish for each bridged call. */
	emit: WorkerEventEmit;
	agentId?: string;
	task?: string;
	readOnly?: boolean;
	executeAutonomy?: "yolo";
	skillLoaderOptions?: { noSkills?: boolean; skillPaths?: string[]; trustProjectCompatRoots?: boolean };
	/** The run's recipe-bound skill policy, shared across calls so its loaded state persists. */
	pendingSkillPolicy?: PendingSkillToolPolicy;
	invokeOptions?: Partial<ToolInvokeOptions>;
	signal?: AbortSignal;
}

const TOOL_USE_ID_META = "claudecode/toolUseId";

/** The SDK tool-use id the CLI stamps on an MCP tools/call, which the permission gate also saw. */
function toolUseIdOf(extra: unknown): string | undefined {
	const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
	const id = meta?.[TOOL_USE_ID_META];
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * SDK MCP tool definitions for the bridged tools in the admitted surface, or
 * an empty list when it holds none. Each handler runs the tool exactly as a
 * native worker does (resolveAgentTools): the permission gate has emitted
 * nothing for an allowed bridged call, so the start, the finish with the
 * real outcome, and the engine execution events all come from here, joined
 * to the gate's decision by the SDK tool-use id.
 */
function clioBridgeToolDefinitions(input: ClioToolBridgeInput): BridgedToolDefinition[] {
	const tools = claudeSdkBridgedTools(input.allowedTools);
	if (tools.length === 0) return [];
	const registry = createBridgeRegistry(input);
	// A Claude SDK worker answers no ask: the permission gate has already
	// refused every call that would ask, so a park here is refused as well.
	registry.onPermissionRequired((_call, _decision, meta) => {
		registry.cancelParkedCall(meta.requestId, "Claude SDK workers run non-interactively; permission denied by policy");
	});
	const agentTools = resolveAgentTools({
		registry,
		allowedTools: tools,
		includeInteractiveTools: false,
		attachCapabilitiesDirectly: true,
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.task !== undefined ? { task: input.task } : {}),
		telemetry: {
			onStart: (event) => input.emit({ type: "clio_coder_tool_start", payload: event }),
			onFinish: (event) => input.emit({ type: "clio_coder_tool_finish", payload: event }),
		},
		invokeOptions: () => ({
			...input.invokeOptions,
			...(input.pendingSkillPolicy !== undefined ? { pendingSkillPolicy: input.pendingSkillPolicy } : {}),
		}),
	});
	let unnamedCalls = 0;
	return agentTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaInput(plainSchema(tool.parameters)),
		handler: async (rawArgs: unknown, extra: unknown) => {
			const args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
			unnamedCalls += 1;
			const toolCallId = toolUseIdOf(extra) ?? `clio-bridge-${unnamedCalls}`;
			const extraSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
			const signals = [input.signal, extraSignal].filter((s): s is AbortSignal => s !== undefined);
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
			input.emit({ type: "tool_execution_start", toolCallId, toolName: tool.name, args });
			let result: AgentToolResult<unknown>;
			try {
				result = await tool.execute(toolCallId, args, signal);
			} catch (error) {
				// A thrown tool error reaches the model as a failed result, as in the native agent loop.
				result = {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { kind: "error" },
					isError: true,
				};
			}
			input.emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: tool.name,
				result,
				isError: result.isError === true,
			});
			return toCallToolResult(result);
		},
	}));
}

function createBridgeRegistry(input: ClioToolBridgeInput): ToolRegistry {
	// The permission gate already recorded this call's decision (tool.decided);
	// the registry's admission is the second seam, so it records nothing again.
	const safety: SafetyContract = { ...input.safety, decisions: {} };
	return createWorkerToolRegistry(
		undefined,
		safety,
		input.skillLoaderOptions,
		undefined,
		input.readOnly,
		undefined,
		undefined,
		undefined,
		undefined,
		input.executeAutonomy,
	);
}

/** The `clio` SDK MCP server for this worker, or null when its surface holds no bridged tool. */
export function createClioToolBridge(
	createSdkMcpServer: CreateSdkMcpServer,
	input: ClioToolBridgeInput,
): McpSdkServerConfigWithInstance | null {
	const tools = clioBridgeToolDefinitions(input);
	if (tools.length === 0) return null;
	return createSdkMcpServer({ name: CLAUDE_SDK_CLIO_SERVER, tools, alwaysLoad: true });
}
