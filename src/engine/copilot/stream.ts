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
import { createHash, randomUUID } from "node:crypto";
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
	CopilotClient,
	CopilotSession,
	Tool as CopilotTool,
	SessionConfig,
	SessionEvent,
	ToolResultObject,
} from "@github/copilot-sdk";
import { COPILOT_REFUSAL_PREFIX } from "../../core/copilot-refusal.js";
import type { EngineRegisteredApiProvider } from "../api-registry.js";
import {
	COPILOT_CLIENT_NAME,
	copilotAccount,
	copilotClient,
	holdCopilotClient,
	onCopilotRuntimeGone,
} from "./client.js";
import { createCopilotSessionFs, removeCopilotSessionRecords, removeCopilotSessionRecordsSync } from "./session-fs.js";

type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

export const COPILOT_SDK_API = "copilot-sdk";

/** What one Copilot model step billed, as the runtime reported it; carried beside the message usage. */
export interface CopilotStepBilling {
	/**
	 * Premium requests this step added to the runtime's own session total (`usage.getMetrics()`
	 * `totalPremiumRequestCost`); null when the runtime gave no answer. Clio never derives it.
	 */
	premiumRequests: number | null;
	/** AI credits in nano-AIU: the session total's growth, else the sum the calls reported. */
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
/** Upper bound on the runtime's accounting answer at the end of a step. */
const SETTLE_METRICS_MS = 1_000;
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

/** One cumulative session total and whether the last reading of it is a usable step boundary. */
interface MetricsBoundary {
	value: number;
	valid: boolean;
}

/** Calls whose steps have settled; their late usage stays theirs. Bounded, oldest forgotten first. */
const RETIRED_CALLS_LIMIT = 512;

class Conversation {
	readonly key: string;
	readonly session: CopilotSession;
	readonly client: CopilotClient;
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
	/** The open step; events reach no other. */
	activeStep: Step | null = null;
	/**
	 * The runtime's cumulative accounting at the last step boundary, per quantity. The first boundary is read
	 * right after the session is created, before anything is sent: the SDK documents no starting value for a
	 * session's totals, so none is assumed. A failed, late or partial reading leaves that quantity invalid: the
	 * next good reading becomes the new boundary and the growth in between is attributed to no call.
	 */
	readonly boundaries: { premiumRequests: MetricsBoundary; nanoAiu: MetricsBoundary } = {
		premiumRequests: { value: 0, valid: false },
		nanoAiu: { value: 0, valid: false },
	};
	/** Readings are numbered; only the newest may move a boundary. */
	metricsSeq = 0;
	private readonly retiredCalls = new Set<string>();
	/** Settled steps that ended without any usage report and may still be sent one. */
	private owedUsage = 0;
	/** The call ids those steps were seen under; a late report carrying one of them pays its debt by name. */
	private readonly owedIds = new Set<string>();
	private readonly parked = new Map<string, Parked>();
	private readonly delivered = new Map<string, ToolResultObject>();
	private unsubscribe: (() => void) | null = null;

	constructor(input: {
		key: string;
		session: CopilotSession;
		client: CopilotClient;
		systemHash: string;
		toolsHash: string;
		model: string;
		reasoningEffort: string | undefined;
	}) {
		this.key = input.key;
		this.session = input.session;
		this.client = input.client;
		this.systemHash = input.systemHash;
		this.toolsHash = input.toolsHash;
		this.model = input.model;
		this.reasoningEffort = input.reasoningEffort;
		this.unsubscribe = this.session.on((event) => this.route(event));
	}

	/**
	 * Usage belongs to the call that made it, and Copilot's ids do not prove which call that is: message and
	 * usage ids come from different namespaces (Copilot's call id, the provider's message id) and either may be
	 * absent. So the rule is conservative. A report naming a settled call stays with that call. While any
	 * settled step still owes a report, a report whose id is not already bound to the open step is
	 * unattributable: it is credited to no step, it pays one debt, and the open step's counts become unknown,
	 * whether the report carried an id or not.
	 */
	private route(event: SessionEvent): void {
		if (event.type === "assistant.usage" && !(event as { agentId?: string }).agentId && !event.data.parentToolCallId) {
			const id = event.data.apiCallId;
			if (id !== undefined && this.retiredCalls.has(id)) {
				if (this.owedIds.delete(id)) this.payDebt();
				return;
			}
			const bound = id !== undefined && this.activeStep?.callIds.has(id) === true;
			if (this.owedUsage > 0 && !bound) {
				this.payDebt();
				this.activeStep?.markUsageUncertain();
				return;
			}
		}
		this.activeStep?.handle(event);
	}

