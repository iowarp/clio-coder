import { randomUUID } from "node:crypto";

import {
	type ChatHistoryData,
	type ChatMessageData,
	type ChatMessagePartFileData,
	type ChatMessagePartTextData,
	type ChatMessagePartToolCallRequestData,
	type ChatMessagePartToolCallResultData,
	type FileHandle,
	type FunctionToolCallRequest,
	type LLMLoadModelConfig,
	type LLMPredictionStopReason,
	type LLMRespondOpts,
	type LLMTool,
	LMStudioClient,
} from "@lmstudio/sdk";
import type {
	Api,
	ApiProvider,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import type { LocalModelQuirks, SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";
import { calculateEngineCost, parseEngineJsonWithRepair, parseEngineStreamingJson } from "../ai.js";
import { remainingContextMaxTokens } from "./output-budget.js";
import { applyThinkingMechanism } from "./thinking-mechanism.js";

const EMPTY_TOOL_ARGUMENTS_ERROR =
	"LM Studio SDK returned empty tool-call arguments; this model's chat template may not be compatible. Try the openai-compat runtime against the same gateway.";

type RuntimeLifecycle = "user-managed" | "clio-managed";

interface ClioRuntimeMetadata {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: RuntimeLifecycle;
		gateway?: boolean;
		quirks?: LocalModelQuirks;
	};
}

function normalizeBaseUrl(url: string): string {
	const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
	if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
	if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
	if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
	return trimmed;
}

function normalizeHttpBaseUrl(url: string): string {
	const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
	if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
	if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
	return `http://${trimmed}`;
}

// Per-runtime cache: when a (baseUrl, modelId) pair was last confirmed to be
// the sole resident model, skip the listLoaded round-trip on the next prompt
// inside the TTL. Eviction races (another client mutates LM Studio's resident
// set) self-heal on the first request after the TTL expires.
export const RESIDENT_TTL_MS = 60_000;
const residentCache = new Map<string, { modelId: string; at: number }>();

export function resetResidentCache(): void {
	residentCache.clear();
}

export interface ResidentModelEntry {
	readonly modelKey: string;
	unload(): Promise<void>;
}

export interface ResidentModelStatus {
	readonly state: "unknown" | "loaded" | "not-loaded";
}

export interface ResidentModelClient {
	llm: {
		listLoaded(): Promise<ReadonlyArray<ResidentModelEntry>>;
	};
}

export interface EnsureResidentOptions {
	lifecycle?: RuntimeLifecycle;
}

export async function ensureResidentModel(
	client: ResidentModelClient,
	baseUrl: string,
	modelId: string,
	options: EnsureResidentOptions = {},
	now: () => number = Date.now,
): Promise<ResidentModelStatus> {
	if (options.lifecycle !== "clio-managed") return { state: "unknown" };
	const cached = residentCache.get(baseUrl);
	if (cached && cached.modelId === modelId && now() - cached.at < RESIDENT_TTL_MS) return { state: "loaded" };
	let loaded: ReadonlyArray<ResidentModelEntry>;
	try {
		loaded = await client.llm.listLoaded();
	} catch {
		return { state: "unknown" };
	}
	const targetLoaded = loaded.some((entry) => entry.modelKey === modelId);
	const stale = loaded.filter((entry) => entry.modelKey !== modelId);
	if (stale.length > 0) {
		await Promise.all(stale.map((entry) => entry.unload().catch(() => undefined)));
	}
	if (targetLoaded) {
		residentCache.set(baseUrl, { modelId, at: now() });
		return { state: "loaded" };
	}
	residentCache.delete(baseUrl);
	return { state: "not-loaded" };
}

function toolToLmStudio(tool: Tool): LLMTool {
	const fn: LLMTool["function"] = {
		name: tool.name,
		parameters: tool.parameters as unknown as NonNullable<LLMTool["function"]["parameters"]>,
	};
	if (tool.description) fn.description = tool.description;
	return { type: "function", function: fn };
}

type UserPart = ChatMessagePartTextData | ChatMessagePartFileData;
type AssistantPart = ChatMessagePartTextData | ChatMessagePartFileData | ChatMessagePartToolCallRequestData;

interface PredictionStatsLike {
	promptTokensCount?: number;
	predictedTokensCount?: number;
	totalTokensCount?: number;
	stopReason?: LLMPredictionStopReason;
}

interface PredictionResultLike {
	stats: PredictionStatsLike;
}

interface OngoingPredictionLike {
	result(): Promise<PredictionResultLike>;
}

interface LmStudioPredictionHandle {
	respond(history: ChatHistoryData, opts: LLMRespondOpts<unknown>): OngoingPredictionLike;
}

interface LmStudioRunClient {
	files: {
		prepareImageBase64(fileName: string, contentBase64: string): Promise<FileHandle>;
	};
	llm: {
		listLoaded(): Promise<ReadonlyArray<ResidentModelEntry>>;
		model(
			modelId: string,
			opts: { signal: AbortSignal; verbose: boolean; config?: LLMLoadModelConfig },
		): Promise<LmStudioPredictionHandle>;
	};
}

export interface LmStudioRunDeps {
	createClient(opts: ConstructorParameters<typeof LMStudioClient>[0]): LmStudioRunClient;
	ensureResident(
		client: ResidentModelClient,
		baseUrl: string,
		modelId: string,
		options?: EnsureResidentOptions,
	): Promise<ResidentModelStatus | undefined>;
	discoverLoadedContext(baseUrl: string, modelId: string, signal: AbortSignal): Promise<number | undefined>;
}

/**
 * Out-of-band hints from the api-provider wrapper. `thinkingLevel` is the
 * Clio ThinkingLevel for the in-flight turn; `runStream` resolves it through
 * `applyThinkingMechanism` to pick the catalog sampling profile. The bare
 * `stream` path (no SimpleStreamOptions) leaves it undefined, in which case
 * the helper falls back to the model's `reasoning` capability flag.
 */
export interface RunStreamHints {
	thinkingLevel?: ThinkingLevel;
}

const defaultRunDeps: LmStudioRunDeps = {
	createClient: (opts) => new LMStudioClient(opts),
	ensureResident: ensureResidentModel,
	discoverLoadedContext: discoverLoadedContextLength,
};

function fileHandleToPart(handle: FileHandle): ChatMessagePartFileData {
	return {
		type: "file",
		name: handle.name,
		identifier: handle.identifier,
		sizeBytes: handle.sizeBytes,
		fileType: handle.type,
	};
}

function imageFileName(mimeType: string, index: number): string {
	const slash = mimeType.indexOf("/");
	const ext = slash >= 0 ? mimeType.slice(slash + 1) : "png";
	const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "") || "png";
	return `clio-image-${index}.${safeExt}`;
}

