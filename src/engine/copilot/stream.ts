/**
 * The copilot-sdk API: each Clio model call is one step of an official Copilot SDK session.
 *
 * Clio's agent loop owns the tools. Every tool in the request is declared to Copilot as an SDK tool whose
 * handler parks until Clio's loop has run the call under its own policy; Copilot's built-in tools are all
 * excluded (`availableTools: ["custom:*"]`), so Copilot executes nothing itself. A Copilot assistant
 * message that requests tools ends the Clio stream with `toolUse`; the next Clio call carries the results,
 * which resolve the parked handlers, and Copilot continues the same run.
 *
 * One Copilot session is reused while Clio's transcript strictly extends what that session has seen.
 * Compaction, undo or any rewrite of earlier history is a divergence: the session is disposed and a fresh
 * one is seeded with Clio's current transcript. Side calls on the same Clio session (a side question, a
 * summarizer) match no live conversation and get their own, so they never disturb the main one.
 *
 * Every parked handler settles: with Clio's result, or rejected when its call is retired by Copilot, when
 * the conversation is disposed (divergence, abort, Clio session end) or when the process stops the runtime.
 */
import { createHash } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type {
	CopilotSession,
	Tool as CopilotTool,
	SessionConfig,
	SessionEvent,
	ToolResultObject,
} from "@github/copilot-sdk";
import { COPILOT_REFUSAL_PREFIX } from "../../core/copilot-refusal.js";
import { copilotConsentMissingMessage, hasCopilotConsent } from "../../domains/providers/copilot-consent.js";
import type { EngineRegisteredApiProvider } from "../api-registry.js";
import { COPILOT_CLIENT_NAME, copilotAccount, copilotClient } from "./client.js";

type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

export const COPILOT_SDK_API = "copilot-sdk";
export const COPILOT_SDK_PROVIDER = "copilot-sdk";

/** What one Copilot model step billed, as the runtime reported it; carried beside the message usage. */
export interface CopilotStepBilling {
	/** Premium requests: the model multiplier for a user-initiated call, zero for an agent continuation. */
	premiumRequests: number | null;
	/** AI credits in nano-AIU, when the API reported them. */
	nanoAiu: number | null;
	/** Model calls Copilot made for this step, root agent only. */
	modelCalls: number;
}

type ConversationState = "idle" | "awaiting-tools";

interface Parked {
	resolve(result: ToolResultObject): void;
	reject(error: Error): void;
}

const MAX_CONVERSATIONS_PER_KEY = 4;
/** Upper bound on waiting for a tool-requesting call's usage before handing the calls to Clio. */
const TOOL_USE_SETTLE_MS = 2_000;
const MAX_CONVERSATIONS = 16;

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;
const MIDDLEWARE_NOTE = /(?:^|\n)\[middleware:[a-z-]+\][^\n]*/gu;

/** Request-only framing the host adds per call; it is not part of the transcript identity. */
function withoutHostFraming(text: string): string {
	return text.replace(REMINDER_BLOCK, "").replace(MIDDLEWARE_NOTE, "").trim();
}

function textOf(content: string | ReadonlyArray<TextContent | ImageContent | ThinkingContent | ToolCall>): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function imagesOf(content: Message["content"]): ImageContent[] {
	if (typeof content === "string") return [];
	return (content as ReadonlyArray<{ type: string }>).filter((block): block is ImageContent => block.type === "image");
}

type CoreMessage = Exclude<Message, { role: "system" }>;

/**
 * Transcript identity of one message. Assistant text is not part of it: Clio may filter what the stream
 * produced before storing it, while the tool call ids it answered with are stable.
 */
function fingerprint(message: CoreMessage): string | null {
	switch (message.role) {
		case "user": {
			const text = withoutHostFraming(textOf(message.content));
			const images = imagesOf(message.content).map((image) => hash(image.data));
			if (text.length === 0 && images.length === 0) return null;
			return `u:${hash(text)}:${images.join(",")}`;
		}
		case "assistant": {
			const ids = message.content.filter((block): block is ToolCall => block.type === "toolCall").map((call) => call.id);
			return `a:${ids.join(",")}`;
		}
		case "toolResult":
			return `r:${message.toolCallId}`;
	}
}

function toolsSignature(tools: ReadonlyArray<Tool>): string {
	return hash(JSON.stringify(tools.map((tool) => [tool.name, tool.description, tool.parameters])));
}

interface StepSink {
	handle(event: SessionEvent): void;
}