	private payDebt(): void {
		this.owedUsage = Math.max(0, this.owedUsage - 1);
		if (this.owedUsage === 0) this.owedIds.clear();
	}

	/** A settled step's calls keep their late usage; one that ended without its own usage moves no boundary. */
	retire(step: Step): void {
		for (const id of step.callIds) {
			this.retiredCalls.add(id);
			if (this.retiredCalls.size > RETIRED_CALLS_LIMIT) {
				const oldest = this.retiredCalls.values().next().value;
				if (oldest !== undefined) this.retiredCalls.delete(oldest);
			}
		}
		if (step.owesUsage) {
			this.owedUsage += 1;
			for (const id of step.callIds) this.owedIds.add(id);
		}
		if (!step.usageComplete) {
			// Its usage may still be accounted later, so the runtime's next totals cannot split it from a successor.
			this.boundaries.premiumRequests.valid = false;
			this.boundaries.nanoAiu.valid = false;
			this.metricsSeq += 1;
		}
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

	/**
	 * Settle the open step and every parked handler, detach and remove the Copilot session. Idempotent. A step
	 * still streaming ends with the reason as its error, so its stream and its runtime hold are released.
	 */
	async dispose(reason: string): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const release = holdCopilotClient();
		const step = this.activeStep;
		this.activeStep = null;
		if (step && !step.isFinished) step.finish("error", [], reason);
		const error = new Error(reason);
		for (const waiter of this.parked.values()) waiter.reject(error);
		this.parked.clear();
		this.delivered.clear();
		this.unsubscribe?.();
		this.unsubscribe = null;
		const sessionId = this.session.sessionId;
		// An idle or closed session has nothing to abort, and an exited runtime took it with it. A runtime that is alive
		// but never answers must not keep the hold, or a one-shot command would never exit.
		await settledWithin(this.session.abort(), DISPOSE_RPC_TIMEOUT_MS);
		await settledWithin(this.session.disconnect(), DISPOSE_RPC_TIMEOUT_MS);
		// The runtime wrote this session's records only through Clio's sessionFs, so removing them is the delete;
		// the SDK's deleteSession looks in COPILOT_HOME and finds nothing there.
		try {
			await removeCopilotSessionRecords(sessionId);
		} catch {
			// The records directory is disposable cache; a later close or cache sweep removes what is left.
		}
		release();
	}
}

/** How long dispose waits on each session RPC before it releases the runtime anyway. */
const DISPOSE_RPC_TIMEOUT_MS = 3_000;

function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
		timer.unref();
	});
	return Promise.race([
		work.then(
			() => undefined,
			() => undefined,
		),
		expired,
	]).finally(() => clearTimeout(timer));
}

const conversations: Conversation[] = [];
let exitCleanupInstalled = false;

/** A process that exits with conversations still open (headless run, a killed TUI) leaves no records behind. */
function installExitCleanup(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", () => {
		for (const conversation of conversations) {
			try {
				removeCopilotSessionRecordsSync(conversation.session.sessionId);
			} catch {
				// Exit-time cleanup is best effort; the directory is disposable cache.
			}
		}
	});
}

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

function framedUserText(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.startsWith("<system-reminder>")) return trimmed;
	return `<user-message>\n${trimmed}\n</user-message>`;
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
class Step {
	readonly message: AssistantMessage & { copilotBilling?: CopilotStepBilling };
	private textIndex: number | null = null;
	private thinkingIndex: number | null = null;
	private started = false;
	private finished = false;
	private error: string | null = null;
	private billing: CopilotStepBilling = { premiumRequests: null, nanoAiu: null, modelCalls: 0 };
	private toolUse: string[] | null = null;
	private usageEvents = 0;
	private readonly fieldReports = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	private nanoReports = 0;
	private nanoSum = 0;
	/** The model the runtime reported serving this step's calls (`assistant.usage.model`). */
	private servedModel: string | null = null;
	/** Reads this step's premium requests and AI credits from the runtime's own session accounting. */
	settle: ((step: Step) => Promise<{ premiumRequests: number | null; nanoAiu: number | null }>) | null = null;
	/** Copilot's ids for this step's model calls, from its messages and usage. */
	readonly callIds = new Set<string>();
	/** Set when a usage report that cannot be placed arrived during this step: its own counts are then uncertain. */
	private usageUncertain = false;
	/** Whether the tool-requesting call's own usage arrived before the step settled. */
	private toolUseUsageSeen = false;
	/** Whether Copilot answered this step at all (any root message, text or reasoning), so a usage report is due. */
	private answered = false;
	/** Runs when the step stops taking events, before any settling; later usage then waits for the next step. */
	onDetach: ((step: Step) => void) | null = null;
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

