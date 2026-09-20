import { randomUUID } from "node:crypto";
import type {
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
import type {
	ChatRequest,
	Message as OllamaMessage,
	Options as OllamaOptions,
	Tool as OllamaTool,
	ToolCall as OllamaToolCall,
} from "ollama";
import { residencyTargetKey } from "../../core/residency-target-key.js";
import {
	type AppliedThinking,
	resolveModelRuntimeCapabilitiesForModel,
	type ThinkingLevel,
} from "../../domains/providers/index.js";
import { ollamaModelIds } from "../../domains/providers/runtimes/common/ollama-model-ids.js";
import type { LocalModelQuirks, SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";
import { calculateEngineCost } from "../ai.js";
import { resolvedRequestContext } from "../context.js";
import { createGemmaChannelFilter, usesGemmaChannelMarkers } from "../gemma-channel-filter.js";
import { createSentinelStripper } from "../strip-tokenizer-sentinels.js";
import { createDegradedInferenceStream } from "./degraded-inference.js";
import { ollamaJson, streamOllamaChat } from "./ollama-http.js";
import { remainingContextMaxTokens } from "./output-budget.js";
import {
	EXIT_RELEASE_MS,
	forgetReleasedModel,
	isClioLoaded,
	markClioLoaded,
	type ReleaseScope,
	type ResidencyAdapter,
	reconcileResidency,
	registerExitRelease,
	registerWorkerLoadAdopter,
	reportClioModelLoad,
	residencyManagedFor,
} from "./residency.js";
import { type ResidentModelInfo, residentMatchesKeep } from "./resident-models.js";
import { pickSamplingProfile, samplingParamsFromProfile } from "./sampling-overrides.js";
import type { EngineApiProvider } from "./types.js";

const REASONING_CHARS_PER_TOKEN = 4;
const ownedModelsByTarget = new Map<string, Set<string>>();
/** How to reach each target that holds an owned model, for the release on exit. */
const ownedEndpointsByTarget = new Map<string, { baseUrl: string; headers: Record<string, string> }>();

interface ClioRuntimeMetadata {
	clioCoder?: {
		targetId: string;
		runtimeId: string;
		/** Present only when settings set the target lifecycle explicitly. */
		lifecycle?: "user-managed" | "clio-coder-managed";
		gateway?: boolean;
		family?: string;
		quirks?: LocalModelQuirks;
		ollama?: { numCtx?: number };
	};
}

function clioQuirks(model: Model<"ollama-native">): LocalModelQuirks | undefined {
	return (model as Model<"ollama-native"> & ClioRuntimeMetadata).clioCoder?.quirks;
}

function ollamaTargetId(model: Model<"ollama-native">): string {
	return (model as Model<"ollama-native"> & ClioRuntimeMetadata).clioCoder?.targetId ?? model.provider;
}

/**
 * Reconcile Ollama residency before a turn streams. Both the interactive and
 * headless paths reach here through runStream, so this is the single place
 * that decides Ollama residency. Ollama schedules loads and fits itself, so
 * co-resident and operator-loaded models stay; the reconciler only releases
 * Clio's own unprotected stragglers, which Clio pinned with `keep_alive: -1`
 * and nothing else ever reclaims. Best-effort: a failure never blocks the
 * turn.
 */
async function reconcileOllamaResidency(
	model: Model<"ollama-native">,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<boolean> {
	const baseUrl = model.baseUrl;
	if (!baseUrl) return false;
	const metadata = (model as Model<"ollama-native"> & ClioRuntimeMetadata).clioCoder;
	if (!residencyManagedFor(metadata?.lifecycle)) return false;
	let resident: ResidentModelInfo[] = [];
	const adapter: ResidencyAdapter = {
		targetKey: residencyTargetKey("ollama", baseUrl),
		targetId: ollamaTargetId(model),
		runtimeId: "ollama",
		keepModelId: model.id,
		managed: true,
		strategy: "scheduler",
		...(signal ? { signal } : {}),
		listResident: async () => (resident = await listResidentOllamaModels(baseUrl, headers, signal)),
		unload: (id) =>
			unloadOllamaModel(baseUrl, resident.find((entry) => entry.modelId === id) ?? { modelId: id }, headers, signal),
	};
	try {
		const plan = await reconcileResidency(adapter);
		const keep = resident.find((entry) => residentMatchesKeep(entry, model.id));
		const ids = ollamaModelIds(model.id, ...(keep ? [keep.modelId, ...(keep.aliasIds ?? [])] : []));
		return (
			plan.decision === "reconcile" &&
			(!plan.keepResident || ids.some((id) => ownedModelsByTarget.get(adapter.targetKey)?.has(id)))
		);
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

function applyOllamaSamplingProfile(opts: Partial<OllamaOptions>, profile: SamplingProfile): void {
	if (profile.temperature !== undefined && opts.temperature === undefined) opts.temperature = profile.temperature;
	Object.assign(opts, { ...samplingParamsFromProfile(profile, "ollama"), ...opts });
}

function isOllamaEffort(value: string | undefined): value is "low" | "medium" | "high" {
	return value === "low" || value === "medium" || value === "high";
}

function ollamaThinkValue(applied: AppliedThinking): ChatRequest["think"] | undefined {
	if (applied.mechanism === "always-on") return undefined;
	if (applied.mechanism === "none") return applied.thinkingActive;
	if (applied.mechanism === "effort-levels") {
		if (!applied.thinkingActive) return false;
		return isOllamaEffort(applied.effort) ? applied.effort : true;
	}
	return applied.thinkingActive;
}

function fallbackThinkingLevel(model: Model<"ollama-native">): ThinkingLevel {
	return model.reasoning === true ? "medium" : "off";
}

function thinkingLevelFromSimple(options: SimpleStreamOptions | undefined): ThinkingLevel {
	const reasoning = options?.reasoning;
	if (reasoning === undefined) return "off";
	return reasoning as ThinkingLevel;
}

function toolToOllama(tool: Tool): OllamaTool {
	const fn: OllamaTool["function"] = {
		name: tool.name,
		parameters: tool.parameters as NonNullable<OllamaTool["function"]["parameters"]>,
	};
	if (tool.description) fn.description = tool.description;
	return { type: "function", function: fn };
}

function userToOllama(content: string | (TextContent | ImageContent)[]): OllamaMessage {
	if (typeof content === "string") return { role: "user", content };
	const textParts: string[] = [];
	const images: string[] = [];
	for (const block of content) {
		if (block.type === "text") textParts.push(block.text);
		else if (block.type === "image") images.push(block.data);
	}
	const out: OllamaMessage = { role: "user", content: textParts.join("\n") };
	if (images.length > 0) out.images = images;
	return out;
}

function assistantToOllama(content: AssistantMessage["content"]): OllamaMessage {
	const textParts: string[] = [];
	const toolCalls: OllamaToolCall[] = [];
	const thinkingParts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "toolCall") {
			toolCalls.push({ function: { name: block.name, arguments: block.arguments } });
		} else if (block.type === "thinking") {
			const thinkingVal = (block as ThinkingContent).thinking;
			if (thinkingVal) {
				thinkingParts.push(thinkingVal);
			}
		}
	}
	const out: OllamaMessage = { role: "assistant", content: textParts.join("\n") };
	if (toolCalls.length > 0) out.tool_calls = toolCalls;
	if (thinkingParts.length > 0) {
		out.thinking = thinkingParts.join("\n");
	}
	return out;
}

function translateMessage(msg: Message): OllamaMessage | null {
	if (msg.role === "user") return userToOllama(msg.content);
	if (msg.role === "assistant") return assistantToOllama(msg.content);
	if (msg.role === "toolResult") {
		const text = msg.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		return { role: "tool", content: text, tool_name: msg.toolName };
	}
	return null;
}

function buildMessages(context: Context): OllamaMessage[] {
	const messages: OllamaMessage[] = [];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: context.systemPrompt });
	}
	for (const msg of context.messages) {
		const translated = translateMessage(msg);
		if (translated) messages.push(translated);
	}
	return messages;
}

