import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { serveDeferredAcp } from "../../src/engine/acp/deferred-boot.js";
import { createAcpHandshake } from "../../src/engine/acp/server.js";
import { createStdioServerTransport } from "../../src/engine/acp/transport.js";
import { createStdioTransport } from "../../src/engine/acp/transport.js";
import { makeScratchHome } from "../harness/scratch-env.js";

test("ACP binds the first session cwd before boot and refuses a different later cwd", async () => {
	const launch = process.cwd();
	const root = mkdtempSync(join(tmpdir(), "acp-deferred-root-"));
	const other = mkdtempSync(join(tmpdir(), "acp-deferred-other-"));
	const input = new PassThrough();
	const output = new PassThrough();
	const responses = new Map<number, Record<string, unknown>>();
	let buffer = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const row = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
			buffer = buffer.slice(newline + 1);
			if (typeof row.id === "number") responses.set(row.id, row);
		}
	});
	const transport = createStdioServerTransport({ input, output });
	const handshake = createAcpHandshake({
		version: "test", session: true, loadSession: true, settings: true, providers: true,
		steer: true, dispatch: true, toolRegistry: true, bus: true,
	});
	const seen: string[] = [];
	const done = serveDeferredAcp({
		transport,
		handshake,
		launchCwd: launch,
		boot: async (cwd, ready) => {
			seen.push(cwd);
			strictEqual(process.cwd(), realpathSync(root));
			await new Promise((resolve) => setTimeout(resolve, 25));
			transport.onRequest("session/new", () => ({ sessionId: "bound" }));
			transport.onRequest("session/list", () => ({ sessions: [] }));
			ready();
			return 0;
		},
	});
	const send = (id: number, method: string, params: unknown) => {
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	};
	const response = async (id: number): Promise<Record<string, unknown>> => {
		for (let tries = 0; tries < 300; tries += 1) {
			const value = responses.get(id);
			if (value) return value;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`missing ACP response ${id}`);
	};
	try {
		send(1, "initialize", { protocolVersion: 1 });
		const initialized = await response(1);
		strictEqual((initialized.result as { protocolVersion: number }).protocolVersion, 1);
		deepStrictEqual(seen, []);
		send(5, "session/new", { cwd: "./", mcpServers: [] });
		strictEqual(((await response(5)).error as { code: number }).code, -32602);
		deepStrictEqual(seen, []);
		send(2, "session/new", { cwd: root, mcpServers: [] });
		send(3, "session/list", {});
		strictEqual((await response(2)).result && ((await response(2)).result as { sessionId: string }).sessionId, "bound");
		deepStrictEqual((await response(3)).result, { sessions: [] });
		deepStrictEqual(seen, [realpathSync(root)]);
		send(4, "session/new", { cwd: other, mcpServers: [] });
		const mismatch = await response(4);
		strictEqual((mismatch.error as { code: number }).code, -32602);
		strictEqual((mismatch.error as { message: string }).message.includes(realpathSync(root)), true);
	} finally {
		transport.close();
		await done;
		process.chdir(launch);
		rmSync(root, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	}
});

