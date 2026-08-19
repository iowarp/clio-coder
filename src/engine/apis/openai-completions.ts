import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenAICompletionsOptions,
	type SimpleStreamOptions,
	type StreamOptions,
	type ThinkingContent,
	type Tool,
	type Usage,
} from "@earendil-works/pi-ai";
import { type ApiProvider, streamOpenAICompletions, streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/compat";
import {
	type AppliedThinking,
	type ResolvedModelRuntimeCapabilities,
	reasoningClassForMechanism,
	resolveModelRuntimeCapabilitiesForModel,
} from "../../domains/providers/model-runtime-capabilities.js";
import { lmStudioReasoningEffort } from "../../domains/providers/runtimes/common/lmstudio-http.js";
import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import type { LocalModelQuirks, SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";
import type { LmStudioTargetSettings } from "../../domains/providers/types/target-descriptor.js";
import { filterGemmaChannelStream } from "../gemma-channel-filter.js";
import { HarmonyResponseParser } from "../harmony-response.js";
import { createSentinelStripper, stripTokenizerSentinels } from "../strip-tokenizer-sentinels.js";
import { ensureLlamaCppResidency } from "./llamacpp-residency.js";
import { ensureLmStudioResidency } from "./lmstudio.js";
import { LOCAL_TOOL_TURN_MAX_OUTPUT_TOKENS, remainingContextMaxTokens } from "./output-budget.js";
import { residencyManagedFor } from "./residency.js";
import { mergeSamplingOverride } from "./sampling-overrides.js";

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
		/** Present only when settings set the target lifecycle explicitly. */
		lifecycle?: "user-managed" | "clio-managed";
		gateway?: boolean;
		quirks?: LocalModelQuirks;
		chatTemplateKwargsUnsupported?: boolean;
		lmstudio?: LmStudioTargetSettings;
		lmstudioReasoningOptions?: ReadonlyArray<string>;
		lmstudioDefaultModel?: string;
	};
}

function chatTemplateKwargsUnsupported(model: Model<Api>): boolean {
	return (model as Model<Api> & ClioRuntimeMetadata).clio?.chatTemplateKwargsUnsupported === true;
}

function clioQuirks(model: Model<"openai-completions">): LocalModelQuirks | undefined {
	return (model as Model<"openai-completions"> & ClioRuntimeMetadata).clio?.quirks;
}

function pickSamplingProfile(
	quirks: LocalModelQuirks | undefined,
	thinkingActive: boolean,
): SamplingProfile | undefined {
	const sampling = quirks?.sampling;
	const profile = sampling ? (thinkingActive ? (sampling.thinking ?? sampling.instruct) : sampling.instruct) : undefined;
	return mergeSamplingOverride(profile);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

const THINKING_CHAT_TEMPLATE_KWARGS = new Set([
	"enable_thinking",
	"preserve_thinking",
	"reasoning_effort",
	"thinking_budget",
]);

type UsageWithReasoningAliases = Usage & { reasoning?: number; reasoningTokens?: number; reasoning_tokens?: number };

function stripThinkingRequestFields(payload: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...payload };
	delete next.enable_thinking;
	delete next.reasoning;
	delete next.reasoning_effort;
	delete next.thinking;
	if (isPlainRecord(next.chat_template_kwargs)) {
		const chatTemplateKwargs: Record<string, unknown> = { ...next.chat_template_kwargs };
		for (const key of THINKING_CHAT_TEMPLATE_KWARGS) delete chatTemplateKwargs[key];
		if (Object.keys(chatTemplateKwargs).length > 0) next.chat_template_kwargs = chatTemplateKwargs;
		else delete next.chat_template_kwargs;
	}
	return next;
}

function stripsThinking(resolved: ResolvedModelRuntimeCapabilities): boolean {
	return reasoningClassForMechanism(resolved.thinking.mechanism) === "never";
}

function stripThinkingFromMessage(message: AssistantMessage): AssistantMessage {
	const content = message.content.filter((block) => block.type !== "thinking");
	const usage = { ...message.usage } as UsageWithReasoningAliases;
	delete usage.reasoning;
	delete usage.reasoningTokens;
	delete usage.reasoning_tokens;
	return { ...message, content, usage };
}

function stripThinkingFromContext(context: Context): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant") return message;
			const content = message.content.filter((block) => block.type !== "thinking");
			return content.length === message.content.length ? message : { ...message, content };
		}),
	};
}

function withStrippedPartial<TEvent extends AssistantMessageEvent>(event: TEvent): TEvent {
	if (!("partial" in event)) return event;
	return { ...event, partial: stripThinkingFromMessage(event.partial as AssistantMessage) };
}