function buildRequest(
	model: Model<"ollama-native">,
	context: Context,
	options: StreamOptions | undefined,
	thinkingLevel: ThinkingLevel,
	pin: boolean,
): ChatRequest & { stream: true } {
	const req: ChatRequest & { stream: true } = {
		model: model.id,
		messages: buildMessages(context),
		stream: true,
		// Only pin loads we can own and release. Otherwise use the server's policy.
		...(pin ? { keep_alive: -1 } : {}),
	};
	if (context.tools && context.tools.length > 0) req.tools = context.tools.map(toolToOllama);
	const opts: Partial<OllamaOptions> = {};
	const resolved = resolveModelRuntimeCapabilitiesForModel(model, thinkingLevel);
	const applied = resolved.thinking;
	const think = ollamaThinkValue(applied);
	if (think !== undefined) req.think = think;
	const samplingProfile = pickSamplingProfile(resolved.quirks ?? clioQuirks(model), applied.thinkingActive);
	if (samplingProfile) applyOllamaSamplingProfile(opts, samplingProfile);
	if (options?.temperature !== undefined) opts.temperature = options.temperature;
	opts.num_predict = remainingContextMaxTokens(model, context, options);
	// Sent only when the operator configured it: a `num_ctx` that differs from
	// the loaded one makes Ollama reload the model, which on a shared server
	// evicts whatever window another client opened it at.
	const numCtx = (model as Model<"ollama-native"> & ClioRuntimeMetadata).clioCoder?.ollama?.numCtx;
	if (numCtx !== undefined) opts.num_ctx = numCtx;
	if (Object.keys(opts).length > 0) req.options = opts;
	return req;
}

