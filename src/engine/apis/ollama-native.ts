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
	Tool,
	ToolCall,
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
import { calculateEngineCost } from "../ai.js";

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
	if (options?.temperature !== undefined) opts.temperature = options.temperature;
	if (options?.maxTokens !== undefined) opts.num_predict = options.maxTokens;
	if (Object.keys(opts).length > 0) req.options = opts;
	return req;
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
): Promise<void> {
	const client = new Ollama({ host: baseUrl, ...(headers ? { headers } : {}) });
	let resident: Awaited<ReturnType<typeof client.ps>>;
	try {
		resident = await client.ps();
	} catch {
		return;
	}
	const stale = resident.models.filter((entry) => entry.model !== keepModelId && entry.name !== keepModelId);
	await Promise.all(
		stale.map((entry) =>
			client
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
			const iterator = await client.chat(buildRequest(model, context, options));
			stream.push({ type: "start", partial: output });
			let active: TextContent | null = null;
			let activeIdx = -1;
			let hadToolCall = false;
			let doneReason: string | undefined;
			for await (const chunk of iterator) {
				const response = chunk as ChatResponse;
				const msg = response.message;
				if (msg?.content && msg.content.length > 0) {
					if (!active) {
						active = { type: "text", text: "" };
						output.content.push(active);
						activeIdx = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: activeIdx, partial: output });
					}
					active.text += msg.content;
					stream.push({
						type: "text_delta",
						contentIndex: activeIdx,
						delta: msg.content,
						partial: output,
					});
				}
				if (msg?.tool_calls && msg.tool_calls.length > 0) {
					if (active) {
						stream.push({
							type: "text_end",
							contentIndex: activeIdx,
							content: active.text,
							partial: output,
						});
						active = null;
						activeIdx = -1;
					}
					for (const raw of msg.tool_calls) emitToolCall(raw, output, stream);
					hadToolCall = true;
				}
				if (response.done) {
					if (active) {
						stream.push({
							type: "text_end",
							contentIndex: activeIdx,
							content: active.text,
							partial: output,
						});
						active = null;
						activeIdx = -1;
					}
					output.usage.input = response.prompt_eval_count ?? 0;
					output.usage.output = response.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
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
	stream: (model, context, options) => runStream(model, context, options),
	streamSimple: (model, context, options?: SimpleStreamOptions) => runStream(model, context, stripReasoning(options)),
};
