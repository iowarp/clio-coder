import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, isSubset } from "../../src/domains/safety/scope.js";
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
			emit({ type: "prompt_diagnostics", promptDiagnostics: { renderedPromptHash: "hash" } });
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

function createCancellableMockChat(): AcpServerChat & { cancelled: boolean } {
	const listeners = new Set<(event: unknown) => void>();
	let streaming = false;
	let resolveSubmit: (() => void) | null = null;
	const emit = (event: unknown): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		cancelled: false,
		async submit(): Promise<void> {
			streaming = true;
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

const safety: SafetyContract = {
	classify: () => ({ actionClass: "read", reasons: [] }),
	evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
	observeLoop: () => ({ looping: false, key: "test", count: 0 }),
	scopes: {
		default: DEFAULT_SCOPE,
		readonly: DEFAULT_SCOPE,
		advise: DEFAULT_SCOPE,
		super: DEFAULT_SCOPE,
	},
	isSubset,
	audit: { recordCount: () => 0 },
};

describe("contracts/acp", () => {
	it("maps agent thought chunks from ACP agents that use the OpenCode update name", () => {
		const mapper = new AcpEventMapper("default");
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
			mode: "default",
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
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, agentInfo: { name: "mock-acp", version: "1" } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from acp" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { input: 2, output: 3 } } });
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
				mode: "default",
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

	it("serves Clio as an ACP agent over newline JSON-RPC streams", async () => {
		const clientToServer = new PassThrough();
		const serverToClient = new PassThrough();
		const transport = createStdioServerTransport({ input: clientToServer, output: serverToClient });
		const chat = createMockChat();
		const server = serveClioAcpAgent({ transport, chat, cwd: process.cwd(), version: "test" });
		const client = createRpcClient(clientToServer, serverToClient);

		const init = await client.request<{ protocolVersion: number; agentInfo: { name: string } }>("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "mock-client", version: "1" },
		});
		strictEqual(init.protocolVersion, 1);
		strictEqual(init.agentInfo.name, "clio-coder");

		const session = await client.request<{ sessionId: string }>("session/new", { cwd: process.cwd() });
		strictEqual(typeof session.sessionId, "string");

		const prompt = await client.request<{ stopReason: string; usage: { input: number; output: number } }>(
			"session/prompt",
			{
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "say hello" }],
			},
		);
		strictEqual(prompt.stopReason, "end_turn");
		strictEqual(prompt.usage.input, 4);
		strictEqual(prompt.usage.output, 5);
		strictEqual(chat.submitted[0], "say hello");

		ok(
			client.notifications.some(
				(message) =>
					isRecord(message) &&
					message.method === "session/update" &&
					isRecord(message.params) &&
					isRecord(message.params.update) &&
					message.params.update.sessionUpdate === "agent_message_chunk",
			),
		);
		ok(
			client.notifications.some(
				(message) =>
					isRecord(message) &&
					isRecord(message.params) &&
					isRecord(message.params.update) &&
					message.params.update.sessionUpdate === "thought_message_chunk",
			),
		);
		ok(
			client.notifications.some(
				(message) =>
					isRecord(message) &&
					isRecord(message.params) &&
					isRecord(message.params.update) &&
					message.params.update.sessionUpdate === "tool_call_update",
			),
		);

		await client.request("session/close", { sessionId: session.sessionId });
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
		await client.waitForNotification(
			(message) =>
				isRecord(message) &&
				isRecord(message.params) &&
				isRecord(message.params.update) &&
				message.params.update.sessionUpdate === "progress" &&
				message.params.update.title === "started",
		);
		await client.request("session/cancel", { sessionId: session.sessionId });
		const result = await prompt;
		strictEqual(chat.cancelled, true);
		strictEqual(result.stopReason, "cancelled");
		await client.request("session/close", { sessionId: session.sessionId });
		client.close();
		strictEqual(await server, 0);
	});
});