class Conversation {
	readonly key: string;
	readonly session: CopilotSession;
	readonly systemHash: string;
	toolsHash: string;
	model: string;
	reasoningEffort: string | undefined;
	synced: string[] = [];
	state: ConversationState = "idle";
	pendingToolCallIds: string[] = [];
	busy = false;
	disposed = false;
	lastUsed = Date.now();
	sink: StepSink | null = null;
	orphanUsage: SessionEvent[] = [];
	private readonly parked = new Map<string, Parked>();
	private readonly delivered = new Map<string, ToolResultObject>();
	private unsubscribe: (() => void) | null = null;

	constructor(input: {
		key: string;
		session: CopilotSession;
		systemHash: string;
		toolsHash: string;
		model: string;
		reasoningEffort: string | undefined;
	}) {
		this.key = input.key;
		this.session = input.session;
		this.systemHash = input.systemHash;
		this.toolsHash = input.toolsHash;
		this.model = input.model;
		this.reasoningEffort = input.reasoningEffort;
		this.unsubscribe = this.session.on((event) => {
			if (this.sink) this.sink.handle(event);
			// Usage that lands between steps is the previous call's; the next step reports it, so no tokens drop.
			else if (event.type === "assistant.usage") this.orphanUsage.push(event);
		});
	}

	/** The SDK handler for one of Clio's tools: wait for Clio's own result for this call. */
	park(toolCallId: string, signal: AbortSignal | undefined): Promise<ToolResultObject> {
		const ready = this.delivered.get(toolCallId);
		if (ready) {
			this.delivered.delete(toolCallId);
			return Promise.resolve(ready);
		}
		if (this.disposed) return Promise.reject(new Error("Clio's Copilot conversation was closed"));
		return new Promise<ToolResultObject>((resolve, reject) => {
			const retire = () => {
				this.parked.delete(toolCallId);
				reject(new Error("Copilot retired this tool call before Clio returned its result"));
			};
			if (signal?.aborted) {
				retire();
				return;
			}
			signal?.addEventListener("abort", retire, { once: true });
			this.parked.set(toolCallId, {
				resolve: (result) => {
					signal?.removeEventListener("abort", retire);
					resolve(result);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", retire);
					reject(error);
				},
			});
		});
	}

	deliver(toolCallId: string, result: ToolResultObject): void {
		const waiter = this.parked.get(toolCallId);
		if (waiter) {
			this.parked.delete(toolCallId);
			waiter.resolve(result);
			return;
		}
		this.delivered.set(toolCallId, result);
	}

	/** Settle every parked handler, detach and remove the Copilot session. Idempotent. */
	async dispose(reason: string): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.sink = null;
		const error = new Error(reason);
		for (const waiter of this.parked.values()) waiter.reject(error);
		this.parked.clear();
		this.delivered.clear();
		this.unsubscribe?.();
		this.unsubscribe = null;
		const sessionId = this.session.sessionId;
		try {
			await this.session.abort();
		} catch {
			// An idle or already-closed session has nothing to abort.
		}
		try {
			await this.session.disconnect();
			// Clio keeps the transcript; Copilot's on-disk copy of this session is not left behind.
			await (await copilotClient()).deleteSession(sessionId);
		} catch {
			// A runtime that already exited took the session with it.
		}
	}
}

const conversations: Conversation[] = [];

function evictFor(key: string): void {
	const idle = (list: Conversation[]) =>
		list.filter((conversation) => !conversation.busy).sort((a, b) => a.lastUsed - b.lastUsed);
	const own = conversations.filter((conversation) => conversation.key === key);
	for (const victim of idle(own).slice(0, Math.max(0, own.length - MAX_CONVERSATIONS_PER_KEY + 1))) remove(victim);
	for (const victim of idle(conversations).slice(0, Math.max(0, conversations.length - MAX_CONVERSATIONS + 1)))
		remove(victim);
}

function remove(conversation: Conversation, reason = "Clio closed this Copilot conversation"): void {
	const index = conversations.indexOf(conversation);
	if (index >= 0) conversations.splice(index, 1);
	void conversation.dispose(reason);
}

/** Dispose every Copilot conversation bound to a Clio session, settling its parked handlers. */
export function disposeCopilotConversations(sessionId: string): void {
	for (const conversation of [...conversations]) {
		if (conversation.key === sessionId)
			remove(conversation, "The Clio session ended; its Copilot conversation was closed");
	}
}

