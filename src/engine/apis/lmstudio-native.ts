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
import {
	LMStudioClient,
	type ChatHistoryData,
	type ChatMessageData,
	type ChatMessagePartFileData,
	type ChatMessagePartTextData,
	type ChatMessagePartToolCallRequestData,
	type ChatMessagePartToolCallResultData,
	type FileHandle,
	type FunctionToolCallRequest,
	type LLMPredictionStopReason,
	type LLMRespondOpts,
	type LLMTool,
} from "@lmstudio/sdk";

function normalizeBaseUrl(url: string): string {
	const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
	if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
	if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
	if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
	return trimmed;
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
type AssistantPart =
	| ChatMessagePartTextData
	| ChatMessagePartFileData
	| ChatMessagePartToolCallRequestData;

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
	client: LMStudioClient,
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
		if (block.type === "text") parts.push({ type: "text", text: block.text });
		else if (block.type === "toolCall") {
			const req: FunctionToolCallRequest = {
				type: "function",
				name: block.name,
				arguments: block.arguments,
			};
			if (block.id) req.id = block.id;
			parts.push({ type: "toolCallRequest", toolCallRequest: req });
		}
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

async function buildChatHistory(client: LMStudioClient, context: Context): Promise<ChatHistoryData> {
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
): AssistantMessage["stopReason"] {
	if (aborted || reason === "userStopped") return "aborted";
	if (reason === "failed" || reason === "modelUnloaded") return "error";
	if (reason === "toolCalls") return "toolUse";
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

function runStream(
	model: Model<"lmstudio-native">,
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
			const clientOpts: ConstructorParameters<typeof LMStudioClient>[0] = {
				baseUrl: normalizeBaseUrl(model.baseUrl),
			};
			const passkey = options?.apiKey;
			if (passkey) clientOpts.clientPasskey = passkey;
			const client = new LMStudioClient(clientOpts);
			const llm = await client.llm.model(model.id, { signal: controller.signal });
			stream.push({ type: "start", partial: output });
			const activeTextRef: { block: TextContent | null; idx: number } = { block: null, idx: -1 };
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
			const pending = new Map<number, PendingToolCall>();
			const predictionOpts: LLMRespondOpts<unknown> = {
				signal: controller.signal,
				onPredictionFragment: (fragment) => {
					if (fragment.reasoningType === "reasoning") return;
					if (!fragment.content) return;
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
					entry.toolCallSlot.arguments =
						req.arguments && typeof req.arguments === "object"
							? (req.arguments as Record<string, unknown>)
							: safeParseArgs(entry.argBuffer);
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
			if (options?.maxTokens !== undefined) predictionOpts.maxTokens = options.maxTokens;
			if (options?.temperature !== undefined) predictionOpts.temperature = options.temperature;
			const history = await buildChatHistory(client, context);
			if (aborted) throw new Error("Request was aborted");
			const prediction = llm.respond(history, predictionOpts);
			const result = await prediction.result();
			closeActiveText();
			if (aborted) throw new Error("Request was aborted");
			output.usage.input = result.stats.promptTokensCount ?? 0;
			output.usage.output = result.stats.predictedTokensCount ?? 0;
			output.usage.totalTokens = result.stats.totalTokensCount ?? output.usage.input + output.usage.output;
			output.stopReason = mapStopReason(result.stats.stopReason, aborted);
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

function safeParseArgs(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
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
	streamSimple: (model, context, options?: SimpleStreamOptions) =>
		runStream(model, context, stripReasoning(options)),
};
