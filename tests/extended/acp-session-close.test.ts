import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { makeScratchHome } from "../harness/scratch-env.js";

test("ACP child accepts a new session after closing its bound session", async () => {
	const home = makeScratchHome("clio-coder-acp-session-close-");
	const transport = createStdioTransport(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`
			import { serveClioAcpAgent } from "./src/engine/acp/server.js";
			import { createStdioServerTransport } from "./src/engine/acp/transport.js";
			process.exitCode = await serveClioAcpAgent({
				transport: createStdioServerTransport(),
				cwd: process.cwd(),
				chat: {
					submit: async () => {},
					cancel: () => {},
					onEvent: () => () => {},
					isStreaming: () => false,
					getSessionId: () => null,
				},
			});
			`,
		],
		{
			env: Object.fromEntries(
				Object.entries(home.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
		},
	);
	try {
		const pid = transport.pid;
		ok(pid);
		await transport.request("initialize", { protocolVersion: 1 });
		const first = await transport.request<{ sessionId: string }>("session/new", {
			cwd: process.cwd(),
			mcpServers: [],
		});
		ok(first.sessionId);
		for (const removed of ["read-only", "suggest", "auto-edit", "full-auto", "capable"]) {
			await rejects(
				transport.request("session/set_mode", { sessionId: first.sessionId, modeId: removed }),
				/invalid autonomy level/u,
				removed,
			);
		}
		deepStrictEqual(await transport.request("session/set_mode", { sessionId: first.sessionId, modeId: "yolo" }), {});
		deepStrictEqual(await transport.request("session/set_mode", { sessionId: first.sessionId, modeId: "default" }), {});
		deepStrictEqual(await transport.request("session/close", { sessionId: first.sessionId }), {});
		const second = await transport.request<{ sessionId: string }>("session/new", {
			cwd: process.cwd(),
			mcpServers: [],
		});
		ok(second.sessionId);
		notStrictEqual(second.sessionId, first.sessionId);
		strictEqual(transport.pid, pid);
		deepStrictEqual(await transport.request("session/close", { sessionId: second.sessionId }), {});
		transport.close();
		ok(await transport.waitForExit(5_000));
	} finally {
		await transport.forceTerminate();
		home.cleanup();
	}
});
