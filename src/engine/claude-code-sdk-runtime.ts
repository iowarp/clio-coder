import { randomUUID } from "node:crypto";

import {
	type CanUseTool,
	type Query as ClaudeQuery,
	type Options as ClaudeQueryOptions,
	type PermissionMode,
	type PermissionResult,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, Usage } from "@mariozechner/pi-ai";

import type { ToolName } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type {
	SessionfulRuntime,
	SessionRuntimeSendTurnInput,
	SessionRuntimeSession,
	SessionRuntimeStartInput,
	SessionRuntimeTurnHandle,
	SessionRuntimeTurnResult,
} from "./session-runtime.js";
import type { AgentEvent, AgentMessage } from "./types.js";

type CreateClaudeQuery = (input: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeQueryOptions }) => ClaudeQuery;

interface PromptQueueItem {
	message?: SDKUserMessage;
	terminate?: boolean;
}

interface ActiveTurn {
	turnId: string;
	resolve: (result: SessionRuntimeTurnResult) => void;
	done: Promise<SessionRuntimeTurnResult>;
	text: string;
	thinking: string;
	usage: Usage;
	totalCostUsd: number;
	lastAssistantUuid?: string;
	messageStarted: boolean;
	completed: boolean;
}

interface ClaudeCodeSdkSessionContext {
	session: SessionRuntimeSession;
	promptQueue: AsyncPromptQueue;
	query: ClaudeQuery;
	emit: (event: AgentEvent) => void;
	abortController: AbortController;
	currentModel: string;
	basePermissionMode: PermissionMode;
	currentPermissionMode: PermissionMode;
	pendingApprovals: Map<string, unknown>;
	pendingUserQuestions: Map<string, unknown>;
	capturedPlans: string[];
	messages: AgentMessage[];
	activeTurn?: ActiveTurn;
	closed: boolean;
	pumpDone: Promise<void>;
}

export interface ClaudeCodeSdkRuntimeOptions {
	createQuery?: CreateClaudeQuery;
}

export interface ClaudePermissionMapping {
	permissionMode: PermissionMode;
	allowDangerouslySkipPermissions: boolean;
	tools?: string[] | { type: "preset"; preset: "claude_code" };
	allowedTools?: string[];
}

const READ_ONLY_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch"] as const;
const CLIO_TOOL_TO_CLAUDE = new Map<ToolName, string>([
	["read", "Read"],
	["write", "Write"],
	["edit", "Edit"],
	["bash", "Bash"],
	["grep", "Grep"],
	["glob", "Glob"],
	["ls", "LS"],
	["web_fetch", "WebFetch"],
]);

export function createClaudeCodeSdkRuntime(options: ClaudeCodeSdkRuntimeOptions = {}): SessionfulRuntime {
	return new ClaudeCodeSdkRuntime(options.createQuery ?? ((input) => query(input)));
}

export function mapClioModeToClaudePermission(
	mode: ModeName | undefined,
	allowedTools: ReadonlyArray<ToolName> | undefined,
): ClaudePermissionMapping {
	const mappedTools = mapAllowedTools(allowedTools);
	switch (mode) {
		case "advise":
			return {
				permissionMode: "plan",
				allowDangerouslySkipPermissions: false,
				tools: mappedTools.length > 0 ? restrictToReadOnly(mappedTools) : [...READ_ONLY_CLAUDE_TOOLS],
				allowedTools: [...READ_ONLY_CLAUDE_TOOLS],
			};
		case "super":
			return {
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				tools: mappedTools.length > 0 ? mappedTools : { type: "preset", preset: "claude_code" },
			};
		default:
			return {
				permissionMode: "default",
				allowDangerouslySkipPermissions: false,
				tools: mappedTools.length > 0 ? mappedTools : { type: "preset", preset: "claude_code" },
			};
	}
}

class ClaudeCodeSdkRuntime implements SessionfulRuntime {
	private readonly sessions = new Map<string, ClaudeCodeSdkSessionContext>();

	constructor(private readonly createQuery: CreateClaudeQuery) {}

