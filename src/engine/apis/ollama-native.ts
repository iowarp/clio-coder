import { randomUUID } from "node:crypto";

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
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

interface OllamaRawToolCall {
	function?: { name?: string; arguments?: unknown };
}

interface OllamaMessage {
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	images?: string[];
	tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
	tool_call_id?: string;
}

interface OllamaToolSpec {
	type: "function";
	function: { name: string; description: string; parameters: unknown };
}

interface OllamaChunk {
	message?: { role?: string; content?: string; tool_calls?: OllamaRawToolCall[] };
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

interface OllamaRequestBody {
	model: string;
	messages: OllamaMessage[];
	stream: true;
	tools?: OllamaToolSpec[];
	system?: string;
	options?: { temperature?: number; num_predict?: number };
}

function buildRequestBody(
	model: Model<"ollama-native">,
	context: Context,
	options?: StreamOptions,
): OllamaRequestBody {
	const messages: OllamaMessage[] = [];
	for (const msg of context.messages) {
		const translated = translateMessage(msg);
		if (translated) messages.push(translated);
	}
	const body: OllamaRequestBody = { model: model.id, messages, stream: true };
	if (context.systemPrompt && context.systemPrompt.length > 0) body.system = context.systemPrompt;
	if (context.tools && context.tools.length > 0) body.tools = context.tools.map(toolToOllama);
	const opts: { temperature?: number; num_predict?: number } = {};
	if (options?.temperature !== undefined) opts.temperature = options.temperature;
	if (options?.maxTokens !== undefined) opts.num_predict = options.maxTokens;
	if (Object.keys(opts).length > 0) body.options = opts;
	return body;
}

function toolToOllama(tool: Tool): OllamaToolSpec {
	return {
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	};
}

function translateMessage(msg: Message): OllamaMessage | null {
	if (msg.role === "user") return userToOllama(msg.content);
	if (msg.role === "assistant") return assistantToOllama(msg.content);
	if (msg.role === "toolResult") {
		const text = msg.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		return { role: "tool", content: text, tool_call_id: msg.toolCallId };
	}
	return null;
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
	const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
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

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffered = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let nl = buffered.indexOf("\n");
			while (nl !== -1) {
				const line = buffered.slice(0, nl).trim();
				buffered = buffered.slice(nl + 1);
				nl = buffered.indexOf("\n");
				if (line.length === 0) continue;
				try {
					yield JSON.parse(line) as OllamaChunk;
				} catch {}
			}
		}
		const tail = buffered.trim();
		if (tail.length > 0) {
			try {
				yield JSON.parse(tail) as OllamaChunk;
			} catch {}
		}
	} finally {
		reader.releaseLock();
	}
}

function runStream(
	model: Model<"ollama-native">,
	context: Context,
	options: StreamOptions | undefined,
): AssistantMessageEventStream {
	const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
	const controller = new AbortController();
	if (options?.signal) {
		if (options.signal.aborted) controller.abort();
		else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
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
	(async () => {
		try {
			const body = buildRequestBody(model, context, options);
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (model.headers) Object.assign(headers, model.headers);
			if (options?.headers) Object.assign(headers, options.headers);
			const response = await fetch(`${model.baseUrl}/api/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				const detail = await safeReadText(response);
				throw new Error(`HTTP ${response.status}: ${response.statusText}${detail.length > 0 ? ` ${detail}` : ""}`);
			}
			stream.push({ type: "start", partial: output });
			let active: TextContent | null = null;
			let activeIdx = -1;
			for await (const chunk of readNdjson(response.body)) {
				if (chunk.error) throw new Error(chunk.error);
				const msg = chunk.message;
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
				}
				if (chunk.done) {
					if (active) {
						stream.push({
							type: "text_end",
							contentIndex: activeIdx,
							content: active.text,
							partial: output,
						});
						active = null;
					}
					output.usage.input = chunk.prompt_eval_count ?? 0;
					output.usage.output = chunk.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
					output.stopReason = mapDoneReason(chunk.done_reason, output.stopReason);
				}
			}
			if (controller.signal.aborted) throw new Error("Request was aborted");
			stream.push({ type: "done", reason: asDoneReason(output.stopReason), message: output });
			stream.end();
		} catch (err) {
			output.stopReason = controller.signal.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

function emitToolCall(
	raw: OllamaRawToolCall,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const toolCall: ToolCall = buildToolCall(raw);
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
	output.stopReason = "toolUse";
}

function buildToolCall(raw: OllamaRawToolCall): ToolCall {
	const name = raw.function?.name ?? "";
	const source = raw.function?.arguments;
	const args =
		source && typeof source === "object" && !Array.isArray(source)
			? (source as Record<string, unknown>)
			: {};
	return { type: "toolCall", id: randomUUID(), name, arguments: args };
}

function mapDoneReason(
	reason: string | undefined,
	fallback: AssistantMessage["stopReason"],
): AssistantMessage["stopReason"] {
	if (reason === "length") return "length";
	if (reason === "tool_calls") return "toolUse";
	return fallback;
}

function asDoneReason(
	reason: AssistantMessage["stopReason"],
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
	if (reason === "length" || reason === "toolUse") return reason;
	return "stop";
}

async function safeReadText(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 512);
	} catch {
		return "";
	}
}

function stripReasoning(options: SimpleStreamOptions | undefined): StreamOptions | undefined {
	if (!options) return undefined;
	const { reasoning: _r, thinkingBudgets: _b, ...rest } = options;
	return rest;
}

export const ollamaNativeApiProvider: ApiProvider<"ollama-native"> = {
	api: "ollama-native",
	stream: (model, context, options) => runStream(model, context, options),
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		runStream(model, context, stripReasoning(options)),
};
