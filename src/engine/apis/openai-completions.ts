import { TextDecoder } from "node:util";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenAICompletionsOptions,
	type SimpleStreamOptions,
	type StreamOptions,
	type ThinkingBudgets,
	type Tool,
	type Usage,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { BackendCompletionTimings, BackendTimingsSource } from "../../core/cache-telemetry.js";
import {
	type GatewayRoutingObservation,
	liteLLMGatewayRoutingFromHeaders,
	liteLLMRouteFailureMessage,
} from "../../core/gateway-routing.js";
import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import {
	type ResolvedModelRuntimeCapabilities,
	reasoningClassForMechanism,
	resolveModelRuntimeCapabilitiesForModel,
} from "../../domains/providers/model-runtime-capabilities.js";
import {
	invalidateLmStudioCatalog,
	lmStudioReasoningEffort,
} from "../../domains/providers/runtimes/common/lmstudio-http.js";
import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import type { LocalModelQuirks } from "../../domains/providers/types/local-model-quirks.js";
import type { LiteLLMTargetSettings, LmStudioTargetSettings } from "../../domains/providers/types/target-descriptor.js";
import { isProviderContentFilter, providerContentFilterMessage } from "../ai.js";
import { normalizeContext, resolvedRequestContext } from "../context.js";
import { filterGemmaChannelStream, usesGemmaChannelMarkers } from "../gemma-channel-filter.js";
import { HarmonyResponseParser } from "../harmony-response.js";
import { captureErrorBody, restoreTruncatedErrorBody } from "../provider-error-body.js";
import { createSentinelStripper, stripTokenizerSentinels } from "../strip-tokenizer-sentinels.js";
import { createDegradedInferenceStream, type WatchDegradedInferenceOptions } from "./degraded-inference.js";
import {
	applyDiffusionFrame,
	type DiffusionFrame,
	diffusionFramesEnabled,
	observeDiffusionFrameChunk,
	runtimeStreamsDiffusionFrames,
} from "./diffusion-frames.js";
import { ensureLlamaCppResidency, listLlamaCppResidentModels } from "./llamacpp-residency.js";
import {
	ensureGatewayLmStudioResidency,
	ensureLmStudioResidency,
	gatewayLmStudioProfile,
	listGatewayLmStudioResidentModels,
	listLmStudioResidentModels,
} from "./lmstudio.js";
import { estimateReasoningTokens, remainingContextMaxTokens } from "./output-budget.js";
import { residencyManagedFor } from "./residency.js";
import { pickSamplingProfile, samplingParamsFromProfile } from "./sampling-overrides.js";
import type { EngineApiProvider } from "./types.js";

declare module "@earendil-works/pi-ai" {
	interface Usage {
		/** Whether the wire response explicitly supplied a cache-read count. */
		cacheReadReported?: boolean;
	}
	interface AssistantMessage {
		/** Direct observation of model-id presence in an OpenAI-compatible response. */
		responseModelIdObservation?: ResponseModelIdObservation;
		/** Route, fallback, retry, and proxy timing facts reported by LiteLLM. */
		gatewayRouting?: GatewayRoutingObservation;
		/** Backend-reported prefill and prediction timings when available. */
		backendTimings?: BackendCompletionTimings;
	}
}

const piOpenAICompletions = openAICompletionsApi();

export { estimateInputTokensFromContext, remainingContextMaxTokens } from "./output-budget.js";

interface ClioRuntimeMetadata {
	clioCoder?: {
		targetId: string;
		runtimeId: string;
		/** Present only when settings set the target lifecycle explicitly. */
		lifecycle?: "user-managed" | "clio-coder-managed";
		gateway?: boolean;
		quirks?: LocalModelQuirks;
		chatTemplateKwargsUnsupported?: boolean;
		lmstudio?: LmStudioTargetSettings;
		litellm?: LiteLLMTargetSettings;
		lmstudioReasoningOptions?: ReadonlyArray<string>;
		lmstudioDefaultModel?: string;
	};
}

function chatTemplateKwargsUnsupported(model: Model<Api>): boolean {
	return (model as Model<Api> & ClioRuntimeMetadata).clioCoder?.chatTemplateKwargsUnsupported === true;
}