export interface EvictResidentEntry {
	readonly model: string;
	readonly name: string;
	/** GPU-resident bytes, when Ollama reports it on `/api/ps`. */
	readonly size_vram?: number;
	/** Total resident bytes (GPU + host), when reported. */
	readonly size?: number;
}

export interface EvictResidentResponse {
	readonly models: ReadonlyArray<EvictResidentEntry>;
}

/**
 * Map an Ollama `/api/ps` response to the runtime-agnostic resident shape,
 * preserving the GPU/total footprint when the server reports it.
 */
async function listResidentOllamaModels(
	baseUrl: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
): Promise<ResidentModelInfo[]> {
	const resident = await ollamaJson<EvictResidentResponse>(baseUrl, "ps", undefined, { headers, signal });
	return resident.models.map((entry) => {
		const primary = entry.model || entry.name;
		if (typeof primary !== "string" || !primary.trim()) throw new Error("Ollama returned an invalid resident model");
		// Ollama reports both `model` and `name`; keep the other one as an alias so
		// a keep target that matches either field is never evicted.
		const aliases = ollamaModelIds(
			...[entry.model, entry.name].filter((id): id is string => typeof id === "string" && id.length > 0),
		).filter((id) => id !== primary);
		const info: ResidentModelInfo = { modelId: primary };
		if (aliases.length > 0) info.aliasIds = aliases;
		if (typeof entry.size_vram === "number") info.sizeVramBytes = entry.size_vram;
		if (typeof entry.size === "number") info.sizeBytes = entry.size;
		return info;
	});
}

/**
 * Release one resident model. Ollama pins the active model with
 * `keep_alive: -1`, so eviction fires `keep_alive: 0` against it to let its
 * weights release.
 */
