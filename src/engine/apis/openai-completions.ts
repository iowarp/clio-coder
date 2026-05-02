import {
	type ApiProvider,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenAICompletionsOptions,
	type SimpleStreamOptions,
	type StreamOptions,
	streamOpenAICompletions,
	streamSimpleOpenAICompletions,
	type ThinkingContent,
	type Tool,
	type Usage,
} from "@mariozechner/pi-ai";

import { remainingContextMaxTokens } from "./output-budget.js";

/**
 * Average characters-per-token for the English/code reasoning streams pi-ai
 * surfaces from openai-compatible providers. The exact ratio depends on the
 * upstream tokenizer; 4 matches GPT-2/BPE-style splits and is the same
 * estimator other inference tools use when no authoritative count is exposed.
 */
const REASONING_CHARS_PER_TOKEN = 4;

export { estimateInputTokensFromContext, remainingContextMaxTokens } from "./output-budget.js";

interface ClioRuntimeMetadata {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: "user-managed" | "clio-managed";
		gateway?: boolean;
	};
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

function requiredToolArguments(tool: Tool): ReadonlyArray<string> {
	const schema = tool.parameters as unknown;
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
	const required = (schema as Record<string, unknown>).required;
	if (!Array.isArray(required)) return [];
	return required.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function hasEmptyArguments(args: Record<string, unknown>): boolean {
	return Object.keys(args).length === 0;
}

function runtimeMetadata(model: Model<"openai-completions">): NonNullable<ClioRuntimeMetadata["clio"]> | undefined {
	return (model as Model<"openai-completions"> & ClioRuntimeMetadata).clio;
}

function malformedToolArgsMessage(
	model: Model<"openai-completions">,
	toolName: string,
	requiredFields: ReadonlyArray<string>,
): string {
	const metadata = runtimeMetadata(model);
	const target = metadata?.targetId ?? model.provider;
	const runtime = metadata?.runtimeId ?? model.provider;
	const required = requiredFields.length > 0 ? ` Required fields: ${requiredFields.join(", ")}.` : "";
	const workaround =
		model.provider === "llamacpp" || runtime === "llamacpp"
			? "For llama.cpp, verify --jinja, the model chat template, reasoning flags, and tool parser support for this model."
			: "For LM Studio, use the verified openai-compat gateway fallback when native SDK tool extraction is unreliable.";
	return `OpenAI-compatible runtime returned empty tool-call arguments for target '${target}' model '${model.id}' tool '${toolName}'.${required} ${workaround}`;
}

function finalErrorFromPartial(partial: AssistantMessage, message: string): AssistantMessage {
	return {
		...partial,
		stopReason: "error",
		errorMessage: message,
	};
}

function reasoningCharsFromContent(content: AssistantMessage["content"]): number {
	let chars = 0;
	for (const block of content) {
		if (block.type === "thinking") {
			chars += (block as ThinkingContent).thinking.length;
		}
	}
	return chars;
}

function estimateReasoningTokens(content: AssistantMessage["content"]): number {
	const chars = reasoningCharsFromContent(content);
	if (chars === 0) return 0;
	return Math.max(1, Math.round(chars / REASONING_CHARS_PER_TOKEN));
}

/**
 * pi-ai's openai-compatible parseChunkUsage drops `completion_tokens_details.
 * reasoning_tokens`, and llama.cpp's /v1/chat/completions doesn't surface that
 * field at all. Without a per-fragment token count (the lmstudio-native SDK
 * gives us one; openai-compat does not), we estimate from the cumulative
 * thinking content surfaced as ThinkingContent blocks. The receipt and TUI
 * footer would otherwise report `reasoningTokenCount = 0` even when the model
 * emitted a chain-of-thought, hiding the real cost from the operator.
 */
function withReasoningTokenEstimate(
	source: ReturnType<typeof streamOpenAICompletions>,
): ReturnType<typeof streamOpenAICompletions> {
	const annotated = createAssistantMessageEventStream();
	(async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") {
					const reasoningTokens = estimateReasoningTokens(event.message.content);
					if (reasoningTokens > 0) {
						(event.message.usage as Usage & { reasoningTokens?: number }).reasoningTokens = reasoningTokens;
					}
				} else if (event.type === "error") {
					const reasoningTokens = estimateReasoningTokens(event.error.content);
					if (reasoningTokens > 0) {
						(event.error.usage as Usage & { reasoningTokens?: number }).reasoningTokens = reasoningTokens;
					}
				}
				annotated.push(event as AssistantMessageEvent);
			}
			annotated.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(message);
		}
	})();
	return annotated;
}

function guardMalformedToolCalls(
	source: ReturnType<typeof streamOpenAICompletions>,
	model: Model<"openai-completions">,
	context: Context,
): ReturnType<typeof streamOpenAICompletions> {
	const requiredByTool = new Map<string, ReadonlyArray<string>>();
	for (const tool of context.tools ?? []) {
		const required = requiredToolArguments(tool);
		if (required.length > 0) requiredByTool.set(tool.name, required);
	}
	if (requiredByTool.size === 0) return source;
	const guarded = createAssistantMessageEventStream();
	(async () => {
		try {
			for await (const event of source) {
				if (event.type === "toolcall_end") {
					const required = requiredByTool.get(event.toolCall.name);
					if (required && hasEmptyArguments(event.toolCall.arguments)) {
						const message = malformedToolArgsMessage(model, event.toolCall.name, required);
						const error = finalErrorFromPartial(event.partial, message);
						guarded.push({ type: "error", reason: "error", error });
						guarded.end(error);
						return;
					}
				}
				guarded.push(event as AssistantMessageEvent);
			}
			guarded.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const error: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: message,
				timestamp: Date.now(),
			};
			guarded.push({ type: "error", reason: "error", error });
			guarded.end(error);
		}
	})();
	return guarded;
}

export const openAICompletionsApiProvider: ApiProvider<"openai-completions", OpenAICompletionsOptions> = {
	api: "openai-completions",
	stream: (model, context, options) =>
		guardMalformedToolCalls(
			withReasoningTokenEstimate(
				streamOpenAICompletions(model, context, withRemainingContextBudget(model, context, options)),
			),
			model,
			context,
		),
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		guardMalformedToolCalls(
			withReasoningTokenEstimate(
				streamSimpleOpenAICompletions(model, context, withRemainingContextBudget(model, context, options)),
			),
			model,
			context,
		),
};