function clioQuirks(model: Model<"openai-completions">): LocalModelQuirks | undefined {
	return (model as Model<"openai-completions"> & ClioRuntimeMetadata).clioCoder?.quirks;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ResponseModelIdCapture {
	reportedModelId: string | null;
	observed: boolean;
	modelIdDone: boolean;
	cacheReadReported: boolean;
	backendTimings: BackendCompletionTimings | null;
	backendTimingsSource: BackendTimingsSource | null;
	gatewayRouting: GatewayRoutingObservation | null;
	/** Latest non-2xx body, read from a clone before the SDK truncates its copy. */
	errorBody: Promise<string | null> | null;
	/** Whole-response frames seen on the wire, in order; null when frames were not requested. */
	diffusionFrames: DiffusionFrame[] | null;
	/**
	 * An in-stream error frame said the provider's content filter stopped the
	 * response. The SDK throws on that frame with no HTTP status and keeps only
	 * its message, so this is the one place the code is still visible.
	 */
	contentFilter: boolean;
	buffer: string;
	decoder: TextDecoder | null;
}

function nonnegativeFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The operator's llama.cpp router reported build b226-2115b73d8. Its nonstream
 * response placed a `{ prompt_n, prompt_ms, predicted_n, predicted_ms, cache_n }`
 * timing object at the top level. Its stream placed the timing object on the
 * final SSE JSON event without `timings_per_token`. Setting
 * `timings_per_token: true` repeated cumulative timing objects for individual
 * tokens. LM Studio's OpenAI-compatible stream and nonstream responses omitted
 * timings both with and without that flag. Its native runtime reported
 * llama.cpp-win-x86_64-nvidia-cuda12-avx2 2.29.0.
 */
function backendCompletionTimings(value: unknown, source: BackendTimingsSource): BackendCompletionTimings | null {
	if (!isPlainRecord(value)) return null;
	const promptN = nonnegativeFiniteNumber(value.prompt_n);
	const predictedN = nonnegativeFiniteNumber(value.predicted_n);
	const promptMs = nonnegativeFiniteNumber(value.prompt_ms);
	const predictedMs = nonnegativeFiniteNumber(value.predicted_ms);
	if (promptN === null || predictedN === null || promptMs === null || predictedMs === null) return null;
	const cacheN = nonnegativeFiniteNumber(value.cache_n);
	return {
		promptTokens: promptN + (cacheN ?? 0),
		cachedTokens: cacheN,
		predictedTokens: predictedN,
		promptMs,
		predictedMs,
		source,
	};
}

function backendTimingsSourceForModel(model: Model<Api>): BackendTimingsSource | null {
	const metadata = (model as Model<Api> & ClioRuntimeMetadata).clioCoder;
	if (model.provider === "llamacpp" && metadata?.runtimeId === "llamacpp") return "llamacpp-timings";
	if (model.provider === "lmstudio" && metadata?.runtimeId === "lmstudio") return "lmstudio-timings";
	return null;
}

/**
 * Read one parsed completion chunk. Pi hands each chunk to
 * `onProviderStreamEvent` before it normalizes it, so these facts need no
 * second decode of the transport bytes.
 */
function observeProviderChunk(payload: unknown, capture: ResponseModelIdCapture): void {
	if (!isPlainRecord(payload)) return;
	if (capture.diffusionFrames !== null) observeDiffusionFrameChunk(payload, capture.diffusionFrames);
	const usage = isPlainRecord(payload.usage) ? payload.usage : {};
	const details = isPlainRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
	if (
		nonnegativeFiniteNumber(details.cached_tokens) !== null ||
		nonnegativeFiniteNumber(usage.cache_read_input_tokens) !== null
	) {
		capture.cacheReadReported = true;
	}
	if (!capture.modelIdDone) {
		const model = payload.model;
		if (typeof model === "string" && model.trim().length > 0) {
			capture.reportedModelId = model.trim();
			capture.modelIdDone = true;
		}
	}
	if (capture.backendTimingsSource !== null) {
		const timings = backendCompletionTimings(payload.timings, capture.backendTimingsSource);
		if (timings !== null) capture.backendTimings = timings;
	}
}

/**
 * Inception answers with HTTP 200 and one SSE frame,
 * `{"error": {"type": "content_filter_error", "code": "content_filter", ...}}`,
 * whose message is a refusal written as if the model were speaking.
 */
function isContentFilterErrorFrame(error: unknown): boolean {
	if (!isPlainRecord(error)) return false;
	return [error.code, error.type].some((value) => typeof value === "string" && isProviderContentFilter(value));
}

/**
 * The OpenAI SDK throws on an in-stream error frame before Pi's hook can see
 * it, and Pi's error text drops the frame's code. This scan is the only
 * remaining read of the SSE stream; `captureErrorBody` still reads a non-2xx
 * body from a clone.
 */
function observeErrorFrameBytes(chunk: Uint8Array | undefined, capture: ResponseModelIdCapture, flush = false): void {
	if (!capture.decoder) return;
	capture.buffer += chunk ? capture.decoder.decode(chunk, { stream: !flush }) : capture.decoder.decode();
	const lines = capture.buffer.split("\n");
	capture.buffer = flush ? "" : (lines.pop() ?? "");
	for (const line of lines) {
		const data = line.startsWith("data:") ? line.slice("data:".length).trimStart() : "";
		if (!data.includes('"error"')) continue;
		try {
			const payload = JSON.parse(data) as unknown;
			if (isPlainRecord(payload) && isContentFilterErrorFrame(payload.error)) capture.contentFilter = true;
		} catch {
			// A partial or vendor-specific event is pi-ai's parsing concern.
		}
	}
	if (flush) capture.decoder = null;
}

function captureResponseModelId(response: Response, capture: ResponseModelIdCapture, model: Model<Api>): Response {
	if (runtimeMetadata(model)?.runtimeId === "litellm") {
		capture.gatewayRouting = liteLLMGatewayRoutingFromHeaders(response.headers);
	}
	if (!response.ok) capture.errorBody = captureErrorBody(response);
	if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
		return response;
	}
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				capture.observed = true;
				observeErrorFrameBytes(chunk, capture);
				controller.enqueue(chunk);
			},
			flush() {
				capture.observed = true;
				observeErrorFrameBytes(undefined, capture, true);
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/** Whether this request asks the provider for whole-response diffusion frames. */
function diffusionFramesActive(model: Model<Api>): boolean {
	// Engine models carry the runtime id in their Clio metadata; a model
	// synthesized straight from the descriptor carries only its provider name.
	return diffusionFramesEnabled() && runtimeStreamsDiffusionFrames(runtimeMetadata(model)?.runtimeId ?? model.provider);
}

function withResponseModelIdCapture<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions,
	sourceFactory: (capturedOptions: TOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const capture: ResponseModelIdCapture = {
		reportedModelId: null,
		observed: false,
		modelIdDone: false,
		cacheReadReported: false,
		backendTimings: null,
		backendTimingsSource: backendTimingsSourceForModel(model),
		gatewayRouting: null,
		errorBody: null,
		diffusionFrames: diffusionFramesActive(model) ? [] : null,
		contentFilter: false,
		buffer: "",
		decoder: new TextDecoder(),
	};
	const fetchImpl: NonNullable<StreamOptions["fetch"]> =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const capturedOptions = {
		...options,
		fetch: async (input, init) => captureResponseModelId(await fetchImpl(input, init), capture, model),
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			observeProviderChunk(data, capture);
			await options.onProviderStreamEvent?.(data, eventModel);
		},
	} as TOptions;
	const source = sourceFactory(capturedOptions);
	const annotated = createAssistantMessageEventStream();
	(async () => {
		try {
			for await (const raw of source) {
				const event = capture.diffusionFrames !== null ? applyDiffusionFrame(raw, capture.diffusionFrames) : raw;
				const observation: ResponseModelIdObservation = capture.observed
					? capture.reportedModelId === null
						? { state: "not-reported" }
						: { state: "reported", reportedModelId: capture.reportedModelId }
					: { state: "not-observed" };
				if (event.type === "done") {
					event.message.usage.cacheReadReported = capture.cacheReadReported;
					event.message.responseModelIdObservation = observation;
					if (capture.gatewayRouting !== null) event.message.gatewayRouting = capture.gatewayRouting;
					if (capture.backendTimings !== null) event.message.backendTimings = capture.backendTimings;
				} else if (event.type === "error") {
					if (event.error.errorMessage !== undefined && capture.errorBody !== null) {
						event.error.errorMessage = restoreTruncatedErrorBody(event.error.errorMessage, await capture.errorBody);
					}
					if (capture.contentFilter && event.error.stopReason === "error") {
						event.error.errorMessage = providerContentFilterMessage(event.error.errorMessage ?? "");
					}
					event.error.usage.cacheReadReported = capture.cacheReadReported;
					event.error.responseModelIdObservation = observation;
					if (capture.gatewayRouting !== null) event.error.gatewayRouting = capture.gatewayRouting;
					if (capture.backendTimings !== null) event.error.backendTimings = capture.backendTimings;
				}
				annotated.push(event as AssistantMessageEvent);
			}
			annotated.end();
		} catch (err) {
			failStream(annotated, model, err);
		}
	})();
	return annotated;
}

