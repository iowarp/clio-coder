import { randomUUID } from "node:crypto";
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
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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
import { resolveModelRuntimeCapabilitiesForModel } from "../../domains/providers/model-runtime-capabilities.js";
import { lmStudioQuietLogger } from "../../domains/providers/runtimes/common/lmstudio-logger.js";
import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import {
	asKvCacheQuant,
	KV_CACHE_QUANTS,
	type LocalModelQuirks,
	type SamplingProfile,
} from "../../domains/providers/types/local-model-quirks.js";
import { ceilChars } from "../../domains/session/context-accounting.js";
import { calculateEngineCost, parseEngineJsonWithRepair, parseEngineStreamingJson } from "../ai.js";
import { HarmonyResponseParser } from "../harmony-response.js";
import { createSentinelStripper } from "../strip-tokenizer-sentinels.js";
import { remainingContextMaxTokens } from "./output-budget.js";
import {
	emitResidencyNotice,
	type ResidencyAdapter,
	type ResidencyPlan,
	reconcileResidency,
	residencyManaged,
} from "./residency.js";
import { mergeSamplingOverride } from "./sampling-overrides.js";
import { formatThinkingForReplay } from "./thinking-replay.js";

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

// One loaded model in LM Studio's resident set, as the SDK socket reports it.
// The reconciler (residency.ts) drives load and evict through these entries.
export interface ResidentModelEntry {
	readonly modelKey: string;
	unload(): Promise<void>;
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
	reconcile(adapter: ResidencyAdapter): Promise<ResidencyPlan>;
	discoverLoadedContext(baseUrl: string, modelId: string, signal: AbortSignal): Promise<number | undefined>;
}

/**
 * Out-of-band hints from the api-provider wrapper. `thinkingLevel` is the
 * Clio ThinkingLevel for the in-flight turn; `runStream` resolves it through
 * the provider-domain runtime capability layer before choosing catalog
 * sampling. The bare `stream` path (no SimpleStreamOptions) leaves it
 * undefined, in which case the helper falls back to the model's `reasoning`
 * capability flag.
 */
export interface RunStreamHints {
	thinkingLevel?: ThinkingLevel;
}

// Worker-process-scoped cache of LMStudioClient instances keyed on
// `${baseUrl}|${clientPasskey ?? ""}`. Creating a fresh client per turn
// allocates a new WebSocket session against the LM Studio server, and abandoning
// it without [Symbol.asyncDispose] leaks server-side channel state. The server
// then logs `Received channelSend for unknown channel` warnings on the next
// abort because the previous turn's controller fires after the SDK has already
// torn the channel down. Reusing one client across turns avoids that race and
// keeps the WebSocket warm for high-latency remote targets like the dynamo
// node. The cache lives in the worker subprocess and dies with it; it is not
// shared across worker processes.
const lmStudioClientCache = new Map<string, LMStudioClient>();

function lmStudioCacheKey(baseUrl: string, clientPasskey: string | undefined): string {
	return `${baseUrl}|${clientPasskey ?? ""}`;
}

export async function disposeLmStudioClients(): Promise<void> {
	const clients = Array.from(lmStudioClientCache.values());
	lmStudioClientCache.clear();
	await Promise.all(
		clients.map(async (client) => {
			try {
				await client[Symbol.asyncDispose]();
			} catch {
				// Disposal is best-effort: the worker is already shutting down,
				// and a noisy close should not block process exit.
			}
		}),
	);
}

function getOrCreateLmStudioClient(
	opts: ConstructorParameters<typeof LMStudioClient>[0],
	create: (o: ConstructorParameters<typeof LMStudioClient>[0]) => LmStudioRunClient,
): LmStudioRunClient {
	const baseUrl = opts?.baseUrl ?? "";
	const passkey = opts?.clientPasskey;
	const key = lmStudioCacheKey(baseUrl, passkey);
	const cached = lmStudioClientCache.get(key);
	if (cached) return cached as unknown as LmStudioRunClient;
	const created = create(opts);
	// `created` is the structural LmStudioRunClient view of an LMStudioClient.
	// In production `defaultRunDeps.createClient` returns `new LMStudioClient(...)`,
	// which satisfies the cache value type. Tests inject fakes through the
	// `deps.createClient` parameter and bypass this cache entirely (see
	// `runStream`'s caller-provided-deps branch below).
	lmStudioClientCache.set(key, created as unknown as LMStudioClient);
	return created;
}

