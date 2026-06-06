import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { SessionContract } from "../../domains/session/contract.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { AcpJsonRpcPeerTransport } from "./transport.js";
import type {
	AcpContentBlock,
	AcpInitializeResponse,
	AcpPromptResponse,
	AcpRequestPermissionResponse,
	AcpSessionUpdateParams,
	AcpToolCallStatus,
	AcpToolKind,
} from "./types.js";
import { ACP_SESSION_META_KEY, ACP_USAGE_META_KEY } from "./types.js";

type AcpServerEvent = unknown;
type AcpEventRecord = Record<string, unknown> & { type?: unknown };

export interface AcpServerChat {
	submit(text: string, options?: unknown): Promise<void>;
	cancel(): void;
	onEvent(handler: (event: AcpServerEvent) => void): () => void;
	isStreaming(): boolean;
	getSessionId(): string | null;
	dispose?(): void;
}

export interface ClioAcpServerOptions {
	transport: AcpJsonRpcPeerTransport;
	chat: AcpServerChat;
	session?: SessionContract;
	toolRegistry?: ToolRegistry;
	cwd?: string;
	version?: string;
	permissionTimeoutMs?: number;
}

interface AcpServerSession {
	id: string;
	cwd: string;
	activePrompt: ActivePrompt | null;
}

interface ActivePrompt {
	cancelled: boolean;
	errored: boolean;
	errorMessage?: string;
	sentAssistantChars: number;
	sentThinkingChars: number;
	stopReason: string;
	usage: AcpServerUsage;
	usageMessages: WeakSet<object>;
}

interface AcpServerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventRecord(value: unknown): AcpEventRecord {
	return isRecord(value) ? value : {};
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Maps Clio canonical tool names onto the ACP v1 `ToolKind` closed enum. The
 * kind is a UI hint; the human-readable tool name travels in `title`. Anything
 * unrecognised (dynamic/MCP tools) falls back to `other` so the discriminated
 * union always deserialises on strict clients.
 */
const TOOL_KIND_BY_NAME: Record<string, AcpToolKind> = {
	read: "read",
	ls: "read",
	read_skill: "read",
	write: "edit",
	edit: "edit",
	create_skill: "edit",
	write_plan: "edit",
	write_review: "edit",
	grep: "search",
	find: "search",
	glob: "search",
	find_symbol: "search",
	entry_points: "search",
	where_is: "search",
	workspace_context: "search",
	bash: "execute",
	run_tests: "execute",
	run_lint: "execute",
	run_build: "execute",
	package_script: "execute",
	validate_frontend: "execute",
	web_fetch: "fetch",
	git_status: "other",
	git_diff: "other",
	git_log: "other",
	dispatch: "other",
	dispatch_batch: "other",
};

function toolKind(name: string | undefined): AcpToolKind {
	if (!name) return "other";
	return TOOL_KIND_BY_NAME[name] ?? "other";
}

/** ACP `ToolCallContent[]`. The `content` variant wraps a regular ContentBlock. */
function toolCallContent(text: string): Array<{ type: "content"; content: { type: "text"; text: string } }> {
	return [{ type: "content", content: textContent(text) }];
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
	if (!isRecord(value)) return "";
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.content === "string") return value.content;
	return "";
}

function promptText(params: unknown): string {
	if (!isRecord(params)) return "";
	const prompt = params.prompt ?? params.content ?? params.message;
	const text = contentText(prompt);
	return text.trim();
}

function requestedCwd(params: unknown, fallback: string): string {
	if (!isRecord(params)) return fallback;
	const cwd = typeof params.cwd === "string" && params.cwd.trim().length > 0 ? params.cwd.trim() : fallback;
	try {
		if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
	} catch {
		// fall through to fallback
	}
	return fallback;
}

function emptyUsage(): AcpServerUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeUsage(into: AcpServerUsage, usage: unknown): void {
	if (!isRecord(usage)) return;
	into.input +=
		finite(usage.input) + finite(usage.inputTokens) + finite(usage.input_tokens) + finite(usage.prompt_tokens);
	into.output +=
		finite(usage.output) + finite(usage.outputTokens) + finite(usage.output_tokens) + finite(usage.completion_tokens);
	into.cacheRead += finite(usage.cacheRead) + finite(usage.cacheReadTokens) + finite(usage.cache_read_tokens);
	into.cacheWrite += finite(usage.cacheWrite) + finite(usage.cacheWriteTokens) + finite(usage.cache_write_tokens);
	into.reasoning += finite(usage.reasoning) + finite(usage.reasoningTokens) + finite(usage.reasoning_tokens);
}

