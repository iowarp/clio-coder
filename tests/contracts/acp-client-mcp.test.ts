import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createMcpCapabilitySource } from "../../src/tools/gateway/mcp-capabilities.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("ACP client stdio MCP server is callable through gateway and closes with its session", async () => {
	const env = await isolateClioEnv("acp-client-mcp-");
	const cwd = process.cwd();
	const fixture = resolve("tests/fixtures/mcp-fake-server.mjs");
	const registry = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "yolo" });
	const source = createMcpCapabilitySource({ cwd, registry, configDir: env.dir, requestTimeoutMs: 5_000 });
	registry.register(createGatewayTool({ registry, mcp: source }));
	const handlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
	let stop: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onNotification: () => () => {},
		onRequest: (method, handler) => { handlers.set(method, handler); return () => handlers.delete(method); },
		onClose: (handler) => { stop = handler; return () => {}; },
		close: () => stop(),
	};
	type StoredSession = { id: string; cwd: string; createdAt: string; endedAt: string | null };
	let current: StoredSession | null = null;
	let stored: StoredSession | null = null;
	const session = {
		current: () => current,
		history: () => stored ? [stored] : [],
		create: () => {
			current = { id: "acp-mcp", cwd, createdAt: new Date().toISOString(), endedAt: null };
			stored = current;
			return current;
		},
		resume: () => {
			if (!stored) throw new Error("missing stored session");
			stored.endedAt = null;
			current = stored;
			return stored;
		},
		tree: () => ({ leafId: null }),
		close: async () => { if (stored) stored.endedAt = new Date().toISOString(); current = null; },
	} as unknown as SessionContract;
	const done = serveClioAcpAgent({
		transport, cwd, session, toolRegistry: registry, mcpCapabilities: source,
		readSessionEntries: () => [], buildReplayMessages: () => [],
		chat: {
			submit: async () => {}, cancel: () => {}, onEvent: () => () => {}, isStreaming: () => false,
			getSessionId: () => current?.id ?? null, resetForSession: () => {},
		},
	});
	const call = async (method: string, params: unknown) => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`missing ${method}`);
		return await handler(params);
	};
	try {
		await call("initialize", { protocolVersion: 1 });
		await rejects(
			call("session/new", { cwd, mcpServers: [{ type: "http", name: "remote", url: "https://example.invalid" }] }),
			(error: unknown) => error instanceof AcpRequestError && error.rpcCode === -32602,
		);
		const mcpServers = [{ name: "fixture", command: process.execPath, args: [fixture], env: [] }];
		const created = await call("session/new", { cwd, mcpServers }) as { sessionId: string };
		strictEqual(created.sessionId, "acp-mcp");
		deepStrictEqual(source.connectedIds({ readyOnly: true }), ["acp_fixture"]);
		const result = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: "mcp_acp_fixture__echo", args: { text: "through gateway" } },
		});
		ok(result.kind === "ok" && result.result.kind === "ok", JSON.stringify(result));
		deepStrictEqual(JSON.parse(result.result.output), { text: "through gateway" });
		await call("session/close", { sessionId: created.sessionId });
		deepStrictEqual(source.connectedIds(), []);
		strictEqual(source.teardownReports().length, 1);
		strictEqual(registry.get("mcp_acp_fixture__echo" as never), undefined);
		for (const method of ["session/resume", "session/load"]) {
			await call(method, { sessionId: created.sessionId, cwd, mcpServers });
			deepStrictEqual(source.connectedIds({ readyOnly: true }), ["acp_fixture"]);
			const replayed = await registry.invoke({
				tool: ToolNames.Gateway,
				args: { op: "call", capability: "mcp_acp_fixture__echo", args: { text: method } },
			});
			ok(replayed.kind === "ok" && replayed.result.kind === "ok", JSON.stringify(replayed));
			deepStrictEqual(JSON.parse(replayed.result.output), { text: method });
			await call("session/close", { sessionId: created.sessionId });
			deepStrictEqual(source.connectedIds(), []);
		}
		strictEqual(source.teardownReports().length, 3);
	} finally {
		transport.close();
		await done;
		await source.close();
		env.restore();
	}
});