function reasoningEffortFor(model: Model<Api>, options: SimpleStreamOptions | undefined): string | undefined {
	if (!model.reasoning) return undefined;
	switch (options?.reasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		default:
			return undefined;
	}
}

function toolResultObject(message: Extract<CoreMessage, { role: "toolResult" }>, extraText = ""): ToolResultObject {
	const text = [textOf(message.content), extraText].filter((part) => part.length > 0).join("\n\n");
	const images = imagesOf(message.content);
	return {
		textResultForLlm: text,
		resultType: message.isError ? "failure" : "success",
		...(images.length > 0
			? {
					binaryResultsForLlm: images.map((image) => ({
						type: "image" as const,
						data: image.data,
						mimeType: image.mimeType,
					})),
				}
			: {}),
	};
}

function renderTranscript(messages: ReadonlyArray<CoreMessage>): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text.length > 0) lines.push(`<user>\n${text}\n</user>`);
		} else if (message.role === "assistant") {
			const text = textOf(message.content);
			const calls = message.content
				.filter((block): block is ToolCall => block.type === "toolCall")
				.map((call) => `<tool_call id="${call.id}" name="${call.name}">${JSON.stringify(call.arguments)}</tool_call>`);
			lines.push(`<assistant>\n${[text, ...calls].filter((part) => part.length > 0).join("\n")}\n</assistant>`);
		} else {
			lines.push(
				`<tool_result id="${message.toolCallId}" name="${message.toolName}"${message.isError ? ' error="true"' : ""}>\n${textOf(message.content)}\n</tool_result>`,
			);
		}
	}
	return lines.join("\n");
}

/** The first prompt of a fresh session: the trailing user turn, after earlier history when there is any. */
function seedPrompt(messages: ReadonlyArray<CoreMessage>): { prompt: string; images: ImageContent[] } {
	let tail = messages.length;
	while (tail > 0 && messages[tail - 1]?.role === "user") tail--;
	const history = messages.slice(0, tail);
	const current = messages.slice(tail);
	const currentText = current.map((message) => textOf(message.content)).filter((text) => text.length > 0);
	const images = current.flatMap((message) => imagesOf(message.content));
	if (history.length === 0) return { prompt: currentText.join("\n\n"), images };
	const intro =
		"<conversation-history>\nThe conversation so far, recorded by the host. Continue it; do not repeat completed tool calls.\n";
	const body = `${intro}${renderTranscript(history)}\n</conversation-history>`;
	return {
		prompt: currentText.length > 0 ? `${body}\n\n${currentText.join("\n\n")}` : `${body}\n\nContinue.`,
		images,
	};
}