function mergeMessageUsage(into: AcpServerUsage, message: unknown, seen?: WeakSet<object>): void {
	if (!isRecord(message)) return;
	if (seen) {
		if (seen.has(message)) return;
		seen.add(message);
	}
	mergeUsage(into, message.usage);
}

function mergeMessagesUsage(into: AcpServerUsage, messages: unknown, seen?: WeakSet<object>): void {
	if (!Array.isArray(messages)) return;
	for (const message of messages) mergeMessageUsage(into, message, seen);
}

function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	return contentText(message.content);
}

function assistantThinking(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "thinking" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("");
}

/**
 * Collapses pi-agent / Clio message stop reasons onto the ACP v1 StopReason
 * closed enum (end_turn | max_tokens | max_turn_requests | refusal | cancelled).
 * Tool-driven or unknown reasons ("stop", "toolUse", "length"…) map to
 * "end_turn"; "error" is a sentinel that the prompt handler converts into a
 * JSON-RPC error, since ACP has no error StopReason.
 */
function mapAcpStopReason(raw: unknown): string {
	switch (raw) {
		case "aborted":
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
		case "refusal":
			return "refusal";
		case "length":
		case "max_tokens":
		case "maxTokens":
			return "max_tokens";
		case "max_turn_requests":
		case "maxTurnRequests":
			return "max_turn_requests";
		default:
			return "end_turn";
	}
}

/** Applies a message's stop reason to the active prompt, tracking the error sentinel. */
function applyStopReason(active: ActivePrompt, message: unknown): void {
	const mapped = mapAcpStopReason(isRecord(message) ? message.stopReason : undefined);
	if (mapped === "error") {
		active.errored = true;
		const explicit = isRecord(message) && typeof message.errorMessage === "string" ? message.errorMessage : "";
		const text = explicit.length > 0 ? explicit : assistantText(message);
		if (text.length > 0) active.errorMessage = text;
		return;
	}
	active.errored = false;
	active.stopReason = mapped;
}

function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.output === "string") return value.output;
	if (typeof value.text === "string") return value.text;
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function toolStatus(event: AcpEventRecord): string {
	return event.isError === true ? "failed" : "completed";
}

function eventString(event: AcpEventRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = event[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function eventTextDelta(event: AcpEventRecord): string {
	const direct = eventString(event, "delta", "text");
	if (direct !== undefined) return direct;
	const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
	if (assistantEvent) {
		const nested = assistantEvent.delta;
		if (typeof nested === "string") return nested;
	}
	return "";
}

function sendUpdate(transport: AcpJsonRpcPeerTransport, sessionId: string, update: Record<string, unknown>): void {
	const params: AcpSessionUpdateParams = { sessionId, update };
	transport.notify("session/update", params);
}

function handleChatEvent(
	rawEvent: AcpServerEvent,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
): void {
	const event = eventRecord(rawEvent);
	if (event.type === "text_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentAssistantChars += text.length;
		sendUpdate(transport, sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: textContent(text),
		});
		return;
	}
	if (event.type === "thinking_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentThinkingChars += text.length;
		sendUpdate(transport, sessionId, {
			sessionUpdate: "agent_thought_chunk",
			content: textContent(text),
		});
		return;
	}
	if (event.type === "tool_execution_start") {
		const toolName = eventString(event, "toolName");
		sendUpdate(transport, sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: eventString(event, "toolCallId") ?? `tool-${Date.now()}`,
			title: toolName ?? "tool",
			kind: toolKind(toolName),
			status: "in_progress" satisfies AcpToolCallStatus,
			rawInput: isRecord(event.args) ? event.args : {},
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		const toolName = eventString(event, "toolName");
		const output = outputText(event.result);
		sendUpdate(transport, sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: eventString(event, "toolCallId") ?? `tool-${Date.now()}`,
			title: toolName ?? "tool",
			kind: toolKind(toolName),
			status: toolStatus(event),
			...(output.length > 0 ? { content: toolCallContent(output) } : {}),
			rawOutput: { result: event.result, isError: event.isError === true },
		});
		return;
	}
	if (event.type === "message_end") {
		const message = event.message;
		mergeMessageUsage(active.usage, message, active.usageMessages);
		applyStopReason(active, message);
		const thinking = assistantThinking(message);
		if (thinking.length > active.sentThinkingChars) {
			const tail = thinking.slice(active.sentThinkingChars);
			active.sentThinkingChars = thinking.length;
			sendUpdate(transport, sessionId, {
				sessionUpdate: "agent_thought_chunk",
				content: textContent(tail),
			});
		}
		const text = assistantText(message);
		if (text.length > active.sentAssistantChars) {
			const tail = text.slice(active.sentAssistantChars);
			active.sentAssistantChars = text.length;
			sendUpdate(transport, sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: textContent(tail),
			});
		}
		return;
	}
	if (event.type === "agent_end") {
		mergeMessagesUsage(active.usage, event.messages, active.usageMessages);
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const last = [...messages].reverse().find((message) => isRecord(message) && message.role === "assistant");
		if (last !== undefined) applyStopReason(active, last);
		return;
	}
	// Clio lifecycle events (agent_start, prompt_diagnostics, retry_status,
	// clio_plan_update) have no ACP v1 SessionUpdate equivalent. The prompt turn
	// is bounded by the session/prompt response, so emitting non-spec
	// `progress` updates would break strict clients. They are intentionally dropped.
}