	async startSession(
		input: SessionRuntimeStartInput,
		emit: (event: AgentEvent) => void,
	): Promise<SessionRuntimeSession> {
		const threadId = input.threadId ?? randomUUID();
		if (this.sessions.has(threadId)) throw new Error(`Claude Code SDK session already exists: ${threadId}`);

		const promptQueue = new AsyncPromptQueue();
		const abortController = new AbortController();
		const permission = mapClioModeToClaudePermission(input.mode, input.allowedTools);
		const options = buildClaudeQueryOptions(input, permission, abortController, this.canUseTool(threadId));
		const sdkQuery = this.createQuery({ prompt: promptQueue, options });
		const session: SessionRuntimeSession = {
			threadId,
			runtimeId: input.runtime.id,
			model: input.wireModelId,
			permissionMode: permission.permissionMode,
			...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
			startedAt: Date.now(),
		};
		const context: ClaudeCodeSdkSessionContext = {
			session,
			promptQueue,
			query: sdkQuery,
			emit,
			abortController,
			currentModel: input.wireModelId,
			basePermissionMode: permission.permissionMode,
			currentPermissionMode: permission.permissionMode,
			pendingApprovals: new Map(),
			pendingUserQuestions: new Map(),
			capturedPlans: [],
			messages: [],
			closed: false,
			pumpDone: Promise.resolve(),
		};
		context.pumpDone = this.consumeMessages(context);
		this.sessions.set(threadId, context);
		emit({ type: "agent_start" });
		return session;
	}

	async sendTurn(input: SessionRuntimeSendTurnInput): Promise<SessionRuntimeTurnHandle> {
		const context = this.getContext(input.threadId);
		if (context.activeTurn && !context.activeTurn.completed) {
			throw new Error(`Claude Code SDK session ${input.threadId} already has an active turn`);
		}
		if (input.wireModelId && input.wireModelId !== context.currentModel) {
			await context.query.setModel(input.wireModelId);
			context.currentModel = input.wireModelId;
			context.session = { ...context.session, model: input.wireModelId };
		}
		if (input.mode !== undefined) {
			const permission = mapClioModeToClaudePermission(input.mode, undefined);
			if (permission.permissionMode !== context.currentPermissionMode) {
				await context.query.setPermissionMode(permission.permissionMode);
				context.currentPermissionMode = permission.permissionMode;
				context.session = { ...context.session, permissionMode: permission.permissionMode };
			}
		}
		const turn = makeActiveTurn();
		context.activeTurn = turn;
		context.promptQueue.push({
			type: "user",
			message: { role: "user", content: input.task },
			parent_tool_use_id: null,
		});
		return { threadId: input.threadId, turnId: turn.turnId, done: turn.done };
	}

	async interruptTurn(threadId: string, turnId?: string): Promise<void> {
		const context = this.getContext(threadId);
		if (turnId && context.activeTurn?.turnId !== turnId) return;
		try {
			await context.query.interrupt();
		} finally {
			this.finalizeActiveTurn(context, "aborted", "interrupted by caller");
		}
	}

	async stopSession(threadId: string): Promise<void> {
		const context = this.sessions.get(threadId);
		if (!context) return;
		context.closed = true;
		context.abortController.abort();
		context.promptQueue.close();
		try {
			await context.query.interrupt();
		} catch {
			// Query may already be closed.
		}
		context.query.close();
		this.finalizeActiveTurn(context, "aborted", "session stopped");
		await context.pumpDone.catch(() => undefined);
		this.sessions.delete(threadId);
	}

	listSessions(): ReadonlyArray<SessionRuntimeSession> {
		return [...this.sessions.values()].map((context) => context.session);
	}

	readThread(threadId: string): ReadonlyArray<AgentMessage> {
		return [...this.getContext(threadId).messages];
	}

	rollbackThread(threadId: string, turns: number): ReadonlyArray<AgentMessage> {
		const context = this.getContext(threadId);
		if (turns <= 0) return [...context.messages];
		context.messages.splice(Math.max(0, context.messages.length - turns));
		return [...context.messages];
	}

	private getContext(threadId: string): ClaudeCodeSdkSessionContext {
		const context = this.sessions.get(threadId);
		if (!context) throw new Error(`Claude Code SDK session not found: ${threadId}`);
		return context;
	}

	private canUseTool(threadId: string): CanUseTool {
		return async (toolName, input, options): Promise<PermissionResult> => {
			const context = this.sessions.get(threadId);
			const requestId = options.toolUseID ?? randomUUID();
			if (context) context.pendingApprovals.set(requestId, { toolName, input, options });
			if (toolName === "AskUserQuestion") {
				if (context) context.pendingUserQuestions.set(requestId, input);
				return {
					behavior: "deny",
					message: "Clio cannot answer Claude Code AskUserQuestion prompts in this non-interactive worker yet.",
				};
			}
			if (toolName === "ExitPlanMode") {
				if (context) context.capturedPlans.push(extractPlanText(input));
				return {
					behavior: "deny",
					message: "Plan captured by Clio; refusing automatic plan exit in the worker adapter.",
					interrupt: true,
				};
			}
			if (READ_ONLY_CLAUDE_TOOLS.includes(toolName as (typeof READ_ONLY_CLAUDE_TOOLS)[number])) {
				return { behavior: "allow" };
			}
			return {
				behavior: "deny",
				message: `Clio denied native Claude Code permission request for ${toolName}; interactive approvals are not wired yet.`,
			};
		};
	}