/** Make a failed physical gateway route final and useful to an operator. */
function withLiteLLMRouteFailureAdvice(
	model: Model<"openai-completions">,
	source: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const metadata = runtimeMetadata(model);
	if (metadata?.runtimeId !== "litellm") return source;
	const advised = createAssistantMessageEventStream();
	let hasPartialResponse = false;
	(async () => {
		try {
			for await (const event of source) {
				if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
					hasPartialResponse = true;
				}
				if (event.type === "error" && event.reason !== "aborted" && event.error.stopReason !== "aborted") {
					event.error.errorMessage = liteLLMRouteFailureMessage(
						event.error.errorMessage,
						metadata.targetId,
						model.id,
						hasPartialResponse || event.error.content.length > 0,
					);
				}
				advised.push(event as AssistantMessageEvent);
			}
			advised.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failStream(
				advised,
				model,
				err instanceof Error && err.name === "AbortError"
					? err
					: new Error(liteLLMRouteFailureMessage(message, metadata.targetId, model.id, hasPartialResponse)),
			);
		}
	})();
	return advised;
}

type StreamOptionsWithThinkingBudgets = StreamOptions & { thinkingBudgets?: ThinkingBudgets };

type UsageWithReasoningAliases = Usage & { reasoning?: number; reasoningTokens?: number; reasoning_tokens?: number };

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

