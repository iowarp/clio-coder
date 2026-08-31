import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
	BusChannels,
	type PermissionRequestedPayload,
	type PermissionResolvedPayload,
} from "../../src/core/bus-events.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import { canonicalizeExistingPath } from "../../src/core/path-canonical.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { startAcpDelegationRun } from "../../src/engine/acp/adapter.js";
import { AcpEventMapper } from "../../src/engine/acp/event-mapper.js";
import {
	type AcpSafeSettingsSnapshot,
	type AcpServerChat,
	type AcpSettingsControl,
	serveClioAcpAgent,
} from "../../src/engine/acp/server.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { createStdioServerTransport, createStdioTransport } from "../../src/engine/acp/transport.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { scaleWatchdog } from "../harness/load.js";

interface RpcClient {
	request<T>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void;
	notifications: unknown[];
	/** Every frame the server wrote, responses included, in arrival order. */
	frames: Array<Record<string, unknown>>;
	waitForNotification(predicate: (value: unknown) => boolean): Promise<unknown>;
	close(): void;
}

/** A JSON-RPC failure with the whole error object, not just its message. */
class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data: unknown,
	) {
		super(message);
		this.name = "RpcError";
	}
}

/** The `clio-coder/error` detail an error frame is required to carry (C001 §0). */
function errorDetail(err: unknown): Record<string, unknown> {
	ok(err instanceof RpcError, `expected a JSON-RPC failure, got ${String(err)}`);
	const data = err.data;
	ok(isRecord(data), "error.data must be present");
	const keys = Object.keys(data);
	deepStrictEqual(keys, ["_meta"], "error.data carries exactly one _meta object");
	const meta = data._meta;
	ok(isRecord(meta), "error.data._meta must be an object");
	const detail = meta["clio-coder/error"];
	ok(isRecord(detail), "error.data._meta['clio-coder/error'] must be an object");
	strictEqual(detail.version, 1);
	return detail;
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
	try {
		await promise;
	} catch (err) {
		ok(err instanceof RpcError, `expected an RpcError, got ${String(err)}`);
		return err;
	}
	throw new Error("expected the request to fail");
}

/**
 * No frame this server writes may carry a stack frame or the repository's own
 * absolute path. Both used to ride along in `-32000` `data` on every ordinary
 * error, disclosing the installation's directory layout to any client.
 */