	get isFinished(): boolean {
		return this.finished;
	}

	markUsageUncertain(): void {
		this.usageUncertain = true;
	}

	/** The step's own calls all reported usage, and none of it is mixed with a report it cannot place. */
	get usageComplete(): boolean {
		if (this.usageUncertain || this.usageEvents === 0) return false;
		return this.toolUse === null || this.toolUseUsageSeen;
	}

	/** The step answered (it made a model call) but settled before any usage report for it arrived. */
	get owesUsage(): boolean {
		return this.answered && this.usageEvents === 0;
	}

	private usage(data: Extract<SessionEvent, { type: "assistant.usage" }>["data"]): void {
		if (typeof data.apiCallId === "string") this.callIds.add(data.apiCallId);
		const usage = this.message.usage;
		const count = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
		const inputTokens = count(data.inputTokens);
		const outputTokens = count(data.outputTokens);
		const cacheRead = count(data.cacheReadTokens);
		const cacheWrite = count(data.cacheWriteTokens);
		// Copilot's inputTokens counts the whole prompt, cached part included, as OpenAI's prompt_tokens does.
		if (inputTokens !== undefined) usage.input += Math.max(0, inputTokens - (cacheRead ?? 0));
		usage.output += outputTokens ?? 0;
		usage.cacheRead += cacheRead ?? 0;
		usage.cacheWrite += cacheWrite ?? 0;
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		// A field counts as reported only when every call of the step sent it; an omitted field is never zero.
		// The uncached input needs the cached part too, so it is reported only beside a cache-read count.
		this.usageEvents += 1;
		if (inputTokens !== undefined && cacheRead !== undefined) this.fieldReports.input += 1;
		if (outputTokens !== undefined) this.fieldReports.output += 1;
		if (cacheRead !== undefined) this.fieldReports.cacheRead += 1;
		if (cacheWrite !== undefined) this.fieldReports.cacheWrite += 1;
		this.billing.modelCalls += 1;
		const nano = count(data.copilotUsage?.totalNanoAiu);
		if (nano !== undefined) {
			this.nanoReports += 1;
			this.nanoSum += nano;
		}
		if (typeof data.model === "string" && data.model.trim().length > 0) {
			this.message.responseModel = data.model;
			this.servedModel = data.model.trim();
		}
		if (typeof data.apiCallId === "string") this.message.responseId = data.apiCallId;
		// A step is one model call (Copilot's built-ins are off), and the router keeps settled calls' reports
		// out, so usage reaching the open step is this call's own, whatever id format it carries. Once the tool
		// request has also arrived, the step is complete (see the tool-request case for the other order).
		if (this.toolUse) {
			this.toolUseUsageSeen = true;
			this.finish("toolUse", this.toolUse);
		}
	}