/**
 * Pi 0.85 drops assistant turns with neither text nor tools, even when it has
 * serialized their raw reasoning field. Give only an interrupted, same-model
 * raw-reasoning turn a request-local notice so a continuation retains its work.
 * Never turn private reasoning into answer text or modify the saved transcript.
 * Opaque signatures and cross-model conversion remain the provider's concern.
 */
function preserveInterruptedReasoning(
	context: Context,
	model: Model<"openai-completions">,
	resolved: ResolvedModelRuntimeCapabilities,
): Context {
	if (!resolved.thinking.thinkingActive || model.compat?.requiresThinkingAsText) return context;
	return {
		...context,
		messages: context.messages.map((message) => {
			if (
				message.role !== "assistant" ||
				message.stopReason !== "length" ||
				message.provider !== model.provider ||
				message.api !== model.api ||
				message.model !== model.id ||
				message.content.length === 0 ||
				!message.content.every(
					(block) =>
						block.type === "thinking" &&
						!block.redacted &&
						block.thinking.trim().length > 0 &&
						["reasoning", "reasoning_content", "reasoning_text"].includes(block.thinkingSignature ?? ""),
				)
			)
				return message;
			return {
				...message,
				content: [...message.content, { type: "text" as const, text: "Response interrupted before its answer." }],
			};
		}),
	};
}

/**
 * The gpt-oss chat template raises on an assistant turn that carries text,
 * reasoning and tool calls together ("Cannot pass both content and thinking in
 * an assistant message with tool calls"). Hosted endpoints report it as a bare
 * 400, so one such turn poisons every later request in the session. Harmony
 * renders that text on the analysis channel anyway: drop the reasoning from
 * the request only and never modify the saved transcript.
 */
function harmonyToolTurnsWithoutThinking(context: Context, resolved: ResolvedModelRuntimeCapabilities): Context {
	if (resolved.response.parser !== "harmony") return context;
	return {
		...context,
		messages: context.messages.map((message) => {
			if (
				message.role !== "assistant" ||
				!message.content.some((block) => block.type === "toolCall") ||
				!message.content.some((block) => block.type === "text" && block.text.trim().length > 0) ||
				!message.content.some((block) => block.type === "thinking")
			)
				return message;
			return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
		}),
	};
}

function withStrippedPartial<TEvent extends AssistantMessageEvent>(event: TEvent): TEvent {
	if (!("partial" in event)) return event;
	return { ...event, partial: stripThinkingFromMessage(event.partial as AssistantMessage) };
}

function isLmStudioModel(model: Model<Api>): boolean {
	const metadata = runtimeMetadata(model);
	return model.provider === "lmstudio" && metadata?.runtimeId === "lmstudio";
}

/**
 * The `reasoning_effort` spelling LM Studio reads for this request, or
 * undefined to send none (binary models take an effort only to switch off).
 */