async function userMessage(
	client: Pick<LmStudioRunClient, "files">,
	content: string | (TextContent | ImageContent)[],
	imageCounter: { next: number },
): Promise<ChatMessageData> {
	if (typeof content === "string") {
		return { role: "user", content: [{ type: "text", text: content }] };
	}
	const parts: UserPart[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "image") {
			const fileName = imageFileName(block.mimeType, imageCounter.next++);
			let handle: FileHandle;
			try {
				handle = await client.files.prepareImageBase64(fileName, block.data);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`LM Studio prepareImage failed for ${fileName}: ${msg}`);
			}
			parts.push(fileHandleToPart(handle));
		}
	}
	return { role: "user", content: parts };
}

function assistantMessage(content: AssistantMessage["content"]): ChatMessageData {
	const parts: AssistantPart[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			const req: FunctionToolCallRequest = {
				type: "function",
				name: block.name,
				arguments: block.arguments,
			};
			if (block.id) req.id = block.id;
			parts.push({ type: "toolCallRequest", toolCallRequest: req });
		}
		// ThinkingContent blocks are intentionally skipped on replay: LM Studio's
		// chat protocol has no thinking part, and re-sending the raw chain of
		// thought as text would confuse the model on the next turn.
	}
	return { role: "assistant", content: parts };
}

function toolResultMessage(msg: Extract<Message, { role: "toolResult" }>): ChatMessageData {
	const text = msg.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const result: ChatMessagePartToolCallResultData = {
		type: "toolCallResult",
		content: text,
		toolCallId: msg.toolCallId,
	};
	return { role: "tool", content: [result] };
}

async function buildChatHistory(client: Pick<LmStudioRunClient, "files">, context: Context): Promise<ChatHistoryData> {
	const messages: ChatMessageData[] = [];
	const imageCounter = { next: 0 };
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: [{ type: "text", text: context.systemPrompt }] });
	}
	for (const msg of context.messages) {
		if (msg.role === "user") messages.push(await userMessage(client, msg.content, imageCounter));
		else if (msg.role === "assistant") messages.push(assistantMessage(msg.content));
		else if (msg.role === "toolResult") messages.push(toolResultMessage(msg));
	}
	return { messages };
}

function mapStopReason(
	reason: LLMPredictionStopReason | undefined,
	aborted: boolean,
	hadToolCall: boolean,
): AssistantMessage["stopReason"] {
	if (aborted || reason === "userStopped") return "aborted";
	if (reason === "failed" || reason === "modelUnloaded") return "error";
	if (reason === "toolCalls" || hadToolCall) return "toolUse";
	if (reason === "maxPredictedTokensReached" || reason === "contextLengthReached") return "length";
	return "stop";
}