	private async consumeMessages(context: ClaudeCodeSdkSessionContext): Promise<void> {
		try {
			for await (const message of context.query) {
				this.handleSdkMessage(context, message);
			}
			this.finalizeActiveTurn(context, "error", "Claude Code SDK stream ended before a result message");
		} catch (error) {
			if (context.closed || context.abortController.signal.aborted) {
				this.finalizeActiveTurn(context, "aborted", "Claude Code SDK stream aborted");
			} else {
				this.finalizeActiveTurn(context, "error", error instanceof Error ? error.message : String(error));
			}
		}
	}

	private handleSdkMessage(context: ClaudeCodeSdkSessionContext, message: SDKMessage): void {
		if (message.type === "system" && message.subtype === "init") {
			context.session = {
				...context.session,
				model: message.model,
				permissionMode: message.permissionMode,
				resumeSessionId: message.session_id,
			};
			context.currentModel = message.model;
			context.currentPermissionMode = message.permissionMode;
			return;
		}
		if (message.type === "stream_event") {
			this.handleStreamEvent(context, message.event as unknown);
			return;
		}
		if (message.type === "assistant") {
			this.handleAssistantSnapshot(context, message);
			return;
		}
		if (message.type === "tool_progress") {
			context.emit({
				type: "tool_execution_update",
				toolCallId: message.tool_use_id,
				toolName: message.tool_name,
				args: {},
				partialResult: { elapsedTimeSeconds: message.elapsed_time_seconds, taskId: message.task_id },
			});
			return;
		}
		if (message.type === "auth_status" && message.error) {
			this.finalizeActiveTurn(context, "error", message.error);
			return;
		}
		if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
			this.finalizeActiveTurn(context, "error", "Claude Code rate limit rejected this run");
			return;
		}
		if (message.type === "result") {
			const error =
				message.subtype === "success" ? undefined : message.errors.length > 0 ? message.errors.join("\n") : message.subtype;
			const text = message.subtype === "success" ? message.result : "";
			const override: { text?: string; usage?: Usage; sessionId?: string } = { sessionId: message.session_id };
			if (text.length > 0) override.text = text;
			const usage = normalizeSdkUsage(message.usage, message.total_cost_usd);
			if (usage) override.usage = usage;
			this.finalizeActiveTurn(context, error ? "error" : "stop", error, override);
		}
	}

	private handleStreamEvent(context: ClaudeCodeSdkSessionContext, event: unknown): void {
		const turn = context.activeTurn;
		if (!turn || !isRecord(event)) return;
		if (event.type === "content_block_start" && isRecord(event.content_block)) {
			const contentBlock = event.content_block;
			if (contentBlock.type === "tool_use") {
				const id = typeof contentBlock.id === "string" ? contentBlock.id : randomUUID();
				const name = typeof contentBlock.name === "string" ? contentBlock.name : "unknown";
				const args = isRecord(contentBlock.input) ? contentBlock.input : {};
				context.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
			}
			return;
		}
		if (event.type !== "content_block_delta" || !isRecord(event.delta)) return;
		const delta = event.delta;
		if (delta.type === "text_delta" && typeof delta.text === "string") {
			this.emitTextDelta(context, turn, delta.text);
			return;
		}
		if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
			this.emitThinkingDelta(context, turn, delta.thinking);
		}
	}

	private handleAssistantSnapshot(
		context: ClaudeCodeSdkSessionContext,
		message: Extract<SDKMessage, { type: "assistant" }>,
	): void {
		const turn = context.activeTurn;
		if (!turn) return;
		turn.lastAssistantUuid = message.uuid;
		const content = isRecord(message.message) ? message.message.content : undefined;
		const text = extractTextContent(content);
		const thinking = extractThinkingContent(content);
		if (turn.text.length === 0 && text.length > 0) turn.text = text;
		if (turn.thinking.length === 0 && thinking.length > 0) turn.thinking = thinking;
		if (isRecord(message.message)) {
			turn.usage = mergeUsage(turn.usage, normalizeSdkUsage(message.message.usage, undefined));
		}
		for (const toolCall of extractToolCalls(content)) {
			context.emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
		}
	}

	private emitTextDelta(context: ClaudeCodeSdkSessionContext, turn: ActiveTurn, delta: string): void {
		if (delta.length === 0) return;
		this.ensureMessageStarted(context, turn);
		turn.text += delta;
		const partial = this.buildAssistantMessage(context, turn, "stop");
		const assistantMessageEvent: AssistantMessageEvent = {
			type: "text_delta",
			contentIndex: turn.thinking.length > 0 ? 1 : 0,
			delta,
			partial,
		};
		context.emit({ type: "message_update", message: partial, assistantMessageEvent });
	}

	private emitThinkingDelta(context: ClaudeCodeSdkSessionContext, turn: ActiveTurn, delta: string): void {
		if (delta.length === 0) return;
		this.ensureMessageStarted(context, turn);
		turn.thinking += delta;
		const partial = this.buildAssistantMessage(context, turn, "stop");
		const assistantMessageEvent: AssistantMessageEvent = {
			type: "thinking_delta",
			contentIndex: 0,
			delta,
			partial,
		};
		context.emit({ type: "message_update", message: partial, assistantMessageEvent });
	}

	private ensureMessageStarted(context: ClaudeCodeSdkSessionContext, turn: ActiveTurn): void {
		if (turn.messageStarted) return;
		turn.messageStarted = true;
		context.emit({ type: "message_start", message: this.buildAssistantMessage(context, turn, "stop") });
	}

	private finalizeActiveTurn(
		context: ClaudeCodeSdkSessionContext,
		stopReason: AssistantMessage["stopReason"],
		errorMessage?: string,
		override?: { text?: string; usage?: Usage; sessionId?: string },
	): void {
		const turn = context.activeTurn;
		if (!turn || turn.completed) return;
		turn.completed = true;
		if (override?.text && override.text.length > 0) turn.text = override.text;
		if (override?.usage) turn.usage = override.usage;
		if (override?.sessionId) {
			context.session = { ...context.session, resumeSessionId: override.sessionId };
		}
		const message = this.buildAssistantMessage(context, turn, stopReason, errorMessage);
		if (!turn.messageStarted) context.emit({ type: "message_start", message });
		context.messages.push(message);
		context.emit({ type: "message_end", message });
		context.emit({ type: "agent_end", messages: [message] });
		turn.resolve({ messages: [message], exitCode: stopReason === "stop" ? 0 : 1 });
	}

	private buildAssistantMessage(
		context: ClaudeCodeSdkSessionContext,
		turn: ActiveTurn,
		stopReason: AssistantMessage["stopReason"],
		errorMessage?: string,
	): AssistantMessage {
		const content: AssistantMessage["content"] = [];
		if (turn.thinking.length > 0) content.push({ type: "thinking", thinking: turn.thinking });
		if (turn.text.length > 0) content.push({ type: "text", text: turn.text });
		return {
			role: "assistant",
			content,
			api: "claude-agent-sdk",
			provider: "anthropic",
			model: context.currentModel,
			...(turn.lastAssistantUuid ? { responseId: turn.lastAssistantUuid } : {}),
			usage: turn.usage,
			stopReason,
			...(errorMessage && errorMessage.length > 0 ? { errorMessage } : {}),
			timestamp: Date.now(),
		} as AssistantMessage;
	}
}

