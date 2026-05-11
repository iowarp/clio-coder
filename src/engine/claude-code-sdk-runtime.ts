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
import type { SafetyContract } from "../domains/safety/contract.js";
import { evaluateClaudeToolCall, mapClaudeToolName } from "./sdk-policy-bridge.js";
import type {
	SessionfulRuntime,
	SessionRuntimeHook,
	SessionRuntimeSendTurnInput,
	SessionRuntimeSession,
	SessionRuntimeStartInput,
	SessionRuntimeTurnHandle,
	SessionRuntimeTurnResult,
} from "./session-runtime.js";
import type { AgentEvent, AgentMessage } from "./types.js";
import type { ClioToolApprovalRequest, ClioToolFinishEvent, ToolApprovalResponsePayload } from "./worker-events.js";
import { createWorkerSafety, type ToolFinishEvent } from "./worker-tools.js";

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
	mode: ModeName;
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
	safety?: SafetyContract;
	autoApprove?: "allow" | "deny";
	awaitApproval?: (requestId: string, timeoutMs?: number) => Promise<ToolApprovalResponsePayload>;
}

export interface BuildCanUseToolInput {
	safety: SafetyContract;
	mode: ModeName;
	autoApprove?: "allow" | "deny" | undefined;
	awaitApproval: (requestId: string, timeoutMs?: number) => Promise<ToolApprovalResponsePayload>;
	emit: (event: AgentEvent | ClioToolApprovalRequest | ClioToolFinishEvent) => void;
}

export function buildCanUseTool(input: BuildCanUseToolInput): CanUseTool {
	const { safety, mode, autoApprove, awaitApproval, emit } = input;
	return async (toolName, args, options): Promise<PermissionResult> => {
		if (toolName === "ExitPlanMode") {
			return {
				behavior: "deny",
				message: "Plan captured by Clio; refusing automatic plan exit.",
				interrupt: true,
			};
		}
		if (toolName === "AskUserQuestion") {
			return {
				behavior: "deny",
				message: "Clio cannot answer Claude Code AskUserQuestion prompts in non-interactive workers.",
			};
		}

		const toolArgs = isRecord(args) ? args : {};
		const startedAt = Date.now();
		const decision = evaluateClaudeToolCall(toolName, toolArgs, mode, safety);
		const clioToolName = mapClaudeToolName(toolName);
		const finishTool = clioToolName ?? `claude:${toolName}`;

		const emitFinish = (
			decisionKind: "allowed" | "blocked" | "elevated",
			outcome: "ok" | "blocked",
			reason: string | undefined,
		): void => {
			const payload: ToolFinishEvent = {
				tool: finishTool,
				mode,
				durationMs: Math.max(0, Date.now() - startedAt),
				outcome,
				decision: decisionKind,
				actionClass: decision.classification.actionClass,
			};
			if (reason !== undefined) payload.reason = reason;
			if (decision.policy?.ruleId !== undefined) payload.ruleId = decision.policy.ruleId;
			if (decision.policy?.reasonCode !== undefined) payload.reasonCode = decision.policy.reasonCode;
			if (decision.policy?.policySource !== undefined) payload.policySource = decision.policy.policySource;
			emit({ type: "clio_tool_finish", payload });
		};

		if (decision.decision === "allow") {
			emitFinish("allowed", "ok", undefined);
			return { behavior: "allow" };
		}
		if (decision.decision === "block") {
			emitFinish("blocked", "blocked", decision.reason);
			return { behavior: "deny", message: decision.reason };
		}

		if (autoApprove === "allow") {
			emitFinish("elevated", "ok", "auto-approved by --auto-approve allow");
			return { behavior: "allow" };
		}
		if (autoApprove === "deny") {
			emitFinish("blocked", "blocked", `auto-denied by --auto-approve deny: ${decision.reason}`);
			return { behavior: "deny", message: decision.reason };
		}

		const requestId = options.toolUseID ?? randomUUID();
		const payload = {
			requestId,
			claudeToolName: toolName,
			clioToolName,
			args: toolArgs,
			classification: {
				actionClass: decision.classification.actionClass,
				reasons: decision.classification.reasons,
			},
			...(decision.rejection ? { rejection: decision.rejection } : {}),
			mode,
		} satisfies ClioToolApprovalRequest["payload"];
		emit({ type: "clio_tool_approval_request", payload });

		try {
			const response = await awaitApproval(requestId);
			if (response.decision === "allow") {
				emitFinish("elevated", "ok", response.reason ?? "approved via supervised IPC");
				return { behavior: "allow" };
			}
			const denyReason = response.reason ?? "user denied";
			emitFinish("blocked", "blocked", denyReason);
			return { behavior: "deny", message: denyReason };
		} catch (err) {
			const errMessage = err instanceof Error ? err.message : "approval channel error";
			emitFinish("blocked", "blocked", errMessage);
			return { behavior: "deny", message: errMessage };
		}
	};
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
	return new ClaudeCodeSdkRuntime(
		options.createQuery ?? createFauxAskQueryFromEnv() ?? ((input) => query(input)),
		options,
	);
}