async function unloadOllamaModel(
	baseUrl: string,
	entry: ResidentModelInfo,
	headers?: Record<string, string>,
	signal?: AbortSignal,
): Promise<void> {
	const targetKey = residencyTargetKey("ollama", baseUrl);
	const owned = ownedModelsByTarget.get(targetKey);
	const ids = [entry.modelId, ...(entry.aliasIds ?? [])];
	if (!ids.some((id) => owned?.has(id))) throw new Error("Ollama model ownership is unknown");
	await ollamaJson(
		baseUrl,
		"generate",
		{ model: entry.modelId, prompt: "", keep_alive: 0, stream: false },
		{ headers, signal },
	);
	for (const id of ids) {
		owned?.delete(id);
		forgetReleasedModel(targetKey, id);
	}
}

/**
 * Release on process exit every Ollama model this process loaded and pinned
 * with `keep_alive: -1`, so a finished run does not hold its weights forever
 * (#379). A model counts as this process's own only when both registries agree:
 * the residency reconciler saw it absent from the server before Clio's request
 * and marked it Clio-loaded, and a chat for it then streamed, which is what
 * pinned it. A model that was already resident when Clio first touched it, or
 * one whose load never produced a response, is left alone, so an operator's
 * model is never unloaded (#313). The resident list is read first, and only
 * models still resident are released, so a model Ollama already dropped is
 * not loaded again just to be unloaded. A `scope` narrows the release further,
 * which is how a one-shot probe releases only what it loaded.
 *
 * Best-effort and bounded: every request shares one deadline, and a failure
 * or timeout leaves the model pinned and never throws. A crashed process
 * releases nothing.
 */
export async function releaseClioLoadedOllamaModels(
	options: { timeoutMs?: number; scope?: ReleaseScope } = {},
): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? EXIT_RELEASE_MS);
	timer.unref();
	const releaseTarget = async (targetKey: string, owned: Set<string>): Promise<void> => {
		const endpoint = ownedEndpointsByTarget.get(targetKey);
		if (!endpoint || owned.size === 0) return;
		const resident = await listResidentOllamaModels(endpoint.baseUrl, endpoint.headers, controller.signal);
		for (const entry of resident) {
			const ids = [entry.modelId, ...(entry.aliasIds ?? [])];
			if (!ids.some((id) => owned.has(id)) || !isClioLoaded(targetKey, entry)) continue;
			if (options.scope && !options.scope(targetKey, ids)) continue;
			await unloadOllamaModel(endpoint.baseUrl, entry, endpoint.headers, controller.signal);
		}
	};
	const releases = [...ownedModelsByTarget].map(([targetKey, owned]) =>
		releaseTarget(targetKey, owned).catch(() => {
			// Best-effort: an unreachable server keeps the model pinned.
		}),
	);
	try {
		await Promise.race([
			Promise.all(releases),
			new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true })),
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

registerExitRelease((scope) => releaseClioLoadedOllamaModels(scope ? { scope } : {}));

// A dispatched worker's load becomes this process's to release (#379). The
// endpoint comes from this process's own settings for the admitted target.
registerWorkerLoadAdopter("ollama", (targetKey, endpoint, modelIds) => {
	let owned = ownedModelsByTarget.get(targetKey);
	if (!owned) {
		owned = new Set<string>();
		ownedModelsByTarget.set(targetKey, owned);
	}
	for (const id of modelIds) owned.add(id);
	ownedEndpointsByTarget.set(targetKey, { baseUrl: endpoint.baseUrl, headers: endpoint.headers });
});

function mapStopReason(reason: string | undefined, hadToolCall: boolean): AssistantMessage["stopReason"] {
	if (hadToolCall) return "toolUse";
	if (reason === "length") return "length";
	return "stop";
}

function asDoneReason(
	reason: AssistantMessage["stopReason"],
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
	if (reason === "length" || reason === "toolUse") return reason;
	return "stop";
}