function refusalMessage(data: {
	errorType?: string;
	errorCode?: string;
	statusCode?: number;
	message?: string;
}): string {
	const type = data.errorType ?? "error";
	const detail = [data.errorCode, data.statusCode !== undefined ? `HTTP ${data.statusCode}` : undefined]
		.filter(Boolean)
		.join(", ");
	const text = data.message ?? "no detail";
	if (["authentication", "authorization", "policy", "quota", "rate_limit"].includes(type)) {
		return `${COPILOT_REFUSAL_PREFIX} (${type}${detail ? `: ${detail}` : ""}): ${text}`;
	}
	if (type === "context_limit")
		return `GitHub Copilot context limit: ${text} (the prompt exceeds the model's maximum context length)`;
	return `GitHub Copilot ${type}${detail ? ` (${detail})` : ""}: ${text}`;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Drive one model step: forward root-agent output into the Clio stream and end it at the step boundary. */
class Step implements StepSink {
	readonly message: AssistantMessage & { copilotBilling?: CopilotStepBilling };
	private textIndex: number | null = null;
	private thinkingIndex: number | null = null;
	private started = false;
	private finished = false;
	private error: string | null = null;
	private readonly billing: CopilotStepBilling = { premiumRequests: null, nanoAiu: null, modelCalls: 0 };
	private toolUse: string[] | null = null;
	private toolUseTimer: ReturnType<typeof setTimeout> | undefined;
	onFinish: ((outcome: { stop: "stop" | "toolUse" | "aborted" | "error"; toolCallIds: string[] }) => void) | null = null;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.message });
	}

	private text(delta: string): void {
		if (delta.length === 0) return;
		this.start();
		if (this.textIndex === null) {
			this.textIndex = this.message.content.length;
			this.message.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.message });
		}
		const block = this.message.content[this.textIndex] as TextContent;
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta, partial: this.message });
	}

	private thinking(delta: string): void {
		if (delta.length === 0) return;
		this.start();
		if (this.thinkingIndex === null) {
			this.thinkingIndex = this.message.content.length;
			this.message.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.message });
		}
		const block = this.message.content[this.thinkingIndex] as ThinkingContent;
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta, partial: this.message });
	}

	private closeOpenBlocks(): void {
		if (this.thinkingIndex !== null) {
			const block = this.message.content[this.thinkingIndex] as ThinkingContent;
			this.stream.push({
				type: "thinking_end",
				contentIndex: this.thinkingIndex,
				content: block.thinking,
				partial: this.message,
			});
			this.thinkingIndex = null;
		}
		if (this.textIndex !== null) {
			const block = this.message.content[this.textIndex] as TextContent;
			this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.message });
			this.textIndex = null;
		}
	}

	private usage(data: Extract<SessionEvent, { type: "assistant.usage" }>["data"]): void {
		const usage = this.message.usage;
		const cacheRead = data.cacheReadTokens ?? 0;
		// Copilot's inputTokens counts the whole prompt, cached part included, as OpenAI's prompt_tokens does.
		usage.input += Math.max(0, (data.inputTokens ?? 0) - cacheRead);
		usage.output += data.outputTokens ?? 0;
		usage.cacheRead += cacheRead;
		usage.cacheWrite += data.cacheWriteTokens ?? 0;
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		this.billing.modelCalls += 1;
		if (typeof data.cost === "number") {
			// A call with an initiator (sub-agent, background) is not user-initiated and bills no premium request.
			const premium = data.initiator === undefined ? data.cost : 0;
			this.billing.premiumRequests = (this.billing.premiumRequests ?? 0) + premium;
		}
		const nano = data.copilotUsage?.totalNanoAiu;
		if (typeof nano === "number") this.billing.nanoAiu = (this.billing.nanoAiu ?? 0) + nano;
		if (typeof data.model === "string" && data.model.length > 0) this.message.responseModel = data.model;
		if (typeof data.apiCallId === "string") this.message.responseId = data.apiCallId;
	}

	handle(event: SessionEvent): void {
		if (this.finished) return;
		// Sub-agent output never reaches Clio's transcript; Copilot's task tool is excluded anyway.
		if ((event as { agentId?: string }).agentId) return;
		switch (event.type) {
			case "assistant.message_delta":
				if (!event.data.parentToolCallId) this.text(event.data.deltaContent);
				return;
			case "assistant.reasoning_delta":
				this.thinking(event.data.deltaContent);
				return;
			case "assistant.usage":
				if (!event.data.parentToolCallId) this.usage(event.data);
				return;
			case "assistant.message": {
				if (event.data.parentToolCallId) return;
				const streamed = this.textIndex === null ? "" : (this.message.content[this.textIndex] as TextContent).text;
				if (streamed.length === 0 && event.data.content) this.text(event.data.content);
				const requests = event.data.toolRequests ?? [];
				if (requests.length === 0) return;
				this.closeOpenBlocks();
				const ids: string[] = [];
				for (const request of requests) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: request.toolCallId,
						name: request.name,
						arguments:
							typeof request.arguments === "object" && request.arguments !== null && !Array.isArray(request.arguments)
								? (request.arguments as ToolCall["arguments"])
								: {},
					};
					const index = this.message.content.length;
					this.message.content.push(toolCall);
					this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
					this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.message });
					ids.push(request.toolCallId);
				}
				// The call's usage may follow its message; the step ends when Copilot moves on to the tools.
				this.toolUse = ids;
				this.toolUseTimer = setTimeout(() => this.finish("toolUse", ids), TOOL_USE_SETTLE_MS);
				return;
			}
			case "external_tool.requested":
			case "tool.execution_start":
			case "assistant.turn_end":
				if (this.toolUse) this.finish("toolUse", this.toolUse);
				return;
			case "session.error":
				this.error = refusalMessage(event.data);
				return;
			case "session.idle":
				if (this.toolUse) this.finish("toolUse", this.toolUse);
				else if (event.data && (event.data as { aborted?: boolean }).aborted) this.finish("aborted", []);
				else this.finish(this.error ? "error" : "stop", []);
				return;
			default:
				return;
		}
	}

	finish(stop: "stop" | "toolUse" | "aborted" | "error", toolCallIds: string[], errorText?: string): void {
		if (this.finished) return;
		this.finished = true;
		if (this.toolUseTimer) clearTimeout(this.toolUseTimer);
		this.start();
		this.closeOpenBlocks();
		this.message.copilotBilling = { ...this.billing };
		if (stop === "stop" || stop === "toolUse") {
			this.message.stopReason = stop;
			this.stream.push({ type: "done", reason: stop, message: this.message });
		} else {
			this.message.stopReason = stop;
			this.message.errorMessage =
				errorText ?? this.error ?? (stop === "aborted" ? "Request was aborted" : "GitHub Copilot run failed");
			this.stream.push({ type: "error", reason: stop, error: this.message });
		}
		this.stream.end(this.message);
		this.onFinish?.({ stop, toolCallIds });
	}
}

