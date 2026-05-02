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
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { calculateEngineCost, parseEngineJsonWithRepair, parseEngineStreamingJson } from "../ai.js";
import { remainingContextMaxTokens } from "./output-budget.js";

const EMPTY_TOOL_ARGUMENTS_ERROR =
	"LM Studio SDK returned empty tool-call arguments; this model's chat template may not be compatible. Try the openai-compat runtime against the same gateway.";

type RuntimeLifecycle = "user-managed" | "clio-managed";

interface ClioRuntimeMetadata {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: RuntimeLifecycle;
		gateway?: boolean;
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
): Promise<void> {
	if (options.lifecycle !== "clio-managed") return;
	const cached = residentCache.get(baseUrl);
	if (cached && cached.modelId === modelId && now() - cached.at < RESIDENT_TTL_MS) return;
	let loaded: ReadonlyArray<ResidentModelEntry>;
	try {
		loaded = await client.llm.listLoaded();
	} catch {
		return;
	}
	const stale = loaded.filter((entry) => entry.modelKey !== modelId);
	if (stale.length > 0) {
		await Promise.all(stale.map((entry) => entry.unload().catch(() => undefined)));
	}
	residentCache.set(baseUrl, { modelId, at: now() });
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
	): Promise<void>;
	discoverLoadedContext(baseUrl: string, modelId: string, signal: AbortSignal): Promise<number | undefined>;
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
	const requestedOutput = model.maxTokens > 0 ? model.maxTokens : MIN_AUTOMATIC_LOAD_CONTEXT;
	const target = Math.max(MIN_AUTOMATIC_LOAD_CONTEXT, requestedOutput * 2);
	const modelLimit = model.contextWindow > 0 ? model.contextWindow : target;
	return Math.min(modelLimit, target, MAX_AUTOMATIC_LOAD_CONTEXT);
}

function loadModelConfig(model: Model<"lmstudio-native">): LLMLoadModelConfig {
	return {
		contextLength: automaticLoadContextLength(model),
		flashAttention: true,
		gpu: { ratio: "max" },
		gpuStrictVramCap: true,
		offloadKVCacheToGpu: true,
	};
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

function runtimeMetadata(model: Model<Api>): Required<NonNullable<ClioRuntimeMetadata["clio"]>> {
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
			await deps.ensureResident(client, baseUrl, model.id, { lifecycle: metadata.lifecycle });
			const verbose = process.env.CLIO_RUNTIME_VERBOSE === "1";
			const loadedContextWindow = await deps.discoverLoadedContext(baseUrl, model.id, controller.signal);
			const budgetLimits = loadedContextWindow !== undefined ? { contextWindow: loadedContextWindow } : undefined;
			const requestedMaxTokens = remainingContextMaxTokens(model, context, options, budgetLimits);
			const loadConfig = loadModelConfig(model);
			const modelOpenConfig =
				metadata.lifecycle === "user-managed" && loadedContextWindow !== undefined ? undefined : loadConfig;
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
						return;
					}
					if (fragment.reasoningType === "reasoning") {
						closeActiveText();
						let current = activeThinkingRef.block;
						if (!current) {
							current = { type: "thinking", thinking: "" };
							output.content.push(current);
							activeThinkingRef.block = current;
							activeThinkingRef.idx = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: activeThinkingRef.idx, partial: output });
						}
						current.thinking += fragment.content;
						stream.push({
							type: "thinking_delta",
							contentIndex: activeThinkingRef.idx,
							delta: fragment.content,
							partial: output,
						});
						return;
					}
					closeActiveThinking();
					let current = activeTextRef.block;
					if (!current) {
						current = { type: "text", text: "" };
						output.content.push(current);
						activeTextRef.block = current;
						activeTextRef.idx = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: activeTextRef.idx, partial: output });
					}
					current.text += fragment.content;
					stream.push({
						type: "text_delta",
						contentIndex: activeTextRef.idx,
						delta: fragment.content,
						partial: output,
					});
				},
				onToolCallRequestStart: (callId) => {
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
			if (options?.temperature !== undefined) predictionOpts.temperature = options.temperature;
			const history = await buildChatHistory(client, context);
			if (aborted) throw new Error("Request was aborted");
			const prediction = llm.respond(history, predictionOpts);
			const result = await prediction.result();
			closeActiveText();
			closeActiveThinking();
			if (aborted) throw new Error("Request was aborted");
			if (toolExtractionError) throw toolExtractionError;
			output.usage.input = result.stats.promptTokensCount ?? 0;
			output.usage.output = result.stats.predictedTokensCount ?? 0;
			output.usage.totalTokens = result.stats.totalTokensCount ?? output.usage.input + output.usage.output;
			calculateEngineCost(model, output.usage);
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

export const lmstudioNativeApiProvider: ApiProvider<"lmstudio-native"> = {
	api: "lmstudio-native",
	stream: (model, context, options) => runStream(model, context, options),
	streamSimple: (model, context, options?: SimpleStreamOptions) => runStream(model, context, stripReasoning(options)),
};