function asDoneReason(
	reason: AssistantMessage["stopReason"],
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
	if (reason === "length" || reason === "toolUse") return reason;
	return "stop";
}

interface PendingToolCall {
	contentIndex: number;
	name: string;
	argBuffer: string;
	assistantIndex: number;
	toolCallSlot: ToolCall;
}

class LmStudioToolCallExtractionError extends Error {
	constructor() {
		super(EMPTY_TOOL_ARGUMENTS_ERROR);
		this.name = "LmStudioToolCallExtractionError";
	}
}

function hasNonEmptyGeneratedContent(output: AssistantMessage): boolean {
	return output.content.some((block) => {
		if (block.type === "text") return block.text.trim().length > 0;
		if (block.type === "thinking") return block.thinking.trim().length > 0;
		return false;
	});
}

function hasEmptyToolArguments(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.trim().length === 0;
	if (value && typeof value === "object" && !Array.isArray(value)) return Object.keys(value).length === 0;
	return false;
}

const MAX_AUTOMATIC_LOAD_CONTEXT = 262_144;
const MIN_AUTOMATIC_LOAD_CONTEXT = 32_768;

function automaticLoadContextLength(model: Model<"lmstudio-native">): number {
	// When `model.contextWindow` is set (from a knowledge-base entry or an
	// explicit `--context-window` override on the endpoint) it is the
	// authoritative budget for the load. Earlier versions also clamped against
	// `maxTokens * 2`, but agent workloads are dominated by *input* tokens, so
	// that clamp silently undersized the KV cache (e.g. 262K → 65K).
	if (model.contextWindow > 0) {
		return Math.min(model.contextWindow, MAX_AUTOMATIC_LOAD_CONTEXT);
	}
	const requestedOutput = model.maxTokens > 0 ? model.maxTokens : MIN_AUTOMATIC_LOAD_CONTEXT;
	const target = Math.max(MIN_AUTOMATIC_LOAD_CONTEXT, requestedOutput * 2);
	return Math.min(target, MAX_AUTOMATIC_LOAD_CONTEXT);
}

function clioQuirks(model: Model<Api>): LocalModelQuirks | undefined {
	return (model as Model<Api> & ClioRuntimeMetadata).clio?.quirks;
}

function pickSamplingProfile(
	quirks: LocalModelQuirks | undefined,
	thinkingActive: boolean,
): SamplingProfile | undefined {
	const sampling = quirks?.sampling;
	if (!sampling) return undefined;
	return thinkingActive ? sampling.thinking : sampling.instruct;
}

function thinkingLevelFromHintOrModel(hints: RunStreamHints, model: Model<"lmstudio-native">): ThinkingLevel {
	if (hints.thinkingLevel) return hints.thinkingLevel;
	return model.reasoning === true ? "medium" : "off";
}

function loadModelConfig(model: Model<"lmstudio-native">): LLMLoadModelConfig {
	// LM Studio's REST `/api/v1/models/load` does not expose KV cache quant or
	// fp16 KV options; those only round-trip through the SDK's WebSocket
	// protocol (LLMLoadModelConfig.llama{K,V}CacheQuantizationType,
	// useFp16ForKVCache). Honor catalog quirks here so dense gemma-4 NVFP4 loads
	// fit at f16 KV with parallel=1 and drop to q8_0 KV at parallel=4 without
	// the user editing settings.yaml by hand.
	const config: LLMLoadModelConfig = {
		contextLength: automaticLoadContextLength(model),
		flashAttention: true,
		gpu: { ratio: "max" },
		gpuStrictVramCap: true,
		offloadKVCacheToGpu: true,
	};
	const kvCache = clioQuirks(model)?.kvCache;
	if (kvCache) {
		if (kvCache.kQuant !== undefined) config.llamaKCacheQuantizationType = kvCache.kQuant;
		if (kvCache.vQuant !== undefined) config.llamaVCacheQuantizationType = kvCache.vQuant;
		if (kvCache.useFp16 !== undefined) config.useFp16ForKVCache = kvCache.useFp16;
	}
	return config;
}

interface LmStudioApiV0ModelEntry {
	id?: unknown;
	loaded_context_length?: unknown;
}

interface LmStudioApiV0ModelsResponse {
	data?: unknown;
}

interface LmStudioApiV1ModelEntry {
	key?: unknown;
	loaded_instances?: unknown;
}