function assertNoDisclosure(frames: ReadonlyArray<Record<string, unknown>>): void {
	for (const frame of frames) {
		if (!isRecord(frame.error)) continue;
		const serialized = JSON.stringify(frame);
		ok(!serialized.includes("    at "), `frame carries a stack: ${serialized.slice(0, 200)}`);
		ok(!serialized.includes(process.cwd()), `frame carries the repository path: ${serialized.slice(0, 200)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/**
 * True when a cut left half of a surrogate pair behind. That half has no UTF-8
 * encoding, so the peer receives a replacement character and the two chunks can
 * never be reassembled into the character the model produced.
 */
function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xdc00 && unit <= 0xdfff) return true;
		if (unit < 0xd800 || unit > 0xdbff) continue;
		const next = value.charCodeAt(index + 1);
		if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
		index += 1;
	}
	return false;
}

function pidIsAlive(pid: number | null): boolean {
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function forceCleanupPid(pid: number | null): void {
	if (pid === null) return;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
	} catch {
		// Already gone, which is the expected path.
	}
}

function forceCleanupDirectPid(pid: number | null): void {
	if (pid === null) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone, which is the expected path.
	}
}

/**
 * Both of these bound a wait on the ACP peer, not a claim that the peer is
 * quick. The budgets widen with the shard load the run carries and are used
 * verbatim when the file runs on its own.
 */
async function waitForCondition(predicate: () => boolean, budgetMs: number, message: string): Promise<void> {
	const deadline = Date.now() + scaleWatchdog(budgetMs);
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

async function within<T>(promise: Promise<T>, budgetMs: number, message: string): Promise<T> {
	const timeoutMs = scaleWatchdog(budgetMs);
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

// ACP v1 (schema 0.4.5) closed enums. Anything a Clio ACP server emits must stay
// inside these sets or strict clients (Zed/serde) reject the discriminated union.
const VALID_SESSION_UPDATES = new Set([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
	"available_commands_update",
	"current_mode_update",
]);
const VALID_TOOL_KINDS = new Set([
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other",
]);
const VALID_TOOL_CONTENT_TYPES = new Set(["content", "diff", "terminal"]);
const USAGE_META_KEY = "clio-coder/usage";

function sessionUpdates(notifications: ReadonlyArray<unknown>): Record<string, unknown>[] {
	const updates: Record<string, unknown>[] = [];
	for (const message of notifications) {
		if (!isRecord(message) || message.method !== "session/update") continue;
		if (!isRecord(message.params) || !isRecord(message.params.update)) continue;
		updates.push(message.params.update);
	}
	return updates;
}

function createRpcClient(input: PassThrough, output: PassThrough): RpcClient {
	let nextId = 1;
	let buffer = "";
	const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
	const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
	const notifications: unknown[] = [];
	const frames: Array<Record<string, unknown>> = [];
	const waiters: Array<{ predicate(value: unknown): boolean; resolve(value: unknown): void }> = [];
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const idx = buffer.indexOf("\n");
			if (idx === -1) break;
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim().length === 0) continue;
			const message = JSON.parse(line) as Record<string, unknown>;
			frames.push(message);
			if ("id" in message && ("result" in message || "error" in message)) {
				const id = Number(message.id);
				const entry = pending.get(id);
				if (!entry) continue;
				pending.delete(id);
				if (isRecord(message.error)) {
					entry.reject(
						new RpcError(Number(message.error.code), String(message.error.message ?? "RPC error"), message.error.data),
					);
				} else entry.resolve(message.result);
				continue;
			}
			if ("id" in message && typeof message.method === "string") {
				const id = Number(message.id);
				const handler = requestHandlers.get(message.method);
				if (handler) {
					Promise.resolve()
						.then(() => handler(message.params))
						.then((result) => {
							input.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
						})
						.catch((error) => {
							input.write(
								`${JSON.stringify({
									jsonrpc: "2.0",
									id,
									error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
								})}\n`,
							);
						});
					continue;
				}
			}
			notifications.push(message);
			for (let index = 0; index < waiters.length; index += 1) {
				const waiter = waiters[index];
				if (!waiter?.predicate(message)) continue;
				waiters.splice(index, 1);
				waiter.resolve(message);
				break;
			}
		}
	});
	return {
		notifications,
		frames,
		notify(method: string, params?: unknown): void {
			input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		},
		request<T>(method: string, params?: unknown): Promise<T> {
			const id = nextId++;
			// The pending entry is registered before the write: a PassThrough pair
			// delivers synchronously, and a handler that throws without reaching an
			// await answers inside this very write call. Writing first dropped that
			// answer on the floor and the caller waited forever.
			const answer = new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: (value) => resolve(value as T), reject });
			});
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return answer;
		},
		onRequest(method, handler) {
			requestHandlers.set(method, handler);
			return () => {
				requestHandlers.delete(method);
			};
		},
		waitForNotification(predicate: (value: unknown) => boolean): Promise<unknown> {
			const existing = notifications.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve) => waiters.push({ predicate, resolve }));
		},
		close(): void {
			input.end();
		},
	};
}

function createMockChat(): AcpServerChat & { submitted: string[]; cancelled: boolean } {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	const submitted: string[] = [];
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "hello from clio" }],
		stopReason: "stop",
		usage: { input: 4, output: 5 },
	};
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		submitted,
		cancelled: false,
		async submit(text: string): Promise<void> {
			streaming = true;
			submitted.push(text);
			emit({ type: "agent_start" });
			emit({ type: "thinking_delta", delta: "thinking" });
			emit({ type: "text_delta", delta: "hello from clio" });
			emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "package.json" } });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: "ok",
				isError: false,
			});
			emit({ type: "message_end", message: assistant });
			emit({ type: "agent_end", messages: [assistant] });
			streaming = false;
		},
		cancel(): void {
			this.cancelled = true;
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
		dispose: () => {},
	};
}

function createResettableMockChat(): ReturnType<typeof createMockChat> & {
	resets: Array<{ leafTurnId: string | null; messages: ReadonlyArray<AgentMessage> | undefined }>;
} {
	const chat = createMockChat() as ReturnType<typeof createMockChat> & {
		resets: Array<{ leafTurnId: string | null; messages: ReadonlyArray<AgentMessage> | undefined }>;
	};
	chat.resets = [];
	chat.resetForSession = (leafTurnId, messages) => {
		chat.resets.push({ leafTurnId, messages });
	};
	return chat;
}

function createLoopEventMockChat(bus: SafeEventBus): ReturnType<typeof createMockChat> {
	const chat = createMockChat();
	const submit = chat.submit.bind(chat);
	chat.submit = async (text: string): Promise<void> => {
		bus.emit(BusChannels.LoopBlocked, {
			tool: "bash",
			repeatCount: 3,
			blocksThisTurn: 1,
			budget: 3,
			interrupted: false,
			disposition: "block",
			at: Date.now(),
			turnId: "turn-1",
		});
		bus.emit(BusChannels.LoopBlocked, {
			tool: "bash",
			repeatCount: 4,
			blocksThisTurn: 3,
			budget: 3,
			interrupted: false,
			disposition: "lockout",
			at: Date.now(),
			turnId: "turn-1",
		});
		await submit(text);
	};
	return chat;
}

function sessionMeta(input: Partial<SessionMeta> & Pick<SessionMeta, "id" | "cwd">): SessionMeta {
	return {
		...input,
		id: input.id,
		cwd: input.cwd,
		cwdHash: input.cwdHash ?? "test-cwd-hash",
		createdAt: input.createdAt ?? "2026-08-18T12:00:00.000Z",
		endedAt: input.endedAt === undefined ? "2026-08-18T12:01:00.000Z" : input.endedAt,
		model: input.model ?? null,
		target: input.target ?? null,
		clioVersion: input.clioVersion ?? "test",
		piMonoVersion: input.piMonoVersion ?? "test",
		platform: input.platform ?? "test",
		nodeVersion: input.nodeVersion ?? "test",
		sessionFormatVersion: input.sessionFormatVersion ?? 3,
	};
}

function createAcpSessionStore(input: {
	cwd: string;
	metas?: ReadonlyArray<SessionMeta>;
	leafById?: Readonly<Record<string, string | null>>;
}): {
	contract: SessionContract;
	metas: Map<string, SessionMeta>;
	createInputs: Array<{ cwd?: string; model?: string; target?: string } | undefined>;
	deleted: string[];
} {
	const metas = new Map((input.metas ?? []).map((meta) => [meta.id, meta]));
	const createInputs: Array<{ cwd?: string; model?: string; target?: string } | undefined> = [];
	const deleted: string[] = [];
	let current: SessionMeta | null = null;
	const contract = {
		current: () => current,
		create(createInput?: { cwd?: string; model?: string; target?: string }) {
			createInputs.push(createInput);
			const meta = sessionMeta({
				id: `new-session-${createInputs.length}`,
				cwd: createInput?.cwd ?? input.cwd,
				endedAt: null,
				target: createInput?.target ?? null,
				model: createInput?.model ?? null,
			});
			metas.set(meta.id, meta);
			current = meta;
			return meta;
		},
		resume(id: string) {
			const meta = metas.get(id);
			if (!meta) throw new Error("unknown session");
			meta.endedAt = null;
			current = meta;
			return meta;
		},
		tree(id?: string) {
			const sessionId = id ?? current?.id ?? "";
			return { rootIds: [], nodesById: {}, childrenById: {}, leafId: input.leafById?.[sessionId] ?? null };
		},
		setName(name: string, id?: string) {
			const meta = metas.get(id ?? current?.id ?? "");
			if (!meta) throw new Error("unknown session");
			meta.name = name;
		},
		deleteSession(id: string) {
			if (!metas.delete(id)) throw new Error("unknown session");
			deleted.push(id);
		},
		history: () => [...metas.values()],
		async close() {
			if (current) current.endedAt = "2026-08-18T12:02:00.000Z";
			current = null;
		},
	} as unknown as SessionContract;
	return { contract, metas, createInputs, deleted };
}

function createCancellableMockChat(): AcpServerChat & { cancelled: boolean; started: Promise<void> } {
	const listeners = new Set<(event: unknown) => void>();
	let streaming = false;
	let resolveSubmit: (() => void) | null = null;
	let resolveStarted: (() => void) | null = null;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const emit = (event: unknown): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		cancelled: false,
		started,
		async submit(): Promise<void> {
			streaming = true;
			resolveStarted?.();
			emit({ type: "agent_start" });
			await new Promise<void>((resolve) => {
				resolveSubmit = resolve;
			});
		},
		cancel(): void {
			this.cancelled = true;
			streaming = false;
			const assistant = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "aborted",
				errorMessage: "request aborted",
			};
			emit({ type: "message_end", message: assistant });
			emit({ type: "agent_end", messages: [assistant] });
			resolveSubmit?.();
		},
		onEvent(handler: (event: unknown) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
		dispose: () => {},
	};
}

// Emits an intermediate assistant message that stops for a tool call (pi-ai
// stopReason "toolUse"), runs the tool, then finishes normally ("stop"). The
// turn's reported StopReason must collapse to the ACP-valid "end_turn".
function createToolUseMockChat(): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "agent_start" });
			emit({ type: "text_delta", delta: "calling tool" });
			emit({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "calling tool" }], stopReason: "toolUse" },
			});
			emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "x" } });
			emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false });
			emit({ type: "text_delta", delta: " done" });
			const final = { role: "assistant", content: [{ type: "text", text: "calling tool done" }], stopReason: "stop" };
			emit({ type: "message_end", message: final });
			emit({ type: "agent_end", messages: [final] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
		dispose: () => {},
	};
}

// A turn that fails (pi-ai stopReason "error", which has no ACP StopReason).
// The failure text is a parameter because it is the thing the wire contract
// bounds: a caller can hand it a provider body full of paths and credentials.
function createErroringMockChat(errorMessage = "provider exploded"): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "agent_start" });
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "error",
				errorMessage,
			};
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
		dispose: () => {},
	};
}

async function runChat(
	chat: AcpServerChat,
): Promise<{ prompt: Promise<Record<string, unknown>>; close(): Promise<void> }> {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const server = serveClioAcpAgent({ transport, chat, cwd: process.cwd(), version: "test" });
	const client = createRpcClient(clientToServer, serverToClient);
	await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "mock-client", version: "1" } });
	const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
	const prompt = client.request<Record<string, unknown>>("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "go" }],
	});
	return {
		prompt,
		async close(): Promise<void> {
			client.close();
			await server;
		},
	};
}

interface AcpServerHarness {
	client: RpcClient;
	server: Promise<number>;
}

/** One in-process server plus a client wired to it over a PassThrough pair. */
function startAcpServer(input: {
	chat: AcpServerChat;
	cwd?: string;
	session?: SessionContract;
	providers?: ProvidersContract;
	settings?: AcpSettingsControl;
	routing?: () => { target: string | null; model: string | null };
	readSessionEntries?: (sessionId: string) => ReadonlyArray<SessionEntry>;
	buildReplayMessages?: (entries: ReadonlyArray<SessionEntry>, leafTurnId: string | null) => ReadonlyArray<AgentMessage>;
	toolRegistry?: ToolRegistry;
	bus?: SafeEventBus;
	permissionTimeoutMs?: number;
	autonomy?: () => AutonomyLevel;
	onActiveSessionAutonomyChange?: (level: AutonomyLevel | null) => void;
	diagnostics?: (line: string) => void;
}): AcpServerHarness {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const server = serveClioAcpAgent({ cwd: process.cwd(), version: "test", ...input, transport });
	return { client: createRpcClient(clientToServer, serverToClient), server };
}

/** Initializes and opens the one session this server hosts. */
async function openSession(client: RpcClient, cwd: string = process.cwd()): Promise<string> {
	await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "mock-client", version: "1" } });
	const session = await client.request<{ sessionId: string }>("session/new", { cwd });
	return session.sessionId;
}

interface ServerPromptRun {
	init: Record<string, unknown>;
	session: { sessionId: string };
	prompt: Record<string, unknown>;
	chat: ReturnType<typeof createMockChat>;
	notifications: unknown[];
	code: number;
}

async function runServerPrompt(): Promise<ServerPromptRun> {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const chat = createMockChat();
	const server = serveClioAcpAgent({ transport, chat, cwd: process.cwd(), version: "test" });
	const client = createRpcClient(clientToServer, serverToClient);
	const init = await client.request<Record<string, unknown>>("initialize", {
		protocolVersion: 1,
		clientInfo: { name: "mock-client", version: "1" },
	});
	const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
	const prompt = await client.request<Record<string, unknown>>("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "say hello" }],
	});
	await client.request("session/close", { sessionId: session.sessionId });
	client.close();
	const code = await server;
	return { init, session, prompt, chat, notifications: client.notifications, code };
}

const safety: SafetyContract = {
	classify: () => ({ actionClass: "read", reasons: [] }),
	evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
	observeLoop: () => ({ looping: false, key: "test", count: 0 }),
	scopes: {
		readonly: READONLY_SCOPE,
		workspace: WORKSPACE_SCOPE,
		confirmed: CONFIRMED_SCOPE,
	},
	isSubset,
	audit: { recordCount: () => 0 },
};

const askSafety: SafetyContract = {
	classify: () => ({ actionClass: "execute", reasons: ["test"] }),
	evaluate: () => ({
		kind: "ask",
		classification: { actionClass: "execute", reasons: ["test"] },
		rejection: { short: "approval required", detail: "approval required", hints: [] },
	}),
	observeLoop: () => ({ looping: false, key: "test", count: 0 }),
	scopes: {
		readonly: READONLY_SCOPE,
		workspace: WORKSPACE_SCOPE,
		confirmed: CONFIRMED_SCOPE,
	},
	isSubset,
	audit: { recordCount: () => 0 },
};

const allowWriteSafety: SafetyContract = {
	classify: () => ({ actionClass: "write", reasons: ["test"] }),
	evaluate: () => ({ kind: "allow", classification: { actionClass: "write", reasons: ["test"] } }),
	observeLoop: () => ({ looping: false, key: "test", count: 0 }),
	scopes: {
		readonly: READONLY_SCOPE,
		workspace: WORKSPACE_SCOPE,
		confirmed: CONFIRMED_SCOPE,
	},
	isSubset,
	audit: { recordCount: () => 0 },
};

interface EvaluatedSafetyCall {
	tool: string;
	args: Record<string, unknown>;
}

function targetRecordingSafety(
	calls: EvaluatedSafetyCall[],
	blockedPaths: ReadonlySet<string> = new Set(),
): SafetyContract {
	return {
		...allowWriteSafety,
		evaluate(call) {
			const args = { ...(call.args ?? {}) };
			calls.push({ tool: call.tool, args });
			if (typeof args.path === "string" && blockedPaths.has(args.path)) {
				return {
					kind: "block",
					classification: { actionClass: "write", reasons: ["blocked test target"] },
					rejection: { short: "blocked test target", detail: "blocked test target", hints: [] },
				};
			}
			return { kind: "allow", classification: { actionClass: "write", reasons: ["test"] } };
		},
	};
}

function permissionSpec(name: string, baseActionClass: ActionClass): ToolSpec {
	return {
		name: name as ToolName,
		description: "ACP permission bridge test tool",
		parameters: Type.Object({}),
		baseActionClass,
		run: async () => ({ kind: "ok", output: "ran" }),
	};
}

function createPermissionRegistry(): ToolRegistry {
	const registry = createRegistry({ safety: askSafety });
	registry.register(permissionSpec(ToolNames.Bash, "execute"));
	return registry;
}

function createPermissionChat(registry: ToolRegistry): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			// The engine announces a call before it runs, so the permission bridge
			// always has a tool_call the client already rendered to bind to.
			const args = { command: "sudo true" };
			emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args });
			const verdict = await registry.invoke({ tool: ToolNames.Bash, args }, { toolCallId: "bash-1" });
			emit({
				type: "tool_execution_end",
				toolCallId: "bash-1",
				toolName: "bash",
				result: verdict.kind,
				isError: verdict.kind !== "ok",
			});
			const message = {
				role: "assistant",
				content: [{ type: "text", text: verdict.kind === "ok" ? "allowed" : "denied" }],
				stopReason: "stop",
				usage: { input: 1, output: 1 },
			};
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

function createQueuedPermissionChat(registry: ToolRegistry): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			const firstArgs = { command: "sudo true one" };
			const secondArgs = { command: "sudo true two" };
			emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: firstArgs });
			emit({ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash", args: secondArgs });
			const first = registry.invoke({ tool: ToolNames.Bash, args: firstArgs }, { toolCallId: "bash-1" });
			const second = registry.invoke({ tool: ToolNames.Bash, args: secondArgs }, { toolCallId: "bash-2" });
			const verdicts = await Promise.all([first, second]);
			const message = {
				role: "assistant",
				content: [{ type: "text", text: verdicts.map((verdict) => verdict.kind).join(",") }],
				stopReason: "stop",
				usage: { input: 1, output: 1 },
			};
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/**
 * Opens `openCalls` tool calls, then asks for permission through a call the
 * engine gave no id for. That is the shape the bridge has to bind by itself.
 */
function createUnidentifiedPermissionChat(registry: ToolRegistry, openCalls: number): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			for (let index = 1; index <= openCalls; index += 1) {
				emit({
					type: "tool_execution_start",
					toolCallId: `engine-${index}`,
					toolName: "bash",
					args: { command: `sudo true ${index}` },
				});
			}
			const verdict = await registry.invoke({ tool: ToolNames.Bash, args: { command: "sudo true" } });
			const message = {
				role: "assistant",
				content: [{ type: "text", text: verdict.kind }],
				stopReason: "stop",
			};
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/**
 * Opens one tool call and then asks for permission under an engine id no
 * `tool_call` was ever emitted for. Binding that id would put an approval on a
 * call the client has no way to show.
 */
function createMistargetedPermissionChat(registry: ToolRegistry): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "tool_execution_start", toolCallId: "engine-1", toolName: "bash", args: { command: "sudo true" } });
			const verdict = await registry.invoke(
				{ tool: ToolNames.Bash, args: { command: "sudo true" } },
				{ toolCallId: "never-started" },
			);
			const message = { role: "assistant", content: [{ type: "text", text: verdict.kind }], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/**
 * Starts two calls under one engine id, optionally ends both, then asks for
 * permission under that id. An engine that numbers its calls per request
 * legitimately repeats an id, so the bridge has to pick which of the two the
 * operator is being asked about.
 */
function createReusedIdPermissionChat(registry: ToolRegistry, options: { endBoth: boolean }): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "sudo true one" } });
			emit({ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "sudo true two" } });
			if (options.endBoth) {
				emit({ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: "ok" });
				emit({ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: "ok" });
			}
			const verdict = await registry.invoke(
				{ tool: ToolNames.Bash, args: { command: "sudo true three" } },
				{ toolCallId: "dup" },
			);
			const message = { role: "assistant", content: [{ type: "text", text: verdict.kind }], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

function createWriteChat(registry: ToolRegistry): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			const args = { file_path: "notes/acp-autonomy.txt", content: "x" };
			emit({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args });
			const verdict = await registry.invoke({ tool: ToolNames.Write, args }, { toolCallId: "write-1" });
			const message = {
				role: "assistant",
				content: [{ type: "text", text: verdict.kind }],
				stopReason: "stop",
				usage: { input: 1, output: 1 },
			};
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/** A chat that only reports a notice and returns, the way an unadmitted turn does. */
function createNoticeChat(notice: Record<string, unknown>, options: { endTurn: boolean }): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "notice", ...notice });
			if (options.endTurn) {
				const message = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
				emit({ type: "message_end", message });
				emit({ type: "agent_end", messages: [message] });
			}
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/** A chat that replays a fixed event script and ends the turn. */
function createScriptedChat(events: ReadonlyArray<Record<string, unknown>>): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			for (const event of events) emit(event);
			const message = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/** Starts a tool call and never ends it, so cancel has an open call to settle. */
function createOpenToolChat(): AcpServerChat & { started: Promise<void> } {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	let resolveSubmit: (() => void) | null = null;
	let resolveStarted: (() => void) | null = null;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		started,
		async submit(): Promise<void> {
			streaming = true;
			emit({ type: "tool_execution_start", toolCallId: "engine-call-1", toolName: "bash", args: { command: "sleep 9" } });
			resolveStarted?.();
			await new Promise<void>((resolve) => {
				resolveSubmit = resolve;
			});
		},
		cancel(): void {
			streaming = false;
			resolveSubmit?.();
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/**
 * Turn one opens a tool call and blocks until it is cancelled. Turn two replays
 * the `tool_execution_end` that call never received, which is where a real
 * engine's late tool result lands once the cancelled turn has already been
 * swept and its listener detached.
 */
function createLateEndChat(): AcpServerChat & { started: Promise<void> } {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	let turns = 0;
	let resolveSubmit: (() => void) | null = null;
	let resolveStarted: (() => void) | null = null;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		started,
		async submit(): Promise<void> {
			streaming = true;
			turns += 1;
			if (turns === 1) {
				emit({
					type: "tool_execution_start",
					toolCallId: "engine-call-1",
					toolName: "bash",
					args: { command: "sleep 9" },
				});
				resolveStarted?.();
				await new Promise<void>((resolve) => {
					resolveSubmit = resolve;
				});
				return;
			}
			emit({ type: "tool_execution_end", toolCallId: "engine-call-1", toolName: "bash", result: "late" });
			const message = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
			resolveSubmit?.();
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/**
 * Announces a tool call to the client and then parks it on the permission
 * bridge under the same engine id, which is what makes the request's identity
 * bindable to the `tool_call` the client already rendered.
 */
function createIdentifiedPermissionChat(
	registry: ToolRegistry,
	call: { tool: ToolName; args: Record<string, unknown> } = {
		tool: ToolNames.Bash,
		args: { command: "sudo true" },
	},
): AcpServerChat & { parked: Promise<void> } {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	let resolveParked: (() => void) | null = null;
	const parked = new Promise<void>((resolve) => {
		resolveParked = resolve;
	});
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		parked,
		async submit(): Promise<void> {
			streaming = true;
			emit({
				type: "tool_execution_start",
				toolCallId: "engine-call-1",
				toolName: call.tool,
				args: call.args,
			});
			const verdict = await registry.invoke(call, { toolCallId: "engine-call-1", onParked: () => resolveParked?.() });
			emit({ type: "tool_execution_end", toolCallId: "engine-call-1", toolName: call.tool, result: verdict.kind });
			const message = { role: "assistant", content: [{ type: "text", text: verdict.kind }], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

/** A safety net that parks every call and records the arguments it evaluated. */
function recordingAskSafety(evaluated: EvaluatedSafetyCall[]): SafetyContract {
	return {
		...askSafety,
		evaluate(call) {
			evaluated.push({ tool: call.tool, args: { ...(call.args ?? {}) } });
			return {
				kind: "ask",
				classification: { actionClass: "write", reasons: ["test"] },
				rejection: { short: "approval required", detail: "approval required", hints: [] },
			};
		},
	};
}

/**
 * A registry whose one tool replaces its arguments during admission, the way
 * `prepareAdmissionArguments` does for every approval-sensitive tool: the path
 * becomes absolute and a prepared field appears. Everything downstream of
 * admission, the permission listener included, sees the replacement, so this is
 * the fixture where the ask's arguments and the rendered call's arguments can
 * legitimately disagree.
 */
function createNormalizingPermissionRegistry(safety: SafetyContract): ToolRegistry {
	const registry = createRegistry({ safety });
	registry.register({
		name: ToolNames.Write,
		description: "ACP permission snapshot test tool",
		parameters: Type.Object({}),
		baseActionClass: "write",
		prepareAdmissionArguments: (args) => ({
			...args,
			path: resolve(realpathSync(process.cwd()), String(args.path ?? "")),
			prepared: true,
		}),
		run: async () => ({ kind: "ok", output: "ran" }),
	});
	return registry;
}

/**
 * Announces a path-bearing call with the engine's own relative arguments, then
 * parks it under the same engine id. The registry normalizes on the way in, so
 * the arguments the bridge is handed are not the arguments the client rendered.
 */
function createNormalizedArgsPermissionChat(
	registry: ToolRegistry,
	argsInput: Record<string, unknown> = { path: "notes/acp-snapshot.txt", content: "x" },
): AcpServerChat {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	let streaming = false;
	const emit = (event: Record<string, unknown>): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		async submit(): Promise<void> {
			streaming = true;
			const args = argsInput;
			emit({ type: "tool_execution_start", toolCallId: "engine-call-1", toolName: "write", args });
			const verdict = await registry.invoke({ tool: ToolNames.Write, args }, { toolCallId: "engine-call-1" });
			emit({ type: "tool_execution_end", toolCallId: "engine-call-1", toolName: "write", result: verdict.kind });
			const message = { role: "assistant", content: [{ type: "text", text: verdict.kind }], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
			streaming = false;
		},
		cancel(): void {
			streaming = false;
		},
		onEvent(handler: (event: Record<string, unknown>) => void): () => void {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		isStreaming: () => streaming,
		getSessionId: () => null,
	};
}

async function runAcpPermissionBridge(outcome: "allow" | "reject" | "timeout" | "allow-always"): Promise<{
	requests: PermissionRequestedPayload[];
	resolutions: PermissionResolvedPayload[];
	answer: string;
	promptErrorCode: string | null;
}> {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const registry = createPermissionRegistry();
	const bus = createSafeEventBus();
	const requests: PermissionRequestedPayload[] = [];
	const resolutions: PermissionResolvedPayload[] = [];
	bus.on(BusChannels.PermissionRequested, (payload) => {
		requests.push(payload);
	});
	bus.on(BusChannels.PermissionResolved, (payload) => {
		resolutions.push(payload);
	});
	registry.onPermissionRequired((call, decision, meta) => {
		bus.emit(BusChannels.PermissionRequested, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			origin: "acp-server",
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
		});
	});
	const chat = createPermissionChat(registry);
	const server = serveClioAcpAgent({
		transport,
		chat,
		toolRegistry: registry,
		bus,
		cwd: process.cwd(),
		version: "test",
		permissionTimeoutMs: outcome === "timeout" ? 20 : 1000,
	});
	const client = createRpcClient(clientToServer, serverToClient);
	const optionIdFor: Record<string, string> = {
		allow: "allow-once",
		reject: "reject-once",
		"allow-always": "allow-always",
	};
	if (outcome !== "timeout") {
		client.onRequest("session/request_permission", () => ({
			outcome: { outcome: "selected", optionId: optionIdFor[outcome] },
		}));
	}
	const sessionId = await openSession(client);
	let promptErrorCode: string | null = null;
	try {
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "need permission" }] });
	} catch (err) {
		if (outcome !== "timeout") throw err;
		promptErrorCode = String(errorDetail(err).code);
	}
	await client.request("session/close", { sessionId });
	client.close();
	await server;
	const answer = sessionUpdates(client.notifications)
		.filter((update) => update.sessionUpdate === "agent_message_chunk")
		.map((update) => (isRecord(update.content) ? String(update.content.text) : ""))
		.join("");
	return { requests, resolutions, answer, promptErrorCode };
}

async function runAcpQueuedPermissionBridge(): Promise<{
	requests: PermissionRequestedPayload[];
	resolutions: PermissionResolvedPayload[];
	presentedCommands: string[];
}> {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const registry = createPermissionRegistry();
	const bus = createSafeEventBus();
	const requests: PermissionRequestedPayload[] = [];
	const resolutions: PermissionResolvedPayload[] = [];
	const presentedCommands: string[] = [];
	bus.on(BusChannels.PermissionRequested, (payload) => {
		requests.push(payload);
	});
	bus.on(BusChannels.PermissionResolved, (payload) => {
		resolutions.push(payload);
	});
	registry.onPermissionRequired((call, decision, meta) => {
		bus.emit(BusChannels.PermissionRequested, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			origin: "acp-server",
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
		});
	});
	const server = serveClioAcpAgent({
		transport,
		chat: createQueuedPermissionChat(registry),
		toolRegistry: registry,
		bus,
		cwd: process.cwd(),
		version: "test",
		permissionTimeoutMs: 1000,
	});
	const client = createRpcClient(clientToServer, serverToClient);
	const outcomes = ["reject-once", "allow-once"];
	client.onRequest("session/request_permission", (params) => {
		if (isRecord(params) && isRecord(params.toolCall) && isRecord(params.toolCall.rawInput)) {
			presentedCommands.push(String(params.toolCall.rawInput.command));
		}
		const optionId = outcomes.shift();
		if (!optionId) throw new Error("unexpected duplicate ACP permission request");
		return { outcome: { outcome: "selected", optionId } };
	});
	await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "mock-client", version: "1" } });
	const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
	await client.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "need queued permissions" }],
	});
	await client.request("session/close", { sessionId: session.sessionId });
	client.close();
	await server;
	return { requests, resolutions, presentedCommands };
}

async function runAcpQueuedPermissionBridgeTransportError(): Promise<{
	requests: PermissionRequestedPayload[];
	resolutions: PermissionResolvedPayload[];
	presentedCommands: string[];
}> {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
	const registry = createPermissionRegistry();
	const bus = createSafeEventBus();
	const requests: PermissionRequestedPayload[] = [];
	const resolutions: PermissionResolvedPayload[] = [];
	const presentedCommands: string[] = [];
	bus.on(BusChannels.PermissionRequested, (payload) => {
		requests.push(payload);
	});
	bus.on(BusChannels.PermissionResolved, (payload) => {
		resolutions.push(payload);
	});
	registry.onPermissionRequired((call, decision, meta) => {
		bus.emit(BusChannels.PermissionRequested, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			origin: "acp-server",
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
		});
	});
	const server = serveClioAcpAgent({
		transport,
		chat: createQueuedPermissionChat(registry),
		toolRegistry: registry,
		bus,
		cwd: process.cwd(),
		version: "test",
		permissionTimeoutMs: 1000,
	});
	const client = createRpcClient(clientToServer, serverToClient);
	client.onRequest("session/request_permission", (params) => {
		if (isRecord(params) && isRecord(params.toolCall) && isRecord(params.toolCall.rawInput)) {
			presentedCommands.push(String(params.toolCall.rawInput.command));
		}
		throw new Error("permission transport unavailable");
	});
	await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "mock-client", version: "1" } });
	const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
	await client.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "need queued permissions" }],
	});
	await client.request("session/close", { sessionId: session.sessionId });
	client.close();
	await server;
	return { requests, resolutions, presentedCommands };
}

describe("contracts/acp", () => {
	it("maps agent thought chunks from ACP agents that use the OpenCode update name", () => {
		const mapper = new AcpEventMapper();
		const events = mapper.mapUpdate({
			sessionId: "sess-1",
			update: {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "thinking through delegated task" },
			},
		});

		strictEqual(events.length, 1);
		strictEqual((events[0] as { type?: string }).type, "thinking_delta");
		strictEqual((events[0] as { text?: string }).text, "thinking through delegated task");
	});

	it("mediates ACP permission requests through configured governance", async () => {
		const mediator = new AcpToolMediator({
			safety,
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
		});
		const result = await mediator.handle({
			sessionId: "sess-1",
			toolCall: {
				toolCallId: "call-1",
				kind: "read",
				title: "Read package.json",
				rawInput: { path: "package.json" },
			},
			options: [
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
			],
		});

		strictEqual(result.outcome.outcome, "selected");
		if (result.outcome.outcome === "selected") strictEqual(result.outcome.optionId, "allow-once");
		const snapshot = mediator.snapshot();
		strictEqual(snapshot.toolCallsRequested, 1);
		strictEqual(snapshot.toolCallsApproved, 1);
		strictEqual(snapshot.toolCallLog[0]?.tool, "read");
	});

	it("authorizes canonical ACP mutation locations, never the display title", async () => {
		const options = [
			{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
			{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
		];
		for (const target of [".env", "/etc/shadow", "PLAN.md"]) {
			const canonical = canonicalizeExistingPath(resolve(process.cwd(), target));
			const calls: EvaluatedSafetyCall[] = [];
			const mediator = new AcpToolMediator({
				safety: targetRecordingSafety(calls, new Set([canonical])),
				cwd: process.cwd(),
				toolGovernance: "clio-policy",
			});
			const result = await mediator.handle({
				sessionId: "s",
				toolCall: {
					toolCallId: `location-${target}`,
					kind: "edit",
					title: "Edit harmless-package.json",
					locations: [{ path: target }],
				},
				options,
			});

			strictEqual(result.outcome.outcome, "selected");
			if (result.outcome.outcome === "selected") strictEqual(result.outcome.optionId, "reject-once");
			deepStrictEqual(calls, [{ tool: ToolNames.Edit, args: { path: canonical } }]);
			deepStrictEqual(mediator.snapshot().toolCallLog[0]?.arguments, { path: canonical });
			strictEqual(mediator.snapshot().toolCallLog[0]?.decision, "denied");
		}
	});

	it("evaluates standardized locations for reads and fails closed without a proven target", async () => {
		const options = [
			{ optionId: "allow-once", kind: "allow_once" },
			{ optionId: "reject-once", kind: "reject_once" },
		];
		for (const target of [".env", "/etc/shadow"]) {
			const canonical = canonicalizeExistingPath(resolve(process.cwd(), target));
			const calls: EvaluatedSafetyCall[] = [];
			const mediator = new AcpToolMediator({
				safety: targetRecordingSafety(calls, new Set([canonical])),
				cwd: process.cwd(),
				toolGovernance: "clio-policy",
			});
			const result = await mediator.handle({
				sessionId: "s",
				toolCall: { toolCallId: `read-${target}`, kind: "read", title: "Read package.json", locations: [{ path: target }] },
				options,
			});
			strictEqual(result.outcome.outcome, "selected");
			if (result.outcome.outcome === "selected") strictEqual(result.outcome.optionId, "reject-once");
			deepStrictEqual(calls, [{ tool: ToolNames.Read, args: { path: canonical } }]);
			deepStrictEqual(mediator.snapshot().toolCallLog[0]?.arguments, { path: canonical });
		}

		const missing = new AcpToolMediator({ safety, cwd: process.cwd(), toolGovernance: "clio-policy" });
		const missingResult = await missing.handle({
			sessionId: "s",
			toolCall: { toolCallId: "read-missing", kind: "read", title: "Read package.json" },
			options,
		});
		strictEqual(missingResult.outcome.outcome, "selected");
		if (missingResult.outcome.outcome === "selected") strictEqual(missingResult.outcome.optionId, "reject-once");
		match(missing.snapshot().toolCallLog[0]?.reason ?? "", /path target is missing/);
	});

	it("fails closed when raw mutation targets conflict with standardized locations", async () => {
		const calls: EvaluatedSafetyCall[] = [];
		const mediator = new AcpToolMediator({
			safety: targetRecordingSafety(calls),
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
		});
		const result = await mediator.handle({
			sessionId: "s",
			toolCall: {
				toolCallId: "conflicting-edit",
				kind: "edit",
				title: "Edit package.json",
				locations: [{ path: ".env" }],
				rawInput: { path: "package.json" },
			},
			options: [
				{ optionId: "allow-once", kind: "allow_once" },
				{ optionId: "reject-once", kind: "reject_once" },
			],
		});

		const envPath = canonicalizeExistingPath(join(process.cwd(), ".env"));
		const packagePath = canonicalizeExistingPath(join(process.cwd(), "package.json"));
		strictEqual(result.outcome.outcome, "selected");
		if (result.outcome.outcome === "selected") strictEqual(result.outcome.optionId, "reject-once");
		deepStrictEqual(calls, [
			{ tool: ToolNames.Edit, args: { path: envPath } },
			{ tool: ToolNames.Edit, args: { path: packagePath } },
		]);
		const log = mediator.snapshot().toolCallLog[0];
		deepStrictEqual(log?.arguments, { paths: [envPath, packagePath] });
		ok(log?.reason?.includes("conflicting mutation targets"), log?.reason);
	});

	it("fails closed when benign ACP metadata contradicts dangerous raw shapes", async () => {
		const options = [
			{ optionId: "allow-once", kind: "allow_once" },
			{ optionId: "reject-once", kind: "reject_once" },
		];
		const mutationCalls: EvaluatedSafetyCall[] = [];
		const mutation = new AcpToolMediator({
			safety: targetRecordingSafety(mutationCalls),
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
		});
		const mutationResult = await mutation.handle({
			sessionId: "s",
			toolCall: {
				toolCallId: "contradictory-read-edit",
				kind: "read",
				locations: [{ path: ".env" }],
				rawInput: { path: ".env", content: "secret" },
			},
			options,
		});
		const envPath = canonicalizeExistingPath(join(process.cwd(), ".env"));
		strictEqual(mutationResult.outcome.outcome, "selected");
		if (mutationResult.outcome.outcome === "selected") strictEqual(mutationResult.outcome.optionId, "reject-once");
		deepStrictEqual(mutationCalls, [{ tool: ToolNames.Edit, args: { path: envPath } }]);
		match(mutation.snapshot().toolCallLog[0]?.reason ?? "", /mutation shape conflicts with ACP kind read/);

		const commandCalls: EvaluatedSafetyCall[] = [];
		const command = new AcpToolMediator({
			safety: targetRecordingSafety(commandCalls),
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
		});
		const commandResult = await command.handle({
			sessionId: "s",
			toolCall: {
				toolCallId: "contradictory-read-command",
				kind: "read",
				rawInput: { path: "package.json", command: "rm -rf ." },
			},
			options,
		});
		strictEqual(commandResult.outcome.outcome, "selected");
		if (commandResult.outcome.outcome === "selected") strictEqual(commandResult.outcome.optionId, "reject-once");
		deepStrictEqual(commandCalls, [{ tool: ToolNames.Bash, args: { command: "rm -rf .", cwd: process.cwd() } }]);
		match(command.snapshot().toolCallLog[0]?.reason ?? "", /command shape conflicts with ACP kind read/);
	});

	it("evaluates every canonical location in a multi-target move", async () => {
		const source = canonicalizeExistingPath(join(process.cwd(), "src/old-name.ts"));
		const protectedDestination = canonicalizeExistingPath(join(process.cwd(), "PLAN.md"));
		const calls: EvaluatedSafetyCall[] = [];
		const mediator = new AcpToolMediator({
			safety: targetRecordingSafety(calls, new Set([protectedDestination])),
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
		});
		const result = await mediator.handle({
			sessionId: "s",
			toolCall: {
				toolCallId: "move-protected",
				kind: "move",
				title: "Rename a harmless file",
				locations: [{ path: "src/old-name.ts" }, { path: "PLAN.md" }],
			},
			options: [
				{ optionId: "allow-once", kind: "allow_once" },
				{ optionId: "reject-once", kind: "reject_once" },
			],
		});

		strictEqual(result.outcome.outcome, "selected");
		if (result.outcome.outcome === "selected") strictEqual(result.outcome.optionId, "reject-once");
		deepStrictEqual(calls, [
			{ tool: ToolNames.Edit, args: { path: source } },
			{ tool: ToolNames.Edit, args: { path: protectedDestination } },
		]);
		deepStrictEqual(mediator.snapshot().toolCallLog[0]?.arguments, { paths: [source, protectedDestination] });
	});

	it("fails closed for missing and malformed ACP mutation locations", async () => {
		const cases: Array<Record<string, unknown>> = [
			{ kind: "edit", title: "package.json" },
			{ kind: "edit", title: "package.json", locations: [] },
			{ kind: "edit", title: "package.json", locations: [{ path: 42 }] },
			{ kind: "edit", title: "package.json", locations: [{ path: "src/index.ts", line: -1 }] },
			{ kind: "move", title: "Rename package.json", locations: [{ path: "package.json" }] },
		];
		for (const [index, toolCall] of cases.entries()) {
			const calls: EvaluatedSafetyCall[] = [];
			const mediator = new AcpToolMediator({
				safety: targetRecordingSafety(calls),
				cwd: process.cwd(),
				toolGovernance: "clio-policy",
			});
			const result = await mediator.handle({
				sessionId: "s",
				toolCall: { toolCallId: `malformed-${index}`, ...toolCall },
				options: [
					{ optionId: "allow-once", kind: "allow_once" },
					{ optionId: "reject-once", kind: "reject_once" },
				],
			});
			strictEqual(result.outcome.outcome, "selected");
			if (result.outcome.outcome === "selected") strictEqual(result.outcome.optionId, "reject-once");
			const log = mediator.snapshot().toolCallLog[0];
			strictEqual(log?.decision, "denied");
			ok(log?.reason?.startsWith("invalid ACP mutation targets:"), log?.reason);
			ok(!JSON.stringify(log?.arguments).includes("package.json") || index === cases.length - 1);
		}
	});

	it("classifies kind-less permission requests (claude-code-acp) from the rawInput shape", async () => {
		// @zed-industries/claude-code-acp sends requestPermission with only
		// rawInput + title and omits `kind`/tool name. The mediator must still map
		// the dangerous classes to the right clio tool so safety gates them rather
		// than blanket-denying every Claude Code tool call as unknown.
		const options = [
			{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
			{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
		];
		const call = async (rawInput: Record<string, unknown>, title: string) => {
			const mediator = new AcpToolMediator({ safety, cwd: process.cwd(), toolGovernance: "clio-policy" });
			await mediator.handle({ sessionId: "s", toolCall: { toolCallId: "c", title, rawInput }, options });
			return mediator.snapshot().toolCallLog[0];
		};

		strictEqual((await call({ command: "ls -la" }, "`ls -la`"))?.tool, ToolNames.Bash);
		strictEqual((await call({ file_path: "src/x.ts", offset: 0 }, "Read File"))?.tool, ToolNames.Read);
		strictEqual((await call({ file_path: "src/x.ts", content: "x" }, "Write"))?.tool, ToolNames.Edit);
		strictEqual((await call({ file_path: "src/x.ts", old_string: "a", new_string: "b" }, "Edit"))?.tool, ToolNames.Edit);
		strictEqual((await call({ pattern: "TODO", path: "src" }, "Grep"))?.tool, ToolNames.Grep);
		strictEqual((await call({ url: "https://example.com" }, "Fetch"))?.tool, ToolNames.WebFetch);

		// A genuinely unmapped tool (e.g. TodoWrite) stays unknown and is denied.
		const todo = await call({ todos: [] }, "Update Todos");
		strictEqual(todo?.decision, "denied");
	});

	it("runs a prompt turn against a stdio ACP agent", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-acp-mock-"));
		const script = join(scratch, "mock-acp.cjs");
		writeFileSync(
			script,
			`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (!msg.params.clientInfo.version) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "clientInfo.version required" } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, _meta: { "clio-coder/session": { close: true } } }, agentInfo: { name: "mock-acp", version: "1" } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from acp" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", _meta: { "clio-coder/usage": { input: 2, output: 3 } } } });
  } else if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    process.exit(0);
  }
});
`,
		);
		try {
			const handle = startAcpDelegationRun({
				agent: {
					id: "mock",
					command: process.execPath,
					args: [script],
					connectTimeoutMs: 1000,
					turnTimeoutMs: 1000,
					permissionTimeoutMs: 1000,
					toolGovernance: "clio-policy",
				},
				task: "say hello",
				cwd: scratch,
				safety,
			});
			const events: unknown[] = [];
			for await (const event of handle.events) events.push(event);
			const result = await handle.promise;

			strictEqual(result.exitCode, 0);
			strictEqual(result.delegation.acpSessionId, "sess-1");
			strictEqual(result.usage.inputTokens, 2);
			strictEqual(result.usage.outputTokens, 3);
			ok(
				events.some(
					(event) => typeof event === "object" && event !== null && (event as { type?: string }).type === "text_delta",
				),
			);
			ok(
				events.some(
					(event) => typeof event === "object" && event !== null && (event as { type?: string }).type === "message_end",
				),
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("bounds a successful ACP peer that ignores cooperative EOF", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-acp-success-resistant-"));
		const script = join(scratch, "success-resistant.cjs");
		writeFileSync(
			script,
			`
