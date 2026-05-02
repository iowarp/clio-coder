import { randomUUID } from "node:crypto";
import type {
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
import {
	type ChatRequest,
	type ChatResponse,
	Ollama,
	type Message as OllamaMessage,
	type Options as OllamaOptions,
	type Tool as OllamaTool,
	type ToolCall as OllamaToolCall,
} from "ollama";
import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import type { LocalModelQuirks, SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";
import { calculateEngineCost } from "../ai.js";
import { remainingContextMaxTokens } from "./output-budget.js";
import { type AppliedThinking, applyThinkingMechanism } from "./thinking-mechanism.js";

const REASONING_CHARS_PER_TOKEN = 4;

interface ClioRuntimeMetadata {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: "user-managed" | "clio-managed";
		gateway?: boolean;
		quirks?: LocalModelQuirks;
	};
}

function clioQuirks(model: Model<"ollama-native">): LocalModelQuirks | undefined {
	return (model as Model<"ollama-native"> & ClioRuntimeMetadata).clio?.quirks;
}

function pickSamplingProfile(
	quirks: LocalModelQuirks | undefined,
	thinkingActive: boolean,
): SamplingProfile | undefined {
	const sampling = quirks?.sampling;
	if (!sampling) return undefined;
	return thinkingActive ? sampling.thinking : sampling.instruct;
}

function applyOllamaSamplingProfile(opts: Partial<OllamaOptions>, profile: SamplingProfile): void {
	if (profile.temperature !== undefined && opts.temperature === undefined) opts.temperature = profile.temperature;
	if (profile.topP !== undefined && opts.top_p === undefined) opts.top_p = profile.topP;
	if (profile.topK !== undefined && opts.top_k === undefined) opts.top_k = profile.topK;
	if (profile.repeatPenalty !== undefined && opts.repeat_penalty === undefined)
		opts.repeat_penalty = profile.repeatPenalty;
	if (profile.presencePenalty !== undefined && opts.presence_penalty === undefined)
		opts.presence_penalty = profile.presencePenalty;
	if (profile.frequencyPenalty !== undefined && opts.frequency_penalty === undefined)
		opts.frequency_penalty = profile.frequencyPenalty;
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
	for (const block of content) {
		if (block.type === "text") textParts.push(block.text);
		else if (block.type === "toolCall") {
			toolCalls.push({ function: { name: block.name, arguments: block.arguments } });
		}
	}
	const out: OllamaMessage = { role: "assistant", content: textParts.join("\n") };
	if (toolCalls.length > 0) out.tool_calls = toolCalls;
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
): ChatRequest & { stream: true } {
	const req: ChatRequest & { stream: true } = {
		model: model.id,
		messages: buildMessages(context),
		stream: true,
		// Pin the active model resident; chat-loop fires a `keep_alive: 0` sweep
		// on hot-swap to evict any previously-pinned models.
		keep_alive: -1,
	};
	if (context.tools && context.tools.length > 0) req.tools = context.tools.map(toolToOllama);
	const opts: Partial<OllamaOptions> = {};
	const applied = applyThinkingMechanism(clioQuirks(model), thinkingLevel, { reasoning: model.reasoning === true });
	const think = ollamaThinkValue(applied);
	if (think !== undefined) req.think = think;
	const samplingProfile = pickSamplingProfile(clioQuirks(model), applied.thinkingActive);
	if (samplingProfile) applyOllamaSamplingProfile(opts, samplingProfile);
	if (options?.temperature !== undefined) opts.temperature = options.temperature;
	opts.num_predict = remainingContextMaxTokens(model, context, options);
	if (Object.keys(opts).length > 0) req.options = opts;
	return req;
}

export interface EvictResidentEntry {
	readonly model: string;
	readonly name: string;
}

export interface EvictResidentResponse {
	readonly models: ReadonlyArray<EvictResidentEntry>;
}

export interface EvictGenerateRequest {
	readonly model: string;
	readonly prompt: string;
	readonly keep_alive: number;
	readonly stream: false;
}

export interface OllamaEvictClient {
	ps(): Promise<EvictResidentResponse>;
	generate(req: EvictGenerateRequest): Promise<unknown>;
}

/**
 * Eviction sweep for an Ollama server: queries `/api/ps` for all currently
 * resident models and fires `keep_alive: 0` against any that are not the
 * keep target. Used by chat-loop on hot-swap so the prior pinned model
 * releases VRAM instead of lingering forever (`-1` keep_alive).
 */
export async function evictOtherOllamaModels(
	baseUrl: string,
	keepModelId: string,
	headers?: Record<string, string>,
	client?: OllamaEvictClient,
): Promise<void> {
	const evictClient: OllamaEvictClient = client ?? new Ollama({ host: baseUrl, ...(headers ? { headers } : {}) });
	let resident: EvictResidentResponse;
	try {
		resident = await evictClient.ps();
	} catch {
		return;
	}
	const stale = resident.models.filter((entry) => entry.model !== keepModelId && entry.name !== keepModelId);
	await Promise.all(
		stale.map((entry) =>
			evictClient
				.generate({ model: entry.model || entry.name, prompt: "", keep_alive: 0, stream: false })
				.catch(() => undefined),
		),
	);
}

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
		arguments: args,
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
	// Fresh instance per call so instance-level abort() scopes to this stream only.
	const headers: Record<string, string> = {};
	if (model.headers) Object.assign(headers, model.headers);
	if (options?.headers) Object.assign(headers, options.headers);
	const client = new Ollama({ host: model.baseUrl, headers });
	const signal = options?.signal;
	let aborted = signal?.aborted === true;
	const onAbort = () => {
		aborted = true;
		client.abort();
	};
	if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
	(async () => {
		try {
			if (aborted) throw new Error("Request was aborted");
			const iterator = await client.chat(buildRequest(model, context, options, thinkingLevel));
			stream.push({ type: "start", partial: output });
			let active: TextContent | null = null;
			let activeIdx = -1;
			let activeThinking: ThinkingContent | null = null;
			let activeThinkingIdx = -1;
			let reasoningChars = 0;
			let hadToolCall = false;
			let doneReason: string | undefined;
			const closeActiveText = () => {
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
			const emitText = (content: string) => {
				closeActiveThinking();
				if (!active) {
					active = { type: "text", text: "" };
					output.content.push(active);
					activeIdx = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex: activeIdx, partial: output });
				}
				active.text += content;
				stream.push({
					type: "text_delta",
					contentIndex: activeIdx,
					delta: content,
					partial: output,
				});
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
			for await (const chunk of iterator) {
				const response = chunk as ChatResponse;
				const msg = response.message;
				if (msg?.thinking && msg.thinking.length > 0) {
					emitThinking(msg.thinking);
				}
				if (msg?.content && msg.content.length > 0) {
					emitText(msg.content);
				}
				if (msg?.tool_calls && msg.tool_calls.length > 0) {
					closeActiveText();
					closeActiveThinking();
					for (const raw of msg.tool_calls) emitToolCall(raw, output, stream);
					hadToolCall = true;
				}
				if (response.done) {
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
			if (aborted) throw new Error("Request was aborted");
			output.stopReason = mapStopReason(doneReason, hadToolCall);
			stream.push({ type: "done", reason: asDoneReason(output.stopReason), message: output });
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

function stripReasoning(options: SimpleStreamOptions | undefined): StreamOptions | undefined {
	if (!options) return undefined;
	const { reasoning: _r, thinkingBudgets: _b, ...rest } = options;
	return rest;
}

export const ollamaNativeApiProvider: ApiProvider<"ollama-native"> = {
	api: "ollama-native",
	stream: (model, context, options) => runStream(model, context, options, fallbackThinkingLevel(model)),
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		runStream(model, context, stripReasoning(options), thinkingLevelFromSimple(options)),
};