function lmStudioWireEffort(model: Model<Api>, resolved: ResolvedModelRuntimeCapabilities): string | undefined {
	const metadata = runtimeMetadata(model);
	const options = metadata?.lmstudioReasoningOptions;
	const setting = metadata?.lmstudio?.request?.reasoning;
	switch (setting) {
		case "off":
			return lmStudioReasoningEffort("off", options);
		case "on":
			return lmStudioReasoningEffort("low", options);
		case "low":
		case "medium":
		case "high":
			return lmStudioReasoningEffort(setting, options);
		default:
			return options
				? lmStudioReasoningEffort(resolved.thinking.effectiveLevel, options)
				: (resolved.request.reasoningEffort ?? lmStudioReasoningEffort(resolved.thinking.effectiveLevel));
	}
}

/**
 * Body fields the runtime reads for one request on a local runtime target.
 * Only `synthLocalModel` sets `clioCoder.runtimeId`, and that id is the gate.
 * Pi merges `StreamOptions.samplingParams` into the request body after its own
 * fields, so these ride that public pass-through instead of a payload rewrite,
 * and a caller's samplingParams key replaces the value computed here. Pi's
 * compat chain cannot carry them: it emits `chat_template_kwargs` or
 * `reasoning_effort` but never both, gates the chat-template branch on
 * `model.reasoning` while Clio's family kwargs apply regardless, and has no
 * field for `allowed_openai_params`, `cache_prompt`, `ttl` or `draft_model`.
 * `none` and `always-on` leave `reasoning_effort` to the backend or to
 * model.samplingParams (Mercury's pinned `instant`). A model without a runtime
 * id keeps Pi's thinking handling. That includes Pi catalog models and
 * catalog-backed targets, which can carry `clioCoder` cache metadata but never
 * a runtime id.
 */
function runtimeBodyFields(
	model: Model<"openai-completions">,
	resolved: ResolvedModelRuntimeCapabilities,
	options: (StreamOptions & { reasoning?: string; reasoningEffort?: string }) | undefined,
): Record<string, unknown> {
	const metadata = runtimeMetadata(model);
	const fields: Record<string, unknown> = {};
	if (metadata?.runtimeId === undefined) return fields;
	const lmstudio = isLmStudioModel(model);
	const { mechanism } = resolved.thinking;
	const controlled = mechanism !== "none" && mechanism !== "always-on";
	const effort = controlled
		? lmstudio
			? lmStudioWireEffort(model, resolved)
			: resolved.request.reasoningEffort
		: undefined;
	if (effort !== undefined) fields.reasoning_effort = effort;
	// LiteLLM generic openai/<local model> routes otherwise drop this standard
	// parameter. Allow only the effort this model/runtime actually resolved.
	if (
		resolved.runtimeId === "litellm" &&
		controlled &&
		effort !== undefined &&
		effort === resolved.request.reasoningEffort
	) {
		fields.allowed_openai_params = ["reasoning_effort"];
	}
	const requested = options?.reasoning ?? options?.reasoningEffort;
	const kwargs = {
		// samplingParams replaces the whole chat_template_kwargs value, so Pi's
		// two-key qwen-chat-template spelling is repeated here for the family
		// kwargs to extend. Re-run the local wire matrix after a Pi bump.
		...(model.compat?.thinkingFormat === "qwen-chat-template" && model.reasoning
			? { enable_thinking: requested !== undefined && requested !== "off", preserve_thinking: true }
			: {}),
		...(chatTemplateKwargsUnsupported(model) ? {} : resolved.request.chatTemplateKwargs),
	};
	// LM Studio ignores chat_template_kwargs; undefined removes Pi's own field.
	if (lmstudio) fields.chat_template_kwargs = undefined;
	else if (Object.keys(kwargs).length > 0) fields.chat_template_kwargs = kwargs;
	if (model.provider === "llamacpp" && metadata.runtimeId === "llamacpp")
		fields.cache_prompt = options?.cacheRetention !== "none";
	if (lmstudio) {
		const request = metadata.lmstudio?.request;
		if (request?.ttlSeconds !== undefined) fields.ttl = request.ttlSeconds;
		if (request?.draftModel !== undefined) fields.draft_model = request.draftModel;
	}
	return fields;
}