/**
 * Apply thinking-mechanism payload mutations to an openai-compat request body
 * after the catalog sampler is in place. Each mechanism owns the wire fields
 * it touches:
 *   - `effort-levels` writes `reasoning_effort` when the family resolved one;
 *     off also carries `chat_template_kwargs.enable_thinking=false` for strict
 *     templates whose effort vocabulary has no off value.
 *   - `budget-tokens` writes a vendor-specific budget object when the family
 *     declares a `thinkingFormat` of `anthropic-extended`; otherwise the
 *     budget remains informational and surfaces through the prompt only.
 *   - `on-off` writes `chat_template_kwargs.enable_thinking` matching the
 *     existing nemotron-cascade YAML precedent.
 *   - `none` removes thinking controls that lower layers may have added from
 *     stale/live-probed `model.reasoning` state.
 *   - `always-on` does not touch the payload; the backend/model owns it.
 */
function applyThinkingPayload(
	payload: Record<string, unknown>,
	applied: AppliedThinking,
	resolved: ResolvedModelRuntimeCapabilities,
	model: Model<Api>,
): Record<string, unknown> {
	if (applied.mechanism === "none") return stripThinkingRequestFields(payload);
	if (applied.mechanism === "always-on") return payload;
	const next: Record<string, unknown> = { ...payload };
	if (
		resolved.request.reasoningEffort &&
		(next.reasoning_effort === undefined || resolved.response.parser === "harmony")
	) {
		next.reasoning_effort = resolved.request.reasoningEffort;
	}
	if (resolved.request.chatTemplateKwargs && !chatTemplateKwargsUnsupported(model)) {
		const existing = isPlainRecord(next.chat_template_kwargs) ? next.chat_template_kwargs : {};
		next.chat_template_kwargs = { ...existing, ...resolved.request.chatTemplateKwargs };
	}
	if (
		applied.mechanism === "budget-tokens" &&
		resolved.request.budgetTokens !== undefined &&
		next.thinking === undefined &&
		resolved.request.budgetEnforcement === "enforced"
	) {
		// Only vendors whose openai-compat surface advertises a structured
		// thinking budget (e.g. anthropic-extended on routed providers) get
		// the field. The `qwen-chat-template` and llama.cpp surfaces do not
		// accept it; in those cases the budget stays informational and the
		// model only learns about it through the prompt Runtime block.
		next.thinking = { type: "enabled", budget_tokens: resolved.request.budgetTokens };
	}
	return next;
}

function isLmStudioModel(model: Model<Api>): boolean {
	const metadata = runtimeMetadata(model);
	return model.provider === "lmstudio" && metadata?.runtimeId === "lmstudio";
}

function applyLmStudioPayload(
	payload: Record<string, unknown>,
	model: Model<Api>,
	resolved: ResolvedModelRuntimeCapabilities,
): Record<string, unknown> {
	if (!isLmStudioModel(model)) return payload;
	const request = runtimeMetadata(model)?.lmstudio?.request;
	const next: Record<string, unknown> = { ...payload };
	delete next.chat_template_kwargs;
	if (request?.ttlSeconds !== undefined) next.ttl = request.ttlSeconds;
	if (request?.draftModel !== undefined) next.draft_model = request.draftModel;
	if (resolved.thinking.mechanism === "none" || resolved.thinking.mechanism === "always-on") return next;
	next.reasoning_effort =
		resolved.request.reasoningEffort ??
		lmStudioReasoningEffort(resolved.thinking.effectiveLevel, runtimeMetadata(model)?.lmstudioReasoningOptions);
	return next;
}

function applyLlamaCppPromptCachePayload(payload: Record<string, unknown>, model: Model<Api>): Record<string, unknown> {
	const metadata = runtimeMetadata(model);
	if (model.provider !== "llamacpp" || metadata?.runtimeId !== "llamacpp") return payload;
	if (payload.cache_prompt !== undefined) return payload;
	return { ...payload, cache_prompt: true };
}

function shouldApplyLlamaCppPromptCache(model: Model<"openai-completions">): boolean {
	const metadata = runtimeMetadata(model);
	return model.provider === "llamacpp" && metadata?.runtimeId === "llamacpp";
}

/**
 * Compose an `onPayload` hook over any caller-supplied one. Catalog overrides
 * apply first so the caller's hook sees the mutated body and can override or
 * inspect it. The result is returned only when the body actually changed
 * (pi-ai treats `undefined` as "use the original").
 */