function emitToolCall(raw: OllamaToolCall, output: AssistantMessage, stream: AssistantMessageEventStream): void {
	const args =
		raw.function?.arguments && typeof raw.function.arguments === "object"
			? (raw.function.arguments as Record<string, unknown>)
			: {};
	const toolCall: ToolCall = {
		type: "toolCall",
		id: randomUUID(),
		name: raw.function?.name ?? "",
		arguments: args as ToolCall["arguments"],
	};
	output.content.push(toolCall);
	const idx = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex: idx,
		delta: JSON.stringify(toolCall.arguments),
		partial: output,
	});
	stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
}

function runStream(
	model: Model<"ollama-native">,
	context: Context,
	options: StreamOptions | undefined,
	thinkingLevel: ThinkingLevel,
): AssistantMessageEventStream {
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
	const requestHeaders = new Headers(model.headers);
	for (const [name, value] of Object.entries(options?.headers ?? {})) {
		if (value === null) requestHeaders.delete(name);
		else if (value !== undefined) requestHeaders.set(name, value);
	}
	if (options?.apiKey && !requestHeaders.has("authorization")) {
		requestHeaders.set("authorization", `Bearer ${options.apiKey}`);
	}
	const headers = Object.fromEntries(requestHeaders);
	const signal = options?.signal;
	const baseUrl = model.baseUrl;
	// Events go straight into the watched stream, so this function's own catch
	// still decides how a failed turn ends.
	const stream = createDegradedInferenceStream({
		targetId: ollamaTargetId(model),
		runtimeId: "ollama",
		model: model.id,
		...(signal ? { signal } : {}),
		...(baseUrl ? { listResident: () => listResidentOllamaModels(baseUrl, headers, signal) } : {}),
	});
	(async () => {
		try {
			signal?.throwIfAborted();
			const pin = await reconcileOllamaResidency(model, headers, signal);
			signal?.throwIfAborted();
			const iterator = streamOllamaChat(model.baseUrl, buildRequest(model, context, options, thinkingLevel, pin), {
				headers,
				signal,
				fetch: options?.fetch,
			});
			let active: TextContent | null = null;
			let activeIdx = -1;
			let activeThinking: ThinkingContent | null = null;
			let activeThinkingIdx = -1;
			let reasoningChars = 0;
			let hadToolCall = false;
			let doneReason: string | undefined;
			const sentinelStripper = createSentinelStripper();
			const resolved = resolveModelRuntimeCapabilitiesForModel(model, thinkingLevel);
			const channelFilter = usesGemmaChannelMarkers(resolved.modelId) ? createGemmaChannelFilter() : null;
			const closeActiveThinking = () => {
				if (!activeThinking) return;
				stream.push({
					type: "thinking_end",
					contentIndex: activeThinkingIdx,
					content: activeThinking.thinking,
					partial: output,
				});
				activeThinking = null;
				activeThinkingIdx = -1;
			};
			const pushSafeText = (safe: string) => {
				if (!safe) return;
				closeActiveThinking();
				if (!active) {
					active = { type: "text", text: "" };
					output.content.push(active);
					activeIdx = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex: activeIdx, partial: output });
				}
				active.text += safe;
				stream.push({
					type: "text_delta",
					contentIndex: activeIdx,
					delta: safe,
					partial: output,
				});
			};
			const emitText = (content: string) => {
				if (!content) return;
				const safe = sentinelStripper.push(content);
				pushSafeText(safe);
			};
			const closeActiveText = () => {
				// Drain any sentinel-prefix bytes the streaming stripper held
				// back across the last delta before closing the text block.
				const tail = sentinelStripper.flush();
				if (tail) pushSafeText(tail);
				if (!active) return;
				stream.push({
					type: "text_end",
					contentIndex: activeIdx,
					content: active.text,
					partial: output,
				});
				active = null;
				activeIdx = -1;
			};
			const emitThinking = (content: string) => {
				closeActiveText();
				if (!activeThinking) {
					activeThinking = { type: "thinking", thinking: "" };
					output.content.push(activeThinking);
					activeThinkingIdx = output.content.length - 1;
					stream.push({ type: "thinking_start", contentIndex: activeThinkingIdx, partial: output });
				}
				activeThinking.thinking += content;
				reasoningChars += content.length;
				stream.push({
					type: "thinking_delta",
					contentIndex: activeThinkingIdx,
					delta: content,
					partial: output,
				});
			};
			const routeText = (content: string) => {
				if (!channelFilter) {
					emitText(content);
					return;
				}
				for (const segment of channelFilter.push(content)) {
					if (segment.kind === "thinking") emitThinking(segment.content);
					else emitText(segment.content);
				}
			};
			const flushChannel = () => {
				for (const segment of channelFilter?.flush() ?? []) {
					if (segment.kind === "thinking") emitThinking(segment.content);
					else emitText(segment.content);
				}
			};
			let recordedOwnership = false;
			let started = false;
			for await (const response of iterator) {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}
				if (pin && !recordedOwnership && model.baseUrl) {
					const targetKey = residencyTargetKey("ollama", model.baseUrl);
					let owned = ownedModelsByTarget.get(targetKey);
					if (!owned) {
						owned = new Set<string>();
						ownedModelsByTarget.set(targetKey, owned);
					}
					const loadedId = response.model || model.id;
					const firstRecord = !owned.has(loadedId);
					for (const id of ollamaModelIds(model.id, loadedId)) {
						owned.add(id);
						markClioLoaded(targetKey, id);
					}
					ownedEndpointsByTarget.set(targetKey, { baseUrl: model.baseUrl, headers });
					recordedOwnership = true;
					// In a dispatched worker this hands the load to the orchestrator,
					// which owns its release (#379). Elsewhere no sink is installed.
					if (firstRecord) {
						reportClioModelLoad(
							{
								runtimeId: "ollama",
								targetId: ollamaTargetId(model),
								modelId: model.id,
								aliasIds: loadedId === model.id ? [] : [loadedId],
							},
							targetKey,
						);
					}
				}
				const msg = response.message;
				if (msg?.thinking && msg.thinking.length > 0) {
					emitThinking(msg.thinking);
				}
				if (msg?.content && msg.content.length > 0) {
					routeText(msg.content);
				}
				if (msg?.tool_calls && msg.tool_calls.length > 0) {
					flushChannel();
					closeActiveText();
					closeActiveThinking();
					for (const raw of msg.tool_calls) emitToolCall(raw, output, stream);
					hadToolCall = true;
				}
				if (response.done) {
					flushChannel();
					closeActiveText();
					closeActiveThinking();
					output.usage.input = response.prompt_eval_count ?? 0;
					output.usage.output = response.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
					if (reasoningChars > 0) {
						(output.usage as Usage & { reasoningTokens?: number }).reasoningTokens = Math.max(
							1,
							Math.round(reasoningChars / REASONING_CHARS_PER_TOKEN),
						);
					}
					calculateEngineCost(model, output.usage);
					doneReason = response.done_reason;
				}
			}
			signal?.throwIfAborted();
			output.stopReason = mapStopReason(doneReason, hadToolCall);
			stream.push({ type: "done", reason: asDoneReason(output.stopReason), message: output });
			stream.end();
		} catch (err) {
			output.stopReason = signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

function stripReasoning(options: SimpleStreamOptions | undefined): StreamOptions | undefined {
	if (!options) return undefined;
	const { reasoning: _r, thinkingBudgets: _b, ...rest } = options;
	return rest;
}

export const ollamaNativeApiProvider: EngineApiProvider<"ollama-native"> = {
	api: "ollama-native",
	stream: (model, context, options) =>
		runStream(model, resolvedRequestContext(context), options, fallbackThinkingLevel(model)),
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		runStream(model, resolvedRequestContext(context), stripReasoning(options), thinkingLevelFromSimple(options)),
};
