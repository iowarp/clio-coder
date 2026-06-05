import type {
	Api,
	Context,
	ImageContent,
	Message,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";

const CONTEXT_BUDGET_SAFETY_TOKENS = 1024;
const IMAGE_ESTIMATE_BYTES = 4800;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const LOCAL_TOOL_TURN_MAX_OUTPUT_TOKENS = 2048;

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function estimatePayloadBytes(payload: string | ReadonlyArray<TextContent | ImageContent>): number {
	if (typeof payload === "string") return byteLength(payload);
	let total = 0;
	for (const block of payload) {
		if (block.type === "text") total += byteLength(block.text);
		else if (block.type === "image") total += IMAGE_ESTIMATE_BYTES;
	}
	return total;
}

function estimateAssistantBytes(block: TextContent | ThinkingContent | ToolCall): number {
	if (block.type === "text") return byteLength(block.text);
	if (block.type === "thinking") return byteLength(block.thinking);
	return byteLength(block.name) + byteLength(JSON.stringify(block.arguments));
}

function estimateToolResultBytes(message: ToolResultMessage): number {
	let total = byteLength(message.toolName);
	for (const block of message.content) total += estimatePayloadBytes([block]);
	return total;
}

function estimateMessageBytes(message: Message): number {
	if (message.role === "user") return estimatePayloadBytes(message.content);
	if (message.role === "assistant")
		return message.content.reduce((sum, block) => sum + estimateAssistantBytes(block), 0);
	return estimateToolResultBytes(message);
}

function estimateToolBytes(tool: Tool): number {
	return byteLength(tool.name) + byteLength(tool.description) + byteLength(JSON.stringify(tool.parameters));
}

export function estimateInputTokensFromContext(context: Context): number {
	let bytes = context.systemPrompt ? byteLength(context.systemPrompt) : 0;
	for (const message of context.messages) bytes += estimateMessageBytes(message);
	for (const tool of context.tools ?? []) bytes += estimateToolBytes(tool);
	return Math.ceil(bytes / 4);
}

export function remainingContextMaxTokens(
	model: Pick<Model<Api>, "contextWindow" | "maxTokens">,
	context: Context,
	options: Pick<StreamOptions, "maxTokens"> | undefined,
	limits?: { contextWindow?: number; maxOutputTokens?: number },
): number {
	const safety = CONTEXT_BUDGET_SAFETY_TOKENS;
	const inputTokens = estimateInputTokensFromContext(context);
	const configuredContextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const loadedContextWindow =
		limits?.contextWindow !== undefined && limits.contextWindow > 0 ? limits.contextWindow : Number.POSITIVE_INFINITY;
	const contextWindow = Math.min(configuredContextWindow, loadedContextWindow);
	const budget = Number.isFinite(contextWindow)
		? Math.max(1, contextWindow - inputTokens - safety)
		: Number.POSITIVE_INFINITY;
	const modelLimit = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const defaultLimit =
		limits?.maxOutputTokens !== undefined && limits.maxOutputTokens > 0 ? limits.maxOutputTokens : modelLimit;
	const requested = options?.maxTokens ?? defaultLimit;
	const resolved = Math.min(requested, modelLimit, budget);
	return Number.isFinite(resolved) ? resolved : DEFAULT_MAX_OUTPUT_TOKENS;
}