	handle(event: SessionEvent): void {
		if (this.finished) return;
		// Sub-agent output never reaches Clio's transcript; Copilot's task tool is excluded anyway.
		if ((event as { agentId?: string }).agentId) return;
		switch (event.type) {
			case "assistant.message_delta":
				if (!event.data.parentToolCallId) {
					this.answered = true;
					this.text(event.data.deltaContent);
				}
				return;
			case "assistant.reasoning_delta":
				// Reasoning is model output too: a call that only reasoned still owes its usage report.
				this.answered = true;
				this.thinking(event.data.deltaContent);
				return;
			case "assistant.usage":
				if (!event.data.parentToolCallId) this.usage(event.data);
				return;
			case "assistant.message": {
				if (event.data.parentToolCallId) return;
				this.answered = true;
				if (typeof event.data.apiCallId === "string") this.callIds.add(event.data.apiCallId);
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
				// The step ends with this call's usage, so its tokens and seat units settle on this call. Without
				// usage by the deadline it settles them as unreported; a later report is not moved to another call.
				this.toolUse = ids;
				// The live runtime can report the call's usage before this message: the step is then already complete.
				if (this.usageEvents > 0) {
					this.toolUseUsageSeen = true;
					this.finish("toolUse", ids);
					return;
				}
				this.toolUseTimer = setTimeout(() => this.finish("toolUse", ids), TOOL_USE_SETTLE_MS);
				return;
			}
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
		this.onDetach?.(this);
		const settle = this.settle;
		if ((stop === "stop" || stop === "toolUse") && settle && this.billing.modelCalls > 0) {
			void settle(this)
				.then((settled) => {
					this.billing.premiumRequests = settled.premiumRequests;
					this.billing.nanoAiu = settled.nanoAiu;
				})
				.catch(() => {
					// No accounting answer leaves both quantities unknown; the step itself succeeded.
				})
				.finally(() => this.complete(stop, toolCallIds, errorText));
			return;
		}
		this.complete(stop, toolCallIds, errorText);
	}

	private complete(stop: "stop" | "toolUse" | "aborted" | "error", toolCallIds: string[], errorText?: string): void {
		this.start();
		this.closeOpenBlocks();
		// A step that reached no model call billed nothing and records no seat units.
		if (this.billing.modelCalls > 0) {
			// AI credits: the step's own reports when every call sent them, else the runtime total's growth.
			if (!this.usageUncertain && this.nanoReports === this.usageEvents) this.billing.nanoAiu = this.nanoSum;
			if (this.usageUncertain) this.billing = { premiumRequests: null, nanoAiu: null, modelCalls: this.usageEvents };
			this.message.copilotBilling = { ...this.billing };
		}
		// A count is reported only when every call of the step sent it and no unplaceable report was mixed in.
		(this.message.usage as { reportedFields?: string[] }).reportedFields = this.usageUncertain
			? []
			: Object.entries(this.fieldReports)
					.filter(([, reports]) => this.usageEvents > 0 && reports === this.usageEvents)
					.map(([field]) => field);
		if (this.billing.modelCalls > 0) {
			(this.message as { responseModelIdObservation?: unknown }).responseModelIdObservation = this.servedModel
				? { state: "reported", reportedModelId: this.servedModel }
				: { state: "not-reported" };
		}
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

class CopilotOpenCancelled extends Error {
	constructor() {
		super("Opening the Copilot session was cancelled");
		this.name = "CopilotOpenCancelled";
	}
}

/**
 * Open a conversation under a runtime hold. Cancellation does not wait for the SDK: on abort the hold is released
 * at once and the caller sees CopilotOpenCancelled, even when createSession never answers. A session that
 * arrives after the cancel is disposed (dispose is idempotent) and never used; a creation that later fails
 * needs nothing.
 */
function openConversation(
	input: Parameters<typeof openConversationHeld>[0],
	signal: AbortSignal | undefined,
): Promise<Conversation> {
	const release = holdCopilotClient();
	const opening = openConversationHeld(input);
	return new Promise<Conversation>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			release();
			reject(new CopilotOpenCancelled());
			void opening.then(
				(late) => late.dispose("The Copilot step was cancelled before its session was used."),
				() => {
					// A creation that fails after the cancel left nothing to clean up.
				},
			);
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		opening.then(
			(conversation) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				release();
				resolve(conversation);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				release();
				reject(error);
			},
		);
	});
}

async function openConversationHeld(input: {
	key: string;
	model: Model<Api>;
	systemPrompt: string;
	tools: ReadonlyArray<Tool>;
	reasoningEffort: string | undefined;
}): Promise<Conversation> {
	// The signed-in account is the authorization; a missing login fails here with `copilot login` named.
	await copilotAccount();
	const client = await copilotClient();
	let conversation: Conversation | null = null;
	const sessionId = randomUUID();
	const session = await client
		.createSession({
			sessionId,
			createSessionFsProvider: () => createCopilotSessionFs(sessionId),
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
		})
		.catch(async (error: unknown) => {
			await removeCopilotSessionRecords(sessionId).catch(() => {});
			throw error;
		});
	const opened = new Conversation({
		key: input.key,
		session,
		client,
		systemHash: hash(input.systemPrompt),
		toolsHash: toolsSignature(input.tools),
		model: input.model.id,
		reasoningEffort: input.reasoningEffort,
	});
	conversation = opened;
	await acquireBoundaries(opened);
	return opened;
}