function withSamplingOverrides<TOptions extends StreamOptions>(
	model: Model<"openai-completions">,
	options: TOptions | undefined,
	resolved: ResolvedModelRuntimeCapabilities,
	diffusion: boolean,
): TOptions {
	const quirks = clioQuirks(model);
	const profile = pickSamplingProfile(quirks, resolved.thinking.thinkingActive);
	const vllmThinkingBudgets = resolved.runtimeId === "vllm" ? quirks?.thinking?.budgetByLevel : undefined;
	const merged: Record<string, unknown> = { ...(options ?? {}) };
	if (profile?.temperature !== undefined && merged.temperature === undefined) merged.temperature = profile.temperature;
	merged.samplingParams = {
		...(diffusion ? { diffusing: true } : {}),
		...runtimeBodyFields(model, resolved, options),
		...(profile ? samplingParamsFromProfile(profile, resolved.runtimeId) : {}),
		...options?.samplingParams,
	};
	if (vllmThinkingBudgets) {
		merged.thinkingBudgets = {
			...vllmThinkingBudgets,
			...(options as StreamOptionsWithThinkingBudgets | undefined)?.thinkingBudgets,
		};
	}
	return merged as TOptions;
}

function stripNeverReasoningFromStream(
	source: AssistantMessageEventStream,
	model: Model<Api>,
	resolved: ResolvedModelRuntimeCapabilities,
): AssistantMessageEventStream {
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
			failStream(stripped, model, err);
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
	return {
		...(options ?? {}),
		maxTokens: remainingContextMaxTokens(model, context, options),
	} as TOptions;
}

