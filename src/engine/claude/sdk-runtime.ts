import {
	type CanUseTool,
	type EffortLevel,
	type HookCallback,
	type Options,
	type PermissionMode,
	type PermissionResult,
	query,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
	type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";

import type { AutonomyLevel } from "../../domains/safety/autonomy.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../worker/spec-contract.js";
import type { AgentEvent, AgentMessage, Usage } from "../types.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput, WorkerRunResult } from "../worker-runtime.js";
import { createWorkerSafety } from "../worker-tools.js";
import { isClaudeCodeSessionId } from "./session-id.js";
import { type ClaudeToolPermissionDecision, coerceToolInput, emitClaudeToolPermissionDecision } from "./tool-safety.js";

const DEFAULT_CLAUDE_TOOLS = { type: "preset", preset: "claude_code" } as const;

function sdkUserTextMessage(text: string, shouldQuery: boolean): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] } as never,
		parent_tool_use_id: null,
		shouldQuery,
		timestamp: new Date().toISOString(),
	};
}

function buildClaudeSdkPrompt(input: WorkerRunInput): string {
	const parts = (input.dynamicPromptMessages ?? []).map((message) => message.body.trim()).filter(Boolean);
	parts.push(input.task);
	return parts.join("\n\n");
}

async function* oneSdkUserMessage(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
	yield message;
}

export function claudeSdkPermissionModeForAutonomy(_level: AutonomyLevel | undefined): PermissionMode {
	return "default";
}

export function claudeSdkToolsForAutonomy(_level: AutonomyLevel | undefined): NonNullable<Options["tools"]> {
	return DEFAULT_CLAUDE_TOOLS;
}

function effortForThinking(level: WorkerRunInput["thinkingLevel"] | undefined): EffortLevel | undefined {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		default:
			return undefined;
	}
}

function thinkingForInput(input: WorkerRunInput): ThinkingConfig | undefined {
	const level = input.runtimeResolution?.effectiveThinkingLevel ?? input.thinkingLevel ?? "off";
	if (level === "off") return { type: "disabled" };
	const budgetTokens = input.runtimeResolution?.request.budgetTokens;
	if (typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0) {
		return { type: "enabled", budgetTokens, display: "summarized" };
	}
	return { type: "adaptive", display: "summarized" };
}