interface LmStudioApiV1ModelsResponse {
	models?: unknown;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function apiV0ModelEntries(payload: LmStudioApiV0ModelsResponse | undefined): LmStudioApiV0ModelEntry[] {
	if (!Array.isArray(payload?.data)) return [];
	return payload.data.filter((entry): entry is LmStudioApiV0ModelEntry => isRecord(entry));
}

function apiV1ModelEntries(payload: LmStudioApiV1ModelsResponse | undefined): LmStudioApiV1ModelEntry[] {
	if (!Array.isArray(payload?.models)) return [];
	return payload.models.filter((entry): entry is LmStudioApiV1ModelEntry => isRecord(entry));
}

function loadedContextFromV1Instance(value: unknown): number | undefined {
	if (!isRecord(value) || !isRecord(value.config)) return undefined;
	return positiveNumber(value.config.context_length);
}

function loadedContextFromV1Entry(entry: LmStudioApiV1ModelEntry): number | undefined {
	if (!Array.isArray(entry.loaded_instances)) return undefined;
	for (const instance of entry.loaded_instances) {
		const contextLength = loadedContextFromV1Instance(instance);
		if (contextLength !== undefined) return contextLength;
	}
	return undefined;
}

async function discoverLoadedContextLength(
	baseUrl: string,
	modelId: string,
	signal: AbortSignal,
): Promise<number | undefined> {
	const base = normalizeHttpBaseUrl(baseUrl);
	const v1 = await discoverLoadedContextFromV1(base, modelId, signal);
	if (v1 !== undefined) return v1;
	return discoverLoadedContextFromV0(base, modelId, signal);
}

async function fetchLmStudioJson<T>(url: string, signal: AbortSignal): Promise<T | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1500);
	const onAbort = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

async function discoverLoadedContextFromV1(
	baseUrl: string,
	modelId: string,
	signal: AbortSignal,
): Promise<number | undefined> {
	const payload = await fetchLmStudioJson<LmStudioApiV1ModelsResponse>(`${baseUrl}/api/v1/models`, signal);
	const entry = apiV1ModelEntries(payload).find((row) => row.key === modelId);
	return entry ? loadedContextFromV1Entry(entry) : undefined;
}

async function discoverLoadedContextFromV0(
	baseUrl: string,
	modelId: string,
	signal: AbortSignal,
): Promise<number | undefined> {
	const payload = await fetchLmStudioJson<LmStudioApiV0ModelsResponse>(`${baseUrl}/api/v0/models`, signal);
	const entry = apiV0ModelEntries(payload).find((row) => row.id === modelId);
	return positiveNumber(entry?.loaded_context_length);
}

interface ResolvedRuntimeMetadata {
	targetId: string;
	runtimeId: string;
	lifecycle: RuntimeLifecycle;
	gateway: boolean;
}

function runtimeMetadata(model: Model<Api>): ResolvedRuntimeMetadata {
	const metadata = (model as Model<Api> & ClioRuntimeMetadata).clio;
	return {
		targetId: metadata?.targetId ?? model.provider,
		runtimeId: metadata?.runtimeId ?? model.provider,
		lifecycle: metadata?.lifecycle ?? "user-managed",
		gateway: metadata?.gateway ?? false,
	};
}

function describeLoadFailure(
	baseUrl: string,
	model: Model<"lmstudio-native">,
	loadConfig: LLMLoadModelConfig | undefined,
	requestedMaxTokens: number | false | undefined,
	err: unknown,
): string {
	const metadata = runtimeMetadata(model);
	const cause = err instanceof Error ? err.message : String(err);
	const context = loadConfig?.contextLength ?? model.contextWindow;
	const output = requestedMaxTokens === false || requestedMaxTokens === undefined ? model.maxTokens : requestedMaxTokens;
	return [
		`LM Studio could not load target '${metadata.targetId}' model '${model.id}' at ${baseUrl}.`,
		`Requested context ${context} and output ${output}.`,
		`Likely cause: VRAM pressure or a context length above the quantized model/server limit.`,
		"Try a lower contextWindow/maxTokens override, a smaller quant/tier, or openai-compat against the same LM Studio gateway when the model is already user-managed.",
		`SDK error: ${cause}`,
	].join(" ");
}

