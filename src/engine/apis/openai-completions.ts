import {
	type ApiProvider,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type OpenAICompletionsOptions,
	type SimpleStreamOptions,
	type StreamOptions,
	streamOpenAICompletions,
	streamSimpleOpenAICompletions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@mariozechner/pi-ai";

const CONTEXT_BUDGET_SAFETY_TOKENS = 1024;
const IMAGE_ESTIMATE_BYTES = 4800;

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
	model: Model<"openai-completions">,
	context: Context,
	options: StreamOptions | undefined,
): number {
	const safety = CONTEXT_BUDGET_SAFETY_TOKENS;
	const inputTokens = estimateInputTokensFromContext(context);
	const contextWindow = model.contextWindow ?? Number.POSITIVE_INFINITY;
	const budget = Math.max(safety, contextWindow - inputTokens - safety);
	const requested = options?.maxTokens ?? model.maxTokens ?? budget;
	return Math.min(requested, budget);
}

function withRemainingContextBudget<TOptions extends StreamOptions>(
	model: Model<"openai-completions">,
	context: Context,
	options: TOptions | undefined,
): TOptions {
	return {
		...(options ?? {}),
		maxTokens: remainingContextMaxTokens(model, context, options),
	} as TOptions;
}

export const openAICompletionsApiProvider: ApiProvider<"openai-completions", OpenAICompletionsOptions> = {
	api: "openai-completions",
	stream: (model, context, options) =>
		streamOpenAICompletions(model, context, withRemainingContextBudget(model, context, options)),
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		streamSimpleOpenAICompletions(model, context, withRemainingContextBudget(model, context, options)),
};