function systemPromptForInput(input: WorkerRunInput): NonNullable<Options["systemPrompt"]> {
	const append = input.systemPrompt.trim();
	if (append.length === 0) return { type: "preset", preset: "claude_code" };
	return { type: "preset", preset: "claude_code", append };
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function normalizeUsage(raw: unknown, totalCostUsd = 0): Usage {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const cacheCreation =
		finite(record.cache_creation_input_tokens) +
		finite(record.cacheCreationInputTokens) +
		finite(record.cacheWrite) +
		finite(record.cacheWriteTokens);
	const cacheRead =
		finite(record.cache_read_input_tokens) +
		finite(record.cacheReadInputTokens) +
		finite(record.cacheRead) +
		finite(record.cacheReadTokens);
	const input =
		finite(record.input_tokens) +
		finite(record.inputTokens) +
		finite(record.input) +
		finite(record.prompt_tokens) +
		finite(record.promptTokens);
	const output =
		finite(record.output_tokens) +
		finite(record.outputTokens) +
		finite(record.output) +
		finite(record.completion_tokens) +
		finite(record.completionTokens);
	const totalTokens = input + output + cacheRead + cacheCreation;
	const cost = finite(totalCostUsd) + finite(record.costUSD) + finite(record.cost_usd);
	return {
		input,
		output,
		cacheRead,
		cacheWrite: cacheCreation,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

function textFromUnknownBlock(block: unknown): string {
	if (typeof block !== "object" || block === null) return "";
	const record = block as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") return record.text;
	if (record.type === "thinking" && typeof record.thinking === "string") return "";
	return "";
}

function thinkingFromUnknownBlock(block: unknown): string {
	if (typeof block !== "object" || block === null) return "";
	const record = block as Record<string, unknown>;
	if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
	return "";
}

function contentFromSdkMessage(message: unknown): AgentMessage & { role: "assistant" } {
	const content: Array<Record<string, unknown>> = [];
	const record = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
	const blocks = Array.isArray(record.content) ? record.content : [];
	for (const block of blocks) {
		const text = textFromUnknownBlock(block);
		if (text.length > 0) {
			content.push({ type: "text", text });
			continue;
		}
		const thinking = thinkingFromUnknownBlock(block);
		if (thinking.length > 0) {
			content.push({ type: "thinking", thinking });
			continue;
		}
		if (typeof block === "object" && block !== null) {
			const tool = block as Record<string, unknown>;
			if (tool.type === "tool_use" && typeof tool.name === "string" && typeof tool.id === "string") {
				content.push({
					type: "toolCall",
					id: tool.id,
					name: tool.name,
					arguments: nestedRecord(tool, "input") ?? {},
				});
			}
		}
	}
	if (content.length === 0) content.push({ type: "text", text: "" });
	return {
		role: "assistant",
		content,
		api: "claude-agent-sdk",
		provider: "anthropic",
		model: "",
		usage: normalizeUsage(null),
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage & { role: "assistant" };
}

function extractAssistantText(message: SDKMessage): string {
	if (message.type !== "assistant") return "";
	const record = message as unknown as { message?: unknown };
	const assistant = contentFromSdkMessage(record.message);
	return assistant.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("");
}

function extractStreamDelta(message: SDKMessage): string {
	if (message.type !== "stream_event") return "";
	const event = (message as unknown as { event?: unknown }).event;
	if (typeof event !== "object" || event === null) return "";
	const record = event as Record<string, unknown>;
	const delta = nestedRecord(record, "delta");
	if (delta && typeof delta.text === "string") return delta.text;
	if (delta && typeof delta.thinking === "string") return "";
	const contentBlock = nestedRecord(record, "content_block");
	if (contentBlock && contentBlock.type === "text" && typeof contentBlock.text === "string") return contentBlock.text;
	return "";
}

function resultText(message: SDKResultMessage | null): string {
	if (!message || message.subtype !== "success") return "";
	return typeof message.result === "string" ? message.result : "";
}

function resultError(message: SDKResultMessage | null): string {
	if (!message || message.subtype === "success") return "";
	return Array.isArray(message.errors) ? message.errors.join("; ") : "Claude Agent SDK run failed";
}

function stopReasonFor(result: SDKResultMessage | null, aborted: boolean): "stop" | "error" | "aborted" | "length" {
	if (aborted) return "aborted";
	if (!result) return "stop";
	if (result.subtype !== "success") return "error";
	if (result.stop_reason === "max_tokens") return "length";
	return "stop";
}

function buildAssistantMessage(input: {
	model: string;
	responseModel?: string | undefined;
	responseId?: string | undefined;
	text: string;
	result: SDKResultMessage | null;
	aborted: boolean;
	errorMessage?: string | undefined;
}): AgentMessage & { role: "assistant" } {
	const usage = normalizeUsage(input.result?.usage, input.result?.total_cost_usd ?? 0);
	const message: AgentMessage & { role: "assistant" } = {
		role: "assistant",
		content: [{ type: "text", text: input.text }],
		api: "claude-agent-sdk",
		provider: "anthropic",
		model: input.model,
		usage,
		stopReason: stopReasonFor(input.result, input.aborted),
		timestamp: Date.now(),
	} as AgentMessage & { role: "assistant" };
	if (input.responseModel !== undefined) message.responseModel = input.responseModel;
	if (input.responseId !== undefined) message.responseId = input.responseId;
	if (input.errorMessage !== undefined && input.errorMessage.length > 0) message.errorMessage = input.errorMessage;
	return message;
}

function emitTextDelta(
	emit: WorkerEventEmit,
	state: { started: boolean; text: string; model: string },
	delta: string,
): void {
	if (delta.length === 0) return;
	state.text += delta;
	const message = buildAssistantMessage({ model: state.model, text: state.text, result: null, aborted: false });
	if (!state.started) {
		state.started = true;
		emit({ type: "message_start", message } as AgentEvent);
	}
	emit({
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: message,
		},
	} as AgentEvent);
}

interface PermissionGateInput {
	safety: ReturnType<typeof createWorkerSafety>;
	cwd: string;
	autonomy?: AutonomyLevel;
	onPermission: "deny" | "fail";
	emit: WorkerEventEmit;
	onPermissionFailure(): void;
	handledToolDecisions: Map<string, ClaudeToolPermissionDecision>;
}

function permissionResultForDecision(
	decision: ClaudeToolPermissionDecision,
	toolUseID: string | undefined,
	input: PermissionGateInput,
): PermissionResult {
	if (decision.kind === "allow") {
		const result: PermissionResult = {
			behavior: "allow",
			decisionClassification: "user_temporary",
		};
		if (toolUseID !== undefined) result.toolUseID = toolUseID;
		return result;
	}
	if (decision.permissionRequired && input.onPermission === "fail") {
		input.onPermissionFailure();
	}
	const result: PermissionResult = {
		behavior: "deny",
		message: decision.reason,
		interrupt: decision.permissionRequired && input.onPermission === "fail",
		decisionClassification: "user_reject",
	};
	if (toolUseID !== undefined) result.toolUseID = toolUseID;
	return result;
}

function decideToolUse(input: PermissionGateInput, toolName: string, toolInput: unknown): ClaudeToolPermissionDecision {
	return emitClaudeToolPermissionDecision({
		toolName,
		input: coerceToolInput(toolInput),
		safety: input.safety,
		cwd: input.cwd,
		...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
		onPermission: input.onPermission,
		emit: input.emit,
	});
}

function buildCanUseTool(input: PermissionGateInput): CanUseTool {
	return async (toolName, toolInput, options): Promise<PermissionResult> => {
		const cached = input.handledToolDecisions.get(options.toolUseID);
		if (cached) return permissionResultForDecision(cached, options.toolUseID, input);
		const decision = decideToolUse(input, toolName, toolInput);
		if (options.toolUseID) {
			input.handledToolDecisions.set(options.toolUseID, decision);
		}
		return permissionResultForDecision(decision, options.toolUseID, input);
	};
}

function buildPreToolUseHook(input: PermissionGateInput): HookCallback {
	return async (hookInput, toolUseID) => {
		if (hookInput.hook_event_name !== "PreToolUse") return { continue: true };
		const decision = decideToolUse(input, hookInput.tool_name, hookInput.tool_input);
		const id = hookInput.tool_use_id || toolUseID;
		if (id) input.handledToolDecisions.set(id, decision);
		if (decision.kind === "allow") {
			return {
				continue: true,
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
					permissionDecisionReason: decision.reason,
				},
			};
		}
		if (decision.permissionRequired && input.onPermission === "fail") input.onPermissionFailure();
		return {
			continue: true,
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: decision.reason,
			},
		};
	};
}

export function startClaudeSdkWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const abortController = new AbortController();
	let queryHandle: ReturnType<typeof query> | null = null;
	let aborted = false;
	let permissionFailure = false;

	const abort = (): void => {
		aborted = true;
		abortController.abort();
		void queryHandle?.interrupt().catch(() => {});
		queryHandle?.close();
	};

	if (input.signal) {
		if (input.signal.aborted) abort();
		else input.signal.addEventListener("abort", abort, { once: true });
	}

	const safety = createWorkerSafety({ cwd: process.cwd() });
	const onPermission = input.onPermission ?? "deny";
	const permissionGate = {
		safety,
		cwd: process.cwd(),
		...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
		onPermission,
		emit,
		handledToolDecisions: new Map<string, ClaudeToolPermissionDecision>(),
		onPermissionFailure() {
			permissionFailure = true;
			abort();
		},
	};
	const canUseTool = buildCanUseTool(permissionGate);
	const preToolUseHook = buildPreToolUseHook(permissionGate);

	const options: Options = {
		abortController,
		cwd: process.cwd(),
		model: input.wireModelId,
		systemPrompt: systemPromptForInput(input),
		tools: claudeSdkToolsForAutonomy(input.autonomy),
		permissionMode: claudeSdkPermissionModeForAutonomy(input.autonomy),
		canUseTool,
		hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
		includePartialMessages: true,
		persistSession: false,
		settingSources: [],
		env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "@iowarp/clio-coder/0.2.3" },
	};
	const thinking = thinkingForInput(input);
	if (thinking !== undefined) options.thinking = thinking;
	const effort = effortForThinking(input.runtimeResolution?.effectiveThinkingLevel ?? input.thinkingLevel);
	if (effort !== undefined) options.effort = effort;
	if (isClaudeCodeSessionId(input.sessionId)) options.sessionId = input.sessionId.trim();

	const promise = (async (): Promise<WorkerRunResult> => {
		const messages: AgentMessage[] = [];
		const streamState = { started: false, text: "", model: input.wireModelId };
		let result: SDKResultMessage | null = null;
		let responseModel: string | undefined;
		let responseId: string | undefined;

		emit({ type: "agent_start" } as AgentEvent);
		try {
			queryHandle = query({ prompt: buildClaudeSdkPrompt(input), options });
			for await (const sdkMessage of queryHandle) {
				if (sdkMessage.type === "system" && (sdkMessage as { subtype?: string }).subtype === "init") {
					const init = sdkMessage as { model?: string; session_id?: string; uuid?: string };
					if (typeof init.model === "string" && init.model.length > 0) streamState.model = init.model;
					if (typeof init.uuid === "string") responseId = init.uuid;
					continue;
				}
				if (sdkMessage.type === "stream_event") {
					emitTextDelta(emit, streamState, extractStreamDelta(sdkMessage));
					continue;
				}
				if (sdkMessage.type === "assistant") {
					const text = extractAssistantText(sdkMessage);
					if (text.length > 0 && text.length >= streamState.text.length) {
						streamState.text = text;
					}
					const assistant = sdkMessage as { message?: { model?: string; id?: string }; uuid?: string; request_id?: string };
					if (typeof assistant.message?.model === "string") responseModel = assistant.message.model;
					if (typeof assistant.request_id === "string") responseId = assistant.request_id;
					else if (typeof assistant.uuid === "string") responseId = assistant.uuid;
					continue;
				}
				if (sdkMessage.type === "result") {
					result = sdkMessage;
				}
			}
			const error = resultError(result);
			const finalText = streamState.text || resultText(result) || error;
			const finalMessage = buildAssistantMessage({
				model: streamState.model,
				responseModel,
				responseId,
				text: finalText,
				result,
				aborted,
				errorMessage: error,
			});
			if (!streamState.started) emit({ type: "message_start", message: finalMessage } as AgentEvent);
			emit({ type: "message_end", message: finalMessage } as AgentEvent);
			messages.push(finalMessage);
			emit({ type: "agent_end", messages } as AgentEvent);
			if (permissionFailure) return { messages, exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			return { messages, exitCode: finalMessage.stopReason === "error" ? 1 : 0 };
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			const finalMessage = buildAssistantMessage({
				model: streamState.model,
				text: messageText,
				result,
				aborted,
				errorMessage: messageText,
			});
			emit({ type: "message_end", message: finalMessage } as AgentEvent);
			messages.push(finalMessage);
			emit({ type: "agent_end", messages } as AgentEvent);
			if (permissionFailure) return { messages, exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			if (!aborted) process.stderr.write(`[worker:claude-sdk] ${messageText}\n`);
			return { messages, exitCode: 1 };
		} finally {
			queryHandle?.close();
		}
	})();

	return {
		promise,
		abort,
		steer(text: string) {
			const trimmed = text.trim();
			if (trimmed.length === 0) return;
			emit({ type: "clio_steer_received", payload: { chars: trimmed.length } });
			void queryHandle?.streamInput(oneSdkUserMessage(sdkUserTextMessage(trimmed, true))).catch(() => {});
		},
	};
}
