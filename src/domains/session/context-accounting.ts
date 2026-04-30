import type { AgentMessage, Usage } from "../../engine/types.js";

const IMAGE_CHAR_ESTIMATE = 4800;
const TOKEN_CHARS = 4;
const MESSAGE_OVERHEAD_TOKENS = 16;

export interface AgentContextEstimateInput {
	messages: ReadonlyArray<AgentMessage>;
	systemPrompt?: string;
	pendingUserText?: string;
}

export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

function ceilChars(chars: number): number {
	return Math.ceil(Math.max(0, chars) / TOKEN_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "boolean") return String(value).length;
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function argsLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	return typeof value === "string" ? value.length : jsonLength(value);
}

function blockChars(block: unknown): number {
	if (typeof block === "string") return block.length;
	if (!isRecord(block)) return jsonLength(block);
	if (block.type === "text" && typeof block.text === "string") return block.text.length;
	if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking.length;
	if (block.type === "image") return IMAGE_CHAR_ESTIMATE;
	if (block.type === "toolCall") {
		const name = typeof block.name === "string" ? block.name : "";
		const id = typeof block.id === "string" ? block.id : "";
		return id.length + name.length + argsLength(block.arguments ?? block.args ?? block.input);
	}
	if (Array.isArray(block.content)) return contentChars(block.content);
	if (typeof block.text === "string") return block.text.length;
	if (typeof block.thinking === "string") return block.thinking.length;
	return jsonLength(block);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return jsonLength(content);
	return content.reduce((sum, block) => sum + blockChars(block), 0);
}

function messageChars(message: unknown): number {
	if (!isRecord(message)) return jsonLength(message);
	let chars = 0;
	chars += typeof message.role === "string" ? message.role.length : 0;
	chars += contentChars(message.content);
	chars += typeof message.toolCallId === "string" ? message.toolCallId.length : 0;
	chars += typeof message.toolName === "string" ? message.toolName.length : 0;
	chars += typeof message.errorMessage === "string" ? message.errorMessage.length : 0;
	return chars;
}

function usageTotalTokens(usage: unknown): number | null {
	if (!isRecord(usage)) return null;
	const total = usage.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
	const output = typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
	const cacheRead = typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
	const sum = input + output + cacheRead + cacheWrite;
	return sum > 0 ? sum : null;
}

function latestUsableAssistantUsage(messages: ReadonlyArray<AgentMessage>): { index: number; tokens: number } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as AgentMessage | undefined;
		if (!message || message.role !== "assistant") continue;
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		if (stopReason === "error" || stopReason === "aborted") continue;
		const tokens = usageTotalTokens((message as { usage?: Usage }).usage);
		if (tokens !== null) return { index: i, tokens };
	}
	return null;
}

function finitePositive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nestedNumber(root: unknown, path: ReadonlyArray<string>): number | null {
	let current = root;
	for (const key of path) {
		if (!isRecord(current)) return null;
		current = current[key];
	}
	return finitePositive(current);
}

export function extractReasoningTokens(usage: unknown): number | null {
	if (!isRecord(usage)) return null;
	const direct =
		finitePositive(usage.reasoningTokens) ?? finitePositive(usage.reasoning_tokens) ?? finitePositive(usage.reasoning);
	if (direct !== null) return direct;
	const paths = [
		["outputDetails", "reasoningTokens"],
		["output_details", "reasoning_tokens"],
		["output_tokens_details", "reasoning_tokens"],
		["completion_tokens_details", "reasoning_tokens"],
		["completionTokensDetails", "reasoningTokens"],
		["details", "reasoningTokens"],
	] as const;
	for (const path of paths) {
		const value = nestedNumber(usage, path);
		if (value !== null) return value;
	}
	return null;
}

export function estimateAgentMessageTokens(message: AgentMessage): number {
	return ceilChars(messageChars(message)) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateAgentContextTokens(input: AgentContextEstimateInput): number {
	const systemTokens = input.systemPrompt ? ceilChars(input.systemPrompt.length) : 0;
	const pendingTokens = input.pendingUserText ? ceilChars(input.pendingUserText.length) : 0;
	const messageTokens = input.messages.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
	const projection = systemTokens + messageTokens + pendingTokens;

	const usage = latestUsableAssistantUsage(input.messages);
	if (!usage) return projection;
	const trailingTokens = input.messages
		.slice(usage.index + 1)
		.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
	const anchored = usage.tokens + trailingTokens + pendingTokens;
	return Math.max(projection, anchored);
}

export function contextUsageSnapshot(
	tokens: number | null,
	contextWindow: number | null | undefined,
): ContextUsageSnapshot {
	const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) ? Math.max(0, contextWindow) : 0;
	if (tokens === null || tokens <= 0 || window <= 0) return { tokens, contextWindow: window, percent: null };
	return { tokens, contextWindow: window, percent: Math.min(100, (tokens / window) * 100) };
}
