import { catalogSupportsXhighForRuntime } from "../catalog.js";

export type ToolCallFormat = "openai" | "anthropic" | "hermes" | "llama3-json" | "mistral" | "qwen" | "xml";

export type ThinkingFormat =
	| "qwen-chat-template"
	| "openrouter"
	| "zai"
	| "anthropic-extended"
	| "deepseek-r1"
	| "openai-codex";

export type StructuredOutputMode = "json-schema" | "gbnf" | "xgrammar" | "none";

export interface CapabilityFlags {
	chat: boolean;
	tools: boolean;
	toolCallFormat?: ToolCallFormat;
	reasoning: boolean;
	thinkingFormat?: ThinkingFormat;
	structuredOutputs?: StructuredOutputMode;
	vision: boolean;
	audio: boolean;
	embeddings: boolean;
	rerank: boolean;
	fim: boolean;
	contextWindow: number;
	maxTokens: number;
}

export const EMPTY_CAPABILITIES: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 0,
	maxTokens: 0,
};

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

const THINKING_LEVELS_WITHOUT_XHIGH: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high"];
const THINKING_LEVELS_OPENAI_5_1_MINI: ReadonlyArray<ThinkingLevel> = ["off", "medium", "high"];
const THINKING_LEVELS_OPENAI_5_2_PLUS: ReadonlyArray<ThinkingLevel> = ["off", "low", "medium", "high", "xhigh"];

function normalizeModelId(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	const trimmed = modelId.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
}

function availableOpenAICodexThinkingLevels(modelId: string | undefined): ReadonlyArray<ThinkingLevel> {
	const normalized = normalizeModelId(modelId);
	if (!normalized) return VALID_THINKING_LEVELS;
	if (normalized === "gpt-5.1-codex-mini") return THINKING_LEVELS_OPENAI_5_1_MINI;
	if (
		normalized.startsWith("gpt-5.2") ||
		normalized.startsWith("gpt-5.3") ||
		normalized.startsWith("gpt-5.4") ||
		normalized.startsWith("gpt-5.5")
	) {
		return THINKING_LEVELS_OPENAI_5_2_PLUS;
	}
	return THINKING_LEVELS_WITHOUT_XHIGH;
}

export function availableThinkingLevels(
	caps: CapabilityFlags,
	options?: { runtimeId?: string; modelId?: string },
): ReadonlyArray<ThinkingLevel> {
	if (!caps.reasoning) return ["off"];
	const catalogSupportsXhigh =
		options?.runtimeId && options.modelId
			? catalogSupportsXhighForRuntime(options.runtimeId, options.modelId)
			: undefined;
	if (catalogSupportsXhigh === false) {
		if (caps.thinkingFormat === "openai-codex" || options?.runtimeId === "openai-codex") {
			return availableOpenAICodexThinkingLevels(options?.modelId);
		}
		return THINKING_LEVELS_WITHOUT_XHIGH;
	}
	if (catalogSupportsXhigh === true) {
		if (caps.thinkingFormat === "openai-codex" || options?.runtimeId === "openai-codex") {
			return THINKING_LEVELS_OPENAI_5_2_PLUS;
		}
		return VALID_THINKING_LEVELS;
	}
	if (caps.thinkingFormat === "openai-codex" || options?.runtimeId === "openai-codex") {
		return availableOpenAICodexThinkingLevels(options?.modelId);
	}
	if (caps.thinkingFormat === "anthropic-extended") {
		return VALID_THINKING_LEVELS;
	}
	return THINKING_LEVELS_WITHOUT_XHIGH;
}
