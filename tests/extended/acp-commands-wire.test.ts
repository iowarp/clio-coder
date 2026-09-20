import { ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

function fakeTransport() {
	const handlers = new Map<string, RequestHandler>();
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const transport: AcpJsonRpcPeerTransport = {
		get closed() {
			return closed;
		},
		request: async () => {
			throw new Error("the server sends no client requests in this test");
		},
		notify: () => {},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			closeHandlers.push(handler);
			return () => {};
		},
		close: () => {
			closed = true;
			for (const handler of closeHandlers) handler();
		},
	};
	const call = async (method: string, params: unknown): Promise<unknown> => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`no handler registered for ${method}`);
		return await handler(params);
	};
	return { transport, call, has: (method: string) => handlers.has(method) };
}

/** A prompt that never settles, so the test can observe the active-prompt window. */
function hangingChat(): AcpServerChat & { release: () => void } {
	let release: () => void = () => {};
	let streaming = false;
	return {
		submit: () =>
			new Promise<void>((resolve) => {
				streaming = true;
				release = () => {
					streaming = false;
					resolve();
				};
			}),
		cancel: () => release(),
		onEvent: () => () => {},
		isStreaming: () => streaming,
		getSessionId: () => null,
		release: () => release(),
	};
}

const CATALOG = { version: 1 as const, commands: [] };

function control(calls: string[]) {
	return {
		catalog: () => {
			calls.push("catalog");
			return CATALOG;
		},
		invoke: (request: { command: unknown }) => {
			calls.push(`invoke:${String(request.command)}`);
			return { level: "info" as const, lines: ["ran"] };
		},
		injectsUserTurn: (command: unknown) => command === "share",
		capability: { version: 1, list: "clio-coder/commands/list", invoke: "clio-coder/commands/invoke", count: 13 },
	};
}

describe("contracts/acp exposes the operator command catalog only when one is wired", () => {
	it("announces nothing and refuses both methods when the host wired no commands", async () => {
		const peer = fakeTransport();
		const chat = hangingChat();
		const served = serveClioAcpAgent({ transport: peer.transport, chat, cwd: process.cwd() });
		const init = (await peer.call("initialize", { protocolVersion: 1, clientCapabilities: {} })) as {
			agentCapabilities: { _meta: Record<string, unknown> };
		};
		strictEqual(init.agentCapabilities._meta["clio-coder/commands"], undefined);
		await rejects(
			() => peer.call("clio-coder/commands/list", {}),
			(error: unknown) => error instanceof AcpRequestError && error.detail?.code === "internal_error",
		);
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("announces the capability, memoizes the catalog across polls, and invokes through the control", async () => {
		const peer = fakeTransport();
		const calls: string[] = [];
		const chat = hangingChat();
		const served = serveClioAcpAgent({
			transport: peer.transport,
			chat,
			commands: control(calls),
			cwd: process.cwd(),
		});
		const init = (await peer.call("initialize", { protocolVersion: 1, clientCapabilities: {} })) as {
			protocolVersion: number;
			agentCapabilities: { _meta: Record<string, { count?: number }> };
		};
		// Everything rides `_meta`; the version stays where every existing client expects it.
		strictEqual(init.protocolVersion, 1);
		strictEqual(init.agentCapabilities._meta["clio-coder/commands"]?.count, 13);
		const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		strictEqual(await peer.call("clio-coder/commands/list", {}), CATALOG);
		await peer.call("clio-coder/commands/list", {});
		strictEqual(calls.filter((entry) => entry === "catalog").length, 1);
		const result = (await peer.call("clio-coder/commands/invoke", {
			sessionId: session.sessionId,
			command: "doctor",
		})) as { lines: string[] };
		strictEqual(result.lines[0], "ran");
		peer.transport.close();
		strictEqual(await served, 0);
	});

	it("refuses a turn-injecting command while a prompt is active and admits the others", async () => {
		const peer = fakeTransport();
		const calls: string[] = [];
		const chat = hangingChat();
		const served = serveClioAcpAgent({
			transport: peer.transport,
			chat,
			commands: control(calls),
			cwd: process.cwd(),
		});
		await peer.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
		const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		const prompt = peer.call("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "go" }],
		});
		await new Promise((resolve) => setImmediate(resolve));
		await rejects(
			() => peer.call("clio-coder/commands/invoke", { sessionId: session.sessionId, command: "share" }),
			(error: unknown) => error instanceof AcpRequestError && error.detail?.code === "prompt_active",
		);
		ok(!calls.includes("invoke:share"));
		// A command that submits nothing is unaffected by the running turn.
		await peer.call("clio-coder/commands/invoke", { sessionId: session.sessionId, command: "mcp" });
		ok(calls.includes("invoke:mcp"));
		chat.release();
		await prompt;
		peer.transport.close();
		strictEqual(await served, 0);
	});
});