function declareTools(conversationRef: () => Conversation | null, tools: ReadonlyArray<Tool>): CopilotTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })) as Record<
			string,
			unknown
		>,
		// Every name may shadow a Copilot built-in; all built-ins are excluded, so Clio's tool is the only one.
		overridesBuiltInTool: true,
		// Clio's loop runs this call under Clio's permission policy before the result comes back.
		skipPermission: true,
		defer: "never" as const,
		handler: (_args: unknown, invocation: { toolCallId: string; signal?: AbortSignal }) => {
			const conversation = conversationRef();
			if (!conversation) return Promise.reject(new Error("Clio's Copilot conversation is not available"));
			return conversation.park(invocation.toolCallId, invocation.signal);
		},
	}));
}

async function openConversation(input: {
	key: string;
	model: Model<Api>;
	systemPrompt: string;
	tools: ReadonlyArray<Tool>;
	reasoningEffort: string | undefined;
}): Promise<Conversation> {
	const account = await copilotAccount();
	if (!hasCopilotConsent(account)) throw new Error(copilotConsentMissingMessage(account));
	const client = await copilotClient();
	let conversation: Conversation | null = null;
	const session = await client.createSession({
		model: input.model.id,
		clientName: COPILOT_CLIENT_NAME,
		streaming: true,
		// Replace, not append: Clio's compiled prompt carries its identity, safety rules and tool contract, and
		// Copilot's default sections describe built-in tools that are excluded here.
		systemMessage: { mode: "replace", content: input.systemPrompt },
		tools: declareTools(() => conversation, input.tools),
		availableTools: ["custom:*"],
		infiniteSessions: { enabled: false },
		enableSessionStore: false,
		enableSkills: false,
		enableConfigDiscovery: false,
		workingDirectory: process.cwd(),
		...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort as ReasoningEffort } : {}),
		// No Copilot built-in runs, so any permission request is outside Clio's surface and is refused.
		onPermissionRequest: () => ({
			kind: "reject",
			feedback: "Clio governs every tool call; Copilot built-in tools are disabled in this session.",
		}),
	});
	conversation = new Conversation({
		key: input.key,
		session,
		systemHash: hash(input.systemPrompt),
		toolsHash: toolsSignature(input.tools),
		model: input.model.id,
		reasoningEffort: input.reasoningEffort,
	});
	return conversation;
}

interface Plan {
	conversation: Conversation | null;
	newMessages: CoreMessage[];
}

function plan(key: string, systemHash: string, core: ReadonlyArray<CoreMessage>, prints: ReadonlyArray<string>): Plan {
	let best: Conversation | null = null;
	for (const conversation of conversations) {
		if (conversation.key !== key || conversation.busy || conversation.disposed) continue;
		if (conversation.systemHash !== systemHash) continue;
		if (conversation.synced.length >= prints.length) continue;
		if (!conversation.synced.every((print, index) => prints[index] === print)) continue;
		if (!best || conversation.synced.length > best.synced.length) best = conversation;
	}
	if (!best) return { conversation: null, newMessages: [...core] };
	const fresh = core.slice(best.synced.length);
	const first = fresh[0];
	const valid =
		best.state === "awaiting-tools"
			? first?.role === "toolResult" && fresh.every((message) => message.role !== "assistant")
			: fresh.every((message) => message.role === "user");
	return valid ? { conversation: best, newMessages: fresh } : { conversation: null, newMessages: [...core] };
}