function rawToolInput(call: { tool: string; args?: Record<string, unknown> }): Record<string, unknown> {
	return { tool: call.tool, ...(isRecord(call.args) ? call.args : {}) };
}

function installPermissionBridge(input: {
	transport: AcpJsonRpcPeerTransport;
	toolRegistry: ToolRegistry | undefined;
	activeSessionId: () => string | null;
	permissionTimeoutMs: number;
}): () => void {
	if (!input.toolRegistry) return () => {};
	let sequence = 0;
	let chain = Promise.resolve();
	return input.toolRegistry.onSuperRequired((call) => {
		const run = async (): Promise<void> => {
			const sessionId = input.activeSessionId();
			if (!sessionId) {
				input.toolRegistry?.cancelParkedCalls("ACP permission requested with no active session");
				return;
			}
			const toolCallId = `clio-permission-${++sequence}`;
			try {
				const response = await input.transport.request<AcpRequestPermissionResponse>(
					"session/request_permission",
					{
						sessionId,
						toolCall: {
							sessionUpdate: "tool_call",
							toolCallId,
							title: call.tool,
							kind: call.tool,
							status: "pending",
							rawInput: rawToolInput(call),
						},
						options: [
							{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
							{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
						],
					},
					input.permissionTimeoutMs,
				);
				if (response.outcome.outcome === "selected" && response.outcome.optionId.startsWith("allow")) {
					await input.toolRegistry?.resumeParkedCalls({ mode: "super", requestedBy: "acp-client" });
					return;
				}
				input.toolRegistry?.cancelParkedCalls("ACP client denied this tool call");
			} catch (err) {
				input.toolRegistry?.cancelParkedCalls(
					`ACP permission request failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		};
		chain = chain.then(run, run);
	});
}

export async function serveClioAcpAgent(options: ClioAcpServerOptions): Promise<number> {
	const sessions = new Map<string, AcpServerSession>();
	let initialized = false;
	let activeSessionId: string | null = null;
	const cwd = options.cwd ?? process.cwd();
	const permissionTimeoutMs = options.permissionTimeoutMs ?? 120_000;
	const unregisterPermission = installPermissionBridge({
		transport: options.transport,
		toolRegistry: options.toolRegistry,
		activeSessionId: () => activeSessionId,
		permissionTimeoutMs,
	});

	const getSession = (params: unknown): AcpServerSession => {
		if (!isRecord(params) || typeof params.sessionId !== "string") throw new Error("sessionId is required");
		const session = sessions.get(params.sessionId);
		if (!session) throw new Error(`unknown ACP session: ${params.sessionId}`);
		return session;
	};

	options.transport.onRequest("initialize", () => {
		initialized = true;
		return {
			protocolVersion: 1,
			agentInfo: {
				name: "clio-coder",
				title: "Clio Coder",
				...(options.version !== undefined ? { version: options.version } : {}),
			},
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { audio: false, embeddedContext: false, image: false },
				mcpCapabilities: { http: false, sse: false },
				// Clio mediates every tool through its own safety policy and supports an
				// explicit session/close (a documented ACP RFD, not yet in the stable
				// schema). Both are advertised via the _meta extension slot so strict
				// clients never observe a non-spec capability field.
				_meta: {
					[ACP_SESSION_META_KEY]: { close: true },
					"clio.coder/tools": "mediated",
				},
			},
			authMethods: [],
		} satisfies AcpInitializeResponse;
	});

	options.transport.onRequest("session/new", (params) => {
		if (!initialized) throw new Error("initialize must be called before session/new");
		const sessionCwd = requestedCwd(params, cwd);
		if (sessions.size === 0 && sessionCwd !== process.cwd()) process.chdir(sessionCwd);
		if (sessionCwd !== process.cwd()) {
			throw new Error(`ACP session cwd ${sessionCwd} differs from server cwd ${process.cwd()}`);
		}
		const meta = options.session?.create({ cwd: sessionCwd });
		const id = meta?.id ?? randomUUID();
		sessions.set(id, { id, cwd: sessionCwd, activePrompt: null });
		// NewSessionResponse is { sessionId, modes?, models?, _meta? }; cwd is not a
		// schema field. Clio runs a single-session-per-process server pinned to the
		// launch cwd, so no extra fields are needed.
		return { sessionId: id };
	});

	const cancel = (params: unknown): Record<string, never> => {
		const session = getSession(params);
		if (session.activePrompt) {
			session.activePrompt.cancelled = true;
			options.chat.cancel();
		}
		return {};
	};
	options.transport.onRequest("session/cancel", cancel);
	options.transport.onNotification("session/cancel", cancel);

	options.transport.onRequest("session/close", async (params) => {
		const session = getSession(params);
		if (session.activePrompt) {
			session.activePrompt.cancelled = true;
			options.chat.cancel();
		}
		if (options.session?.current()?.id === session.id) await options.session.close();
		sessions.delete(session.id);
		return {};
	});

	options.transport.onRequest("session/prompt", async (params): Promise<AcpPromptResponse> => {
		const session = getSession(params);
		if (session.activePrompt || options.chat.isStreaming()) throw new Error("ACP session already has an active prompt");
		const text = promptText(params);
		if (text.length === 0) throw new Error("prompt text is required");
		if (options.session?.current()?.id !== session.id && options.session) options.session.resume(session.id);
		const active: ActivePrompt = {
			cancelled: false,
			errored: false,
			sentAssistantChars: 0,
			sentThinkingChars: 0,
			stopReason: "end_turn",
			usage: emptyUsage(),
			usageMessages: new WeakSet<object>(),
		};
		session.activePrompt = active;
		activeSessionId = session.id;
		const unsubscribe = options.chat.onEvent((event) => handleChatEvent(event, options.transport, session.id, active));
		try {
			await options.chat.submit(text);
		} finally {
			unsubscribe();
			if (session.activePrompt === active) session.activePrompt = null;
			if (activeSessionId === session.id) activeSessionId = null;
		}
		// ACP has no error StopReason: a failed turn is signalled by failing the
		// session/prompt request itself. Cancellation takes precedence over error.
		if (active.errored && !active.cancelled) {
			throw new Error(active.errorMessage ?? "ACP prompt turn failed");
		}
		const stopReason = active.cancelled ? "cancelled" : active.stopReason;
		// PromptResponse is { stopReason, _meta? } in ACP v1; token usage is not a
		// schema field, so it travels under a namespaced _meta key.
		return {
			stopReason,
			_meta: {
				[ACP_USAGE_META_KEY]: {
					input: active.usage.input,
					output: active.usage.output,
					cacheRead: active.usage.cacheRead,
					cacheWrite: active.usage.cacheWrite,
					reasoning: active.usage.reasoning,
				},
			},
		};
	});

	return await new Promise<number>((resolve) => {
		options.transport.onClose(() => {
			unregisterPermission();
			for (const session of sessions.values()) {
				if (session.activePrompt) {
					session.activePrompt.cancelled = true;
					options.chat.cancel();
				}
			}
			resolve(0);
		});
	});
}

export type AcpPromptContent = AcpContentBlock[];