const defaultRunDeps: LmStudioRunDeps = {
	createClient: (opts) =>
		getOrCreateLmStudioClient(opts, (o) => new LMStudioClient({ ...(o ?? {}), logger: lmStudioQuietLogger })),
	reconcile: reconcileResidency,
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

export function assistantMessage(content: AssistantMessage["content"], opts?: { harmony?: boolean }): ChatMessageData {
	const parts: AssistantPart[] = [];
	const thinkingParts: string[] = [];
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
		} else if (block.type === "thinking") {
			const thinkingVal = (block as ThinkingContent).thinking;
			if (thinkingVal) {
				thinkingParts.push(thinkingVal);
			}
		}
	}
	if (thinkingParts.length > 0) {
		const joined = thinkingParts.join("\n");
		const harmony = opts?.harmony ?? false;
		parts.unshift({ type: "text", text: formatThinkingForReplay(joined, { harmony }) });
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

async function buildChatHistory(
	client: Pick<LmStudioRunClient, "files">,
	context: Context,
	opts?: { harmony?: boolean },
): Promise<ChatHistoryData> {
	const messages: ChatMessageData[] = [];
	const imageCounter = { next: 0 };
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: [{ type: "text", text: context.systemPrompt }] });
	}
	for (const msg of context.messages) {
		if (msg.role === "user") messages.push(await userMessage(client, msg.content, imageCounter));
		else if (msg.role === "assistant") messages.push(assistantMessage(msg.content, opts));
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
	// explicit `--context-window` override on the target) it is the
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
	const profile = sampling ? (thinkingActive ? (sampling.thinking ?? sampling.instruct) : sampling.instruct) : undefined;
	return mergeSamplingOverride(profile);
}

function thinkingLevelFromHintOrModel(hints: RunStreamHints, model: Model<"lmstudio-native">): ThinkingLevel {
	if (hints.thinkingLevel) return hints.thinkingLevel;
	return model.reasoning === true ? "medium" : "off";
}

const VALID_ENV_KV_CACHE_QUANTS: ReadonlySet<string> = new Set(KV_CACHE_QUANTS);