export function startClaudeCodeSdkWorkerRun(
	input: SessionRuntimeStartInput & { task: string },
	emit: (event: AgentEvent) => void,
	options: ClaudeCodeSdkRuntimeOptions = {},
): { promise: Promise<SessionRuntimeTurnResult>; abort(): void } {
	const runtime = createClaudeCodeSdkRuntime(options);
	let threadId: string | undefined;
	let turnId: string | undefined;
	const promise = (async () => {
		const session = await runtime.startSession(input, emit);
		threadId = session.threadId;
		const turnInput: SessionRuntimeSendTurnInput = {
			threadId: session.threadId,
			task: input.task,
			wireModelId: input.wireModelId,
		};
		if (input.mode !== undefined) turnInput.mode = input.mode;
		const turn = await runtime.sendTurn(turnInput);
		turnId = turn.turnId;
		try {
			return await turn.done;
		} finally {
			await runtime.stopSession(session.threadId);
		}
	})();
	return {
		promise,
		abort: () => {
			if (threadId) void runtime.interruptTurn(threadId, turnId);
		},
	};
}

class AsyncPromptQueue implements AsyncIterable<SDKUserMessage> {
	private readonly pending: PromptQueueItem[] = [];
	private readonly waiters: Array<(item: PromptQueueItem) => void> = [];
	private closed = false;