interface Plan {
	conversation: Conversation | null;
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
	if (!best) return { conversation: null };
	const fresh = core.slice(best.synced.length);
	const first = fresh[0];
	const valid =
		best.state === "awaiting-tools"
			? first?.role === "toolResult" && fresh.every((message) => message.role !== "assistant")
			: fresh.every((message) => message.role === "user");
	return { conversation: valid ? best : null };
}

/** The runtime's totals, read once per step; null when it does not answer in time. Never retried. */
async function readMetrics(
	conversation: Conversation,
): Promise<{ seq: number; premium: number | null; nano: number | null } | null> {
	conversation.metricsSeq += 1;
	const seq = conversation.metricsSeq;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), SETTLE_METRICS_MS);
	});
	try {
		const metrics = await Promise.race([conversation.session.rpc.usage.getMetrics().catch(() => null), late]);
		if (metrics === null) return null;
		const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
		return { seq, premium: number(metrics.totalPremiumRequestCost), nano: number(metrics.totalNanoAiu) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A step's share of one cumulative total: the growth since the last boundary, when that boundary is valid and
 * this step's own usage is complete. The reading becomes the next boundary only when it is the newest one taken;
 * a quantity the reading omits, a failed reading or a late one leaves its boundary invalid.
 */
function stepShare(boundary: MetricsBoundary, reading: number | null, own: boolean, newest: boolean): number | null {
	if (!newest) return null;
	if (reading === null) {
		boundary.valid = false;
		return null;
	}
	const share = boundary.valid && own && reading >= boundary.value ? reading - boundary.value : null;
	boundary.value = reading;
	boundary.valid = true;
	return share;
}

/** The first boundary of a new session, read before its first send under the same one-second rule. */
async function acquireBoundaries(conversation: Conversation): Promise<void> {
	const reading = await readMetrics(conversation);
	const newest = reading !== null && reading.seq === conversation.metricsSeq;
	stepShare(conversation.boundaries.premiumRequests, reading?.premium ?? null, false, newest);
	stepShare(conversation.boundaries.nanoAiu, reading?.nano ?? null, false, newest);
}

async function runStep(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | StreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const step = new Step(stream, model);
	const signal = options?.signal;
	// Cancellation is observed from the first moment: an abort during any await below ends the step, and every
	// await is followed by a check, so nothing is sent to Copilot after it.
	const onAbort = () => step.finish("aborted", []);
	if (signal?.aborted) {
		onAbort();
		return;
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	void stream.result().finally(() => signal?.removeEventListener("abort", onAbort));
	const key = options?.sessionId ?? "default";
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	const systemHash = hash(systemPrompt);
	const reasoningEffort = reasoningEffortFor(model, options as SimpleStreamOptions | undefined);
	// Messages that are only per-call host framing carry no transcript identity; they still reach the model.
	const core = context.messages.filter((message): message is CoreMessage => message.role !== "system");
	const kept = core.filter((message) => fingerprint(message) !== null);
	const prints = kept.map((message) => fingerprint(message) as string);

	let { conversation } = plan(key, systemHash, kept, prints);
	const reused = conversation !== null;
	// Everything after what the session has seen, in order, host framing (reminder-only messages) included:
	// framing carries no transcript identity, but each request's own framing still reaches the model.
	const lastSeen = conversation ? kept[conversation.synced.length - 1] : undefined;
	const fresh = lastSeen ? core.slice(core.indexOf(lastSeen) + 1) : core;
	const lastKept = kept[kept.length - 1];
	const tailFraming = core
		.slice(lastKept ? core.indexOf(lastKept) + 1 : 0)
		.filter((message) => fingerprint(message) === null);

	let bound = false;
	try {
		if (!conversation) {
			evictFor(key);
			const opened = await openConversation({ key, model, systemPrompt, tools, reasoningEffort }, signal);
			if (step.isFinished) {
				// Ended another way while the session was being created: it never carries a message.
				void opened.dispose("The Copilot step was cancelled before its session was used.");
				return;
			}
			installRuntimeGoneHandler();
			installExitCleanup();
			conversations.push(opened);
			conversation = opened;
		}
		const active = conversation;
		active.busy = true;
		active.lastUsed = Date.now();
		active.activeStep = step;
		bound = true;
		step.onDetach = (finished) => {
			if (active.activeStep === finished) active.activeStep = null;
			active.retire(finished);
		};
		step.settle = async (finished) => {
			const reading = await readMetrics(active);
			const newest = reading !== null && reading.seq === active.metricsSeq;
			const own = finished.usageComplete;
			const premiumRequests = stepShare(active.boundaries.premiumRequests, reading?.premium ?? null, own, newest);
			const nanoAiu = stepShare(active.boundaries.nanoAiu, reading?.nano ?? null, own, newest);
			if (reading === null) {
				active.boundaries.premiumRequests.valid = false;
				active.boundaries.nanoAiu.valid = false;
			}
			return { premiumRequests, nanoAiu };
		};
		step.onFinish = ({ stop, toolCallIds }) => {
			active.busy = false;
			if (stop === "toolUse" || stop === "stop") {
				active.synced = [...prints, `a:${toolCallIds.join(",")}`];
				active.state = stop === "toolUse" ? "awaiting-tools" : "idle";
				active.pendingToolCallIds = toolCallIds;
			} else {
				// After an abort or error the Copilot run's state is not Clio's; the next call seeds afresh.
				remove(active, "The Copilot step ended without a result; its conversation was closed");
			}
		};
		if (step.isFinished) {
			// Aborted between planning and binding: the reused session stays as it was.
			active.activeStep = null;
			active.busy = false;
			return;
		}
		if (active.model !== model.id || active.reasoningEffort !== reasoningEffort) {
			await active.session.setModel(
				model.id,
				reasoningEffort !== undefined ? { reasoningEffort: reasoningEffort as ReasoningEffort } : undefined,
			);
			if (step.isFinished) return;
			active.model = model.id;
			active.reasoningEffort = reasoningEffort;
		}
		const toolsHash = toolsSignature(tools);
		if (reused && active.toolsHash !== toolsHash) {
			await active.session.setTools(declareTools(() => active, tools));
			if (step.isFinished) return;
			active.toolsHash = toolsHash;
		}

		if (reused && active.state === "awaiting-tools") {
			const results = fresh.filter(
				(message): message is Extract<CoreMessage, { role: "toolResult" }> => message.role === "toolResult",
			);
			const after = fresh.filter((message) => message.role === "user");
			// Copilot takes no user message while its run waits on tools, so text that followed the results rides on
			// the last one. The tool's own output and the registry's `[middleware:*]` notes stay byte-for-byte what
			// Clio produced, as on the Pi route; a reminder keeps its `<system-reminder>` frame, and a person's
			// message gets one, so none of it reads as tool output.
			const extra = after
				.map((message) => framedUserText(textOf(message.content)))
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
			const framingText = tailFraming
				.map((message) => textOf(message.content))
				.filter((text) => text.length > 0)
				.join("\n\n");
			const seed = reused
				? {
						prompt: fresh
							.map((message) => textOf(message.content))
							.filter((text) => text.length > 0)
							.join("\n\n"),
						images: fresh.flatMap((message) => imagesOf(message.content)),
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
		// The abort already settled the step; the cancelled opening has nothing more to report.
		if (error instanceof CopilotOpenCancelled) return;
		const message = error instanceof Error ? error.message : String(error);
		if (conversation && !bound) remove(conversation);
		step.finish("error", [], message);
	}
}

let runtimeGoneHandlerInstalled = false;

/** A lost runtime takes its sessions with it: settle and drop every conversation on that client. */
function installRuntimeGoneHandler(): void {
	if (runtimeGoneHandlerInstalled) return;
	runtimeGoneHandlerInstalled = true;
	onCopilotRuntimeGone((client, reason) => {
		for (const conversation of [...conversations]) if (conversation.client === client) remove(conversation, reason);
	});
}

function streamCopilot(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | StreamOptions | undefined,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// The step holds the runtime until its stream ends, so the process cannot exit under a live call.
	const release = holdCopilotClient();
	void stream.result().finally(release);
	void runStep(model, context, options, stream);
	return stream;
}

export const copilotSdkApiProvider: EngineRegisteredApiProvider = {
	api: COPILOT_SDK_API,
	stream: streamCopilot,
	streamSimple: streamCopilot,
};