function composeSamplingOnPayload(
	profile: SamplingProfile,
	resolved: ResolvedModelRuntimeCapabilities | undefined,
	base: AnyOnPayload | undefined,
): AnyOnPayload {
	return async (payload, model) => {
		if (!isPlainRecord(payload)) {
			return base ? await base(payload, model) : undefined;
		}
		let next = applyLlamaCppPromptCachePayload(applyOpenAISamplingProfile(payload, profile), model);
		if (resolved) next = applyThinkingPayload(next, resolved.thinking, resolved, model);
		if (resolved) next = applyLmStudioPayload(next, model, resolved);
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
function composeThinkingOnPayload(
	resolved: ResolvedModelRuntimeCapabilities,
	base: AnyOnPayload | undefined,
): AnyOnPayload {
	return async (payload, model) => {
		if (!isPlainRecord(payload)) {
			return base ? await base(payload, model) : undefined;
		}
		const next = applyLmStudioPayload(
			applyThinkingPayload(applyLlamaCppPromptCachePayload(payload, model), resolved.thinking, resolved, model),
			model,
			resolved,
		);
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
	resolved: ResolvedModelRuntimeCapabilities,
): TOptions | undefined {
	const applied = resolved.thinking;
	const profile = pickSamplingProfile(clioQuirks(model), applied.thinkingActive);
	const promptCache = shouldApplyLlamaCppPromptCache(model);
	const lmstudio = isLmStudioModel(model);
	if (
		!promptCache &&
		!lmstudio &&
		!profile &&
		applied.mechanism !== "effort-levels" &&
		applied.mechanism !== "budget-tokens" &&
		applied.mechanism !== "on-off" &&
		applied.mechanism !== "none"
	) {
		return options;
	}
	const merged: Record<string, unknown> = { ...(options ?? {}) };
	if (profile?.temperature !== undefined && merged.temperature === undefined) merged.temperature = profile.temperature;
	if (profile) {
		merged.onPayload = composeSamplingOnPayload(profile, resolved, options?.onPayload);
	} else {
		merged.onPayload = composeThinkingOnPayload(resolved, options?.onPayload);
	}
	return merged as TOptions;
}

function stripNeverReasoningFromStream(
	source: ReturnType<typeof streamOpenAICompletions>,
	resolved: ResolvedModelRuntimeCapabilities,
): ReturnType<typeof streamOpenAICompletions> {
	if (!stripsThinking(resolved)) return source;
	const stripped = createAssistantMessageEventStream();
	(async () => {
		try {
			for await (const event of source) {
				if (event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end") {
					continue;
				}
				if (event.type === "done") {
					stripped.push({ ...event, message: stripThinkingFromMessage(event.message) });
				} else if (event.type === "error") {
					stripped.push({ ...event, error: stripThinkingFromMessage(event.error) });
				} else {
					stripped.push(withStrippedPartial(event as AssistantMessageEvent));
				}
			}
			stripped.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(message);
		}
	})();
	return stripped;
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
	const metadata = runtimeMetadata(model);
	const localToolOutputLimit =
		options?.maxTokens === undefined &&
		(context.tools?.length ?? 0) > 0 &&
		(model.provider === "llamacpp" || metadata?.runtimeId === "llamacpp")
			? LOCAL_TOOL_TURN_MAX_OUTPUT_TOKENS
			: undefined;
	return {
		...(options ?? {}),
		maxTokens: remainingContextMaxTokens(
			model,
			context,
			options,
			localToolOutputLimit === undefined ? undefined : { maxOutputTokens: localToolOutputLimit },
		),
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

function runtimeMetadata(model: Model<Api>): NonNullable<ClioRuntimeMetadata["clio"]> | undefined {
	return (model as Model<Api> & ClioRuntimeMetadata).clio;
}

function emptyErrorMessage(model: Model<"openai-completions">, message: string): AssistantMessage {
	return {
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
			: "For LM Studio, verify the model's tool-use capability and active chat template in LM Studio.";
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

function positiveNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasReportedReasoningUsage(usage: Usage): boolean {
	const aliases = usage as UsageWithReasoningAliases;
	return (
		positiveNumber(aliases.reasoning) ||
		positiveNumber(aliases.reasoningTokens) ||
		positiveNumber(aliases.reasoning_tokens)
	);
}

/**
 * pi-ai 0.80.x reports `completion_tokens_details.reasoning_tokens` as
 * `usage.reasoning`. Some local OpenAI-compatible servers still emit thinking
 * content without provider usage details, so clio keeps a fallback estimate
 * from ThinkingContent blocks. The fallback must not add a second alias when
 * upstream already reported reasoning usage, because ACP consumers accept all
 * three field spellings for cross-agent compatibility.
 */
export function applyOpenAICompatReasoningEstimate(message: AssistantMessage): void {
	if (hasReportedReasoningUsage(message.usage)) return;
	const reasoningTokens = estimateReasoningTokens(message.content);
	if (reasoningTokens > 0) {
		(message.usage as UsageWithReasoningAliases).reasoningTokens = reasoningTokens;
	}
}

function withReasoningTokenEstimate(
	source: ReturnType<typeof streamOpenAICompletions>,
): ReturnType<typeof streamOpenAICompletions> {
	const annotated = createAssistantMessageEventStream();
	(async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") {
					applyOpenAICompatReasoningEstimate(event.message);
				} else if (event.type === "error") {
					applyOpenAICompatReasoningEstimate(event.error);
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

/**
 * Strip tokenizer special-token sentinels (e.g. `<|endoftext|>`,
 * `<|im_end|>`) from the streamed assistant text. Local inference servers
 * sometimes leak these when the chat template is misconfigured. Sanitizing
 * them at the engine adapter layer prevents the literal sentinel text from
 * reaching the agent loop, turn history, or the TUI renderer. Thinking and
 * tool-call events pass through unchanged.
 */
function stripSentinelsFromStream(
	source: ReturnType<typeof streamOpenAICompletions>,
	resolved: ResolvedModelRuntimeCapabilities,
): ReturnType<typeof streamOpenAICompletions> {
	const sanitized = createAssistantMessageEventStream();
	(async () => {
		try {
			const parseHarmony = resolved.response.parser === "harmony";
			const strippers = new Map<number, ReturnType<typeof createSentinelStripper>>();
			const harmonyParsers = new Map<number, HarmonyResponseParser>();
			const safeText = new Map<number, string>();
			const ensureStripper = (idx: number): ReturnType<typeof createSentinelStripper> => {
				const existing = strippers.get(idx);
				if (existing) return existing;
				const created = createSentinelStripper();
				strippers.set(idx, created);
				safeText.set(idx, "");
				return created;
			};
			const ensureHarmonyParser = (idx: number): HarmonyResponseParser => {
				const existing = harmonyParsers.get(idx);
				if (existing) return existing;
				const created = new HarmonyResponseParser();
				harmonyParsers.set(idx, created);
				return created;
			};
			const rewritePartialText = (event: AssistantMessageEvent, idx: number, value: string): void => {
				if (!("partial" in event)) return;
				const block = event.partial.content[idx];
				if (block && block.type === "text") block.text = value;
			};
			const sanitizeChunk = (idx: number, chunk: string): string => {
				const harmonySafe = parseHarmony ? ensureHarmonyParser(idx).push(chunk).text : chunk;
				return ensureStripper(idx).push(harmonySafe);
			};
			const flushChunk = (idx: number): string => {
				const harmonyTail = parseHarmony ? ensureHarmonyParser(idx).flush().text : "";
				const stripper = ensureStripper(idx);
				return stripper.push(harmonyTail) + stripper.flush();
			};
			for await (const event of source) {
				if (event.type === "text_delta") {
					const safeChunk = sanitizeChunk(event.contentIndex, event.delta);
					const accumulated = (safeText.get(event.contentIndex) ?? "") + safeChunk;
					safeText.set(event.contentIndex, accumulated);
					rewritePartialText(event, event.contentIndex, accumulated);
					if (safeChunk.length === 0) continue;
					sanitized.push({ ...event, delta: safeChunk });
					continue;
				}
				if (event.type === "text_end") {
					const tail = flushChunk(event.contentIndex);
					let accumulated = safeText.get(event.contentIndex) ?? "";
					if (tail.length > 0) {
						accumulated += tail;
						safeText.set(event.contentIndex, accumulated);
						rewritePartialText(event, event.contentIndex, accumulated);
						sanitized.push({
							type: "text_delta",
							contentIndex: event.contentIndex,
							delta: tail,
							partial: event.partial,
						});
					} else {
						rewritePartialText(event, event.contentIndex, accumulated);
					}
					sanitized.push({ ...event, content: accumulated });
					strippers.delete(event.contentIndex);
					harmonyParsers.delete(event.contentIndex);
					continue;
				}
				if (event.type === "done" || event.type === "error") {
					const message = event.type === "done" ? event.message : event.error;
					for (const block of message.content) {
						if (block.type === "text") block.text = stripTokenizerSentinels(block.text);
					}
				}
				sanitized.push(event as AssistantMessageEvent);
			}
			sanitized.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(message);
		}
	})();
	return sanitized;
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
			const error = emptyErrorMessage(model, message);
			guarded.push({ type: "error", reason: "error", error });
			guarded.end(error);
		}
	})();
	return guarded;
}

function resolvedCapabilitiesForModel(
	model: Model<"openai-completions">,
	level: ThinkingLevel,
): ResolvedModelRuntimeCapabilities {
	return resolveModelRuntimeCapabilitiesForModel(model, level);
}

function isManagedLlamaCppModel(model: Model<"openai-completions">): boolean {
	const metadata = runtimeMetadata(model);
	return model.provider === "llamacpp" && metadata?.runtimeId === "llamacpp" && typeof model.baseUrl === "string";
}

async function ensureResidencyForModel(model: Model<"openai-completions">): Promise<void> {
	const metadata = runtimeMetadata(model);
	if (model.provider !== "llamacpp" || metadata?.runtimeId !== "llamacpp") return;
	if (typeof model.baseUrl !== "string" || model.baseUrl.length === 0) return;
	await ensureLlamaCppResidency({
		baseUrl: model.baseUrl,
		targetId: metadata.targetId ?? model.provider,
		runtimeId: metadata.runtimeId,
		keepModelId: model.id,
		managed: residencyManagedFor(metadata.lifecycle),
	});
}

async function ensureLocalResidency(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal },
): Promise<Model<"openai-completions">> {
	if (isLmStudioModel(model)) {
		const wireModelId = await ensureLmStudioResidency(model, options);
		return wireModelId === model.id ? model : { ...model, id: wireModelId };
	}
	await ensureResidencyForModel(model);
	return model;
}

function withLocalResidency(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal },
	sourceFactory: (requestModel: Model<"openai-completions">) => ReturnType<typeof streamOpenAICompletions>,
): ReturnType<typeof streamOpenAICompletions> {
	if (!isManagedLlamaCppModel(model) && !isLmStudioModel(model)) return sourceFactory(model);
	const stream = createAssistantMessageEventStream();
	(async () => {
		try {
			const requestModel = await ensureLocalResidency(model, options);
			for await (const event of sourceFactory(requestModel)) {
				stream.push(event as AssistantMessageEvent);
			}
			stream.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const error = emptyErrorMessage(model, message);
			stream.push({ type: "error", reason: "error", error });
			stream.end(error);
		}
	})();
	return stream;
}

export const openAICompletionsApiProvider: ApiProvider<"openai-completions", OpenAICompletionsOptions> = {
	api: "openai-completions",
	stream: (model, context, options) => {
		// Bare `stream` callers don't communicate thinking state; fall back to
		// the model's reasoning capability so the catalog still applies. LM Studio
		// is the exception because its HTTP server defaults to thinking off.
		const defaultLevel = isLmStudioModel(model) ? "off" : model.reasoning === true ? "medium" : "off";
		const resolved = resolvedCapabilitiesForModel(model, defaultLevel);
		const effectiveContext = stripsThinking(resolved) ? stripThinkingFromContext(context) : context;
		const withSamplers = withSamplingOverrides(model, options, resolved);
		return guardMalformedToolCalls(
			withReasoningTokenEstimate(
				stripSentinelsFromStream(
					stripNeverReasoningFromStream(
						filterGemmaChannelStream(
							withLocalResidency(
								model,
								{
									...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
									...(options?.signal !== undefined ? { signal: options.signal } : {}),
								},
								(requestModel) =>
									streamOpenAICompletions(
										requestModel,
										effectiveContext,
										withRemainingContextBudget(model, effectiveContext, withSamplers),
									),
							),
							resolved.family === "gemma-4",
						),
						resolved,
					),
					resolved,
				),
			),
			model,
			context,
		);
	},
	streamSimple: (model, context, options?: SimpleStreamOptions) => {
		const resolved = resolvedCapabilitiesForModel(model, thinkingLevelFromSimple(options));
		const effectiveContext = stripsThinking(resolved) ? stripThinkingFromContext(context) : context;
		const withSamplers = withSamplingOverrides(model, options, resolved);
		return guardMalformedToolCalls(
			withReasoningTokenEstimate(
				stripSentinelsFromStream(
					stripNeverReasoningFromStream(
						filterGemmaChannelStream(
							withLocalResidency(
								model,
								{
									...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
									...(options?.signal !== undefined ? { signal: options.signal } : {}),
								},
								(requestModel) =>
									streamSimpleOpenAICompletions(
										requestModel,
										effectiveContext,
										withRemainingContextBudget(model, effectiveContext, withSamplers),
									),
							),
							resolved.family === "gemma-4",
						),
						resolved,
					),
					resolved,
				),
			),
			model,
			context,
		);
	},
};