function createFauxAskQueryFromEnv(): CreateClaudeQuery | null {
	if (process.env.CLIO_CLAUDE_SDK_FAUX_ASK !== "1") return null;
	return ({ prompt, options }) => {
		async function* iterate(): AsyncGenerator<SDKMessage, void> {
			for await (const _message of prompt) {
				const toolName = process.env.CLIO_CLAUDE_SDK_FAUX_TOOL ?? "MysteryTool";
				const toolUseID = process.env.CLIO_CLAUDE_SDK_FAUX_TOOL_USE_ID ?? "tool-approval-e2e";
				const args = readFauxAskArgs();
				const result = await options.canUseTool?.(toolName, args, {
					toolUseID,
					signal: new AbortController().signal,
				} as never);
				yield fauxSdkResultMessage(result?.behavior === "allow" ? "approval allowed" : "approval denied");
				return;
			}
		}
		const generator = iterate();
		return Object.assign(generator, {
			async interrupt() {},
			async setPermissionMode(_mode: string) {},
			async setModel(_model?: string) {},
			async setMaxThinkingTokens(_maxThinkingTokens: number | null) {},
			close() {},
		}) as ClaudeQuery;
	};
}

function readFauxAskArgs(): Record<string, unknown> {
	const raw = process.env.CLIO_CLAUDE_SDK_FAUX_ARGS;
	if (!raw) return { path: "package.json" };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		return { path: raw };
	}
	return { path: String(raw) };
}

function fauxSdkResultMessage(text: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: text,
		stop_reason: "stop",
		total_cost_usd: 0,
		usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
		modelUsage: {},
		permission_denials: [],
		uuid: "faux-sdk-result",
		session_id: "faux-sdk-session",
	} as never;
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
			if (process.env.CLIO_ALLOW_EXTERNAL_FULL_ACCESS !== "1") {
				return {
					permissionMode: "default",
					allowDangerouslySkipPermissions: false,
					tools: mappedTools.length > 0 ? mappedTools : { type: "preset", preset: "claude_code" },
				};
			}
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
	private readonly sessionStartHooks: SessionRuntimeHook[] = [];
	private readonly sessionEndHooks: SessionRuntimeHook[] = [];
	private readonly safety: SafetyContract;
	private readonly autoApprove: "allow" | "deny" | undefined;
	private readonly awaitApproval: (requestId: string, timeoutMs?: number) => Promise<ToolApprovalResponsePayload>;

	constructor(
		private readonly createQuery: CreateClaudeQuery,
		options: ClaudeCodeSdkRuntimeOptions = {},
	) {
		this.safety = options.safety ?? createWorkerSafety({ cwd: process.cwd() });
		this.autoApprove = options.autoApprove;
		this.awaitApproval =
			options.awaitApproval ??
			(async () => {
				throw new Error("approval channel unavailable");
			});
	}

	onSessionStart(hook: SessionRuntimeHook): () => void {
		this.sessionStartHooks.push(hook);
		return () => {
			const index = this.sessionStartHooks.indexOf(hook);
			if (index >= 0) this.sessionStartHooks.splice(index, 1);
		};
	}

	onSessionEnd(hook: SessionRuntimeHook): () => void {
		this.sessionEndHooks.push(hook);
		return () => {
			const index = this.sessionEndHooks.indexOf(hook);
			if (index >= 0) this.sessionEndHooks.splice(index, 1);
		};
	}

	private async runSessionHooks(
		hooks: ReadonlyArray<SessionRuntimeHook>,
		session: SessionRuntimeSession,
	): Promise<void> {
		for (const hook of hooks) await hook({ threadId: session.threadId, session });
	}

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
			mode: input.mode ?? "default",
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
		try {
			await this.runSessionHooks(this.sessionStartHooks, session);
		} catch (err) {
			await this.stopSession(threadId).catch(() => undefined);
			throw err;
		}
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
			context.mode = input.mode;
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
		await this.runSessionHooks(this.sessionEndHooks, context.session);
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
			const canUseTool = buildCanUseTool({
				safety: this.safety,
				mode: context?.mode ?? "default",
				autoApprove: this.autoApprove,
				awaitApproval: this.awaitApproval,
				emit: (event) => {
					context?.emit(event as AgentEvent);
				},
			});
			return canUseTool(toolName, input, options);
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

export interface ClaudeCodeSdkWorkerRunInput extends SessionRuntimeStartInput {
	task: string;
	safety?: SafetyContract;
	autoApprove?: "allow" | "deny";
	awaitApproval?: (requestId: string, timeoutMs?: number) => Promise<ToolApprovalResponsePayload>;
}

export function startClaudeCodeSdkWorkerRun(
	input: ClaudeCodeSdkWorkerRunInput,
	emit: (event: AgentEvent | ClioToolApprovalRequest) => void,
	options: ClaudeCodeSdkRuntimeOptions = {},
): { promise: Promise<SessionRuntimeTurnResult>; abort(): void } {
	const runtimeOptions: ClaudeCodeSdkRuntimeOptions = { ...options };
	if (input.safety !== undefined) runtimeOptions.safety = input.safety;
	if (input.autoApprove !== undefined) runtimeOptions.autoApprove = input.autoApprove;
	if (input.awaitApproval !== undefined) runtimeOptions.awaitApproval = input.awaitApproval;
	const runtime = createClaudeCodeSdkRuntime(runtimeOptions);
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

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