function hasHeader(headers: Readonly<Record<string, unknown>> | undefined, name: string): boolean {
	if (!headers) return false;
	const wanted = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Apply LiteLLM's request-control headers at the final transport boundary.
 *
 * Pi's adapter already makes zero client attempts unless `maxRetries` is set, so
 * the only retry control left here is the optional `numRetries` header: it
 * configures the proxy router itself, where any attempts stay observable. A
 * physical-routing gateway should leave `numRetries` at zero.
 */
function withLiteLLMRequestOptions<TOptions extends StreamOptions>(
	model: Model<"openai-completions">,
	options: TOptions,
): TOptions {
	const metadata = runtimeMetadata(model);
	if (metadata?.runtimeId !== "litellm") return options;
	const request = metadata.litellm?.request;
	const modelHeaders = model.headers as Readonly<Record<string, unknown>> | undefined;
	const optionHeaders = options.headers as Readonly<Record<string, unknown>> | undefined;
	const headers: Record<string, string | null> = { ...(options.headers ?? {}) };
	const setDefault = (name: string, value: string | undefined): void => {
		if (value === undefined || hasHeader(modelHeaders, name) || hasHeader(optionHeaders, name)) return;
		headers[name] = value;
	};
	setDefault("x-litellm-tags", ["clio-coder", ...(request?.tags ?? [])].join(","));
	if (request?.sendSessionId !== false) setDefault("x-litellm-session-id", options.sessionId);
	setDefault("x-litellm-timeout", request?.timeoutSeconds?.toString());
	setDefault("x-litellm-stream-timeout", request?.streamTimeoutSeconds?.toString());
	setDefault("x-litellm-num-retries", request?.numRetries?.toString());
	return { ...options, headers } as TOptions;
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

function runtimeMetadata(model: Model<Api>): NonNullable<ClioRuntimeMetadata["clioCoder"]> | undefined {
	return (model as Model<Api> & ClioRuntimeMetadata).clioCoder;
}

function emptyErrorMessage(model: Model<Api>, message: string): AssistantMessage {
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

function failStream(stream: AssistantMessageEventStream, model: Model<Api>, cause: unknown): void {
	const error = emptyErrorMessage(model, cause instanceof Error ? cause.message : String(cause));
	error.stopReason = cause instanceof Error && cause.name === "AbortError" ? "aborted" : "error";
	stream.push({ type: "error", reason: error.stopReason, error });
	stream.end(error);
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
function applyOpenAICompatReasoningEstimate(message: AssistantMessage): void {
	if (hasReportedReasoningUsage(message.usage)) return;
	const estimated = estimateReasoningTokens(message.content);
	const reportedOutput = message.usage.output;
	const reasoningTokens =
		typeof reportedOutput === "number" && Number.isFinite(reportedOutput)
			? Math.min(estimated, Math.max(0, reportedOutput))
			: estimated;
	if (reasoningTokens > 0) {
		(message.usage as UsageWithReasoningAliases).reasoningTokens = reasoningTokens;
	}
}

function withReasoningTokenEstimate(
	source: AssistantMessageEventStream,
	model: Model<Api>,
): AssistantMessageEventStream {
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
			failStream(annotated, model, err);
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
	source: AssistantMessageEventStream,
	model: Model<Api>,
	resolved: ResolvedModelRuntimeCapabilities,
): AssistantMessageEventStream {
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
			failStream(sanitized, model, err);
		}
	})();
	return sanitized;
}

function guardMalformedToolCalls(
	source: AssistantMessageEventStream,
	model: Model<"openai-completions">,
	context: Context,
): AssistantMessageEventStream {
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
				// The final stop reason distinguishes malformed output from a token
				// limit. pi rejects every call in a length-truncated message (even
				// salvage-parsed arguments) and continues with error tool results.
				// Turning that into an error here aborts the worker before recovery.
				if (event.type === "done" && event.message.stopReason !== "length") {
					const malformed = event.message.content.find(
						(block) => block.type === "toolCall" && requiredByTool.has(block.name) && hasEmptyArguments(block.arguments),
					);
					if (malformed?.type === "toolCall") {
						const message = malformedToolArgsMessage(model, malformed.name, requiredByTool.get(malformed.name) ?? []);
						const error = finalErrorFromPartial(event.message, message);
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

type LocalRequestOptions = Pick<StreamOptions, "apiKey" | "headers" | "signal">;

function localRequestHeaders(model: Model<Api>, options: LocalRequestOptions): Record<string, string> {
	const headers = new Headers(model.headers);
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		if (value === null) headers.delete(name);
		else if (value !== undefined) headers.set(name, value);
	}
	if (options.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${options.apiKey}`);
	return Object.fromEntries(headers);
}

async function ensureResidencyForModel(
	model: Model<"openai-completions">,
	options: LocalRequestOptions,
): Promise<void> {
	const metadata = runtimeMetadata(model);
	if (model.provider !== "llamacpp" || metadata?.runtimeId !== "llamacpp") return;
	if (typeof model.baseUrl !== "string" || model.baseUrl.length === 0) return;
	await ensureLlamaCppResidency({
		baseUrl: model.baseUrl,
		targetId: metadata.targetId ?? model.provider,
		runtimeId: metadata.runtimeId,
		keepModelId: model.id,
		managed: residencyManagedFor(metadata.lifecycle),
		headers: localRequestHeaders(model, options),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

interface LocalResidency {
	model: Model<"openai-completions">;
	/** Ends this stream's claim on the resident model; see lmstudio-ownership.ts. */
	release(): Promise<void>;
}

const NO_RELEASE = (): Promise<void> => Promise.resolve();

async function ensureLocalResidency(
	model: Model<"openai-completions">,
	options: LocalRequestOptions,
): Promise<LocalResidency> {
	if (isLmStudioModel(model)) {
		const requestModel = { ...model, headers: localRequestHeaders(model, options) };
		const { wireModelId, release } = await ensureLmStudioResidency(requestModel, options);
		// Residency may discover a smaller loaded window after turn preflight.
		if (model.contextWindow <= 0 || requestModel.contextWindow < model.contextWindow) {
			model.contextWindow = requestModel.contextWindow;
		}
		return { model: wireModelId === model.id ? model : { ...model, id: wireModelId }, release };
	}
	if (gatewayLmStudioProfile(model)) {
		// The gateway keeps the route; Clio only fixes the load behind it.
		return { model, release: await ensureGatewayLmStudioResidency(model, options) };
	}
	await ensureResidencyForModel(model, options);
	return { model, release: NO_RELEASE };
}

function degradedWatchOptions(
	model: Model<"openai-completions">,
	options: LocalRequestOptions,
): WatchDegradedInferenceOptions {
	const metadata = runtimeMetadata(model);
	const baseUrl = model.baseUrl;
	const listResident = isLmStudioModel(model)
		? () => listLmStudioResidentModels({ ...model, headers: localRequestHeaders(model, options) }, options)
		: gatewayLmStudioProfile(model)
			? () => listGatewayLmStudioResidentModels(model, options)
			: () =>
					listLlamaCppResidentModels(baseUrl, fetch, {
						headers: localRequestHeaders(model, options),
						...(options.signal ? { signal: options.signal } : {}),
					});
	return {
		targetId: metadata?.targetId ?? model.provider,
		runtimeId: metadata?.runtimeId ?? model.provider,
		model: model.id,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		listResident,
	};
}

// Local servers answer a CPU spill with a crawl rather than an error, so the
// streams reaching them run under the degraded-inference watchdog. The source
// is iterated here, inside this catch, so a throw mid-stream still ends the
// turn with an error event. Exported for the error-propagation contract.
export function withLocalResidency(
	model: Model<"openai-completions">,
	options: LocalRequestOptions,
	sourceFactory: (requestModel: Model<"openai-completions">) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (!isManagedLlamaCppModel(model) && !isLmStudioModel(model) && !gatewayLmStudioProfile(model)) {
		return sourceFactory(model);
	}
	const stream = createDegradedInferenceStream(degradedWatchOptions(model, options));
	(async () => {
		let release = NO_RELEASE;
		try {
			options.signal?.throwIfAborted();
			const residency = await ensureLocalResidency(model, options);
			release = residency.release;
			options.signal?.throwIfAborted();
			for await (const event of sourceFactory(residency.model)) {
				if (event.type === "error" && isLmStudioModel(model)) {
					invalidateLmStudioCatalog({
						id: runtimeMetadata(model)?.targetId ?? model.provider,
						runtime: "lmstudio",
						url: model.baseUrl,
					});
				}
				stream.push(event as AssistantMessageEvent);
			}
			stream.end();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const error = emptyErrorMessage(model, message);
			error.stopReason = options.signal?.aborted ? "aborted" : "error";
			stream.push({ type: "error", reason: error.stopReason, error });
			stream.end(error);
		} finally {
			await release();
		}
	})();
	return stream;
}

function streamCompletions<TOptions extends StreamOptions>(
	model: Model<"openai-completions">,
	context: Context,
	options: TOptions | undefined,
	level: ThinkingLevel,
	start: (
		model: Model<"openai-completions">,
		context: TranscriptContext,
		options: TOptions,
	) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const resolved = resolvedCapabilitiesForModel(model, level);
	const effectiveContext = stripsThinking(resolved)
		? stripThinkingFromContext(context)
		: harmonyToolTurnsWithoutThinking(context, resolved);
	// Pi's credential check reads request headers, while its HTTP client also
	// reads model headers. Forward both so header-authenticated targets pass both.
	const transportOptions = model.headers
		? ({
				...options,
				headers: Object.fromEntries(
					[...Object.entries(model.headers), ...Object.entries(options?.headers ?? {})].map(([name, value]) => [
						name.toLowerCase(),
						value,
					]),
				),
			} as TOptions)
		: options;
	const diffusion = diffusionFramesActive(model);
	const requestOptions = withLiteLLMRequestOptions(model, transportOptions ?? ({} as TOptions));
	const source = withResponseModelIdCapture(model, requestOptions, (capturedOptions) =>
		withLocalResidency(model, options ?? {}, (requestModel) => {
			return start(
				requestModel,
				normalizeContext(preserveInterruptedReasoning(effectiveContext, requestModel, resolved)),
				withRemainingContextBudget(
					requestModel,
					effectiveContext,
					withSamplingOverrides(requestModel, capturedOptions, resolved, diffusion),
				),
			);
		}),
	);
	const advised = withLiteLLMRouteFailureAdvice(model, source);
	const channels = filterGemmaChannelStream(advised, usesGemmaChannelMarkers(resolved.modelId), (stream, error) =>
		failStream(stream, model, error),
	);
	const thinking = stripNeverReasoningFromStream(channels, model, resolved);
	// The sentinel stripper accumulates deltas and rewrites the partial from
	// that sum, which is exactly wrong for a stream whose deltas are whole
	// frames. A diffusion provider is a cloud endpoint with no sentinel leak.
	const sanitized = diffusion ? thinking : stripSentinelsFromStream(thinking, model, resolved);
	return guardMalformedToolCalls(withReasoningTokenEstimate(sanitized, model), model, resolvedRequestContext(context));
}

export const openAICompletionsApiProvider: EngineApiProvider<"openai-completions", OpenAICompletionsOptions> = {
	api: "openai-completions",
	stream: (model, context, options) => {
		const level = isLmStudioModel(model) ? "off" : model.reasoning ? "medium" : "off";
		return streamCompletions(model, context, options, level, piOpenAICompletions.stream);
	},
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		streamCompletions(model, context, options, thinkingLevelFromSimple(options), piOpenAICompletions.streamSimple),
};