test("ACP CLI boots the workspace named by its first session", { timeout: 90_000 }, async () => {
	const scratch = makeScratchHome("acp-deferred-cli-");
	const launch = join(scratch.dir, "launch");
	const project = join(scratch.dir, "project");
	mkdirSync(launch);
	mkdirSync(project);
	const cli = join(new URL("../..", import.meta.url).pathname, "src", "cli", "index.ts");
	const child = createStdioTransport(
		process.execPath,
		["--import", import.meta.resolve("tsx"), cli, "--no-context-files", "--no-skills", "acp"],
		{
			cwd: launch,
			env: Object.fromEntries(
				Object.entries({ ...process.env, ...scratch.env, NODE_ENV: "test" })
					.filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
		},
	);
	try {
		const init = await child.request<{ protocolVersion: number; agentCapabilities: Record<string, unknown> }>("initialize", { protocolVersion: 1 }, 10_000);
		strictEqual(init.protocolVersion, 1);
		const eager = createStdioTransport(
			process.execPath,
			["--import", import.meta.resolve("tsx"), cli, "--no-context-files", "--no-skills", "acp", "--cwd", project],
			{
				cwd: launch,
				env: Object.fromEntries(
					Object.entries({ ...process.env, ...scratch.env, NODE_ENV: "test" })
						.filter((entry): entry is [string, string] => entry[1] !== undefined),
				),
			},
		);
		try {
			const eagerInit = await eager.request<{ agentCapabilities: Record<string, unknown> }>("initialize", { protocolVersion: 1 }, 30_000);
			const normalized = (capabilities: Record<string, unknown>) => {
				const copy = structuredClone(capabilities);
				const metadata = copy._meta as Record<string, unknown>;
				const events = metadata["clio-coder/events"] as Record<string, unknown>;
				delete events.workspaceInstanceId;
				return copy;
			};
			deepStrictEqual(normalized(init.agentCapabilities), normalized(eagerInit.agentCapabilities));
		} finally {
			await eager.forceTerminate();
		}
		const created = await child.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] }, 60_000);
		ok(created.sessionId);
		const listed = await child.request<{ sessions: Array<{ sessionId: string; cwd: string }> }>("session/list", {}, 10_000);
		strictEqual(listed.sessions.some((row) => row.sessionId === created.sessionId && row.cwd === project), true);
		await rejects(
			child.request("session/new", { cwd: launch, mcpServers: [] }, 10_000),
			(error: unknown) => error instanceof Error && error.message.includes(project),
		);
		await child.request("session/close", { sessionId: created.sessionId }, 10_000);
	} finally {
		await child.forceTerminate();
		scratch.cleanup();
	}
});

test("ACP first unfiltered session list binds the launch directory", async () => {
	const launch = process.cwd();
	const input = new PassThrough();
	const output = new PassThrough();
	let observed = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => { observed += chunk; });
	const transport = createStdioServerTransport({ input, output });
	const handshake = createAcpHandshake({
		session: true, loadSession: true, settings: true, providers: true,
		steer: true, dispatch: true, toolRegistry: true, bus: true,
	});
	let bootRoot: string | null = null;
	const done = serveDeferredAcp({
		transport, handshake, launchCwd: launch,
		boot: async (cwd, ready) => {
			bootRoot = cwd;
			transport.onRequest("session/list", () => ({ sessions: [] }));
			ready();
			return 0;
		},
	});
	try {
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} })}\n`);
		for (let tries = 0; tries < 300 && !observed.includes('"id":2'); tries += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		strictEqual(bootRoot, realpathSync(launch));
		ok(observed.includes('"sessions":[]'), observed);
	} finally {
		transport.close();
		await done;
	}
});

test("ACP preboot logout keeps the workspace unbound", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let observed = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => { observed += chunk; });
	const transport = createStdioServerTransport({ input, output });
	const handshake = createAcpHandshake({
		session: true, loadSession: true, settings: true, providers: true,
		steer: true, dispatch: true, toolRegistry: true, bus: true,
	});
	let booted = false;
	const done = serveDeferredAcp({
		transport, handshake, launchCwd: process.cwd(),
		boot: async (_cwd, ready) => { booted = true; ready(); return 0; },
	});
	try {
		for (const [id, method, params] of [
			[1, "initialize", {}],
			[2, "authenticate", { methodId: "unknown" }],
			[3, "logout", {}],
			[4, "session/new", { cwd: process.cwd(), mcpServers: [] }],
		] as const) {
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		}
		for (let tries = 0; tries < 300 && !observed.includes('"id":4'); tries += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const rows = observed.trim().split("\n").map((line) => JSON.parse(line) as { id: number; error?: { code: number } });
		strictEqual(rows.find((row) => row.id === 2)?.error?.code, -32602);
		strictEqual(rows.find((row) => row.id === 4)?.error?.code, -32000);
		strictEqual(booted, false);
	} finally {
		transport.close();
		await done;
	}
});