	push(message: SDKUserMessage): void {
		this.enqueue({ message });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.enqueue({ terminate: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		for (;;) {
			const item = await this.next();
			if (item.terminate) return;
			if (item.message) yield item.message;
		}
	}

	private next(): Promise<PromptQueueItem> {
		const item = this.pending.shift();
		if (item) return Promise.resolve(item);
		if (this.closed) return Promise.resolve({ terminate: true });
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	private enqueue(item: PromptQueueItem): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(item);
			return;
		}
		this.pending.push(item);
	}
}

function makeActiveTurn(): ActiveTurn {
	let resolve!: (result: SessionRuntimeTurnResult) => void;
	const done = new Promise<SessionRuntimeTurnResult>((res) => {
		resolve = res;
	});
	return {
		turnId: randomUUID(),
		resolve,
		done,
		text: "",
		thinking: "",
		usage: emptyUsage(),
		totalCostUsd: 0,
		messageStarted: false,
		completed: false,
	};
}

function buildClaudeQueryOptions(
	input: SessionRuntimeStartInput,
	permission: ClaudePermissionMapping,
	abortController: AbortController,
	canUseTool: CanUseTool,
): ClaudeQueryOptions {
	const options: ClaudeQueryOptions = {
		abortController,
		cwd: process.cwd(),
		model: input.wireModelId,
		permissionMode: permission.permissionMode,
		allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
		settingSources: ["user", "project", "local"],
		includePartialMessages: true,
		persistSession: true,
		agentProgressSummaries: true,
		env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "clio-coder/0.1" },
		systemPrompt:
			input.systemPrompt.trim().length > 0
				? { type: "preset", preset: "claude_code", append: input.systemPrompt }
				: { type: "preset", preset: "claude_code" },
		canUseTool,
	};
	const claudePath = process.env.CLIO_CLAUDE_CODE_PATH ?? input.runtime.defaultBinaryPath;
	if (claudePath) options.pathToClaudeCodeExecutable = claudePath;
	if (permission.tools) options.tools = permission.tools;
	if (permission.allowedTools) options.allowedTools = permission.allowedTools;
	if (input.resumeSessionId) options.resume = input.resumeSessionId;
	return options;
}

function mapAllowedTools(allowedTools: ReadonlyArray<ToolName> | undefined): string[] {
	if (!allowedTools) return [];
	const out: string[] = [];
	for (const tool of allowedTools) {
		const mapped = CLIO_TOOL_TO_CLAUDE.get(tool);
		if (mapped && !out.includes(mapped)) out.push(mapped);
	}
	return out;
}

function restrictToReadOnly(tools: ReadonlyArray<string>): string[] {
	const allowed = new Set<string>(READ_ONLY_CLAUDE_TOOLS);
	return tools.filter((tool) => allowed.has(tool));
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mergeUsage(current: Usage, next: Usage | undefined): Usage {
	if (!next) return current;
	return {
		input: current.input + next.input,
		output: current.output + next.output,
		cacheRead: current.cacheRead + next.cacheRead,
		cacheWrite: current.cacheWrite + next.cacheWrite,
		totalTokens: current.totalTokens + next.totalTokens,
		cost: {
			input: current.cost.input + next.cost.input,
			output: current.cost.output + next.cost.output,
			cacheRead: current.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
			total: current.cost.total + next.cost.total,
		},
	};
}

function normalizeSdkUsage(raw: unknown, totalCostUsd: number | undefined): Usage | undefined {
	if (!isRecord(raw)) {
		if (totalCostUsd === undefined) return undefined;
		return {
			...emptyUsage(),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCostUsd },
		};
	}
	const input = numeric(raw.input_tokens) ?? numeric(raw.inputTokens) ?? 0;
	const output = numeric(raw.output_tokens) ?? numeric(raw.outputTokens) ?? 0;
	const cacheRead = numeric(raw.cache_read_input_tokens) ?? numeric(raw.cacheReadInputTokens) ?? 0;
	const cacheWrite = numeric(raw.cache_creation_input_tokens) ?? numeric(raw.cacheCreationInputTokens) ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCostUsd ?? 0 },
	};
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block)) return "";
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

function extractThinkingContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block)) return "";
			return block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "";
		})
		.join("");
}

function extractToolCalls(content: unknown): ToolCall[] {
	if (!Array.isArray(content)) return [];
	const out: ToolCall[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "tool_use") continue;
		const id = typeof block.id === "string" ? block.id : randomUUID();
		const name = typeof block.name === "string" ? block.name : "unknown";
		const args = isRecord(block.input) ? block.input : {};
		out.push({ type: "toolCall", id, name, arguments: args });
	}
	return out;
}

function extractPlanText(input: Record<string, unknown>): string {
	for (const key of ["plan", "content", "text", "message"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return JSON.stringify(input);
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