export function loadModelConfig(model: Model<"lmstudio-native">): LLMLoadModelConfig {
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
		if (kvCache.kQuant !== undefined && kvCache.kQuant !== false) config.llamaKCacheQuantizationType = kvCache.kQuant;
		if (kvCache.vQuant !== undefined && kvCache.vQuant !== false) config.llamaVCacheQuantizationType = kvCache.vQuant;
		if (kvCache.useFp16 !== undefined) config.useFp16ForKVCache = kvCache.useFp16;
	}
	const envKvCacheMode = process.env.CLIO_KV_CACHE_MODE;
	if (envKvCacheMode) {
		if (envKvCacheMode === "f16") {
			config.llamaKCacheQuantizationType = "f16";
			config.llamaVCacheQuantizationType = "f16";
			config.useFp16ForKVCache = true;
		} else if (envKvCacheMode === "f32") {
			config.llamaKCacheQuantizationType = "f32";
			config.llamaVCacheQuantizationType = "f32";
			config.useFp16ForKVCache = false;
		} else if (envKvCacheMode === "none" || envKvCacheMode === "false") {
			delete config.llamaKCacheQuantizationType;
			delete config.llamaVCacheQuantizationType;
			delete config.useFp16ForKVCache;
		} else {
			const quant = asKvCacheQuant(envKvCacheMode);
			if (quant !== undefined && quant !== false && VALID_ENV_KV_CACHE_QUANTS.has(quant)) {
				config.llamaKCacheQuantizationType = quant;
				config.llamaVCacheQuantizationType = quant;
				config.useFp16ForKVCache = false;
			} else {
				process.stderr.write(`clio: ignoring invalid CLIO_KV_CACHE_MODE '${envKvCacheMode}'\n`);
			}
		}
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
	// `predictionDone` flips to true the moment `prediction.result()` resolves
	// successfully, before any post-result work. Once it is set we must not call
	// `controller.abort()` again: the SDK has already closed its channel cleanly,
	// and a late abort raises "Received channelSend for unknown channel" on the
	// LM Studio server. `controllerAborted` collapses repeated abort signals so
	// `controller.abort()` fires at most once.
	let predictionDone = false;
	let controllerAborted = false;
	const abortControllerOnce = () => {
		if (controllerAborted) return;
		controllerAborted = true;
		controller.abort();
	};
	const onAbort = () => {
		aborted = true;
		if (predictionDone) return;
		abortControllerOnce();
	};
	if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
	else if (aborted) abortControllerOnce();
	(async () => {
		try {
			if (aborted) throw new Error("Request was aborted");
			const baseUrl = normalizeBaseUrl(model.baseUrl);
			const clientOpts: ConstructorParameters<typeof LMStudioClient>[0] = { baseUrl };
			const passkey = options?.apiKey;
			if (passkey) clientOpts.clientPasskey = passkey;
			const client = deps.createClient(clientOpts);
			const metadata = runtimeMetadata(model);
			const verbose = process.env.CLIO_RUNTIME_VERBOSE === "1";
			const loadedContextWindow = await deps.discoverLoadedContext(baseUrl, model.id, controller.signal);
			const budgetLimits = loadedContextWindow !== undefined ? { contextWindow: loadedContextWindow } : undefined;
			const requestedMaxTokens = remainingContextMaxTokens(model, context, options, budgetLimits);
			const loadConfig = loadModelConfig(model);
			const requestedLoadContext = loadConfig.contextLength ?? model.contextWindow;
			// One reconciler decides LM Studio load and evict for both the
			// interactive and headless paths. It releases Clio-loaded stragglers,
			// backs off to observe-only on a foreign-loaded model, and declines up
			// front when it already knows the model will not fit. `loadedEntries`
			// captures the SDK handles so eviction reuses one listLoaded round-trip.
			let loadedEntries: ReadonlyArray<ResidentModelEntry> = [];
			const plan = await deps.reconcile({
				targetKey: `lmstudio-native|${baseUrl}`,
				targetId: metadata.targetId,
				runtimeId: "lmstudio-native",
				keepModelId: model.id,
				managed: residencyManaged(),
				contextLength: requestedLoadContext,
				...(model.contextWindow > 0 ? { modelMaxContext: model.contextWindow } : {}),
				listResident: async () => {
					loadedEntries = await client.llm.listLoaded();
					return loadedEntries.map((entry) => ({ modelId: entry.modelKey }));
				},
				unload: async (id) => {
					await loadedEntries.find((entry) => entry.modelKey === id)?.unload();
				},
			});
			if (plan.decision === "decline") {
				// A known VRAM miss fails with the reconciler's notice content rather
				// than a bare SDK error; the reconciler already emitted the notice.
				const reason = plan.notices.find((n) => n.kind === "will-not-fit")?.message;
				throw new Error(
					reason ?? describeLoadFailure(baseUrl, model, loadConfig, requestedMaxTokens, "VRAM fit check failed"),
				);
			}
			// Skip passing `config` to client.llm.model when the model is already
			// resident, or when Clio is observing a foreign/opt-out server. LM Studio
			// can report residency through listLoaded while the REST model metadata
			// still omits context length; passing config in that state triggers a
			// no-progress reload wait in the SDK.
			const observeOnly = plan.decision === "observe";
			const residentModelLoaded = plan.keepResident;
			const loadedUnknownContext = residentModelLoaded && loadedContextWindow === undefined;
			const loadedWithEnoughContext = loadedContextWindow !== undefined && loadedContextWindow >= requestedLoadContext;
			const modelOpenConfig = observeOnly || loadedUnknownContext || loadedWithEnoughContext ? undefined : loadConfig;
			const modelOpenOpts: { signal: AbortSignal; verbose: boolean; config?: LLMLoadModelConfig } = {
				signal: controller.signal,
				verbose,
			};
			if (modelOpenConfig !== undefined) modelOpenOpts.config = modelOpenConfig;
			let llm: LmStudioPredictionHandle;
			try {
				llm = await client.llm.model(model.id, modelOpenOpts);
			} catch (err) {
				const message = describeLoadFailure(baseUrl, model, modelOpenConfig, requestedMaxTokens, err);
				// gpuStrictVramCap turns an oversized load into a failure; surface it
				// as a will-not-fit notice so it reads like every other VRAM miss.
				emitResidencyNotice({
					kind: "will-not-fit",
					level: "error",
					targetId: metadata.targetId,
					runtimeId: "lmstudio-native",
					model: model.id,
					message,
				});
				throw new Error(message);
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
			const sentinelStripper = createSentinelStripper();
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
			const pushSafeText = (safe: string) => {
				if (!safe) return;
				closeActiveThinking();
				let current = activeTextRef.block;
				if (!current) {
					current = { type: "text", text: "" };
					output.content.push(current);
					activeTextRef.block = current;
					activeTextRef.idx = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex: activeTextRef.idx, partial: output });
				}
				current.text += safe;
				stream.push({
					type: "text_delta",
					contentIndex: activeTextRef.idx,
					delta: safe,
					partial: output,
				});
			};
			const flushTextSentinelBuffer = () => {
				const tail = sentinelStripper.flush();
				if (tail) pushSafeText(tail);
			};
			const emitText = (chunk: string) => {
				if (!chunk) return;
				const safe = sentinelStripper.push(chunk);
				pushSafeText(safe);
			};
			const closeActiveText = () => {
				// Drain any sentinel-prefix bytes the streaming stripper held
				// back across the last delta. The buffered tail can never grow
				// past `MAX_SENTINEL_LEN - 1` characters and only contains
				// matter that turned out not to be a sentinel; emitting it now
				// keeps the visible block whole without leaking sentinels.
				flushTextSentinelBuffer();
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
				reasoningTokensAccum += tokensHint ?? ceilChars(chunk.length);
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
			const responseParser = resolveModelRuntimeCapabilitiesForModel(model, thinkingLevelFromHintOrModel(hints, model))
				.response.parser;
			const harmonyParser = responseParser === "harmony" ? new HarmonyResponseParser() : null;
			const flushGemmaPending = () => {
				if (gemmaPending.length === 0) return;
				if (gemmaState === "thought") emitThinking(gemmaPending);
				else if (gemmaState === "idle" && !GEMMA_BARE_THOUGHT_ONLY_RE.test(gemmaPending)) emitText(gemmaPending);
				gemmaPending = "";
			};
			const flushNonReasoningPending = () => {
				if (harmonyParser) {
					const parsed = harmonyParser.flush();
					emitThinking(parsed.thinking);
					emitText(parsed.text);
					return;
				}
				flushGemmaPending();
			};
			const routeNonReasoningChunk = (chunk: string) => {
				if (harmonyParser) {
					const parsed = harmonyParser.push(chunk);
					emitThinking(parsed.thinking);
					emitText(parsed.text);
					return;
				}
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
						flushNonReasoningPending();
						reasoningTokensAccum += fragment.tokensCount ?? 0;
						emitThinking(fragment.content, 0);
						return;
					}
					routeNonReasoningChunk(fragment.content);
				},
				onToolCallRequestStart: (callId) => {
					flushNonReasoningPending();
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
			// chosen by thinking activity, derived through the central resolver so
			// the sampler choice matches the actual surface the model exposes
			// (effort-levels, budget-tokens, on-off, always-on, none). The bare
			// `stream` path leaves `hints.thinkingLevel` unset and falls back to
			// medium when the model advertises reasoning.
			const requestedThinkingLevel = thinkingLevelFromHintOrModel(hints, model);
			const resolved = resolveModelRuntimeCapabilitiesForModel(model, requestedThinkingLevel);
			const applied = resolved.thinking;
			// The LM Studio SDK has no separate thinking-budget channel; the budget
			// from `applied.budgetTokens` is informational only here and surfaces
			// through the prompt Runtime block. `maxPredictedTokens` stays driven
			// by the remaining-context budget so a budget-tokens family does not
			// unexpectedly truncate output.
			const samplingProfile = pickSamplingProfile(resolved.quirks ?? clioQuirks(model), applied.thinkingActive);
			if (samplingProfile) {
				if (samplingProfile.temperature !== undefined) predictionOpts.temperature = samplingProfile.temperature;
				if (samplingProfile.topP !== undefined) predictionOpts.topPSampling = samplingProfile.topP;
				if (samplingProfile.topK !== undefined) predictionOpts.topKSampling = samplingProfile.topK;
				if (samplingProfile.minP !== undefined) predictionOpts.minPSampling = samplingProfile.minP;
				if (samplingProfile.repeatPenalty !== undefined) predictionOpts.repeatPenalty = samplingProfile.repeatPenalty;
			}
			if (options?.temperature !== undefined) predictionOpts.temperature = options.temperature;
			const harmony = resolved.response.parser === "harmony";
			const history = await buildChatHistory(client, context, { harmony });
			if (aborted) throw new Error("Request was aborted");
			const prediction = llm.respond(history, predictionOpts);
			const result = await prediction.result();
			// The SDK has now closed its prediction channel cleanly. Block any
			// future `onAbort` from racing a second `controller.abort()` against
			// that closed channel; the post-result `if (aborted) throw` below
			// still surfaces a late user-driven abort to the caller.
			predictionDone = true;
			flushNonReasoningPending();
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
