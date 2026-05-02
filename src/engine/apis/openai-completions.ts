import {
	type Api,
	type ApiProvider,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Message,
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

import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import type { LocalModelQuirks, SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";
import { remainingContextMaxTokens } from "./output-budget.js";
import { type AppliedThinking, applyThinkingMechanism } from "./thinking-mechanism.js";

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
		quirks?: LocalModelQuirks;
	};
}

function clioQuirks(model: Model<"openai-completions">): LocalModelQuirks | undefined {
	return (model as Model<"openai-completions"> & ClioRuntimeMetadata).clio?.quirks;
}

function pickSamplingProfile(
	quirks: LocalModelQuirks | undefined,
	thinkingActive: boolean,
): SamplingProfile | undefined {
	const sampling = quirks?.sampling;
	if (!sampling) return undefined;
	return thinkingActive ? sampling.thinking : sampling.instruct;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Vendors whose openai-compat surface accepts a structured `thinking` field
 * with a numeric budget. The list intentionally excludes the qwen and
 * llama.cpp surfaces, where the budget stays informational and surfaces only
 * through the prompt Runtime block.
 */
function acceptsBudgetTokensField(model: Model<"openai-completions">): boolean {
	const fmt = model.compat?.thinkingFormat;
	if (!fmt) return false;
	// Pi-ai surfaces 'openrouter' and 'zai' with vendor-specific reasoning
	// shapes that already accept a budget object.
	return fmt === "openrouter" || fmt === "zai";
}

/**
 * Install catalog sampling quirks on the OpenAI-compat request body. Standard
 * OpenAI fields (`temperature`, `top_p`, `presence_penalty`,
 * `frequency_penalty`) and LM Studio's extra fields (`top_k`, `min_p`,
 * `repeat_penalty`) are added only when the request body does not already
 * carry them. This keeps explicit StreamOptions and any user-supplied
 * `onPayload` overrides authoritative.
 */
function applyOpenAISamplingProfile(
	payload: Record<string, unknown>,
	profile: SamplingProfile,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...payload };
	if (profile.temperature !== undefined && next.temperature === undefined) next.temperature = profile.temperature;
	if (profile.topP !== undefined && next.top_p === undefined) next.top_p = profile.topP;
	if (profile.topK !== undefined && next.top_k === undefined) next.top_k = profile.topK;
	if (profile.minP !== undefined && next.min_p === undefined) next.min_p = profile.minP;
	if (profile.repeatPenalty !== undefined && next.repeat_penalty === undefined)
		next.repeat_penalty = profile.repeatPenalty;
	if (profile.presencePenalty !== undefined && next.presence_penalty === undefined)
		next.presence_penalty = profile.presencePenalty;
	if (profile.frequencyPenalty !== undefined && next.frequency_penalty === undefined)
		next.frequency_penalty = profile.frequencyPenalty;
	return next;
}