async function runStep(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | StreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const step = new Step(stream, model);
	const signal = options?.signal;
	if (signal?.aborted) {
		step.finish("aborted", []);
		return;
	}
	const key = options?.sessionId ?? "default";
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	const systemHash = hash(systemPrompt);
	const reasoningEffort = reasoningEffortFor(model, options as SimpleStreamOptions | undefined);
	// Messages that are only per-call host framing carry no transcript identity; they still reach the model.
	const core = context.messages.filter((message): message is CoreMessage => message.role !== "system");
	const kept = core.filter((message) => fingerprint(message) !== null);
	const prints = kept.map((message) => fingerprint(message) as string);

	let { conversation, newMessages } = plan(key, systemHash, kept, prints);
	const reused = conversation !== null;
	// Framing that rides on the request tail (reminders) is sent with the new messages.
	const tailFraming = core
		.slice(core.length > 0 ? core.lastIndexOf(kept[kept.length - 1] as CoreMessage) + 1 : 0)
		.filter((message) => fingerprint(message) === null);

	let abortListener: (() => void) | null = null;
	try {
		if (!conversation) {
			evictFor(key);
			conversation = await openConversation({ key, model, systemPrompt, tools, reasoningEffort });
			conversations.push(conversation);
		}
		const active = conversation;
		active.busy = true;
		active.lastUsed = Date.now();
		if (active.model !== model.id || active.reasoningEffort !== reasoningEffort) {
			await active.session.setModel(
				model.id,
				reasoningEffort !== undefined ? { reasoningEffort: reasoningEffort as ReasoningEffort } : undefined,
			);
			active.model = model.id;
			active.reasoningEffort = reasoningEffort;
		}
		const toolsHash = toolsSignature(tools);
		if (reused && active.toolsHash !== toolsHash) {
			await active.session.setTools(declareTools(() => active, tools));
			active.toolsHash = toolsHash;
		}
		active.sink = step;
		for (const event of active.orphanUsage.splice(0)) step.handle(event);
		step.onFinish = ({ stop, toolCallIds }) => {
			active.sink = null;
			active.busy = false;
			if (abortListener) signal?.removeEventListener("abort", abortListener);
			if (stop === "toolUse" || stop === "stop") {
				active.synced = [...prints, `a:${toolCallIds.join(",")}`];
				active.state = stop === "toolUse" ? "awaiting-tools" : "idle";
				active.pendingToolCallIds = toolCallIds;
			} else {
				// After an abort or error the Copilot run's state is not Clio's; the next call seeds afresh.
				remove(active, "The Copilot step ended without a result; its conversation was closed");
			}
		};
		abortListener = () => {
			step.finish("aborted", []);
		};
		signal?.addEventListener("abort", abortListener, { once: true });

		const framingText = tailFraming
			.map((message) => textOf(message.content))
			.filter((text) => text.length > 0)
			.join("\n\n");
		if (reused && active.state === "awaiting-tools") {
			const results = newMessages.filter(
				(message): message is Extract<CoreMessage, { role: "toolResult" }> => message.role === "toolResult",
			);
			const after = newMessages.filter((message) => message.role === "user");
			const extra = [...after.map((message) => textOf(message.content)), framingText]
				.filter((text) => text.length > 0)
				.join("\n\n");
			const answered = new Set(results.map((message) => message.toolCallId));
			for (const [index, message] of results.entries()) {
				active.deliver(message.toolCallId, toolResultObject(message, index === results.length - 1 ? extra : ""));
			}
			// Every requested call settles even when Clio's loop produced no result for it.
			for (const id of active.pendingToolCallIds) {
				if (!answered.has(id))
					active.deliver(id, { textResultForLlm: "The host returned no result for this call.", resultType: "failure" });
			}
		} else {
			const seed = reused
				? {
						prompt: [...newMessages.map((message) => textOf(message.content)), framingText]
							.filter((text) => text.length > 0)
							.join("\n\n"),
						images: newMessages.flatMap((message) => imagesOf(message.content)),
					}
				: (() => {
						const seeded = seedPrompt(core.filter((message) => fingerprint(message) !== null));
						return {
							prompt: [seeded.prompt, framingText].filter((text) => text.length > 0).join("\n\n"),
							images: seeded.images,
						};
					})();
			await active.session.send({
				prompt: seed.prompt,
				...(seed.images.length > 0
					? {
							attachments: seed.images.map((image) => ({
								type: "blob" as const,
								data: image.data,
								mimeType: image.mimeType,
							})),
						}
					: {}),
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (conversation && !step.onFinish) remove(conversation);
		step.finish("error", [], message);
	}
}

function streamCopilot(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | StreamOptions | undefined,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runStep(model, context, options, stream);
	return stream;
}

export const copilotSdkApiProvider: EngineRegisteredApiProvider = {
	api: COPILOT_SDK_API,
	stream: streamCopilot,
	streamSimple: streamCopilot,
};
