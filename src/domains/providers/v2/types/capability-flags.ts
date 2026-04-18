export type ToolCallFormat =
	| "openai"
	| "anthropic"
	| "hermes"
	| "llama3-json"
	| "mistral"
	| "qwen"
	| "xml";

export type ThinkingFormat =
	| "qwen-chat-template"
	| "openrouter"
	| "zai"
	| "anthropic-extended"
	| "deepseek-r1";

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

const THINKING_LEVELS_WITHOUT_XHIGH: ReadonlyArray<ThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
];

export function availableThinkingLevels(caps: CapabilityFlags): ReadonlyArray<ThinkingLevel> {
	if (!caps.reasoning) return ["off"];
	if (caps.thinkingFormat === "anthropic-extended") return VALID_THINKING_LEVELS;
	return THINKING_LEVELS_WITHOUT_XHIGH;
}