type AnyOnPayload = (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;

/**
 * Apply thinking-mechanism payload mutations to an openai-compat request body
 * after the catalog sampler is in place. Each mechanism owns the wire fields
 * it touches:
 *   - `effort-levels` writes `reasoning_effort` when the family resolved one.
 *   - `budget-tokens` writes a vendor-specific budget object when the family
 *     declares a `thinkingFormat` of `anthropic-extended`; otherwise the
 *     budget remains informational and surfaces through the prompt only.
 *   - `on-off` writes `chat_template_kwargs.enable_thinking` matching the
 *     existing nemotron-cascade YAML precedent.
 *   - `always-on` and `none` do not touch the payload; the helper still
 *     drove sampler selection upstream.
 */
function applyThinkingPayload(
	payload: Record<string, unknown>,
	applied: AppliedThinking,
	model: Model<"openai-completions">,
): Record<string, unknown> {
	if (applied.mechanism === "always-on" || applied.mechanism === "none") return payload;
	const next: Record<string, unknown> = { ...payload };
	if (applied.mechanism === "effort-levels" && applied.effort && next.reasoning_effort === undefined) {
		next.reasoning_effort = applied.effort;
	}
	if (
		applied.mechanism === "budget-tokens" &&
		applied.budgetTokens !== undefined &&
		next.thinking === undefined &&
		acceptsBudgetTokensField(model)
	) {
		// Only vendors whose openai-compat surface advertises a structured
		// thinking budget (e.g. anthropic-extended on routed providers) get
		// the field. The `qwen-chat-template` and llama.cpp surfaces do not
		// accept it; in those cases the budget stays informational and the
		// model only learns about it through the prompt Runtime block.
		next.thinking = { type: "enabled", budget_tokens: applied.budgetTokens };
	}
	if (applied.mechanism === "on-off" && applied.chatTemplateKwargs) {
		const existing = isPlainRecord(next.chat_template_kwargs) ? next.chat_template_kwargs : {};
		next.chat_template_kwargs = { ...existing, ...applied.chatTemplateKwargs };
	}
	return next;
}

/**
 * Compose an `onPayload` hook over any caller-supplied one. Catalog overrides
 * apply first so the caller's hook sees the mutated body and can override or
 * inspect it. The result is returned only when the body actually changed
 * (pi-ai treats `undefined` as "use the original").
 */
function composeSamplingOnPayload(
	profile: SamplingProfile,
	applied: AppliedThinking | undefined,
	base: AnyOnPayload | undefined,
): AnyOnPayload {
	return async (payload, model) => {
		if (!isPlainRecord(payload)) {
			return base ? await base(payload, model) : undefined;
		}
		let next = applyOpenAISamplingProfile(payload, profile);
		if (applied) next = applyThinkingPayload(next, applied, model as Model<"openai-completions">);
		if (base) {
			const fromBase = await base(next, model);
			if (fromBase !== undefined) return fromBase;
		}
		return next;
	};
}

/**
 * Variant of `composeSamplingOnPayload` for cases where there is no catalog
 * sampler but we still need to inject thinking-mechanism fields.
 */
function composeThinkingOnPayload(applied: AppliedThinking, base: AnyOnPayload | undefined): AnyOnPayload {
	return async (payload, model) => {
		if (!isPlainRecord(payload)) {
			return base ? await base(payload, model) : undefined;
		}
		const next = applyThinkingPayload(payload, applied, model as Model<"openai-completions">);
		if (base) {
			const fromBase = await base(next, model);
			if (fromBase !== undefined) return fromBase;
		}
		return next;
	};
}

function withSamplingOverrides<TOptions extends StreamOptions>(
	model: Model<"openai-completions">,
	options: TOptions | undefined,
	applied: AppliedThinking,
): TOptions | undefined {
	const profile = pickSamplingProfile(clioQuirks(model), applied.thinkingActive);
	if (
		!profile &&
		applied.mechanism !== "effort-levels" &&
		applied.mechanism !== "budget-tokens" &&
		applied.mechanism !== "on-off"
	) {
		return options;
	}
	const merged: Record<string, unknown> = { ...(options ?? {}) };
	if (profile?.temperature !== undefined && merged.temperature === undefined) merged.temperature = profile.temperature;
	if (profile) {
		merged.onPayload = composeSamplingOnPayload(profile, applied, options?.onPayload);
	} else {
		merged.onPayload = composeThinkingOnPayload(applied, options?.onPayload);
	}
	return merged as TOptions;
}

function thinkingLevelFromSimple(options: SimpleStreamOptions | undefined): ThinkingLevel {
	const reasoning = options?.reasoning;
	if (reasoning === undefined) return "off";
	return reasoning as ThinkingLevel;
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

/**
 * Drop ThinkingContent blocks from prior assistant messages before they go
 * upstream. Necessary because pi-ai's openai-completions serializer attaches
 * any non-empty thinking back onto the request via
 * `assistantMsg[thinkingSignature] = thinking` (e.g. `reasoning_content` for
 * llama.cpp same-model replays). With a thinking model on llama.cpp this means
 * every prior turn's chain-of-thought is re-sent on every subsequent turn,
 * compounding context use until the request blows past the model's context
 * window. The lmstudio-native adapter strips thinking on replay for the same
 * reason (`assistantMessage` in src/engine/apis/lmstudio-native.ts); this
 * brings the openai-compat path to parity. Tool calls and text content are
 * preserved verbatim. The current in-flight assistant turn is unaffected
 * because pi-ai builds it from streamed events, not from `context.messages`.
 */
function stripThinkingFromHistory(context: Context): Context {
	let mutated = false;
	const messages: Message[] = context.messages.map((message) => {
		if (message.role !== "assistant") return message;
		const filtered = message.content.filter((block) => block.type !== "thinking");
		if (filtered.length === message.content.length) return message;
		mutated = true;
		return { ...message, content: filtered } as Message;
	});
	if (!mutated) return context;
	return { ...context, messages };
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

function appliedThinkingForModel(model: Model<"openai-completions">, level: ThinkingLevel): AppliedThinking {
	return applyThinkingMechanism(clioQuirks(model), level, {
		reasoning: model.reasoning === true,
		...(model.compat?.thinkingFormat ? { thinkingFormat: model.compat.thinkingFormat } : {}),
	});
}

export const openAICompletionsApiProvider: ApiProvider<"openai-completions", OpenAICompletionsOptions> = {
	api: "openai-completions",
	stream: (model, context, options) => {
		const replayContext = stripThinkingFromHistory(context);
		// Bare `stream` callers don't communicate thinking state; fall back to
		// the model's reasoning capability so the catalog still applies.
		const applied = appliedThinkingForModel(model, model.reasoning === true ? "medium" : "off");
		const withSamplers = withSamplingOverrides(model, options, applied);
		return guardMalformedToolCalls(
			withReasoningTokenEstimate(
				streamOpenAICompletions(model, replayContext, withRemainingContextBudget(model, replayContext, withSamplers)),
			),
			model,
			replayContext,
		);
	},
	streamSimple: (model, context, options?: SimpleStreamOptions) => {
		const replayContext = stripThinkingFromHistory(context);
		const applied = appliedThinkingForModel(model, thinkingLevelFromSimple(options));
		const withSamplers = withSamplingOverrides(model, options, applied);
		return guardMalformedToolCalls(
			withReasoningTokenEstimate(
				streamSimpleOpenAICompletions(model, replayContext, withRemainingContextBudget(model, replayContext, withSamplers)),
			),
			model,
			replayContext,
		);
	},
};
