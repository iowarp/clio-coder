import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { startExtensionHost } from "../../src/entry/extension-host.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";
import { buildExtensionRuntimeToolSpecs } from "../../src/tools/extension-runtime-tools.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const script = `let opened = 0;
export default (api) => {
	api.on("session_open", () => { opened += 1; });
	api.hook("before_tool", () => ({ effects: [{ kind: "block_tool", reason: "gate closed" }] }));
	api.tool("ask", () => ({
		text: "asking the author",
		interview: { id: "gate", title: "Gate", step: { key: "s1", questions: [
			{ id: "q", label: "Approve?", kind: "single", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
		] } },
	}));
	api.interview("gate", (answer, ctx) =>
		answer.nav === "cancel"
			? { done: true, text: "author unavailable: " + answer.reason + " " + ctx.snapshot.mode + " opened " + opened }
			: { done: true, text: "answered" });
};
`;

function installRuntime(dir: string, id: string, runtime: Record<string, unknown>, source: string): string {
	const root = path.join(dir, "source");
	const cwd = path.join(dir, "workspace");
	mkdirSync(root);
	mkdirSync(cwd);
	writeFileSync(
		path.join(root, "clio-coder-extension.json"),
		JSON.stringify({
			id,
			name: id,
			version: "1.0.0",
			description: "A runtime a session host starts",
			runtime: { api: 2, entrypoint: "extension.mjs", ...runtime },
		}),
	);
	writeFileSync(path.join(root, "extension.mjs"), source);
	ok(installExtension(root, { cwd, scope: "user" }).extension?.loadable);
	return cwd;
}

test("a headless session hosts api 2 runtimes: hooks gate, observations arrive, an interview fails closed at once", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"gate_probe",
		{
			events: ["session_open"],
			hooks: [{ on: "before_tool", tools: ["write"], timeoutMs: 1000, onTimeout: "block", onError: "block" }],
			tools: [{ name: "ask", description: "Ask the author", actionClass: "execute", inputSchema: { type: "object" } }],
			ui: ["interview"],
		},
		script,
	);
	const previous = process.cwd();
	process.chdir(cwd);
	const bridge = createExtensionRuntimeHookBridge();
	const notices: string[] = [];
	const host = startExtensionHost({
		mode: "headless",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: bridge,
		bus: createTelemetryHub(),
		chat: { isStreaming: () => false, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => "headless-session",
		targetId: () => "target",
		notify: (line) => notices.push(line),
	});
	t.after(async () => {
		await host.dispose();
		process.chdir(previous);
		env.restore();
	});
	equal((await host.ready).status, "committed", notices.join("\n"));
	const executor = bridge.current();
	ok(executor, "the host binds the hook bridge");
	const gated = await executor.hook("gate_probe", { point: "before_tool", tool: "write", turnId: null }, 1000);
	deepStrictEqual(gated, { kind: "ok", effects: [{ kind: "block_tool", reason: "gate closed" }] });
	const [ask] = buildExtensionRuntimeToolSpecs(listInstalledExtensions(cwd, { all: true }), bridge);
	ok(ask);
	const result = await ask.run({}, {});
	equal(result.kind, "error");
	deepStrictEqual(JSON.parse(result.kind === "error" ? result.message : "{}"), {
		interview: "cancelled",
		reason: "headless",
		answers: {},
		text: "author unavailable: headless headless opened 1",
	});
});

test("a turn that starts right after a session change still runs the gate on the next generation", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"gate_probe",
		{ hooks: [{ on: "before_tool", tools: ["write"], timeoutMs: 1000, onTimeout: "block", onError: "block" }] },
		`export default (api) => {
	api.hook("before_tool", () => ({ effects: [{ kind: "block_tool", reason: "gate closed" }] }));
};
`,
	);
	const previous = process.cwd();
	process.chdir(cwd);
	const bridge = createExtensionRuntimeHookBridge();
	const bus = createTelemetryHub();
	const notices: string[] = [];
	let streaming = false;
	const host = startExtensionHost({
		mode: "acp",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: bridge,
		bus,
		chat: { isStreaming: () => streaming, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => "acp-session",
		targetId: () => "target",
		notify: (line) => notices.push(line),
	});
	t.after(async () => {
		await host.dispose();
		process.chdir(previous);
		env.restore();
	});
	equal((await host.ready).status, "committed", notices.join("\n"));
	// ACP's session/new parks the current session, and the prompt that follows starts its turn at once.
	bus.emit("session.parked", { sessionId: "acp-session", reason: "create_new", at: Date.now() });
	streaming = true;
	const executor = bridge.current();
	ok(executor);
	const gated = await executor.hook("gate_probe", { point: "before_tool", tool: "write", turnId: null }, 1000);
	deepStrictEqual(gated, { kind: "ok", effects: [{ kind: "block_tool", reason: "gate closed" }] }, notices.join("\n"));
});

test("a headless run's last turn_end reaches its runtime before the host disposes it", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"turn_probe",
		{ events: ["turn_end", "session_close"] },
		// The handler is still running when the run's drain disposes the host.
		`export default (api) => {
	api.on("turn_end", () => new Promise((resolve) => setTimeout(resolve, 200)));
	api.on("session_close", () => {});
};
`,
	);
	const previous = process.cwd();
	process.chdir(cwd);
	const handlers: Array<(event: ChatLoopEvent) => void> = [];
	const notices: string[] = [];
	const host = startExtensionHost({
		mode: "headless",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: createExtensionRuntimeHookBridge(),
		bus: createTelemetryHub(),
		chat: {
			isStreaming: () => false,
			turnPreparation: () => ({ phase: "idle", since: 0 }),
			onEvent: (handler) => {
				handlers.push(handler);
				return () => {};
			},
		},
		sessionId: () => "headless-session",
		targetId: () => "target",
		notify: (line) => notices.push(line),
	});
	t.after(() => {
		process.chdir(previous);
		env.restore();
	});
	equal((await host.ready).status, "committed", notices.join("\n"));
	for (const handler of handlers) handler({ type: "agent_end", messages: [] } as unknown as ChatLoopEvent);
	await host.dispose();
	deepStrictEqual(notices, []);
});

test("an ACP client that closes stdin leaves no runtime child and the process exits", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"close_probe",
		{ events: ["session_close"] },
		// A runtime still answering session_close while the ACP process stops.
		`export default (api) => {
	api.on("session_close", () => new Promise((resolve) => setTimeout(resolve, 500)));
};
`,
	);
	const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
	const cli = new URL("../../src/cli/index.ts", import.meta.url).pathname;
	const acp = spawn(process.execPath, ["--import", loader, cli, "acp"], { cwd, env: process.env });
	let exitCode: number | null | undefined;
	acp.once("exit", (code) => {
		exitCode = code;
	});
	let runtime: number | undefined;
	const alive = (pid: number): boolean => {
		try {
			process.kill(-pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	t.after(() => {
		acp.kill("SIGKILL");
		// The runtime leads its own process group; a leaked one goes with the test.
		if (runtime !== undefined && alive(runtime)) process.kill(-runtime, "SIGKILL");
		env.restore();
	});
	let stderr = "";
	acp.stderr.setEncoding("utf8");
	acp.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	let buffer = "";
	const responses = new Set<number>();
	acp.stdout.setEncoding("utf8");
	acp.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const row = JSON.parse(buffer.slice(0, newline)) as { id?: unknown };
			buffer = buffer.slice(newline + 1);
			if (typeof row.id === "number") responses.add(row.id);
		}
	});
	const send = (id: number, method: string, params: unknown) =>
		acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	const poll = async <T>(read: () => T | undefined, what: string): Promise<T> => {
		for (let tries = 0; tries < 400; tries++) {
			const value = read();
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`${what}\n${stderr}`);
	};
	send(1, "initialize", { protocolVersion: 1 });
	send(2, "session/new", { cwd, mcpServers: [] });
	await poll(() => (responses.has(2) ? true : undefined), "no session/new response");
	runtime = await poll(() => {
		const rows = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" }).stdout.split("\n");
		const row = rows
			.map((line) => line.trim().split(/\s+/))
			.find((cols) => Number(cols[1]) === acp.pid && cols.slice(2).join(" ").includes(env.dir));
		return row ? Number(row[0]) : undefined;
	}, "the ACP session started no runtime child");
	acp.stdin.end();
	equal(await poll(() => exitCode, "the ACP process did not exit after its client closed stdin"), 0, stderr);
	ok(!alive(runtime), "the runtime child outlived the ACP process");
});

test("an ACP serve loop that throws still disposes the extension host and the process exits", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"throw_probe",
		{ events: ["session_open"] },
		`export default (api) => {
	api.on("session_open", () => {});
};
`,
	);
	const source = (file: string) => new URL(`../../src/${file}`, import.meta.url).href;
	const acp = spawn(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			"--input-type=module",
			"--eval",
			`
			import { createStdioServerTransport } from ${JSON.stringify(source("engine/acp/transport.ts"))};
			import { bootOrchestrator } from ${JSON.stringify(source("entry/orchestrator.ts"))};
			const transport = createStdioServerTransport();
			try {
				await bootOrchestrator({ acp: { transport, onReady: () => { throw new Error("serve failed"); } } });
			} catch (error) {
				// As the CLI does: report, close the transport and let the loop drain once the client leaves.
				transport.close();
				process.stderr.write(String(error) + "\\n");
				process.exitCode = 1;
			}
			`,
		],
		{ cwd, env: process.env },
	);
	let exitCode: number | null | undefined;
	acp.once("exit", (code) => {
		exitCode = code;
	});
	// A runtime leads its own process group and carries the install path in its argv.
	const runtimes = (): number[] =>
		spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
			.stdout.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter((cols) => cols.slice(1).join(" ").includes(env.dir))
			.map((cols) => Number(cols[0]));
	t.after(() => {
		acp.kill("SIGKILL");
		for (const pid of runtimes())
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already gone between the listing and the kill.
			}
		env.restore();
	});
	let stderr = "";
	acp.stderr.setEncoding("utf8");
	acp.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const poll = async <T>(read: () => T | undefined, what: string): Promise<T> => {
		for (let tries = 0; tries < 400; tries++) {
			const value = read();
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`${what}\n${stderr}`);
	};
	await poll(() => (stderr.includes("serve failed") ? true : undefined), "the serve loop did not throw");
	// The client leaves; nothing but a runtime child could hold the process open now.
	acp.stdin.end();
	equal(await poll(() => exitCode, "the ACP process did not exit after its serve loop threw"), 1, stderr);
	deepStrictEqual(runtimes(), [], "a runtime child outlived the ACP process");
});

test("a headless run's first turn_start reaches its runtime though the turn starts before startup commits", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"start_probe",
		{
			events: ["turn_start"],
			tools: [{ name: "seen", description: "The turns seen", actionClass: "read", inputSchema: { type: "object" } }],
		},
		`const seen = [];
export default (api) => {
	api.on("turn_start", (event) => { seen.push(event.turnId); });
	api.tool("seen", () => ({ text: seen.join(",") || "none" }));
};
`,
	);
	const previous = process.cwd();
	process.chdir(cwd);
	const bridge = createExtensionRuntimeHookBridge();
	const notices: string[] = [];
	const host = startExtensionHost({
		mode: "headless",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: bridge,
		bus: createTelemetryHub(),
		chat: { isStreaming: () => false, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => "headless-session",
		targetId: () => "target",
		notify: (line) => notices.push(line),
	});
	t.after(async () => {
		await host.dispose();
		process.chdir(previous);
		env.restore();
	});
	const executor = bridge.current();
	ok(executor, "the host binds the hook bridge");
	// The run submits its prompt while the startup generation still stages.
	executor.observeTurnStart?.("first prompt");
	equal((await host.ready).status, "committed", notices.join("\n"));
	deepStrictEqual(await executor.tool?.("start_probe", "seen", {}), { text: "turn-1" }, notices.join("\n"));
});

test("a turn held during startup is dropped once ACP's session/new makes another session current", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"start_probe",
		{
			events: ["turn_start"],
			tools: [{ name: "seen", description: "The turns seen", actionClass: "read", inputSchema: { type: "object" } }],
		},
		`const seen = [];
export default (api) => {
	api.on("turn_start", (event) => { seen.push(event.turnId); });
	api.tool("seen", () => ({ text: seen.join(",") || "none" }));
};
`,
	);
	const previous = process.cwd();
	process.chdir(cwd);
	const bridge = createExtensionRuntimeHookBridge();
	const bus = createTelemetryHub();
	const notices: string[] = [];
	let sessionId = "old-session";
	const host = startExtensionHost({
		mode: "acp",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: bridge,
		bus,
		chat: { isStreaming: () => false, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => sessionId,
		targetId: () => "target",
		notify: (line) => notices.push(line),
	});
	t.after(async () => {
		await host.dispose();
		process.chdir(previous);
		env.restore();
	});
	const executor = bridge.current();
	ok(executor, "the host binds the hook bridge");
	executor.observeTurnStart?.("old prompt");
	// session/new arrives while the startup generation still stages.
	bus.emit("session.parked", { sessionId, reason: "create_new", at: Date.now() });
	sessionId = "new-session";
	await host.ready;
	deepStrictEqual(await executor.tool?.("start_probe", "seen", {}), { text: "none" }, notices.join("\n"));
});

test("a hook that arrives after a second session change, while the first change's reload runs, waits for the next generation", async (t) => {
	const env = await isolateClioEnv("clio-coder-session-host-");
	const cwd = installRuntime(
		env.dir,
		"gate_probe",
		{ hooks: [{ on: "before_tool", tools: ["write"], timeoutMs: 1000, onTimeout: "block", onError: "block" }] },
		`export default (api) => {
	api.hook("before_tool", () => ({ effects: [{ kind: "block_tool", reason: "gate closed" }] }));
};
`,
	);
	const previous = process.cwd();
	process.chdir(cwd);
	const bridge = createExtensionRuntimeHookBridge();
	const bus = createTelemetryHub();
	const notices: string[] = [];
	const host = startExtensionHost({
		mode: "acp",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: bridge,
		bus,
		chat: { isStreaming: () => true, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => "acp-session",
		targetId: () => "target",
		notify: (line) => notices.push(line),
	});
	t.after(async () => {
		await host.dispose();
		process.chdir(previous);
		env.restore();
	});
	equal((await host.ready).status, "committed", notices.join("\n"));
	bus.emit("session.parked", { sessionId: "acp-session", reason: "create_new", at: Date.now() });
	// The first change's generation starts staging, then a second change rejects it before the hook arrives.
	const first = host.operator.v2.whenLive();
	bus.emit("session.parked", { sessionId: "acp-session", reason: "create_new", at: Date.now() });
	const executor = bridge.current();
	ok(executor);
	const gated = await executor.hook("gate_probe", { point: "before_tool", tool: "write", turnId: null }, 1000);
	deepStrictEqual(gated, { kind: "ok", effects: [{ kind: "block_tool", reason: "gate closed" }] }, notices.join("\n"));
	await first;
});
