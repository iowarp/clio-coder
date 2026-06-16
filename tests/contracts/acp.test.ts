import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { startAcpDelegationRun } from "../../src/engine/acp/adapter.js";
import { AcpEventMapper } from "../../src/engine/acp/event-mapper.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { createStdioServerTransport } from "../../src/engine/acp/transport.js";

interface RpcClient {
	request<T>(method: string, params?: unknown): Promise<T>;
	notifications: unknown[];
	waitForNotification(predicate: (value: unknown) => boolean): Promise<unknown>;
	close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
const USAGE_META_KEY = "clio.coder/usage";

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
	const notifications: unknown[] = [];
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
			if ("id" in message && ("result" in message || "error" in message)) {
				const id = Number(message.id);
				const entry = pending.get(id);
				if (!entry) continue;
				pending.delete(id);
				if (isRecord(message.error)) entry.reject(new Error(String(message.error.message ?? "RPC error")));
				else entry.resolve(message.result);
				continue;
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
		request<T>(method: string, params?: unknown): Promise<T> {
			const id = nextId++;
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: (value) => resolve(value as T), reject });
			});
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
function createErroringMockChat(): AcpServerChat {
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
				content: [{ type: "text", text: "provider exploded" }],
				stopReason: "error",
				errorMessage: "provider exploded",
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
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, _meta: { "clio.coder/session": { close: true } } }, agentInfo: { name: "mock-acp", version: "1" } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from acp" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", _meta: { "clio.coder/usage": { input: 2, output: 3 } } } });
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

	it("serves Clio as an ACP agent with conformant initialize + prompt shapes", async () => {
		const { init, session, prompt, chat, notifications, code } = await runServerPrompt();

		strictEqual(init.protocolVersion, 1);
		strictEqual((init.agentInfo as { name?: string }).name, "clio-coder");

		// AgentCapabilities must match the ACP v1 schema, which has no
		// sessionCapabilities / streaming / tools fields.
		const caps = init.agentCapabilities as Record<string, unknown>;
		strictEqual(caps.loadSession, false);
		ok(isRecord(caps.promptCapabilities), "promptCapabilities must be present");
		ok(isRecord(caps.mcpCapabilities), "mcpCapabilities must be present");
		ok(!("sessionCapabilities" in caps), "sessionCapabilities is not an ACP v1 field");
		ok(!("streaming" in caps), "streaming is not an ACP v1 field");
		ok(!("tools" in caps), "tools is not an ACP v1 field");
		// Clio advertises optional session/close support via the _meta extension slot.
		ok(isRecord(caps._meta), "clio extensions belong in agentCapabilities._meta");

		strictEqual(typeof session.sessionId, "string");

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
		let rejected: Error | null = null;
		try {
			await run.prompt;
		} catch (err) {
			rejected = err as Error;
		}
		ok(rejected, "session/prompt must reject when the turn errors");
		ok(/provider exploded/.test(rejected?.message ?? ""), `unexpected error: ${rejected?.message}`);
		await run.close();
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
});