const readline = require("node:readline");
process.on("SIGTERM", () => {});
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "success-resistant" } });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
setInterval(() => {}, 1000);
`,
		);
		let pid: number | null = null;
		try {
			const handle = startAcpDelegationRun({
				agent: {
					id: "success-resistant",
					command: process.execPath,
					args: [script],
					connectTimeoutMs: 1_000,
					turnTimeoutMs: 1_000,
					permissionTimeoutMs: 1_000,
					toolGovernance: "clio-policy",
				},
				task: "finish but stay alive",
				cwd: scratch,
				safety,
				cancelGraceMs: 25,
				terminationGraceMs: 25,
				terminationWaitMs: 1_000,
			});
			pid = handle.pid;
			const result = await within(handle.promise, 2_000, "successful resistant ACP peer exceeded teardown bound");
			strictEqual(result.exitCode, 0);
			strictEqual(pidIsAlive(pid), false, "successful ACP teardown returned while its process remained alive");
		} finally {
			forceCleanupPid(pid);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("keeps cooperative close signal-free and force-kills a resistant owned process scope", async () => {
		const resistantCode = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const descendant = process.platform === "win32"
  ? null
  : spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
function announce() {
  process.stderr.write(JSON.stringify({ descendantPid: descendant ? descendant.pid : null }) + "\\n");
}
if (descendant) descendant.once("spawn", announce);
else announce();
setInterval(() => {}, 1000);
`;
		const transport = createStdioTransport(process.execPath, ["-e", resistantCode], {
			terminationGraceMs: 30,
			terminationWaitMs: 1_000,
		});
		const pid = transport.pid;
		let descendantPid: number | null = null;
		let stderr = "";
		const ready = new Promise<void>((resolveReady) => {
			const unregister = transport.onStderr((chunk) => {
				stderr += chunk;
				const newline = stderr.indexOf("\n");
				if (newline === -1) return;
				const parsed = JSON.parse(stderr.slice(0, newline)) as { descendantPid?: unknown };
				descendantPid = typeof parsed.descendantPid === "number" ? parsed.descendantPid : null;
				unregister();
				resolveReady();
			});
		});

		try {
			await within(ready, 1_000, "resistant ACP transport did not become ready");
			const pending = transport.request("never-replies");
			transport.close();
			await rejects(pending, /ACP transport closed/);
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
			ok(pidIsAlive(pid), "cooperative close must not send a process signal");

			const terminated = await within(
				transport.forceTerminate(),
				2_000,
				"resistant ACP process exceeded the force-termination deadline",
			);
			strictEqual(terminated.exited, true);
			strictEqual(terminated.scope, process.platform === "win32" ? "child" : "process-group");
			strictEqual(pidIsAlive(pid), false, "direct ACP child must be reaped before forceTerminate resolves");
			if (process.platform !== "win32") {
				strictEqual(terminated.escalated, true, "SIGTERM-resistant POSIX peer must reach SIGKILL");
				ok(descendantPid !== null, "POSIX resistant-child fixture did not spawn its descendant");
				strictEqual(pidIsAlive(descendantPid), false, "owned POSIX process-group descendant survived SIGKILL");
			}
		} finally {
			forceCleanupPid(pid);
			forceCleanupDirectPid(descendantPid);
		}
	});

	it("ActiveRun kill and abort both bound a SIGTERM-resistant ACP peer lifetime", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-acp-resistant-"));
		const script = join(scratch, "resistant-acp.cjs");
		writeFileSync(
			script,
			`
const fs = require("node:fs");
const readline = require("node:readline");
const readyPath = process.argv[2];
const termPath = process.argv[3];
const cancelPath = process.argv[4];
process.on("SIGTERM", () => fs.writeFileSync(termPath, "SIGTERM\\n"));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "resistant-session" } });
  } else if (msg.method === "session/prompt") {
    fs.writeFileSync(readyPath, "ready\\n");
  } else if (msg.method === "session/cancel") {
    fs.writeFileSync(cancelPath, "cancel\\n");
  }
});
setInterval(() => {}, 1000);
`,
		);

		try {
			for (const action of ["kill", "abort"] as const) {
				const readyPath = join(scratch, `${action}-ready`);
				const termPath = join(scratch, `${action}-term`);
				const cancelPath = join(scratch, `${action}-cancel`);
				const handle = startAcpDelegationRun({
					agent: {
						id: `resistant-${action}`,
						command: process.execPath,
						args: [script, readyPath, termPath, cancelPath],
						connectTimeoutMs: 1_000,
						turnTimeoutMs: 60_000,
						permissionTimeoutMs: 1_000,
						toolGovernance: "clio-policy",
					},
					task: `exercise ${action}`,
					cwd: scratch,
					safety,
					terminationGraceMs: 30,
					terminationWaitMs: 1_000,
					cancelGraceMs: 100,
				});
				const pid = handle.pid;
				try {
					await waitForCondition(() => existsSync(readyPath), 1_000, `${action} ACP peer never reached prompt`);
					if (action === "kill") handle.kill();
					else handle.abort();
					const result = await within(handle.promise, 2_000, `${action} did not settle the resistant ACP run`);
					strictEqual(result.exitCode, 1);
					strictEqual(result.stopReason, "cancelled");
					strictEqual(pidIsAlive(pid), false, `${action} left the resistant ACP pid alive`);
					if (process.platform !== "win32") {
						ok(existsSync(termPath), `${action} skipped the SIGTERM phase before escalation`);
						strictEqual(readFileSync(termPath, "utf8"), "SIGTERM\n");
					}
					if (action === "abort") {
						ok(existsSync(cancelPath), "abort did not first send cooperative session/cancel");
					}
				} finally {
					forceCleanupPid(pid);
				}
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("serves Clio as an ACP agent with conformant initialize + prompt shapes", async () => {
		const { init, session, prompt, chat, notifications, code } = await runServerPrompt();

		strictEqual(init.protocolVersion, 1);
		strictEqual((init.agentInfo as { name?: string }).name, "clio-coder");

		// AgentCapabilities must match the ACP v1 schema, which has no
		// sessionCapabilities / streaming / tools fields.
		const caps = init.agentCapabilities as Record<string, unknown>;
		strictEqual(caps.loadSession, false, "a minimal embedded server must not advertise unavailable load support");
		ok(isRecord(caps.promptCapabilities), "promptCapabilities must be present");
		ok(isRecord(caps.mcpCapabilities), "mcpCapabilities must be present");
		ok(!("sessionCapabilities" in caps), "sessionCapabilities is not an ACP v1 field");
		ok(!("streaming" in caps), "streaming is not an ACP v1 field");
		ok(!("tools" in caps), "tools is not an ACP v1 field");
		// Clio advertises optional session controls via the _meta extension slot.
		ok(isRecord(caps._meta), "clio-coder extensions belong in agentCapabilities._meta");
		deepStrictEqual((caps._meta as Record<string, unknown>)["clio-coder/session"], {
			close: true,
			list: false,
			label: false,
			delete: false,
			autonomy: true,
		});
		deepStrictEqual((caps._meta as Record<string, unknown>)["clio-coder/settings"], {
			get_safe: false,
			patch_safe: false,
		});
		deepStrictEqual((caps._meta as Record<string, unknown>)["clio-coder/targets"], {
			list: false,
			probe: false,
		});
		ok(!("clio-coder/events" in (caps._meta as Record<string, unknown>)));
		ok(!("clio-coder/tools" in (caps._meta as Record<string, unknown>)));

		strictEqual(typeof session.sessionId, "string");
		ok(isRecord((session as Record<string, unknown>)._meta));
		const sessionMeta = ((session as Record<string, unknown>)._meta as Record<string, unknown>)["clio-coder/session"];
		ok(isRecord(sessionMeta));
		strictEqual(sessionMeta.sessionId, session.sessionId);
		strictEqual(sessionMeta.resumed, false);

		strictEqual(prompt.stopReason, "end_turn");
		ok(!("usage" in prompt), "usage must not sit at the top level of PromptResponse");
		ok(!("tokenUsage" in prompt), "tokenUsage must not sit at the top level of PromptResponse");
		const meta = prompt._meta as Record<string, unknown>;
		ok(isRecord(meta), "usage is carried in PromptResponse._meta");
		const usage = meta[USAGE_META_KEY] as Record<string, unknown>;
		strictEqual(usage.input, 4);
		strictEqual(usage.output, 5);
		strictEqual(chat.submitted[0], "say hello");

		const updates = sessionUpdates(notifications);
		ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
		ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
		ok(updates.some((u) => u.sessionUpdate === "tool_call"));
		ok(updates.some((u) => u.sessionUpdate === "tool_call_update"));
		strictEqual(code, 0);
	});

	it("attributes a new ACP session to the bind-time effective route", async () => {
		const cwd = realpathSync(process.cwd());
		const store = createAcpSessionStore({ cwd });
		const harness = startAcpServer({
			chat: createMockChat(),
			session: store.contract,
			routing: () => ({ target: "local-target", model: "model-a" }),
		});
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const created = await harness.client.request<Record<string, unknown>>("session/new", { cwd });
			deepStrictEqual(store.createInputs, [{ cwd, target: "local-target", model: "model-a" }]);
			const meta = (created._meta as Record<string, unknown>)["clio-coder/session"];
			ok(isRecord(meta));
			strictEqual(meta.target, "local-target");
			strictEqual(meta.model, "model-a");
			strictEqual(meta.autonomy, "auto-edit");
			strictEqual(meta.resumed, false);
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("refuses an over-bound configured route instead of misreporting it as unselected", async () => {
		const harness = startAcpServer({
			chat: createMockChat(),
			routing: () => ({ target: "t".repeat(129), model: "model-a" }),
			settings: {
				read: () => ({
					target: "t".repeat(129),
					model: "model-a",
					thinkingLevel: "off",
					autonomy: "auto-edit",
				}),
				commit: () => {
					throw new Error("not used");
				},
			},
		});
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			for (const request of [
				harness.client.request("session/new", { cwd: process.cwd() }),
				harness.client.request("clio-coder/settings/get_safe", {}),
			]) {
				const failure = await rejection(request);
				strictEqual(errorDetail(failure).code, "internal_error");
				strictEqual(failure.message, "internal error");
			}
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("lists, labels, deletes, and fail-closes unknown-open workspace sessions", async () => {
		const cwd = realpathSync(process.cwd());
		const closed = sessionMeta({
			id: "closed-session",
			cwd,
			name: "Initial name",
			firstMessagePreview: "first\nquestion",
			messageCount: 3,
			target: "target-a",
			model: "model-a",
			lastActivityAt: "2026-08-18T12:03:00.000Z",
		});
		const unknown = sessionMeta({ id: "unknown-open", cwd, endedAt: null });
		const foreign = sessionMeta({ id: "foreign-session", cwd: tmpdir() });
		const store = createAcpSessionStore({ cwd, metas: [closed, unknown, foreign] });
		const harness = startAcpServer({ chat: createMockChat(), session: store.contract });
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const listed = await harness.client.request<{ sessions: Array<Record<string, unknown>>; truncated: boolean }>(
				"clio-coder/session/list",
				{},
			);
			deepStrictEqual(
				listed.sessions.map((entry) => entry.sessionId),
				["closed-session", "unknown-open"],
			);
			strictEqual(listed.sessions[0]?.state, "closed");
			strictEqual(listed.sessions[0]?.preview, "first question");
			strictEqual(listed.sessions[1]?.state, "unknown");
			strictEqual(listed.truncated, false);

			await harness.client.request("clio-coder/session/label", { sessionId: closed.id, label: "Renamed" });
			strictEqual(store.metas.get(closed.id)?.name, "Renamed");
			const controlError = await rejection(
				harness.client.request("clio-coder/session/label", { sessionId: closed.id, label: "bad\nlabel" }),
			);
			strictEqual(errorDetail(controlError).code, "invalid_params");

			const openError = await rejection(harness.client.request("clio-coder/session/delete", { sessionId: unknown.id }));
			strictEqual(errorDetail(openError).code, "session_open");
			await harness.client.request("clio-coder/session/delete", { sessionId: closed.id });
			deepStrictEqual(store.deleted, [closed.id]);
			const missing = await rejection(harness.client.request("clio-coder/session/delete", { sessionId: foreign.id }));
			strictEqual(errorDetail(missing).code, "session_unknown");
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("keeps a worst-case session list inside the client frame ceiling and marks aggregate truncation", async () => {
		const cwd = realpathSync(process.cwd());
		const metas = Array.from({ length: 200 }, (_, index) =>
			sessionMeta({
				id: `session-${String(index).padStart(3, "0")}`,
				cwd,
				name: '"'.repeat(256),
				firstMessagePreview: '"'.repeat(512),
				messageCount: Number.MAX_SAFE_INTEGER,
				target: '"'.repeat(128),
				model: '"'.repeat(256),
				lastActivityAt: `2026-08-18T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
			}),
		);
		const store = createAcpSessionStore({ cwd, metas });
		const harness = startAcpServer({ chat: createMockChat(), session: store.contract });
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const listed = await harness.client.request<Record<string, unknown>>("clio-coder/session/list", { limit: 200 });
			deepStrictEqual(listed._meta, { "clio-coder/truncated": true });
			strictEqual(listed.truncated, true);
			const sessions = listed.sessions as Array<Record<string, unknown>>;
			ok(sessions.length > 0 && sessions.length < 200);
			strictEqual(sessions[0]?.sessionId, "session-000", "the bounded result is a stable newest-first prefix");
			ok(Buffer.byteLength(JSON.stringify(listed), "utf8") <= 240 * 1024);
			ok(
				Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: listed }), "utf8") <= 256 * 1024,
				"the complete response must fit Workbench's frozen frame reader",
			);
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("loads the pinned branch, resets provider context first, and replays before the response", async () => {
		const cwd = realpathSync(process.cwd());
		const stored = sessionMeta({
			id: "load-session",
			cwd,
			target: "target-a",
			model: "model-a",
			endedAt: "2026-08-18T12:10:00.000Z",
		});
		const entries: SessionEntry[] = [
			{
				kind: "message",
				role: "user",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-08-18T12:00:01.000Z",
				payload: { text: "first" },
			},
			{
				kind: "message",
				role: "assistant",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: "2026-08-18T12:00:02.000Z",
				payload: {
					content: [
						{ type: "thinking", thinking: "thought" },
						{ type: "text", text: "answer" },
					],
				},
			},
			{
				kind: "message",
				role: "user",
				turnId: "u2",
				parentTurnId: "a1",
				timestamp: "2026-08-18T12:00:03.000Z",
				payload: { text: "selected branch" },
			},
			{
				kind: "message",
				role: "tool_call",
				turnId: "tc",
				parentTurnId: "u2",
				timestamp: "2026-08-18T12:00:04.000Z",
				payload: { toolCallId: "call-1", name: "read", args: { path: "README.md" } },
			},
			{
				kind: "message",
				role: "tool_result",
				turnId: "tr",
				parentTurnId: "tc",
				timestamp: "2026-08-18T12:00:05.000Z",
				payload: { toolCallId: "call-1", toolName: "read", result: "ok", isError: false },
			},
			{
				kind: "message",
				role: "user",
				turnId: "u3",
				parentTurnId: "a1",
				timestamp: "2026-08-18T12:00:06.000Z",
				payload: { text: "abandoned branch" },
			},
		];
		const store = createAcpSessionStore({ cwd, metas: [stored], leafById: { [stored.id]: "tr" } });
		const chat = createResettableMockChat();
		const providerReplay = [{ role: "user", content: [{ type: "text", text: "provider replay" }] }] as AgentMessage[];
		let buildLeaf: string | null | undefined;
		const harness = startAcpServer({
			chat,
			session: store.contract,
			readSessionEntries: () => entries,
			buildReplayMessages: (_source, leaf) => {
				buildLeaf = leaf;
				return providerReplay;
			},
		});
		try {
			const initialized = await harness.client.request<Record<string, unknown>>("initialize", { protocolVersion: 1 });
			const capabilities = initialized.agentCapabilities as Record<string, unknown>;
			strictEqual(capabilities.loadSession, true);
			deepStrictEqual((capabilities._meta as Record<string, unknown>)["clio-coder/session"], {
				close: true,
				list: true,
				label: true,
				delete: true,
				autonomy: true,
			});
			const loaded = await harness.client.request<Record<string, unknown>>("session/load", {
				sessionId: stored.id,
				cwd,
				mcpServers: [],
			});
			strictEqual(buildLeaf, "tr");
			deepStrictEqual(chat.resets, [{ leafTurnId: "tr", messages: providerReplay }]);
			const replayNotifications = harness.client.notifications.filter(
				(frame) => isRecord(frame) && frame.method === "session/update",
			) as Array<Record<string, unknown>>;
			const updates = sessionUpdates(replayNotifications);
			deepStrictEqual(
				updates.map((update) => update.sessionUpdate),
				[
					"user_message_chunk",
					"agent_thought_chunk",
					"agent_message_chunk",
					"user_message_chunk",
					"tool_call",
					"tool_call_update",
				],
			);
			ok(!JSON.stringify(updates).includes("abandoned branch"));
			const replayTurns = replayNotifications.map((frame) => {
				const params = frame.params as Record<string, unknown>;
				return ((params._meta as Record<string, unknown>)["clio-coder/replay"] as Record<string, unknown>).turn;
			});
			deepStrictEqual(replayTurns, [1, 1, 1, 2, 2, 2]);
			const responseFrame = harness.client.frames.find(
				(frame) => isRecord(frame.result) && isRecord((frame.result as Record<string, unknown>)._meta),
			);
			ok(responseFrame);
			const responseIndex = harness.client.frames.indexOf(responseFrame);
			for (const notification of replayNotifications) {
				ok(harness.client.frames.indexOf(notification) < responseIndex, "replay must precede the load response");
			}
			const meta = (loaded._meta as Record<string, unknown>)["clio-coder/session"];
			ok(isRecord(meta));
			strictEqual(meta.resumed, true);
			deepStrictEqual(meta.replayed, { turns: 2, truncated: false });
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("measures the replay byte cap with the real session id and drops only whole turns", async () => {
		const cwd = realpathSync(process.cwd());
		const stored = sessionMeta({
			id: "s".repeat(128),
			cwd,
			endedAt: "2026-08-18T12:10:00.000Z",
		});
		// Four turns sit just below 4 MiB when measured with an empty session id,
		// but above it once all 128 id bytes appear in every 16 KiB chunk. This
		// pins the exact wire-envelope accounting, not merely a generous case.
		const turnText = "x".repeat(1_035_000);
		const entries: SessionEntry[] = Array.from({ length: 4 }, (_, index) => ({
			kind: "message" as const,
			role: "user" as const,
			turnId: `u${index + 1}`,
			parentTurnId: index === 0 ? null : `u${index}`,
			timestamp: `2026-08-18T12:00:0${index + 1}.000Z`,
			payload: { text: turnText },
		}));
		const store = createAcpSessionStore({
			cwd,
			metas: [stored],
			leafById: { [stored.id]: "u4" },
		});
		const harness = startAcpServer({
			chat: createResettableMockChat(),
			session: store.contract,
			readSessionEntries: () => entries,
			buildReplayMessages: () => [],
		});
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const loaded = await harness.client.request<Record<string, unknown>>("session/load", {
				sessionId: stored.id,
				cwd,
				mcpServers: [],
			});
			const replayNotifications = harness.client.notifications.filter(
				(frame) => isRecord(frame) && frame.method === "session/update",
			) as Array<Record<string, unknown>>;
			const serializedBytes = replayNotifications.reduce(
				(total, frame) => total + Buffer.byteLength(JSON.stringify(frame), "utf8") + 1,
				0,
			);
			ok(serializedBytes <= 4 * 1024 * 1024, `replay emitted ${serializedBytes} bytes`);
			const replayMeta = ((loaded._meta as Record<string, unknown>)["clio-coder/session"] as Record<string, unknown>)
				.replayed as Record<string, unknown>;
			strictEqual(replayMeta.truncated, true);
			ok(typeof replayMeta.turns === "number" && replayMeta.turns > 0 && replayMeta.turns < 4);

			const textByTurn = new Map<number, number>();
			for (const frame of replayNotifications) {
				const params = frame.params as Record<string, unknown>;
				strictEqual(params.sessionId, stored.id);
				const marker = ((params._meta as Record<string, unknown>)["clio-coder/replay"] as Record<string, unknown>)
					.turn as number;
				const update = params.update as Record<string, unknown>;
				const content = update.content as Record<string, unknown>;
				textByTurn.set(marker, (textByTurn.get(marker) ?? 0) + String(content.text ?? "").length);
			}
			deepStrictEqual(
				[...textByTurn.keys()],
				Array.from({ length: replayMeta.turns as number }, (_, index) => index + 1),
			);
			for (const bytes of textByTurn.values()) strictEqual(bytes, turnText.length, "a replay turn must not be split");
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("caps replay at 8192 tool starts by dropping whole oldest turns", async () => {
		const cwd = realpathSync(process.cwd());
		const stored = sessionMeta({ id: "r", cwd, endedAt: "2026-08-18T12:10:00.000Z" });
		const entries: SessionEntry[] = [];
		let parentTurnId: string | null = null;
		let callIndex = 0;
		for (let turnIndex = 0; turnIndex < 64; turnIndex += 1) {
			const userTurnId = `u${turnIndex.toString(36)}`;
			entries.push({
				kind: "message",
				role: "user",
				turnId: userTurnId,
				parentTurnId,
				timestamp: "2026-08-18T12:00:00.000Z",
				payload: { text: "u" },
			});
			parentTurnId = userTurnId;
			for (let callInTurn = 0; callInTurn < 129; callInTurn += 1) {
				const turnId = `c${callIndex.toString(36)}`;
				entries.push({
					kind: "message",
					role: "tool_call",
					turnId,
					parentTurnId,
					timestamp: "2026-08-18T12:00:00.000Z",
					payload: { toolCallId: callIndex.toString(36), name: "t" },
				});
				parentTurnId = turnId;
				callIndex += 1;
			}
		}
		const store = createAcpSessionStore({ cwd, metas: [stored], leafById: { [stored.id]: parentTurnId } });
		const harness = startAcpServer({
			chat: createResettableMockChat(),
			session: store.contract,
			readSessionEntries: () => entries,
			buildReplayMessages: () => [],
		});
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const loaded = await harness.client.request<Record<string, unknown>>("session/load", {
				sessionId: stored.id,
				cwd,
				mcpServers: [],
			});
			const replayNotifications = harness.client.notifications.filter(
				(frame) => isRecord(frame) && frame.method === "session/update",
			) as Array<Record<string, unknown>>;
			const starts = sessionUpdates(replayNotifications).filter((update) => update.sessionUpdate === "tool_call");
			ok(starts.length <= 8192, `replay emitted ${starts.length} tool starts`);
			const replayMeta = ((loaded._meta as Record<string, unknown>)["clio-coder/session"] as Record<string, unknown>)
				.replayed as Record<string, unknown>;
			strictEqual(replayMeta.truncated, true);
			ok(typeof replayMeta.turns === "number" && replayMeta.turns < 64);
			const callsByTurn = new Map<number, number>();
			for (const frame of replayNotifications) {
				const params = frame.params as Record<string, unknown>;
				const update = params.update as Record<string, unknown>;
				if (update.sessionUpdate !== "tool_call") continue;
				const marker = ((params._meta as Record<string, unknown>)["clio-coder/replay"] as Record<string, unknown>)
					.turn as number;
				callsByTurn.set(marker, (callsByTurn.get(marker) ?? 0) + 1);
			}
			for (const count of callsByTurn.values()) strictEqual(count, 129, "the cap never splits a retained turn");
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("reads and explicitly overrides a hosted session's autonomy between prompts", async () => {
		const harness = startAcpServer({ chat: createMockChat(), autonomy: () => "auto-edit" });
		try {
			const id = await openSession(harness.client);
			deepStrictEqual(await harness.client.request("clio-coder/session/autonomy", { sessionId: id }), {
				level: "auto-edit",
				source: "settings",
			});
			deepStrictEqual(await harness.client.request("clio-coder/session/autonomy", { sessionId: id, level: "read-only" }), {
				level: "read-only",
				source: "session",
			});
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("projects and atomically patches only the frozen safe settings set", async () => {
		let snapshot: AcpSafeSettingsSnapshot = {
			target: "target-a",
			model: "model-a",
			thinkingLevel: "medium" as const,
			autonomy: "auto-edit" as const,
		};
		const commits: Array<Record<string, unknown>> = [];
		const settings: AcpSettingsControl = {
			read: () => snapshot,
			commit: (patch) => {
				commits.push({ ...patch });
				snapshot = {
					target: patch["orchestrator.target"] === undefined ? snapshot.target : patch["orchestrator.target"],
					model: patch["orchestrator.model"] === undefined ? snapshot.model : patch["orchestrator.model"],
					thinkingLevel: patch["orchestrator.thinkingLevel"] ?? snapshot.thinkingLevel,
					autonomy: patch.autonomy ?? snapshot.autonomy,
				};
				return snapshot;
			},
		};
		const providers = {
			getTarget: (id: string) => (id === "target-b" ? { id, runtime: "runtime-a" } : null),
		} as unknown as ProvidersContract;
		const harness = startAcpServer({ chat: createMockChat(), providers, settings });
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const initial = await harness.client.request<Record<string, unknown>>("clio-coder/settings/get_safe", {});
			deepStrictEqual(initial, {
				settings: {
					orchestrator: { target: "target-a", model: "model-a", thinkingLevel: "medium" },
					autonomy: "auto-edit",
				},
				editable: ["orchestrator.target", "orchestrator.model", "orchestrator.thinkingLevel", "autonomy"],
			});
			const updated = await harness.client.request<Record<string, unknown>>("clio-coder/settings/patch_safe", {
				patch: {
					"orchestrator.target": "target-b",
					"orchestrator.model": "model-b",
					"orchestrator.thinkingLevel": "xhigh",
					autonomy: "read-only",
				},
			});
			strictEqual(commits.length, 1);
			deepStrictEqual((updated.settings as Record<string, unknown>).orchestrator, {
				target: "target-b",
				model: "model-b",
				thinkingLevel: "xhigh",
			});
			strictEqual((updated.settings as Record<string, unknown>).autonomy, "read-only");

			const unknownKey = await rejection(
				harness.client.request("clio-coder/settings/patch_safe", { patch: { "targets.0.url": "secret" } }),
			);
			strictEqual(errorDetail(unknownKey).code, "invalid_params");
			const unknownTarget = await rejection(
				harness.client.request("clio-coder/settings/patch_safe", {
					patch: { "orchestrator.target": "missing" },
				}),
			);
			deepStrictEqual(
				{ code: errorDetail(unknownTarget).code, reason: errorDetail(unknownTarget).reason },
				{ code: "invalid_params", reason: "target-unknown" },
			);
			strictEqual(commits.length, 1, "invalid patches must not partially commit");
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("lists and probes bounded targets without disclosing provider configuration or prose", async () => {
		const secret = "SENTINEL_PROVIDER_SECRET";
		const runtime = {
			id: "runtime-a",
			kind: "http",
			auth: "none",
			probe: async () => ({ ok: true }),
			defaultBinaryPath: `/tmp/${secret}`,
		} as unknown as NonNullable<TargetStatus["runtime"]>;
		const status = {
			target: {
				id: "target-a",
				runtime: "runtime-a",
				url: `https://${secret}.invalid/?token=${secret}`,
				auth: { headers: { Authorization: secret } },
				defaultModel: "default-model",
				wireModels: ["configured-model"],
			},
			runtime,
			available: true,
			reason: secret,
			health: { status: "healthy", lastCheckAt: "2026-08-18T12:00:00.000Z", lastError: secret, latencyMs: 12.4 },
			capabilities: {},
			discoveredModels: ["live-model"],
			probeNotes: [secret],
		} as unknown as TargetStatus;
		let probes = 0;
		const providers = {
			list: () => [status],
			getTarget: (id: string) => (id === status.target.id ? status.target : null),
			probeTarget: async (id: string, options?: { reasoning?: boolean }) => {
				strictEqual(id, status.target.id);
				deepStrictEqual(options, { reasoning: false });
				probes += 1;
				return status;
			},
			auth: { statusForTarget: () => ({ available: true }) },
		} as unknown as ProvidersContract;
		const harness = startAcpServer({ chat: createMockChat(), providers });
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const listed = await harness.client.request<Record<string, unknown>>("clio-coder/targets/list", {});
			deepStrictEqual(listed, {
				targets: [
					{
						id: "target-a",
						runtime: "runtime-a",
						models: ["default-model", "configured-model", "live-model"],
						isOrchestrator: true,
					},
				],
			});
			strictEqual(probes, 0, "target listing must not make a network probe");
			const probed = await harness.client.request<Record<string, unknown>>("clio-coder/targets/probe", {
				targetId: "target-a",
			});
			deepStrictEqual(probed, { targetId: "target-a", healthy: true, latencyMs: 12, reason: null });
			strictEqual(probes, 1);
			const unknown = await rejection(harness.client.request("clio-coder/targets/probe", { targetId: "missing" }));
			strictEqual(errorDetail(unknown).reason, "target-unknown");
			ok(!JSON.stringify(harness.client.frames).includes(secret));
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("keeps a worst-case target list inside the client frame ceiling and marks aggregate truncation", async () => {
		const runtime = {
			id: "runtime-a",
			kind: "http",
			auth: "none",
			probe: async () => ({ ok: true }),
		} as unknown as NonNullable<TargetStatus["runtime"]>;
		const statuses = Array.from({ length: 64 }, (_, targetIndex) => {
			const models = Array.from(
				{ length: 64 },
				(_, modelIndex) => `${'"'.repeat(250)}${String(modelIndex).padStart(2, "0")}`,
			);
			return {
				target: {
					id: `target-${String(targetIndex).padStart(2, "0")}`,
					runtime: runtime.id,
					wireModels: models,
				},
				runtime,
				available: true,
				reason: "ready",
				health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 1 },
				capabilities: {},
				discoveredModels: [],
			} as unknown as TargetStatus;
		});
		const providers = { list: () => statuses } as unknown as ProvidersContract;
		const harness = startAcpServer({ chat: createMockChat(), providers });
		try {
			await harness.client.request("initialize", { protocolVersion: 1 });
			const listed = await harness.client.request<Record<string, unknown>>("clio-coder/targets/list", {});
			deepStrictEqual(listed._meta, { "clio-coder/truncated": true });
			const targets = listed.targets as Array<{ models: string[] }>;
			ok(targets.length > 0 && targets.length < 64);
			ok(targets.reduce((total, target) => total + target.models.length, 0) < 64 * 64);
			ok(Buffer.byteLength(JSON.stringify(listed), "utf8") <= 240 * 1024);
			ok(
				Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: listed }), "utf8") <= 256 * 1024,
				"the complete response must fit Workbench's frozen frame reader",
			);
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("forwards loop blocks only through the opted-in versioned event envelope", async () => {
		for (const optedIn of [false, true]) {
			const bus = createSafeEventBus();
			const harness = startAcpServer({ chat: createLoopEventMockChat(bus), bus });
			try {
				const init = await harness.client.request<Record<string, unknown>>("initialize", {
					protocolVersion: 1,
					...(optedIn
						? {
								clientCapabilities: {
									_meta: {
										"clio-coder/events": { version: 1, kinds: ["safety.loopBlocked"] },
									},
								},
							}
						: {}),
				});
				const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
				await harness.client.request("session/prompt", {
					sessionId: id,
					prompt: [{ type: "text", text: "loop" }],
				});
				const events = harness.client.notifications.filter(
					(frame) => isRecord(frame) && frame.method === "clio-coder/event",
				) as Array<Record<string, unknown>>;
				if (!optedIn) {
					strictEqual(events.length, 0);
					continue;
				}
				strictEqual(events.length, 2);
				const capability = ((init.agentCapabilities as Record<string, unknown>)._meta as Record<string, unknown>)[
					"clio-coder/events"
				] as Record<string, unknown>;
				const first = events[0]?.params as Record<string, unknown>;
				const second = events[1]?.params as Record<string, unknown>;
				strictEqual(first.workspaceInstanceId, capability.workspaceInstanceId);
				strictEqual(first.version, 1);
				strictEqual(first.sessionId, id);
				strictEqual(first.turnId, "turn-1");
				strictEqual(first.sequence, 1);
				strictEqual(second.sequence, 2);
				strictEqual(first.kind, "safety.loopBlocked");
				strictEqual(first.terminal, false);
				deepStrictEqual(first.payload, {
					toolCallId: null,
					tool: "bash",
					repeatCount: 3,
					blocksThisTurn: 1,
					budget: 3,
					disposition: "block",
					interrupted: false,
					shape: null,
				});
			} finally {
				harness.client.close();
				await harness.server;
			}
		}
	});

	it("ignores an event opt-in containing an over-bound unknown kind", async () => {
		const bus = createSafeEventBus();
		const harness = startAcpServer({ chat: createLoopEventMockChat(bus), bus });
		try {
			await harness.client.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					_meta: {
						"clio-coder/events": {
							version: 1,
							kinds: ["safety.loopBlocked", "x".repeat(65)],
						},
					},
				},
			});
			const id = (await harness.client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() })).sessionId;
			await harness.client.request("session/prompt", {
				sessionId: id,
				prompt: [{ type: "text", text: "loop" }],
			});
			strictEqual(
				harness.client.notifications.filter((frame) => isRecord(frame) && frame.method === "clio-coder/event").length,
				0,
			);
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("ACP server permission allow resolves the parked request with acp-client identity", async () => {
		const { requests, resolutions } = await runAcpPermissionBridge("allow");

		strictEqual(requests.length, 1);
		strictEqual(resolutions.length, 1);
		strictEqual(requests[0]?.origin, "acp-server");
		strictEqual(resolutions[0]?.origin, "acp-server");
		strictEqual(resolutions[0]?.status, "granted");
		strictEqual(resolutions[0]?.decidedBy, "acp-client");
		strictEqual(resolutions[0]?.requestId, requests[0]?.requestId);
	});

	it("ACP server permission reject resolves the parked request with acp-client identity", async () => {
		const { requests, resolutions } = await runAcpPermissionBridge("reject");

		strictEqual(requests.length, 1);
		strictEqual(resolutions.length, 1);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "acp-client");
		strictEqual(resolutions[0]?.requestId, requests[0]?.requestId);
	});

	it("ACP server reject denies one queued request and allows the next request", async () => {
		const { requests, resolutions, presentedCommands } = await runAcpQueuedPermissionBridge();
		const uniqueRequestIds = Array.from(new Set(requests.map((request) => request.requestId)));

		strictEqual(presentedCommands.join(","), "sudo true one,sudo true two");
		strictEqual(uniqueRequestIds.length, 2);
		strictEqual(resolutions.length, 2);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "acp-client");
		strictEqual(resolutions[0]?.requestId, uniqueRequestIds[0]);
		strictEqual(resolutions[1]?.status, "granted");
		strictEqual(resolutions[1]?.decidedBy, "acp-client");
		strictEqual(resolutions[1]?.requestId, uniqueRequestIds[1]);
	});

	it("ACP server transport error resolves every queued request as denied", async () => {
		const { requests, resolutions, presentedCommands } = await runAcpQueuedPermissionBridgeTransportError();
		const uniqueRequestIds = Array.from(new Set(requests.map((request) => request.requestId)));

		strictEqual(presentedCommands.join(","), "sudo true one");
		strictEqual(uniqueRequestIds.length, 2);
		strictEqual(resolutions.length, 2);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "error");
		strictEqual(resolutions[0]?.requestId, uniqueRequestIds[0]);
		strictEqual(resolutions[1]?.status, "denied");
		strictEqual(resolutions[1]?.decidedBy, "error");
		strictEqual(resolutions[1]?.requestId, uniqueRequestIds[1]);
		ok(resolutions.every((resolution) => resolution.reason?.includes("permission transport unavailable")));
	});

	it("ACP server permission timeout expires and fails the prompt without a model-visible denial", async () => {
		const { requests, resolutions, answer, promptErrorCode } = await runAcpPermissionBridge("timeout");

		strictEqual(requests.length, 1);
		strictEqual(resolutions.length, 1);
		strictEqual(resolutions[0]?.status, "expired");
		strictEqual(resolutions[0]?.decidedBy, "timeout");
		strictEqual(resolutions[0]?.requestId, requests[0]?.requestId);
		strictEqual(resolutions[0]?.reason, "permission approval expired");
		strictEqual(promptErrorCode, "permission_expired");
		strictEqual(answer, "");
	});

	it("rejects explicit unschedulable ACP request timeouts instead of disabling or overflowing the timer", async () => {
		const clientToServer = new PassThrough();
		const serverToClient = new PassThrough();
		const peer = createStdioServerTransport({ input: clientToServer, output: serverToClient });
		const processTransport = createStdioTransport(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			terminationGraceMs: 25,
			terminationWaitMs: 1_000,
		});
		try {
			for (const transport of [peer, processTransport]) {
				for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
					throws(
						() => transport.request("session/request_permission", {}, timeoutMs),
						/timeout must be between 1 and 2147483647 ms/,
					);
				}
			}
		} finally {
			peer.close();
			await processTransport.forceTerminate();
		}
	});

	// One session per process (C001 §2) means the "next session" half of this
	// guarantee is a second process, not a second session/new on the same one.
	// The pinning claim is unchanged: the level a prompt runs under is the one
	// snapshotted at its own session/new, not the level live when it submits.
	it("ACP server pins autonomy at session/new for the life of the process", async () => {
		const runWrite = async (autonomyAtSessionNew: AutonomyLevel, autonomyAtPrompt: AutonomyLevel): Promise<number> => {
			let liveAutonomy: AutonomyLevel = autonomyAtSessionNew;
			let activeSnapshot: AutonomyLevel | null = null;
			let permissionRequests = 0;
			const registry = createRegistry({
				safety: allowWriteSafety,
				autonomy: () => activeSnapshot ?? liveAutonomy,
			});
			registry.register(permissionSpec(ToolNames.Write, "write"));
			const { client, server } = startAcpServer({
				chat: createWriteChat(registry),
				toolRegistry: registry,
				autonomy: () => liveAutonomy,
				onActiveSessionAutonomyChange: (level) => {
					activeSnapshot = level;
				},
			});
			client.onRequest("session/request_permission", () => {
				permissionRequests += 1;
				return { outcome: { outcome: "selected", optionId: "allow-once" } };
			});
			const sessionId = await openSession(client);
			liveAutonomy = autonomyAtPrompt;
			await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write once" }] });
			await client.request("session/close", { sessionId });
			client.close();
			strictEqual(await server, 0);
			return permissionRequests;
		};

		strictEqual(await runWrite("suggest", "full-auto"), 1, "the session keeps the suggest snapshot it opened with");
		strictEqual(await runWrite("full-auto", "suggest"), 0, "a session opened at full-auto never asks");
	});

	it("only emits ACP v1 session/update variants and conformant tool calls", async () => {
		const { notifications } = await runServerPrompt();
		const updates = sessionUpdates(notifications);
		ok(updates.length > 0, "expected session/update notifications");

		for (const update of updates) {
			const kind = update.sessionUpdate;
			ok(typeof kind === "string" && VALID_SESSION_UPDATES.has(kind), `invalid sessionUpdate: ${String(kind)}`);
			if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
				ok(isRecord(update.content) && update.content.type === "text", "message chunk content must be a ContentBlock");
			}
			if (kind === "tool_call" || kind === "tool_call_update") {
				if (update.kind !== undefined && update.kind !== null) {
					ok(VALID_TOOL_KINDS.has(update.kind as string), `invalid tool kind: ${String(update.kind)}`);
				}
				if (update.content !== undefined && update.content !== null) {
					ok(Array.isArray(update.content), "tool call content must be a ToolCallContent[]");
					for (const block of update.content as unknown[]) {
						ok(
							isRecord(block) && typeof block.type === "string" && VALID_TOOL_CONTENT_TYPES.has(block.type),
							`invalid tool call content block: ${JSON.stringify(block)}`,
						);
					}
				}
			}
		}

		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
		ok(toolCall, "expected a tool_call update");
		strictEqual(toolCall?.title, "read");
		ok(VALID_TOOL_KINDS.has(toolCall?.kind as string), "tool_call must carry a valid ToolKind");
	});

	it("collapses pi-agent tool-use stop reasons to the ACP-valid end_turn", async () => {
		const run = await runChat(createToolUseMockChat());
		const prompt = await run.prompt;
		strictEqual(prompt.stopReason, "end_turn");
		await run.close();
	});

	it("fails the prompt turn with a JSON-RPC error when the run errors", async () => {
		const run = await runChat(createErroringMockChat());
		const rejected = await rejection(run.prompt);
		strictEqual(rejected.code, -32000);
		// The client branches on the code. The message is host-authored, so the
		// provider's own prose ("provider exploded") never reaches the wire.
		strictEqual(rejected.message, "the prompt turn failed");
		deepStrictEqual(errorDetail(rejected), { version: 1, code: "turn_failed" });
		await run.close();
	});

	it("keeps a failing turn's paths, URLs, and tokens off the wire", async () => {
		const secretPath = "/home/operator/.clio-coder/config/settings.json";
		const secretUrl = "https://user:pw@example.com/x";
		const secretToken = "sk-live-4f9a2c7b1e8d";
		// The shape a provider client actually fails with: the request it made, the
		// file the credential came from, and the credential itself.
		const providerProse = `POST ${secretUrl} failed (key ${secretToken} from ${secretPath})`;
		const diagnostics: string[] = [];
		const clientToServer = new PassThrough();
		const serverToClient = new PassThrough();
		const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
		const server = serveClioAcpAgent({
			transport,
			chat: createErroringMockChat(providerProse),
			cwd: process.cwd(),
			version: "test",
			diagnostics: (line) => diagnostics.push(line),
		});
		const client = createRpcClient(clientToServer, serverToClient);
		const sessionId = await openSession(client);

		const rejected = await rejection(
			client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }),
		);
		strictEqual(rejected.code, -32000);
		strictEqual(rejected.message, "the prompt turn failed");
		deepStrictEqual(errorDetail(rejected), { version: 1, code: "turn_failed" });

		// Not just the error frame: no frame of the whole turn may carry any of it.
		const serialized = JSON.stringify(client.frames);
		for (const secret of [secretPath, secretUrl, secretToken, "POST"]) {
			strictEqual(serialized.includes(secret), false, `a frame discloses ${secret}`);
		}
		assertNoDisclosure(client.frames);

		// The operator still gets the detail, bounded to one line, on stderr.
		strictEqual(diagnostics.length, 1, "one diagnostics line per failed turn");
		const diagnostic = diagnostics[0] ?? "";
		strictEqual(diagnostic.includes("\n"), false, "a diagnostics line is single-line");
		for (const secret of [secretPath, secretUrl, secretToken]) {
			ok(diagnostic.includes(secret), `diagnostics lost ${secret}: ${diagnostic}`);
		}

		client.close();
		strictEqual(await server, 0);
	});

	it("cancels an active ACP prompt through the chat loop abort path", async () => {
		const clientToServer = new PassThrough();
		const serverToClient = new PassThrough();
		const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
		const chat = createCancellableMockChat();
		const server = serveClioAcpAgent({ transport, chat, cwd: process.cwd(), version: "test" });
		const client = createRpcClient(clientToServer, serverToClient);

		await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "mock-client", version: "1" } });
		const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
		const prompt = client.request<{ stopReason: string }>("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "wait" }],
		});
		await chat.started;
		await client.request("session/cancel", { sessionId: session.sessionId });
		const result = await prompt;
		strictEqual(chat.cancelled, true);
		strictEqual(result.stopReason, "cancelled");

		for (const update of sessionUpdates(client.notifications)) {
			ok(
				typeof update.sessionUpdate === "string" && VALID_SESSION_UPDATES.has(update.sessionUpdate),
				`invalid sessionUpdate during cancel: ${String(update.sessionUpdate)}`,
			);
		}

		await client.request("session/close", { sessionId: session.sessionId });
		client.close();
		strictEqual(await server, 0);
	});

	// --- CONTRACT C001 initial safe profile ---------------------------------

	it("refuses an ACP protocol version this server does not speak", async () => {
		const { client, server } = startAcpServer({ chat: createMockChat() });
		const wrongVersion = await rejection(client.request("initialize", { protocolVersion: 2 }));
		strictEqual(wrongVersion.code, -32602);
		deepStrictEqual(errorDetail(wrongVersion), {
			version: 1,
			code: "protocol_version_unsupported",
			supported: [1],
		});
		const missingVersion = await rejection(client.request("initialize", {}));
		strictEqual(missingVersion.code, -32602);
		strictEqual(errorDetail(missingVersion).code, "protocol_version_unsupported");
		assertNoDisclosure(client.frames);
		client.close();
		strictEqual(await server, 0);
	});

	it("refuses a second initialize on the same connection", async () => {
		const { client, server } = startAcpServer({ chat: createMockChat() });
		await client.request("initialize", { protocolVersion: 1 });
		const duplicate = await rejection(client.request("initialize", { protocolVersion: 1 }));
		strictEqual(duplicate.code, -32000);
		strictEqual(errorDetail(duplicate).code, "already_initialized");
		client.close();
		strictEqual(await server, 0);
	});

	it("requires initialize before every session method", async () => {
		const { client, server } = startAcpServer({ chat: createMockChat() });
		for (const [method, params] of [
			["session/new", { cwd: process.cwd() }],
			["session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "go" }] }],
			["session/cancel", { sessionId: "nope" }],
			["session/close", { sessionId: "nope" }],
		] as const) {
			const failure = await rejection(client.request(method, params));
			strictEqual(failure.code, -32000, method);
			strictEqual(errorDetail(failure).code, "not_initialized", method);
		}
		// The notification form has no reply channel, so an ordering error has
		// nowhere to go and must not become an error frame.
		client.notify("session/cancel", { sessionId: "nope" });
		await client.request("initialize", { protocolVersion: 1 });
		assertNoDisclosure(client.frames);
		client.close();
		strictEqual(await server, 0);
	});

	it("pins the session cwd to the canonical launch workspace", async () => {
		const canonicalCwd = realpathSync(process.cwd());
		const scratch = mkdtempSync(join(tmpdir(), "acp-cwd-"));
		const link = join(scratch, "workspace-link");
		symlinkSync(canonicalCwd, link, "dir");
		try {
			const symlinked = startAcpServer({ chat: createMockChat() });
			await symlinked.client.request("initialize", { protocolVersion: 1 });
			const session = await symlinked.client.request<{ sessionId: string }>("session/new", { cwd: link });
			strictEqual(typeof session.sessionId, "string", "a symlink to the launch cwd is the same workspace");
			symlinked.client.close();
			strictEqual(await symlinked.server, 0);

			for (const params of [{ cwd: scratch }, {}]) {
				const { client, server } = startAcpServer({ chat: createMockChat() });
				await client.request("initialize", { protocolVersion: 1 });
				const failure = await rejection(client.request("session/new", params));
				strictEqual(failure.code, -32000);
				strictEqual(errorDetail(failure).code, "session_cwd_mismatch");
				ok(!failure.message.includes(scratch), "the mismatch message names no path");
				strictEqual(realpathSync(process.cwd()), canonicalCwd, "session/new must never chdir the process");
				assertNoDisclosure(client.frames);
				client.close();
				strictEqual(await server, 0);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("hosts exactly one session per process, before and after close", async () => {
		const { client, server } = startAcpServer({ chat: createMockChat() });
		const sessionId = await openSession(client);
		const second = await rejection(client.request("session/new", { cwd: process.cwd() }));
		strictEqual(second.code, -32000);
		strictEqual(errorDetail(second).code, "session_limit");
		await client.request("session/close", { sessionId });
		const afterClose = await rejection(client.request("session/new", { cwd: process.cwd() }));
		strictEqual(errorDetail(afterClose).code, "session_limit");
		assertNoDisclosure(client.frames);
		client.close();
		strictEqual(await server, 0);
	});

	it("fails an unadmitted prompt with its reason instead of an empty success", async () => {
		const noticeText = "[Clio Coder] orchestrator not configured. Set one up with: /home/nobody/settings.json";
		const { client, server } = startAcpServer({
			chat: createNoticeChat(
				{
					level: "error",
					surface: "transcript",
					text: noticeText,
					admission: { reason: "orchestrator-not-configured" },
				},
				{ endTurn: false },
			),
		});
		const sessionId = await openSession(client);
		const failure = await rejection(
			client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }),
		);
		strictEqual(failure.code, -32000);
		deepStrictEqual(errorDetail(failure), {
			version: 1,
			code: "prompt_not_admitted",
			reason: "orchestrator-not-configured",
		});
		ok(!failure.message.includes(noticeText), "the settings path must not travel in the message");
		ok(failure.message.includes("orchestrator-not-configured"));
		strictEqual(sessionUpdates(client.notifications).length, 0, "an unadmitted prompt emits no updates");
		assertNoDisclosure(client.frames);
		client.close();
		strictEqual(await server, 0);
	});

	it("keeps advisory notices out of the turn outcome", async () => {
		const { client, server } = startAcpServer({
			chat: createNoticeChat(
				{ level: "warning", surface: "transcript", text: "context is getting full" },
				{ endTurn: true },
			),
		});
		const sessionId = await openSession(client);
		const prompt = await client.request<{ stopReason: string }>("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "go" }],
		});
		strictEqual(prompt.stopReason, "end_turn");
		client.close();
		strictEqual(await server, 0);
	});

	it("splits an oversized assistant delta into bounded chunks without dropping text", async () => {
		const delta = "z".repeat(40000);
		const { client, server } = startAcpServer({ chat: createScriptedChat([{ type: "text_delta", delta }]) });
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const chunks = sessionUpdates(client.notifications)
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => (isRecord(update.content) ? String(update.content.text) : ""));
		strictEqual(chunks.length, 3);
		ok(
			chunks.every((chunk) => utf8Bytes(chunk) <= 16384),
			"every chunk stays inside the 16 KiB bound",
		);
		strictEqual(chunks.join(""), delta);
		client.close();
		strictEqual(await server, 0);
	});

	// The bound is UTF-8 bytes, which is what the peer's read buffer spends.
	// Measuring with String.length let one "16 KiB" chunk of CJK text put 48 KiB
	// on the wire, and a naive byte cut splits a surrogate pair into replacement
	// characters the client can never reassemble.
	it("chunks multibyte text by UTF-8 bytes without splitting a code point", async () => {
		// 16,384 three-byte characters (48 KiB) followed by four-byte emoji, which
		// are surrogate pairs in UTF-16 and the case a byte cut gets wrong.
		const delta = `${"世".repeat(16384)}${"😀".repeat(8192)}`;
		const { client, server } = startAcpServer({ chat: createScriptedChat([{ type: "text_delta", delta }]) });
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const chunks = sessionUpdates(client.notifications)
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => (isRecord(update.content) ? String(update.content.text) : ""));

		ok(chunks.length > 1, "an oversized delta is split");
		for (const chunk of chunks) {
			ok(utf8Bytes(chunk) <= 16384, `chunk is ${utf8Bytes(chunk)} bytes`);
			ok(!hasLoneSurrogate(chunk), "no chunk ends mid code point");
		}
		strictEqual(chunks.join(""), delta, "nothing is dropped and nothing is mangled");
		client.close();
		strictEqual(await server, 0);
	});

	it("bounds rawInput strings and elides a raw record that is still oversized", async () => {
		const command = "c".repeat(10240);
		// 4,100 two-byte characters: 8,200 bytes, but only 4,100 UTF-16 units, so
		// a length-based bound would have passed it through untouched.
		const note = "é".repeat(4100);
		// Ten two-byte strings, each small enough that per-string bounding leaves it
		// alone. The serialized record is ~20 K UTF-16 units and ~41 K bytes, so it
		// is over the record cap only when the cap is measured in bytes.
		const wide = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, "é".repeat(2040)]));
		// Twelve strings each five times the per-string cap: per-string bounding
		// shrinks the record by an order of magnitude and it is still over the record
		// cap. The size the client is told is the size the engine produced, so the
		// elision must report the original serialization, not the shortened copy.
		const huge = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, "é".repeat(10240)]));
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command, note } },
				{ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: wide },
				{ type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: huge },
			]),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const calls = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call");

		const first = calls[0]?.rawInput;
		ok(isRecord(first));
		// The marker is reserved inside the cap, so the whole value fits the bound.
		ok(utf8Bytes(String(first.command)) <= 4096, `command is ${utf8Bytes(String(first.command))} bytes`);
		ok(String(first.command).endsWith("…[truncated]"));
		ok(utf8Bytes(String(first.note)) <= 4096, `note is ${utf8Bytes(String(first.note))} bytes`);
		ok(String(first.note).endsWith("…[truncated]"));
		ok(!hasLoneSurrogate(String(first.note)), "a bounded string never ends mid code point");

		const second = calls[1]?.rawInput;
		ok(isRecord(second));
		strictEqual(JSON.stringify(wide).length < 32768, true, "the record is under the cap in UTF-16 units");
		strictEqual(second.truncated, true, "and over it in UTF-8 bytes, which is what counts");
		ok(typeof second.bytes === "number" && second.bytes > 32768, `unexpected bytes: ${String(second.bytes)}`);
		strictEqual(second.bytes, utf8Bytes(JSON.stringify(wide)), "bytes is the original record's serialized size");

		const third = calls[2]?.rawInput;
		ok(isRecord(third));
		strictEqual(third.truncated, true);
		// Per-string bounding cut this record from ~245 KiB to ~49 KiB. Reporting the
		// bounded size would understate what the engine produced by five times.
		const originalBytes = utf8Bytes(JSON.stringify(huge));
		strictEqual(third.bytes, originalBytes, "the reported size is the pre-bounding serialization");
		ok(originalBytes > 200_000, `unexpected original size: ${originalBytes}`);
		client.close();
		strictEqual(await server, 0);
	});

	it("emits absolute locations for path-bearing tools and omits them otherwise", async () => {
		const oversizedPath = "é".repeat(3000);
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/x.ts" } },
				{ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } },
				{ type: "tool_execution_start", toolCallId: "t3", toolName: "read", args: { path: oversizedPath } },
			]),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const calls = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call");
		deepStrictEqual(calls[0]?.locations, [{ path: resolve(realpathSync(process.cwd()), "src/x.ts") }]);
		ok(!("locations" in (calls[1] ?? {})), "a tool with no path field carries no locations at all");
		const bounded = (calls[2]?.locations as Array<{ path: string }>)[0]?.path ?? "";
		strictEqual(utf8Bytes(bounded) <= 4096, true);
		ok(bounded.endsWith("…[truncated]"));
		client.close();
		strictEqual(await server, 0);
	});

	it("reuses the same bounded location path in tool_call and session/request_permission", async () => {
		const oversizedPath = "é".repeat(3000);
		const registry = createNormalizingPermissionRegistry(recordingAskSafety([]));
		const harness = startAcpServer({
			chat: createNormalizedArgsPermissionChat(registry, { path: oversizedPath, content: "x" }),
			toolRegistry: registry,
			permissionTimeoutMs: 2000,
		});
		const asks: Array<Record<string, unknown>> = [];
		harness.client.onRequest("session/request_permission", (params) => {
			if (isRecord(params) && isRecord(params.toolCall)) asks.push(params.toolCall);
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		try {
			const sessionId = await openSession(harness.client);
			await harness.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
			const call = sessionUpdates(harness.client.notifications).find((update) => update.sessionUpdate === "tool_call");
			strictEqual(asks.length, 1);
			deepStrictEqual(asks[0]?.locations, call?.locations);
			strictEqual(JSON.stringify(asks[0]?.locations), JSON.stringify(call?.locations), "snapshot is byte-identical");
			const bounded = (asks[0]?.locations as Array<{ path: string }>)[0]?.path ?? "";
			strictEqual(utf8Bytes(bounded) <= 4096, true);
			ok(bounded.endsWith("…[truncated]"));
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("bounds live tool titles on start and terminal updates", async () => {
		const title = "é".repeat(300);
		const harness = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "long-title", toolName: title, args: {} },
				{ type: "tool_execution_end", toolCallId: "long-title", toolName: title, result: "done" },
			]),
		});
		try {
			const sessionId = await openSession(harness.client);
			await harness.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
			const updates = sessionUpdates(harness.client.notifications).filter(
				(update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
			);
			strictEqual(updates.length, 2);
			for (const update of updates) {
				strictEqual(utf8Bytes(String(update.title)) <= 512, true);
				ok(String(update.title).endsWith("…[truncated]"));
			}
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("resolves max_turn_requests without emitting a 129th live tool call", async () => {
		const scripted: Array<Record<string, unknown>> = Array.from({ length: 130 }, (_, index) => ({
			type: "tool_execution_start",
			toolCallId: `tool-${index + 1}`,
			toolName: "read",
			args: { path: `file-${index + 1}` },
		}));
		scripted.push({ type: "text_delta", delta: "MUST_NOT_REACH_THE_CLIENT", toolCallId: "", toolName: "", args: {} });
		const harness = startAcpServer({ chat: createScriptedChat(scripted) });
		try {
			const sessionId = await openSession(harness.client);
			const result = await harness.client.request<{ stopReason: string }>("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "go" }],
			});
			strictEqual(result.stopReason, "max_turn_requests");
			const updates = sessionUpdates(harness.client.notifications);
			const starts = updates.filter((update) => update.sessionUpdate === "tool_call");
			const terminals = updates.filter((update) => update.sessionUpdate === "tool_call_update");
			strictEqual(starts.length, 128);
			strictEqual(terminals.length, 128, "every rendered call is terminally settled before the response");
			ok(!JSON.stringify(updates).includes("tool-129"));
			ok(!JSON.stringify(updates).includes("MUST_NOT_REACH_THE_CLIENT"));
		} finally {
			harness.client.close();
			await harness.server;
		}
	});

	it("asks for permission under the same tool call id the client already rendered", async () => {
		const registry = createPermissionRegistry();
		const chat = createIdentifiedPermissionChat(registry);
		const { client, server } = startAcpServer({ chat, toolRegistry: registry, permissionTimeoutMs: 2000 });
		const asks: Array<Record<string, unknown>> = [];
		const optionNames: string[][] = [];
		client.onRequest("session/request_permission", (params) => {
			if (isRecord(params) && isRecord(params.toolCall)) {
				asks.push(params.toolCall);
				optionNames.push(
					Array.isArray(params.options)
						? params.options.map((option) => (isRecord(option) && typeof option.name === "string" ? option.name : ""))
						: [],
				);
			}
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const toolCall = sessionUpdates(client.notifications).find((update) => update.sessionUpdate === "tool_call");
		strictEqual(toolCall?.toolCallId, "engine-call-1");
		strictEqual(asks.length, 1);
		strictEqual(asks[0]?.toolCallId, "engine-call-1", "the ask names the call the client is showing");
		// Same id, same arguments. A client diffing the ask against the call it
		// rendered must find nothing to diff.
		deepStrictEqual(asks[0]?.rawInput, toolCall?.rawInput);
		deepStrictEqual(optionNames, [["Approve workspace action once", "Deny this request"]]);
		strictEqual(
			(sessionUpdates(client.notifications).find((update) => update.sessionUpdate === "tool_call_update")?.status ??
				"") !== "failed",
			true,
			"presentation labels do not alter the selected allow-once protocol outcome",
		);
		client.close();
		strictEqual(await server, 0);
	});

	it("projects outward consequence actions through ACP without changing protocol ids", async () => {
		const registry = createRegistry({ safety: askSafety });
		registry.register(permissionSpec(ToolNames.AskUser, "read"));
		const call = {
			tool: ToolNames.AskUser,
			args: { exposure: "outward", questions: [{ question: "Publish the report?" }] },
		};
		const chat = createIdentifiedPermissionChat(registry, call);
		const { client, server } = startAcpServer({ chat, toolRegistry: registry, permissionTimeoutMs: 2000 });
		const options: unknown[] = [];
		client.onRequest("session/request_permission", (params) => {
			if (isRecord(params) && Array.isArray(params.options)) options.push(...params.options);
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});

		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		deepStrictEqual(options, [
			{ optionId: "allow-once", name: "Approve outward decision once", kind: "allow_once" },
			{ optionId: "reject-once", name: "Deny this request", kind: "reject_once" },
		]);
		const terminal = sessionUpdates(client.notifications).find((update) => update.sessionUpdate === "tool_call_update");
		strictEqual(terminal?.status, "completed", "the typed label does not alter allow-once settlement");
		client.close();
		strictEqual(await server, 0);
	});

	it("asks with the tool_call's own arguments when the registry normalized them", async () => {
		const evaluated: EvaluatedSafetyCall[] = [];
		const registry = createNormalizingPermissionRegistry(recordingAskSafety(evaluated));
		const { client, server } = startAcpServer({
			chat: createNormalizedArgsPermissionChat(registry),
			toolRegistry: registry,
			permissionTimeoutMs: 2000,
		});
		const asks: Array<Record<string, unknown>> = [];
		client.onRequest("session/request_permission", (params) => {
			if (isRecord(params) && isRecord(params.toolCall)) asks.push(params.toolCall);
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		// The premise: admission really did replace the arguments, so the registry's
		// copy of this call is not the copy the client was shown.
		const admitted = evaluated[0]?.args ?? {};
		strictEqual(admitted.prepared, true, "the admission normalizer ran");
		strictEqual(admitted.path, resolve(realpathSync(process.cwd()), "notes/acp-snapshot.txt"));

		const toolCall = sessionUpdates(client.notifications).find((update) => update.sessionUpdate === "tool_call");
		strictEqual(asks.length, 1);
		strictEqual(asks[0]?.toolCallId, toolCall?.toolCallId);
		// The ask is the stored snapshot of that tool_call, not a rebuild: same
		// object, so a client diffing the two finds nothing, key order included.
		deepStrictEqual(asks[0]?.rawInput, toolCall?.rawInput);
		strictEqual(JSON.stringify(asks[0]?.rawInput), JSON.stringify(toolCall?.rawInput), "byte for byte, keys in order");
		deepStrictEqual(asks[0]?.rawInput, { path: "notes/acp-snapshot.txt", content: "x" });
		deepStrictEqual(asks[0]?.locations, toolCall?.locations);
		deepStrictEqual(asks[0]?.locations, [{ path: resolve(realpathSync(process.cwd()), "notes/acp-snapshot.txt") }]);
		client.close();
		strictEqual(await server, 0);
	});

	it("settles a parked permission when the prompt is cancelled and ignores the late answer", async () => {
		const registry = createPermissionRegistry();
		const bus = createSafeEventBus();
		const resolutions: PermissionResolvedPayload[] = [];
		bus.on(BusChannels.PermissionResolved, (payload) => {
			resolutions.push(payload);
		});
		const chat = createIdentifiedPermissionChat(registry);
		const { client, server } = startAcpServer({ chat, toolRegistry: registry, bus, permissionTimeoutMs: 30_000 });
		let answerLate: () => void = () => {};
		let noteArrival: () => void = () => {};
		const asked = new Promise<void>((resolve) => {
			noteArrival = resolve;
		});
		client.onRequest("session/request_permission", () => {
			noteArrival();
			return new Promise((resolvePermission) => {
				answerLate = () => resolvePermission({ outcome: { outcome: "selected", optionId: "allow-once" } });
			});
		});
		const started = performance.now();
		const sessionId = await openSession(client);
		const prompt = client.request<{ stopReason: string }>("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "go" }],
		});
		await asked;
		await client.request("session/cancel", { sessionId });
		strictEqual((await prompt).stopReason, "cancelled");
		ok(performance.now() - started < 2000, "cancel must settle the parked permission inside the bound");
		strictEqual(resolutions.length, 1);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "cancelled");
		// The abandoned JSON-RPC id has no waiter left; answering it late is inert.
		answerLate();
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		strictEqual(resolutions.length, 1, "a late answer grants nothing");
		assertNoDisclosure(client.frames);
		await client.request("session/close", { sessionId });
		client.close();
		strictEqual(await server, 0);
	});

	it("refuses session/close under an active prompt and answers a repeat close", async () => {
		const chat = createCancellableMockChat();
		const { client, server } = startAcpServer({ chat });
		const sessionId = await openSession(client);
		const prompt = client.request<{ stopReason: string }>("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "wait" }],
		});
		await chat.started;
		const busy = await rejection(client.request("session/close", { sessionId }));
		strictEqual(busy.code, -32000);
		strictEqual(errorDetail(busy).code, "prompt_active");
		await client.request("session/cancel", { sessionId });
		strictEqual((await prompt).stopReason, "cancelled");
		deepStrictEqual(await client.request("session/close", { sessionId }), {});
		deepStrictEqual(await client.request("session/close", { sessionId }), {}, "close is idempotent");
		assertNoDisclosure(client.frames);
		client.close();
		strictEqual(await server, 0);
	});

	it("fails every tool call left open when a prompt is cancelled", async () => {
		const chat = createOpenToolChat();
		const { client, server } = startAcpServer({ chat });
		const sessionId = await openSession(client);
		const prompt = client.request<{ stopReason: string }>("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "wait" }],
		});
		await chat.started;
		await client.request("session/cancel", { sessionId });
		strictEqual((await prompt).stopReason, "cancelled");
		const updates = sessionUpdates(client.notifications);
		const terminal = updates.find((update) => update.sessionUpdate === "tool_call_update");
		strictEqual(terminal?.toolCallId, "engine-call-1");
		strictEqual(terminal?.status, "failed");
		deepStrictEqual(terminal?.content, [{ type: "content", content: { type: "text", text: "cancelled" } }]);
		// The synthesized update has to land before the prompt settles, or a
		// client that stops rendering on the response never sees it.
		const terminalIndex = client.frames.findIndex(
			(frame) =>
				frame.method === "session/update" &&
				isRecord(frame.params) &&
				isRecord(frame.params.update) &&
				frame.params.update.status === "failed",
		);
		const responseIndex = client.frames.findIndex(
			(frame) => "result" in frame && isRecord(frame.result) && "stopReason" in frame.result,
		);
		ok(terminalIndex >= 0 && terminalIndex < responseIndex, "the failed update precedes the prompt response");
		client.close();
		strictEqual(await server, 0);
	});

	it("treats every option but the exact allow-once as a denial", async () => {
		const { resolutions, answer } = await runAcpPermissionBridge("allow-always");
		strictEqual(resolutions.length, 1);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "acp-client");
		strictEqual(answer, "denied", "an option this server never offered cannot grant the call");
	});

	it("never puts a stack or the installation's paths in an error frame", async () => {
		const { client, server } = startAcpServer({ chat: createMockChat() });
		await rejection(client.request("session/new", { cwd: process.cwd() }));
		await client.request("initialize", { protocolVersion: 1 });
		await rejection(client.request("initialize", { protocolVersion: 1 }));
		await rejection(client.request("session/new", { cwd: join(process.cwd(), "nope") }));
		const { sessionId } = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
		await rejection(client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "  " }] }));
		await rejection(client.request("session/prompt", { sessionId: "unknown-id", prompt: [{ type: "text", text: "x" }] }));
		await rejection(client.request("session/prompt", {}));
		await rejection(client.request("session/unknown", {}));
		assertNoDisclosure(client.frames);
		ok(
			client.frames.some((frame) => isRecord(frame.error)),
			"the run must actually have produced error frames",
		);
		client.close();
		strictEqual(await server, 0);
	});

	it("never hands two tool calls the same wire id", async () => {
		// An engine id past the 128-byte bound is aliased, and the engine's next
		// call is literally named after the alias that was just minted. Reusing it
		// would merge two calls into one on the client.
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "e".repeat(200), toolName: "bash", args: { command: "one" } },
				{ type: "tool_execution_start", toolCallId: "clio-tool-1", toolName: "bash", args: { command: "two" } },
			]),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const ids = sessionUpdates(client.notifications)
			.filter((update) => update.sessionUpdate === "tool_call")
			.map((update) => String(update.toolCallId));

		strictEqual(ids.length, 2);
		strictEqual(ids[0], "clio-tool-1", "an oversized engine id is aliased");
		strictEqual(ids[1], "clio-tool-2", "and the alias is not handed out a second time");
		client.close();
		strictEqual(await server, 0);
	});

	it("sends one terminal update per tool call however many ends the engine repeats", async () => {
		const diagnostics: string[] = [];
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
				{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok" },
				{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok, again" },
			]),
			diagnostics: (line) => diagnostics.push(line),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const updates = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call_update");

		strictEqual(updates.length, 1, "a terminal wire id never receives a second update");
		strictEqual(updates[0]?.toolCallId, "t1");
		deepStrictEqual(updates[0]?.content, [{ type: "content", content: { type: "text", text: "ok" } }]);
		deepStrictEqual(diagnostics, ["dropped duplicate terminal update for t1"]);
		client.close();
		strictEqual(await server, 0);
	});

	it("drops an unidentified end once the call it could have named is already terminal", async () => {
		const diagnostics: string[] = [];
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
				{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok" },
				{ type: "tool_execution_end", toolName: "bash", result: "orphan" },
			]),
			diagnostics: (line) => diagnostics.push(line),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const updates = sessionUpdates(client.notifications);
		const callIds = new Set(
			updates.filter((update) => update.sessionUpdate === "tool_call").map((update) => String(update.toolCallId)),
		);
		const updateIds = updates
			.filter((update) => update.sessionUpdate === "tool_call_update")
			.map((update) => String(update.toolCallId));

		deepStrictEqual(updateIds, ["t1"], "the end binds to the last emitted call, which is already terminal");
		for (const id of updateIds) ok(callIds.has(id), `${id} was updated without ever being announced`);
		deepStrictEqual(diagnostics, ["dropped duplicate terminal update for t1"]);
		client.close();
		strictEqual(await server, 0);
	});

	it("drops an unidentified end when the turn emitted no tool call at all", async () => {
		const diagnostics: string[] = [];
		const { client, server } = startAcpServer({
			chat: createScriptedChat([{ type: "tool_execution_end", toolName: "bash", result: "orphan" }]),
			diagnostics: (line) => diagnostics.push(line),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const updates = sessionUpdates(client.notifications);

		strictEqual(
			updates.some((update) => update.sessionUpdate === "tool_call_update"),
			false,
			"an update names a call the client was never shown",
		);
		strictEqual(
			updates.some((update) => update.sessionUpdate === "tool_call"),
			false,
			"and nothing is invented to name it either",
		);
		deepStrictEqual(diagnostics, ["dropped tool_execution_end with no tool call to update"]);
		client.close();
		strictEqual(await server, 0);
	});

	it("drops an end that arrives after the cancel sweep already failed its call", async () => {
		const diagnostics: string[] = [];
		const chat = createLateEndChat();
		const { client, server } = startAcpServer({ chat, diagnostics: (line) => diagnostics.push(line) });
		const sessionId = await openSession(client);
		const cancelled = client.request<{ stopReason: string }>("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "wait" }],
		});
		await chat.started;
		await client.request("session/cancel", { sessionId });
		strictEqual((await cancelled).stopReason, "cancelled");
		// The sweep marks every id it fails terminal, so the engine's late result
		// cannot reopen the call on the next turn or on this one.
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
		const updates = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call_update");

		strictEqual(updates.length, 1, "only the sweep's own failed update reaches the client");
		strictEqual(updates[0]?.status, "failed");
		strictEqual(updates[0]?.toolCallId, "engine-call-1");
		deepStrictEqual(diagnostics, ["dropped tool_execution_end with no tool call to update"]);
		client.close();
		strictEqual(await server, 0);
	});

	it("binds an unidentified permission request to the turn's one open tool call", async () => {
		const registry = createPermissionRegistry();
		const bus = createSafeEventBus();
		const resolutions: PermissionResolvedPayload[] = [];
		bus.on(BusChannels.PermissionResolved, (payload) => {
			resolutions.push(payload);
		});
		const { client, server } = startAcpServer({
			chat: createUnidentifiedPermissionChat(registry, 1),
			toolRegistry: registry,
			bus,
			permissionTimeoutMs: 2000,
		});
		const asks: Array<Record<string, unknown>> = [];
		client.onRequest("session/request_permission", (params) => {
			if (isRecord(params) && isRecord(params.toolCall)) asks.push(params.toolCall);
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		strictEqual(asks.length, 1);
		strictEqual(asks[0]?.toolCallId, "engine-1", "the ask names the call the client is showing");
		strictEqual(resolutions[0]?.status, "granted");
		client.close();
		strictEqual(await server, 0);
	});

	it("denies an unidentified permission request it cannot bind to one call", async () => {
		const registry = createPermissionRegistry();
		const bus = createSafeEventBus();
		const resolutions: PermissionResolvedPayload[] = [];
		bus.on(BusChannels.PermissionResolved, (payload) => {
			resolutions.push(payload);
		});
		const { client, server } = startAcpServer({
			chat: createUnidentifiedPermissionChat(registry, 2),
			toolRegistry: registry,
			bus,
			permissionTimeoutMs: 2000,
		});
		let asked = 0;
		client.onRequest("session/request_permission", () => {
			asked += 1;
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		// Two calls are open and the request names neither, so there is no call the
		// operator could be shown. Asking anyway would put an approval on a call
		// nobody can identify, so the request fails closed instead.
		strictEqual(asked, 0, "the client is never asked about a call it cannot identify");
		strictEqual(
			client.frames.some((frame) => frame.method === "session/request_permission"),
			false,
			"no permission frame is written at all",
		);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "error");
		strictEqual(resolutions[0]?.reason, "permission request has no bindable tool call");
		client.close();
		strictEqual(await server, 0);
	});

	it("denies a permission request whose engine id names no open tool call", async () => {
		const registry = createPermissionRegistry();
		const bus = createSafeEventBus();
		const resolutions: PermissionResolvedPayload[] = [];
		bus.on(BusChannels.PermissionResolved, (payload) => {
			resolutions.push(payload);
		});
		const { client, server } = startAcpServer({
			chat: createMistargetedPermissionChat(registry),
			toolRegistry: registry,
			bus,
			permissionTimeoutMs: 2000,
		});
		let asked = 0;
		client.onRequest("session/request_permission", () => {
			asked += 1;
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		// One call is open, but the request names a different id. Binding it to the
		// open call would approve a call the operator was never shown, and minting
		// an id for it would ask about a call the client never received.
		strictEqual(asked, 0, "the client is never asked about a call it cannot identify");
		strictEqual(
			client.frames.some((frame) => frame.method === "session/request_permission"),
			false,
			"no permission frame is written at all",
		);
		const calls = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call");
		deepStrictEqual(
			calls.map((update) => String(update.toolCallId)),
			["engine-1"],
			"the lookup mints nothing, so no second tool_call appears",
		);
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "error");
		strictEqual(resolutions[0]?.reason, "permission request has no bindable tool call");
		client.close();
		strictEqual(await server, 0);
	});

	it("gives a reused engine tool call id a fresh wire id", async () => {
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "one" } },
				{ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "two" } },
			]),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const calls = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call");

		deepStrictEqual(
			calls.map((update) => String(update.toolCallId)),
			["dup", "clio-tool-1"],
			"a repeated engine id is two calls, not one call announced twice",
		);
		deepStrictEqual(calls[0]?.rawInput, { command: "one" });
		deepStrictEqual(calls[1]?.rawInput, { command: "two" });
		client.close();
		strictEqual(await server, 0);
	});

	it("closes calls sharing one engine id newest first", async () => {
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "one" } },
				{ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "two" } },
				{ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: "two done" },
				{ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: "one done" },
			]),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const updates = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call_update");

		deepStrictEqual(
			updates.map((update) => String(update.toolCallId)),
			["clio-tool-1", "dup"],
			"each end closes the id's most recently opened call, so neither stays open",
		);
		client.close();
		strictEqual(await server, 0);
	});

	it("drops an end for an engine id this turn never started rather than closing another call", async () => {
		const diagnostics: string[] = [];
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "open-y", toolName: "bash", args: { command: "sleep 9" } },
				{ type: "tool_execution_end", toolCallId: "unknown-x", toolName: "read", result: "not mine" },
			]),
			diagnostics: (line) => diagnostics.push(line),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const updates = sessionUpdates(client.notifications);
		const calls = updates.filter((update) => update.sessionUpdate === "tool_call");

		// Binding the end to `open-y` would report the wrong tool's result under a
		// call that is still running, and minting an id for `unknown-x` would update
		// a call the client never received.
		deepStrictEqual(
			calls.map((update) => String(update.toolCallId)),
			["open-y"],
			"nothing is minted for the unknown id",
		);
		strictEqual(
			updates.some((update) => update.sessionUpdate === "tool_call_update"),
			false,
			"no terminal update goes out, so the open call stays open",
		);
		deepStrictEqual(diagnostics, ["dropped tool_execution_end with no tool call to update"]);
		client.close();
		strictEqual(await server, 0);
	});

	it("binds an unidentified end to the outer call once the nested one has already ended", async () => {
		const diagnostics: string[] = [];
		const { client, server } = startAcpServer({
			chat: createScriptedChat([
				{ type: "tool_execution_start", toolCallId: "outer-a", toolName: "bash", args: { command: "outer" } },
				{ type: "tool_execution_start", toolCallId: "inner-b", toolName: "read", args: { path: "x" } },
				{ type: "tool_execution_end", toolCallId: "inner-b", toolName: "read", result: "inner done" },
				{ type: "tool_execution_end", toolName: "bash", result: "outer boom", isError: true },
			]),
			diagnostics: (line) => diagnostics.push(line),
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
		const updates = sessionUpdates(client.notifications).filter((update) => update.sessionUpdate === "tool_call_update");

		// The nested call ended first, so the unidentified end belongs to the outer
		// call that is still running, not to the newest call the client saw start.
		deepStrictEqual(
			updates.map((update) => String(update.toolCallId)),
			["inner-b", "outer-a"],
			"an unidentified end closes the newest call still open",
		);
		strictEqual(updates[0]?.status, "completed");
		strictEqual(updates[1]?.status, "failed", "the status comes from the end event, not from the call it binds to");
		deepStrictEqual(updates[1]?.content, [{ type: "content", content: { type: "text", text: "outer boom" } }]);
		deepStrictEqual(diagnostics, [], "nothing was dropped");
		client.close();
		strictEqual(await server, 0);
	});

	it("binds a permission for a reused engine id to its most recently opened call", async () => {
		const registry = createPermissionRegistry();
		const bus = createSafeEventBus();
		const resolutions: PermissionResolvedPayload[] = [];
		bus.on(BusChannels.PermissionResolved, (payload) => {
			resolutions.push(payload);
		});
		const { client, server } = startAcpServer({
			chat: createReusedIdPermissionChat(registry, { endBoth: false }),
			toolRegistry: registry,
			bus,
			permissionTimeoutMs: 2000,
		});
		const asks: Array<Record<string, unknown>> = [];
		client.onRequest("session/request_permission", (params) => {
			if (isRecord(params) && isRecord(params.toolCall)) asks.push(params.toolCall);
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		strictEqual(asks.length, 1);
		strictEqual(asks[0]?.toolCallId, "clio-tool-1", "the newest open call under that engine id is the one asked about");
		strictEqual(resolutions[0]?.status, "granted");
		client.close();
		strictEqual(await server, 0);
	});

	it("denies a permission for a reused engine id once every one of its calls has finished", async () => {
		const registry = createPermissionRegistry();
		const bus = createSafeEventBus();
		const resolutions: PermissionResolvedPayload[] = [];
		bus.on(BusChannels.PermissionResolved, (payload) => {
			resolutions.push(payload);
		});
		const { client, server } = startAcpServer({
			chat: createReusedIdPermissionChat(registry, { endBoth: true }),
			toolRegistry: registry,
			bus,
			permissionTimeoutMs: 2000,
		});
		let asked = 0;
		client.onRequest("session/request_permission", () => {
			asked += 1;
			return { outcome: { outcome: "selected", optionId: "allow-once" } };
		});
		const sessionId = await openSession(client);
		await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

		strictEqual(asked, 0, "a call the client already saw finish cannot carry an approval");
		strictEqual(resolutions[0]?.status, "denied");
		strictEqual(resolutions[0]?.decidedBy, "error");
		strictEqual(resolutions[0]?.reason, "permission request has no bindable tool call");
		client.close();
		strictEqual(await server, 0);
	});

	it("refuses a session cwd that is not an absolute path", async () => {
		const { client, server } = startAcpServer({ chat: createMockChat() });
		await client.request("initialize", { protocolVersion: 1 });

		// Each of these resolves to the workspace against this process's cwd, which
		// is exactly why they are refused: the client would believe it had pinned a
		// path it never sent.
		for (const cwd of [".", " ", "", "sub", "./"]) {
			const failure = await rejection(client.request("session/new", { cwd }));
			strictEqual(failure.code, -32000, `cwd ${JSON.stringify(cwd)} must be refused`);
			strictEqual(errorDetail(failure).code, "session_cwd_mismatch");
		}
		// The absolute form of the same workspace still works.
		const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
		ok(session.sessionId.length > 0);
		assertNoDisclosure(client.frames);
		client.close();
		strictEqual(await server, 0);
	});

	it("reports an admission reason outside the profile as the catch-all", async () => {
		const { client, server } = startAcpServer({
			chat: createNoticeChat(
				{
					level: "info",
					surface: "transcript",
					text: "[Clio Coder] runtime cannot be driven",
					admission: { reason: "runtime-use-unsupported" },
				},
				{ endTurn: false },
			),
		});
		const sessionId = await openSession(client);
		const failure = await rejection(
			client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }),
		);

		// The engine's diagnostic vocabulary is larger than the profile's, and a
		// client cannot branch on a code the profile never promised.
		deepStrictEqual(errorDetail(failure), { version: 1, code: "prompt_not_admitted", reason: "admission-failed" });
		strictEqual(failure.message.includes("runtime-use-unsupported"), false, "the engine code stays off the wire");
		client.close();
		strictEqual(await server, 0);
	});

	it("passes a profile admission reason through unchanged", async () => {
		const { client, server } = startAcpServer({
			chat: createNoticeChat(
				{
					level: "info",
					surface: "transcript",
					text: "[Clio Coder] no model configured",
					admission: { reason: "model-not-configured" },
				},
				{ endTurn: false },
			),
		});
		const sessionId = await openSession(client);
		const failure = await rejection(
			client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }),
		);

		deepStrictEqual(errorDetail(failure), { version: 1, code: "prompt_not_admitted", reason: "model-not-configured" });
		client.close();
		strictEqual(await server, 0);
	});

	it("reads prompt text only from the ACP v1 prompt block array", async () => {
		const chat = createMockChat();
		const { client, server } = startAcpServer({ chat });
		const sessionId = await openSession(client);

		// Non-text blocks have no textual reading and are ignored rather than
		// coerced into prose the model would then answer.
		await client.request("session/prompt", {
			sessionId,
			prompt: [
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "hi" },
			],
		});
		deepStrictEqual(chat.submitted, ["hi"]);

		// The shapes this server used to tolerate. No ACP client sends them, and
		// accepting them made a client's framing bug look like a working prompt.
		for (const params of [
			{ sessionId, content: [{ type: "text", text: "x" }] },
			{ sessionId, message: [{ type: "text", text: "x" }] },
			{ sessionId, prompt: "x" },
			{ sessionId, prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
		]) {
			const failure = await rejection(client.request("session/prompt", params));
			strictEqual(failure.code, -32602, `unexpected acceptance of ${JSON.stringify(params)}`);
			strictEqual(errorDetail(failure).code, "invalid_params");
		}
		deepStrictEqual(chat.submitted, ["hi"], "no rejected shape ever reached the chat loop");
		client.close();
		strictEqual(await server, 0);
	});
});