export function runStream(
	model: Model<"lmstudio-native">,
	context: Context,
	options: StreamOptions | undefined,
	deps: LmStudioRunDeps = defaultRunDeps,
	hints: RunStreamHints = {},
): AssistantMessageEventStream {
	const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const controller = new AbortController();
	const signal = options?.signal;
	let aborted = signal?.aborted === true;
	const onAbort = () => {
		aborted = true;
		controller.abort();
	};
	if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
	(async () => {
		try {
			if (aborted) throw new Error("Request was aborted");
			const baseUrl = normalizeBaseUrl(model.baseUrl);
			const clientOpts: ConstructorParameters<typeof LMStudioClient>[0] = { baseUrl };
			const passkey = options?.apiKey;
			if (passkey) clientOpts.clientPasskey = passkey;
			const client = deps.createClient(clientOpts);
			const metadata = runtimeMetadata(model);
			const residentStatus = await deps.ensureResident(client, baseUrl, model.id, { lifecycle: metadata.lifecycle });
			const verbose = process.env.CLIO_RUNTIME_VERBOSE === "1";
			const loadedContextWindow = await deps.discoverLoadedContext(baseUrl, model.id, controller.signal);
			const budgetLimits = loadedContextWindow !== undefined ? { contextWindow: loadedContextWindow } : undefined;
			const requestedMaxTokens = remainingContextMaxTokens(model, context, options, budgetLimits);
			const loadConfig = loadModelConfig(model);
			const requestedLoadContext = loadConfig.contextLength ?? model.contextWindow;
			// Skip passing `config` to client.llm.model when the model is already
			// resident. LM Studio can report residency through listLoaded while the
			// REST model metadata still omits context length; passing config in that
			// state triggers a no-progress reload wait in the SDK.
			const residentModelLoaded = residentStatus?.state === "loaded";
			const clioManagedLoadedUnknownContext =
				metadata.lifecycle === "clio-managed" && residentModelLoaded && loadedContextWindow === undefined;
			const clioManagedLoadedWithEnoughContext =
				metadata.lifecycle === "clio-managed" &&
				loadedContextWindow !== undefined &&
				loadedContextWindow >= requestedLoadContext;
			const modelOpenConfig =
				metadata.lifecycle === "user-managed" || clioManagedLoadedUnknownContext || clioManagedLoadedWithEnoughContext
					? undefined
					: loadConfig;
			const modelOpenOpts: { signal: AbortSignal; verbose: boolean; config?: LLMLoadModelConfig } = {
				signal: controller.signal,
				verbose,
			};
			if (modelOpenConfig !== undefined) modelOpenOpts.config = modelOpenConfig;
			let llm: LmStudioPredictionHandle;
			try {
				llm = await client.llm.model(model.id, modelOpenOpts);
			} catch (err) {
				throw new Error(describeLoadFailure(baseUrl, model, modelOpenConfig, requestedMaxTokens, err));
			}
			stream.push({ type: "start", partial: output });
			// LM Studio's `result.stats.predictedTokensCount` is the total of all generated
			// tokens with no separate reasoning column. Sum the per-fragment `tokensCount`
			// for any fragment whose `reasoningType` belongs to a reasoning block (the
			// chain-of-thought content plus the literal start/end tag tokens) so the
			// receipt and TUI footer can report `reasoningTokens` truthfully even when the
			// model emits a chain-of-thought via its chat template that the SDK has no API
			// to disable. Per-fragment counts are approximate per the SDK docs, but the
			// per-run sum tracks the actual reasoning total closely.
			let reasoningTokensAccum = 0;
			const activeTextRef: { block: TextContent | null; idx: number } = { block: null, idx: -1 };
			const activeThinkingRef: { block: ThinkingContent | null; idx: number } = { block: null, idx: -1 };
			const closeActiveText = () => {
				const current = activeTextRef.block;
				if (!current) return;
				stream.push({
					type: "text_end",
					contentIndex: activeTextRef.idx,
					content: current.text,
					partial: output,
				});
				activeTextRef.block = null;
				activeTextRef.idx = -1;
			};
			const closeActiveThinking = () => {
				const current = activeThinkingRef.block;
				if (!current) return;
				stream.push({
					type: "thinking_end",
					contentIndex: activeThinkingRef.idx,
					content: current.thinking,
					partial: output,
				});
				activeThinkingRef.block = null;
				activeThinkingRef.idx = -1;
			};
			const emitText = (chunk: string) => {
				if (!chunk) return;
				closeActiveThinking();
				let current = activeTextRef.block;
				if (!current) {
					current = { type: "text", text: "" };
					output.content.push(current);
					activeTextRef.block = current;
					activeTextRef.idx = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex: activeTextRef.idx, partial: output });
				}
				current.text += chunk;
				stream.push({
					type: "text_delta",
					contentIndex: activeTextRef.idx,
					delta: chunk,
					partial: output,
				});
			};
			const emitThinking = (chunk: string, tokensHint?: number) => {
				if (!chunk) return;
				closeActiveText();
				let current = activeThinkingRef.block;
				if (!current) {
					current = { type: "thinking", thinking: "" };
					output.content.push(current);
					activeThinkingRef.block = current;
					activeThinkingRef.idx = output.content.length - 1;
					stream.push({ type: "thinking_start", contentIndex: activeThinkingRef.idx, partial: output });
				}
				current.thinking += chunk;
				// When we have an upstream token count from the SDK use it; otherwise
				// approximate at 1 token per 4 chars (the same chars/4 estimator the
				// openai-compat wrapper uses for streamed thinking content).
				reasoningTokensAccum += tokensHint ?? Math.ceil(chunk.length / 4);
				stream.push({
					type: "thinking_delta",
					contentIndex: activeThinkingRef.idx,
					delta: chunk,
					partial: output,
				});
			};
			// Buffered state machine for gemma-4 family chat-template channel markers.
			// The model emits these as plain text fragments (reasoningType = "none")
			// rather than tagging them as reasoning, so without re-classification the
			// chain-of-thought leaks into the visible TUI text. The thought-start
			// pattern is regex-based because gemma emits channel-name variants like
			// `<|channel>thought\n`, `<|channel>own-thought\n`, `<|channel>own-think\n`.
			// LM Studio can also strip the `<|channel>` prefix and leave only the
			// bare channel label, e.g. `ownthought\n`, before a structured tool call.
			// Orphan `<channel|>` close markers (where the open was already consumed
			// via the SDK's reasoning-fragment path) are dropped in idle state.
			const GEMMA_THOUGHT_START_RE = /<\|channel>[^\n]*\n/;
			const GEMMA_BARE_THOUGHT_START_RE = /^\s*(?:thought|own[- ]?(?:thought|think))\s*\n/i;
			const GEMMA_BARE_THOUGHT_ONLY_RE = /^\s*(?:thought|own[- ]?(?:thought|think))\s*$/i;
			const GEMMA_THOUGHT_END = "<channel|>";
			const GEMMA_TOOLCALL_START = "<tool_call|>";
			const GEMMA_TOOLCALL_END = "<|tool_call|>";
			const GEMMA_BUFFER_MAX = 64;
			type GemmaState = "idle" | "thought" | "toolcall";
			let gemmaPending = "";
			let gemmaState: GemmaState = "idle";
			const flushGemmaPending = () => {
				if (gemmaPending.length === 0) return;
				if (gemmaState === "thought") emitThinking(gemmaPending);
				else if (gemmaState === "idle" && !GEMMA_BARE_THOUGHT_ONLY_RE.test(gemmaPending)) emitText(gemmaPending);
				gemmaPending = "";
			};
			const routeNonReasoningChunk = (chunk: string) => {
				gemmaPending += chunk;
				while (true) {
					if (gemmaState === "thought") {
						const endIdx = gemmaPending.indexOf(GEMMA_THOUGHT_END);
						if (endIdx === -1) {
							if (gemmaPending.length > GEMMA_BUFFER_MAX) {
								const safe = gemmaPending.slice(0, gemmaPending.length - GEMMA_BUFFER_MAX);
								emitThinking(safe);
								gemmaPending = gemmaPending.slice(gemmaPending.length - GEMMA_BUFFER_MAX);
							}
							return;
						}
						emitThinking(gemmaPending.slice(0, endIdx));
						gemmaPending = gemmaPending.slice(endIdx + GEMMA_THOUGHT_END.length);
						gemmaState = "idle";
					} else if (gemmaState === "toolcall") {
						// Discard SDK fallback text inside <tool_call|> regions; structured
						// tool calls arrive via the toolcall callbacks instead.
						const endIdx = gemmaPending.indexOf(GEMMA_TOOLCALL_END);
						if (endIdx === -1) {
							if (gemmaPending.length > GEMMA_BUFFER_MAX) {
								gemmaPending = gemmaPending.slice(gemmaPending.length - GEMMA_BUFFER_MAX);
							}
							return;
						}
						gemmaPending = gemmaPending.slice(endIdx + GEMMA_TOOLCALL_END.length);
						gemmaState = "idle";
					} else {
						const thoughtMatch = GEMMA_THOUGHT_START_RE.exec(gemmaPending);
						const thoughtIdx = thoughtMatch?.index ?? -1;
						const bareThoughtMatch = GEMMA_BARE_THOUGHT_START_RE.exec(gemmaPending);
						const bareThoughtIdx = bareThoughtMatch ? 0 : -1;
						const toolcallIdx = gemmaPending.indexOf(GEMMA_TOOLCALL_START);
						// Orphan close marker: SDK consumed `<|channel>...` via a
						// reasoning fragment, leaving only the standalone close in
						// the plain-text stream. Drop it silently.
						const orphanCloseIdx = gemmaPending.indexOf(GEMMA_THOUGHT_END);
						const candidates = [
							{ idx: thoughtIdx, kind: "thought" as const, advance: thoughtMatch?.[0].length ?? 0 },
							{ idx: bareThoughtIdx, kind: "thought" as const, advance: bareThoughtMatch?.[0].length ?? 0 },
							{ idx: toolcallIdx, kind: "toolcall" as const, advance: GEMMA_TOOLCALL_START.length },
							{ idx: orphanCloseIdx, kind: "orphan" as const, advance: GEMMA_THOUGHT_END.length },
						].filter((c) => c.idx !== -1);
						if (candidates.length === 0) {
							if (gemmaPending.length > GEMMA_BUFFER_MAX) {
								const safe = gemmaPending.slice(0, gemmaPending.length - GEMMA_BUFFER_MAX);
								emitText(safe);
								gemmaPending = gemmaPending.slice(gemmaPending.length - GEMMA_BUFFER_MAX);
							}
							return;
						}
						candidates.sort((a, b) => a.idx - b.idx);
						const next = candidates[0];
						if (!next) return;
						emitText(gemmaPending.slice(0, next.idx));
						gemmaPending = gemmaPending.slice(next.idx + next.advance);
						if (next.kind === "thought") gemmaState = "thought";
						else if (next.kind === "toolcall") gemmaState = "toolcall";
						// orphan stays in idle: just drop the marker bytes
					}
				}
			};
			const pending = new Map<number, PendingToolCall>();
			let toolExtractionError: LmStudioToolCallExtractionError | null = null;
			const predictionOpts: LLMRespondOpts<unknown> = {
				signal: controller.signal,
				onPredictionFragment: (fragment) => {
					if (!fragment.content) return;
					// LM Studio SDK reasoningType values:
					//   "none"               normal content (text)
					//   "reasoning"          chain-of-thought inside the block
					//   "reasoningStartTag"  literal <think> token
					//   "reasoningEndTag"    literal </think> token
					// Drop the start/end tags so they never leak into text or thinking;
					// route reasoning fragments into a ThinkingContent block so the
					// agent message is non-empty and pi-agent-core's loop can chain
					// correctly when the model only emits reasoning + tool calls.
					if (fragment.reasoningType === "reasoningStartTag" || fragment.reasoningType === "reasoningEndTag") {
						reasoningTokensAccum += fragment.tokensCount ?? 0;
						return;
					}
					if (fragment.reasoningType === "reasoning") {
						flushGemmaPending();
						reasoningTokensAccum += fragment.tokensCount ?? 0;
						emitThinking(fragment.content, 0);
						return;
					}
					routeNonReasoningChunk(fragment.content);
				},
				onToolCallRequestStart: (callId) => {
					flushGemmaPending();
					gemmaState = "idle";
					closeActiveText();
					closeActiveThinking();
					const slot: ToolCall = { type: "toolCall", id: randomUUID(), name: "", arguments: {} };
					output.content.push(slot);
					const idx = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					pending.set(callId, {
						contentIndex: idx,
						name: "",
						argBuffer: "",
						assistantIndex: idx,
						toolCallSlot: slot,
					});
				},
				onToolCallRequestNameReceived: (callId, name) => {
					const entry = pending.get(callId);
					if (!entry) return;
					entry.name = name;
					entry.toolCallSlot.name = name;
				},
				onToolCallRequestArgumentFragmentGenerated: (callId, fragment) => {
					const entry = pending.get(callId);
					if (!entry) return;
					entry.argBuffer += fragment;
					entry.toolCallSlot.arguments = parseStreamingArgs(entry.argBuffer);
					stream.push({
						type: "toolcall_delta",
						contentIndex: entry.contentIndex,
						delta: fragment,
						partial: output,
					});
				},
				onToolCallRequestEnd: (callId, info) => {
					const entry = pending.get(callId);
					if (!entry) return;
					const req = info.toolCallRequest;
					entry.toolCallSlot.name = req.name || entry.name || "";
					if (hasEmptyToolArguments(req.arguments) && entry.argBuffer.length === 0 && hasNonEmptyGeneratedContent(output)) {
						toolExtractionError = new LmStudioToolCallExtractionError();
						pending.delete(callId);
						return;
					}
					entry.toolCallSlot.arguments =
						req.arguments && typeof req.arguments === "object"
							? (req.arguments as Record<string, unknown>)
							: parseFinalArgs(entry.argBuffer);
					if (req.id) entry.toolCallSlot.id = req.id;
					stream.push({
						type: "toolcall_end",
						contentIndex: entry.contentIndex,
						toolCall: entry.toolCallSlot,
						partial: output,
					});
					pending.delete(callId);
				},
			};
			if (context.tools && context.tools.length > 0) {
				predictionOpts.rawTools = {
					type: "toolArray",
					tools: context.tools.map(toolToLmStudio),
				};
			}
			predictionOpts.maxTokens = requestedMaxTokens;
			// Apply catalog sampling quirks first; explicit StreamOptions overrides
			// (set on `options`) win where they are present. The catalog profile is
			// chosen by thinking activity, derived through applyThinkingMechanism so
			// the sampler choice matches the actual surface the model exposes
			// (effort-levels, budget-tokens, on-off, always-on, none). The bare
			// `stream` path leaves `hints.thinkingLevel` unset and falls back to
			// medium when the model advertises reasoning.
			const requestedThinkingLevel = thinkingLevelFromHintOrModel(hints, model);
			const applied = applyThinkingMechanism(clioQuirks(model), requestedThinkingLevel, {
				reasoning: model.reasoning === true,
			});
			// The LM Studio SDK has no separate thinking-budget channel; the budget
			// from `applied.budgetTokens` is informational only here and surfaces
			// through the prompt Runtime block. `maxPredictedTokens` stays driven
			// by the remaining-context budget so a budget-tokens family does not
			// unexpectedly truncate output.
			const samplingProfile = pickSamplingProfile(clioQuirks(model), applied.thinkingActive);
			if (samplingProfile) {
				if (samplingProfile.temperature !== undefined) predictionOpts.temperature = samplingProfile.temperature;
				if (samplingProfile.topP !== undefined) predictionOpts.topPSampling = samplingProfile.topP;
				if (samplingProfile.topK !== undefined) predictionOpts.topKSampling = samplingProfile.topK;
				if (samplingProfile.minP !== undefined) predictionOpts.minPSampling = samplingProfile.minP;
				if (samplingProfile.repeatPenalty !== undefined) predictionOpts.repeatPenalty = samplingProfile.repeatPenalty;
			}
			if (options?.temperature !== undefined) predictionOpts.temperature = options.temperature;
			const history = await buildChatHistory(client, context);
			if (aborted) throw new Error("Request was aborted");
			const prediction = llm.respond(history, predictionOpts);
			const result = await prediction.result();
			flushGemmaPending();
			closeActiveText();
			closeActiveThinking();
			// Write usage before any throw so the error path (tool-extraction failure,
			// post-result aborts) still surfaces real token counts to dispatch and the TUI.
			output.usage.input = result.stats.promptTokensCount ?? 0;
			output.usage.output = result.stats.predictedTokensCount ?? 0;
			output.usage.totalTokens = result.stats.totalTokensCount ?? output.usage.input + output.usage.output;
			if (reasoningTokensAccum > 0) {
				(output.usage as Usage & { reasoningTokens?: number }).reasoningTokens = reasoningTokensAccum;
			}
			calculateEngineCost(model, output.usage);
			if (aborted) throw new Error("Request was aborted");
			if (toolExtractionError) throw toolExtractionError;
			const hadToolCall = output.content.some((block) => block.type === "toolCall");
			output.stopReason = mapStopReason(result.stats.stopReason, aborted, hadToolCall);
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				output.errorMessage = `prediction stopped: ${result.stats.stopReason ?? "unknown"}`;
				stream.push({ type: "error", reason: output.stopReason, error: output });
			} else {
				stream.push({ type: "done", reason: asDoneReason(output.stopReason), message: output });
			}
			stream.end();
		} catch (err) {
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	})();
	return stream;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseStreamingArgs(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		return asRecord(parseEngineStreamingJson<unknown>(raw));
	} catch {
		return {};
	}
}

function parseFinalArgs(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		return asRecord(parseEngineJsonWithRepair<unknown>(raw));
	} catch {
		return parseStreamingArgs(raw);
	}
}

function stripReasoning(options: SimpleStreamOptions | undefined): StreamOptions | undefined {
	if (!options) return undefined;
	const { reasoning: _r, thinkingBudgets: _b, ...rest } = options;
	return rest;
}

// pi-ai's SimpleStreamOptions.reasoning is the ThinkingLevel for this turn,
// or undefined when thinking is off. The bare `stream` path cannot reach the
// level so runStream falls back to the model's `reasoning` capability flag.
function thinkingLevelFromSimple(options: SimpleStreamOptions | undefined): ThinkingLevel {
	const reasoning = options?.reasoning;
	if (reasoning === undefined) return "off";
	return reasoning as ThinkingLevel;
}

export const lmstudioNativeApiProvider: ApiProvider<"lmstudio-native"> = {
	api: "lmstudio-native",
	stream: (model, context, options) => runStream(model, context, options),
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		runStream(model, context, stripReasoning(options), defaultRunDeps, {
			thinkingLevel: thinkingLevelFromSimple(options),
		}),
};
