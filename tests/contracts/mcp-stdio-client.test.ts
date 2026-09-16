import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	classifyJsonRpcMessage,
	createLineFramer,
	createMcpStdioClient,
	encodeJsonRpcMessage,
	MCP_PROTOCOL_VERSION,
	MCP_TOOL_LIST_CAP,
	type McpClient,
	McpError,
	renderMcpContent,
} from "../../src/domains/gateway/mcp/index.js";

const FIXTURE = resolve("tests/fixtures/mcp-fake-server.mjs");
const roots: string[] = [];
const clients: McpClient[] = [];
/** Processes the fixture started on our behalf; every test that creates one must see it die. */
const strays: number[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-mcp-client-"));
	roots.push(root);
	return root;
}

function client(
	mode = "normal",
	options: Partial<Parameters<typeof createMcpStdioClient>[1]> = {},
	spec: Partial<Parameters<typeof createMcpStdioClient>[0]> = {},
): McpClient {
	const root = workspace();
	const created = createMcpStdioClient(
		{ id: "fake", command: process.execPath, args: [FIXTURE, mode], ...spec },
		{ workspaceRoot: root, requestTimeoutMs: 1_500, initializeTimeoutMs: 1_500, killGraceMs: 200, ...options },
	);
	clients.push(created);
	return created;
}

async function rejectsWithCode(promise: Promise<unknown>, code: McpError["code"], pattern?: RegExp): Promise<McpError> {
	let caught: unknown = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	ok(caught instanceof McpError, `expected an McpError, got ${String(caught)}`);
	strictEqual(caught.code, code, caught.message);
	if (pattern) match(caught.message, pattern);
	return caught;
}

function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((settle) => setTimeout(settle, 10));
	}
}

/**
 * Ask the fixture to start a descendant that ignores SIGTERM. The pid comes
 * back only once the descendant's handler is installed; the handler writes
 * the delivery time into `marker`, which is how a test proves the descendant
 * saw SIGTERM and lived through the grace period.
 */
async function spawnDescendant(c: McpClient, exitLeader: boolean): Promise<{ pid: number; marker: string }> {
	const marker = join(workspace(), "sigterm.marker");
	const result = await c.callTool("spawn_descendant", { marker, ...(exitLeader ? { exitLeader: true } : {}) });
	const { pid } = JSON.parse(result.text) as { pid: number };
	ok(Number.isInteger(pid) && pid > 0, "the fixture reports the descendant pid");
	strays.push(pid);
	ok(processAlive(pid), "the descendant is running with its SIGTERM handler installed");
	ok(!existsSync(marker), "no SIGTERM has reached the descendant yet");
	return { pid, marker };
}

type GroupSignal = [number, string | number | undefined];

/**
 * Run `action` while recording every process.kill aimed at a process group
 * (negative pid). With `phantomMember` the group is made to look occupied no
 * matter what: probes report a member and real signals have their ESRCH
 * swallowed, which is the only way to stage a group that outlives SIGKILL.
 */
async function recordGroupSignals(action: () => Promise<unknown>, phantomMember = false): Promise<GroupSignal[]> {
	const calls: GroupSignal[] = [];
	const realKill = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		if (pid >= 0) return realKill.call(process, pid, signal);
		calls.push([pid, signal]);
		if (!phantomMember) return realKill.call(process, pid, signal);
		if (signal === 0) return true;
		try {
			return realKill.call(process, pid, signal);
		} catch {
			return true;
		}
	}) as typeof process.kill;
	try {
		await action();
	} finally {
		process.kill = realKill;
	}
	return calls;
}

function signalsOnly(calls: ReadonlyArray<GroupSignal>): GroupSignal[] {
	return calls.filter(([, signal]) => signal !== 0);
}

afterEach(async () => {
	for (const entry of clients.splice(0)) await entry.close();
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone, which is what the tests assert.
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mcp stdio protocol framing", () => {
	it("splits newline-delimited messages across chunks and tolerates CRLF and blank lines", () => {
		const framer = createLineFramer();
		const first = framer.push(Buffer.from('{"jsonrpc":"2.0","id":1,"res'));
		deepStrictEqual(first, []);
		strictEqual(framer.pendingBytes, Buffer.byteLength('{"jsonrpc":"2.0","id":1,"res'));
		const second = framer.push(Buffer.from('ult":{}}\r\n\n{"jsonrpc":"2.0","method":"notifications/x"}\n'));
		strictEqual(second.length, 2);
		deepStrictEqual(second[0], {
			kind: "message",
			message: { kind: "response", message: { jsonrpc: "2.0", id: 1, result: {} } },
		});
		deepStrictEqual(second[1], {
			kind: "message",
			message: { kind: "notification", message: { jsonrpc: "2.0", method: "notifications/x" } },
		});
		strictEqual(framer.pendingBytes, 0);
	});

	it("flushes a final unterminated line at end of stream", () => {
		const framer = createLineFramer();
		framer.push(Buffer.from('{"jsonrpc":"2.0","id":"a","method":"roots/list"}'));
		const frames = framer.flush();
		strictEqual(frames.length, 1);
		ok(frames[0]?.kind === "message" && frames[0].message.kind === "request");
		deepStrictEqual(framer.flush(), []);
	});

	it("refuses a line over the cap before its newline arrives and yields nothing afterwards", () => {
		const framer = createLineFramer(16);
		const frames = framer.push(Buffer.from("x".repeat(17)));
		strictEqual(frames.length, 1);
		ok(frames[0]?.kind === "error");
		strictEqual(frames[0].error.code, "protocol");
		match(frames[0].error.message, /exceeds 16 bytes/);
		ok(framer.failed);
		deepStrictEqual(framer.push(Buffer.from('{"jsonrpc":"2.0","id":1,"result":1}\n')), []);
	});

	it("refuses invalid UTF-8 and invalid JSON as protocol errors", () => {
		const utf8 = createLineFramer().push(
			Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}\n')]),
		);
		ok(utf8[0]?.kind === "error");
		match(utf8[0].error.message, /not valid UTF-8/);
		const json = createLineFramer().push(Buffer.from("not json\n"));
		ok(json[0]?.kind === "error");
		match(json[0].error.message, /not valid JSON/);
	});

	it("classifies message shapes and names malformed ones", () => {
		ok(!(classifyJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "m" }) instanceof McpError));
		const missingVersion = classifyJsonRpcMessage({ id: 1, result: 1 });
		ok(missingVersion instanceof McpError);
		match(missingVersion.message, /jsonrpc/);
		const both = classifyJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } });
		ok(both instanceof McpError);
		const badError = classifyJsonRpcMessage({ jsonrpc: "2.0", id: 1, error: { message: "x" } });
		ok(badError instanceof McpError);
		const neither = classifyJsonRpcMessage({ jsonrpc: "2.0", id: 1 });
		ok(neither instanceof McpError);
		const badId = classifyJsonRpcMessage({ jsonrpc: "2.0", id: {}, method: "m" });
		ok(badId instanceof McpError);
		const encoded = encodeJsonRpcMessage({ jsonrpc: "2.0", method: "n", params: { text: "a\nb" } });
		strictEqual(encoded.indexOf(0x0a), encoded.length - 1, "the only raw newline is the terminator");
	});

	it("bounds the rendered result text at a UTF-8 boundary", () => {
		const rendered = renderMcpContent([{ type: "text", text: "é".repeat(100) }], 80);
		ok(rendered.truncated);
		ok(Buffer.byteLength(rendered.text, "utf8") <= 80);
		ok(!rendered.text.includes("�"));
		match(rendered.text, /truncated at 80 bytes/);
	});
});

describe("mcp stdio client", () => {
	it("initializes, records server info, and captures the stderr tail", async () => {
		const c = client();
		strictEqual(c.state().status, "idle");
		const info = await c.initialize();
		strictEqual(info.protocolVersion, MCP_PROTOCOL_VERSION);
		deepStrictEqual(info.serverInfo, { name: "fake", version: "1.0" });
		deepStrictEqual(info.capabilities, { tools: { listChanged: true } });
		strictEqual(info.instructions, "fixture");
		strictEqual(c.state().status, "ready");
		strictEqual(c.serverInfo(), info);
		strictEqual(await c.initialize(), info, "a second initialize reuses the first");
		await waitFor(() => c.stderrTail().includes("fake server started"));
	});

	it("keeps only the last stderrTailBytes under a stderr flood", async () => {
		const c = client("normal", { stderrTailBytes: 2048 });
		strictEqual((await c.callTool("stderr_flood", {})).text, "flooded");
		await waitFor(() => c.stderrTail().endsWith("flood done\n"));
		const tail = c.stderrTail();
		ok(Buffer.byteLength(tail, "utf8") <= 2048, `tail is ${Buffer.byteLength(tail, "utf8")} bytes`);
		ok(Buffer.byteLength(tail, "utf8") > 1024, "the tail keeps the most recent lines, not just the last one");
		ok(!tail.includes("fake server started"), "the oldest output has been evicted");
	});

	it("lists tools across pages and normalizes descriptors", async () => {
		const c = client();
		const listing = await c.listTools();
		strictEqual(listing.truncated, false);
		deepStrictEqual(
			listing.tools.map((tool) => tool.name),
			[
				"echo",
				"fail",
				"sleep",
				"media",
				"structured",
				"crash",
				"oversized",
				"invalid_utf8",
				"server_request",
				"list_changed",
				"env",
				"spawn_descendant",
				"stderr_flood",
				"flood_requests",
			],
		);
		const sleep = listing.tools[2];
		strictEqual(sleep?.title, "Sleeper");
		deepStrictEqual(sleep?.annotations, { readOnlyHint: true });
		strictEqual(listing.tools[1]?.title, null);
		deepStrictEqual(listing.tools[1]?.inputSchema, { type: "object" });
	});

	it("stops pagination at the tool cap and reports the truncation", async () => {
		const c = client("endless-tools");
		const listing = await c.listTools();
		strictEqual(listing.tools.length, MCP_TOOL_LIST_CAP);
		strictEqual(listing.truncated, true);
	});

	it("calls tools and returns text, error flags, structured content, and every content kind", async () => {
		const c = client();
		const echo = await c.callTool("echo", { text: "hi", n: 2 });
		strictEqual(echo.isError, false);
		strictEqual(echo.text, JSON.stringify({ text: "hi", n: 2 }));
		strictEqual(echo.textTruncated, false);
		const failed = await c.callTool("fail", {});
		strictEqual(failed.isError, true);
		strictEqual(failed.text, "boom");
		const structured = await c.callTool("structured", {});
		deepStrictEqual(structured.structuredContent, { a: 1 });
		const media = await c.callTool("media", {});
		deepStrictEqual(
			media.content.map((block) => block.type),
			["text", "image", "audio", "resource", "resource", "other"],
		);
		strictEqual(
			media.text,
			[
				"hello",
				"[image image/png, 3 bytes]",
				"[audio audio/wav, 4 bytes]",
				"[resource file:///a.txt]\nalpha",
				"[resource file:///b.txt]",
				"[unsupported content type hologram]",
			].join("\n"),
		);
	});

	it("maps a JSON-RPC error response to a server error carrying the server's error object", async () => {
		const c = client();
		const error = await rejectsWithCode(c.callTool("nope", {}), "server", /unknown tool: nope/);
		deepStrictEqual(error.data, { code: -32602, message: "unknown tool: nope" });
		strictEqual(c.state().status, "ready");
	});

	it("times out one request without killing the server", async () => {
		const c = client();
		await rejectsWithCode(c.callTool("sleep", { ms: 500 }, { timeoutMs: 50 }), "timeout", /timed out after 50ms/);
		strictEqual(c.state().status, "ready");
		strictEqual((await c.callTool("echo", { after: "timeout" })).text, JSON.stringify({ after: "timeout" }));
	});

	it("aborts a request the server is already working on and leaves the server running", async () => {
		const c = client();
		await c.initialize();
		const controller = new AbortController();
		const call = c.callTool("sleep", { ms: 300 }, { signal: controller.signal });
		await waitFor(() => c.stderrTail().includes("sleep start"), 1_500);
		controller.abort();
		await rejectsWithCode(call, "aborted", /tools\/call aborted$/);
		strictEqual(c.state().status, "ready");
		const early = new AbortController();
		early.abort();
		await rejectsWithCode(c.callTool("echo", {}, { signal: early.signal }), "aborted", /before it was sent/);
		strictEqual((await c.callTool("echo", { ok: true })).isError, false);
		// The late answer to the aborted request arrives and is dropped without effect.
		await new Promise((settle) => setTimeout(settle, 350));
		strictEqual(c.state().status, "ready");
		strictEqual(c.notificationCount(), 0);
		strictEqual((await c.callTool("echo", { still: "fine" })).text, JSON.stringify({ still: "fine" }));
	});

	it("answers server-initiated requests with method-not-found and counts notifications", async () => {
		const c = client();
		const answered = await c.callTool("server_request", {});
		strictEqual(answered.text, "client error code -32601");
		strictEqual(c.toolsChanged(), false);
		const notified = await c.callTool("list_changed", {});
		strictEqual(notified.text, "notified");
		strictEqual(c.toolsChanged(), true);
		strictEqual(c.notificationCount(), 2);
		c.acknowledgeToolsChanged();
		strictEqual(c.toolsChanged(), false);
	});

	it("fails closed on an oversized line and on invalid UTF-8, and then refuses further calls", async () => {
		const oversized = client("normal", { maxLineBytes: 1024 });
		const pid = oversized.pid;
		const first = await rejectsWithCode(
			oversized.callTool("oversized", { bytes: 4096 }),
			"protocol",
			/exceeds 1024 bytes/,
		);
		const state = oversized.state();
		strictEqual(state.status, "failed");
		match(state.status === "failed" ? state.reason : "", /protocol error from mcp server fake/);
		// The failure closes the server; its exit is a second fatal event that must not replace the first.
		await waitFor(() => !processAlive(pid));
		const later = oversized.state();
		strictEqual(later.status === "failed" ? later.reason : "", first.message);
		strictEqual(await rejectsWithCode(oversized.callTool("echo", {}), "protocol"), first, "the same error instance");
		const invalid = client();
		await rejectsWithCode(invalid.callTool("invalid_utf8", {}), "protocol", /not valid UTF-8/);
	});

	it("reports a crashing server as closed with its exit code and keeps that cause", async () => {
		const c = client();
		const first = await rejectsWithCode(
			c.callTool("crash", {}),
			"closed",
			/exited with code 3 before the client closed it/,
		);
		strictEqual(c.state().status, "failed");
		await waitFor(() => !processAlive(c.pid));
		strictEqual(await rejectsWithCode(c.callTool("echo", {}), "closed"), first);
		strictEqual(await rejectsWithCode(c.initialize(), "closed"), first);
	});

	it("keeps the first of two competing fatal events as the cause", async () => {
		// The server writes garbage and exits; whichever event the loop sees first is the cause, and it stays the cause.
		const c = client("garbage-then-exit");
		let caught: unknown = null;
		try {
			await c.initialize();
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof McpError, `expected an McpError, got ${String(caught)}`);
		const first = caught;
		ok(first.code === "protocol" || first.code === "closed", first.code);
		ok(/(not valid JSON|exited with code 9)/.test(first.message), first.message);
		const state = c.state();
		strictEqual(state.status, "failed");
		strictEqual(state.status === "failed" ? state.reason : "", first.message);
		await waitFor(() => !processAlive(c.pid));
		const settled = c.state();
		strictEqual(settled.status === "failed" ? settled.reason : "", first.message);
		strictEqual(await rejectsWithCode(c.callTool("echo", {}), first.code), first);
	});

	it("times out initialize against a silent server and reports a server that exits during initialize", async () => {
		const silent = client("silent-init", { initializeTimeoutMs: 100 });
		await rejectsWithCode(silent.initialize(), "timeout", /initialize failed: initialize timed out after 100ms/);
		strictEqual(silent.state().status, "failed");
		await waitFor(() => !processAlive(silent.pid));
		const exiting = client("exit-on-init");
		await rejectsWithCode(exiting.initialize(), "closed", /exited with code 7/);
		const garbage = client("garbage");
		await rejectsWithCode(garbage.initialize(), "protocol", /not valid JSON/);
	});

	it("reports a missing executable as a spawn failure", async () => {
		const c = client("normal", {}, { command: "clio-coder-definitely-missing-binary" });
		await rejectsWithCode(c.initialize(), "spawn", /failed to start/);
		strictEqual(c.state().status, "failed");
		await rejectsWithCode(c.callTool("echo", {}), "spawn");
	});

	it("refuses a cwd outside the containment root before spawning", () => {
		const root = workspace();
		throws(
			() => createMcpStdioClient({ id: "x", command: process.execPath, cwd: "../.." }, { workspaceRoot: root }),
			(error: unknown) =>
				error instanceof McpError && error.code === "spawn" && /escapes workspace root/.test(error.message),
		);
		throws(
			() => createMcpStdioClient({ id: "x", command: process.execPath, cwd: "absent" }, { workspaceRoot: root }),
			(error: unknown) => error instanceof McpError && error.code === "spawn" && /cannot be resolved/.test(error.message),
		);
	});

	it("refuses a cwd that leaves the workspace through a symbolic link, at creation and again at spawn", async () => {
		const root = workspace();
		const outside = workspace();
		symlinkSync(outside, join(root, "link"));
		throws(
			() => createMcpStdioClient({ id: "x", command: process.execPath, cwd: "link" }, { workspaceRoot: root }),
			(error: unknown) =>
				error instanceof McpError &&
				error.code === "spawn" &&
				/escapes workspace root through a symbolic link/.test(error.message),
		);
		mkdirSync(join(root, "srv"));
		const c = createMcpStdioClient(
			{ id: "x", command: process.execPath, args: [FIXTURE], cwd: "srv" },
			{ workspaceRoot: root, requestTimeoutMs: 1_500, killGraceMs: 200 },
		);
		clients.push(c);
		// Between creation and launch the directory becomes a link to the outside.
		rmSync(join(root, "srv"), { recursive: true });
		symlinkSync(outside, join(root, "srv"));
		await rejectsWithCode(c.initialize(), "spawn", /failed to start: cwd escapes workspace root through a symbolic link/);
		strictEqual(c.state().status, "failed");
		strictEqual(c.pid, undefined, "nothing was spawned");
	});

	it("passes only the allowlisted environment plus declared entries and runs in the declared cwd", async () => {
		process.env.TEST_MCP_SECRET = "must-not-leak";
		try {
			const root = workspace();
			mkdirSync(join(root, "srv"));
			const c = createMcpStdioClient(
				{ id: "env", command: process.execPath, args: [FIXTURE], cwd: "srv", env: { FIXTURE_VAR: "declared" } },
				{ workspaceRoot: root, requestTimeoutMs: 1_500, killGraceMs: 200 },
			);
			clients.push(c);
			const result = JSON.parse((await c.callTool("env", {})).text) as {
				fixture: string;
				secret: string | null;
				cwd: string;
			};
			strictEqual(result.fixture, "declared");
			strictEqual(result.secret, null);
			strictEqual(resolve(result.cwd), resolve(root, "srv"));
		} finally {
			delete process.env.TEST_MCP_SECRET;
		}
	});

	it("refuses one request larger than the outbound cap without failing the client", async () => {
		const c = client("normal", { maxOutboundBytes: 16 * 1024 });
		await rejectsWithCode(
			c.callTool("echo", { pad: "x".repeat(32 * 1024) }),
			"overload",
			/tools\/call request of \d+ bytes exceeds the 16384-byte outbound cap/,
		);
		strictEqual(c.state().status, "ready");
		strictEqual((await c.callTool("echo", { fits: true })).text, JSON.stringify({ fits: true }));
	});

	it("fails with overload and closes when the server floods requests without reading its stdin", async () => {
		const c = client("normal", { maxOutboundBytes: 16 * 1024 });
		await c.initialize();
		const pid = c.pid;
		const first = await rejectsWithCode(
			c.callTool("flood_requests", {}),
			"overload",
			/stopped reading its stdin: \d+ bytes are queued for it and the outbound cap is 16384 bytes/,
		);
		const state = c.state();
		strictEqual(state.status, "failed");
		strictEqual(state.status === "failed" ? state.reason : "", first.message);
		await waitFor(() => !processAlive(pid));
		strictEqual(await rejectsWithCode(c.callTool("echo", {}), "overload"), first);
	});

	it("fails with overload instead of queueing without bound against a server that stopped reading", async () => {
		const c = client("deaf", { maxOutboundBytes: 16 * 1024 });
		await c.initialize();
		const pid = c.pid;
		const pad = "x".repeat(8 * 1024);
		const results = await Promise.allSettled(
			Array.from({ length: 64 }, () => c.callTool("echo", { pad }, { timeoutMs: 1_000 })),
		);
		const codes = new Set(results.map((entry) => (entry.status === "rejected" ? (entry.reason as McpError).code : "ok")));
		deepStrictEqual([...codes], ["overload"], "every call reports the overload, none succeeds or merely times out");
		const state = c.state();
		strictEqual(state.status, "failed");
		match(state.status === "failed" ? state.reason : "", /stopped reading its stdin/);
		await waitFor(() => !processAlive(pid));
	});

	it("close ends the process group, rejects pending calls, and is idempotent", async () => {
		const c = client();
		await c.initialize();
		const pid = c.pid;
		ok(processAlive(pid));
		const pendingCall = c.callTool("sleep", { ms: 5_000 });
		const closing = c.close();
		await rejectsWithCode(pendingCall, "closed", /is closed/);
		deepStrictEqual(await closing, { complete: true });
		deepStrictEqual(c.state(), { status: "closed", cleanupIncomplete: false, teardown: { complete: true } });
		ok(!processAlive(pid));
		deepStrictEqual(await c.close(), { complete: true });
		await rejectsWithCode(c.callTool("echo", {}), "closed");
		await rejectsWithCode(c.initialize(), "closed");
	});

	it("escalates to SIGKILL when the server ignores SIGTERM", async () => {
		const c = client("ignore-sigterm", { killGraceMs: 100 });
		await c.initialize();
		const pid = c.pid;
		const startedAt = Date.now();
		await c.close();
		ok(Date.now() - startedAt < 1_500);
		ok(!processAlive(pid));
	});

	it("close escalates to SIGKILL for a descendant that ignored the SIGTERM which ended its leader", async () => {
		const c = client("normal", { killGraceMs: 300 });
		await c.initialize();
		const leader = c.pid;
		const { pid: descendant, marker } = await spawnDescendant(c, false);
		const startedAt = Date.now();
		const closing = c.close();
		await waitFor(() => existsSync(marker), 1_000);
		ok(processAlive(descendant), "the descendant received SIGTERM and survived it");
		const termAt = Number(readFileSync(marker, "utf8"));
		await closing;
		const closedAt = Date.now();
		ok(closedAt - startedAt < 1_500, `close took ${closedAt - startedAt}ms`);
		ok(!processAlive(leader), "the leader is gone");
		ok(!processAlive(descendant), "the descendant is gone before close returns");
		ok(closedAt - termAt >= 250, `the descendant lived ${closedAt - termAt}ms past SIGTERM: killed by escalation`);
		strictEqual(c.state().status, "closed");
	});

	it("tears the group down as soon as the leader exits and never signals the released id again", async () => {
		const c = client("normal", { killGraceMs: 300 });
		await c.initialize();
		const leader = c.pid;
		const { pid: descendant, marker } = await spawnDescendant(c, true);
		await waitFor(() => !processAlive(leader) && c.state().status === "failed");
		// Nobody has called close(): the client tears the group down on its own.
		await waitFor(() => existsSync(marker), 1_000);
		ok(processAlive(descendant), "the descendant received SIGTERM, survived it, and still holds the pipes");
		const termAt = Number(readFileSync(marker, "utf8"));
		await waitFor(() => !processAlive(descendant), 1_500);
		const deadAt = Date.now();
		ok(deadAt - termAt >= 250, `the descendant lived ${deadAt - termAt}ms past SIGTERM: killed by escalation`);
		// Give the client's own 10 ms poll time to observe the empty group and release the id.
		await new Promise((settle) => setTimeout(settle, 100));
		// A late close() must not probe or signal a number that may belong to someone else by now.
		const startedAt = Date.now();
		const groupSignals = await recordGroupSignals(() => c.close());
		ok(Date.now() - startedAt < 1_500);
		deepStrictEqual(groupSignals, [], "no probe or signal reached the released group id");
		strictEqual(c.state().status, "failed");
	});

	it("reports a group that outlives SIGKILL through close() and state(), then never signals it again", async () => {
		const c = client("normal", { killGraceMs: 50, teardownBoundMs: 100 });
		await c.initialize();
		const pgid = c.pid;
		ok(pgid !== undefined);
		deepStrictEqual(c.state(), { status: "ready", cleanupIncomplete: false, teardown: null });
		let outcome: Awaited<ReturnType<McpClient["close"]>> | null = null;
		const startedAt = Date.now();
		const during = await recordGroupSignals(async () => {
			outcome = await c.close();
		}, true);
		const elapsed = Date.now() - startedAt;
		ok(elapsed >= 150 && elapsed < 1_500, `close waited out both bounds (${elapsed}ms)`);
		const expected = { complete: false, reason: "group-survived-sigkill", pgid, boundMs: 150 };
		deepStrictEqual(outcome, expected, "close() resolves with the flagged outcome instead of throwing");
		deepStrictEqual(c.state(), { status: "closed", cleanupIncomplete: true, teardown: expected });
		deepStrictEqual(signalsOnly(during), [
			[-pgid, "SIGTERM"],
			[-pgid, "SIGKILL"],
		]);
		ok(!processAlive(pgid), "the leader itself did die");
		const after = await recordGroupSignals(async () => {
			deepStrictEqual(await c.close(), expected, "a repeated close reports the same outcome");
		});
		deepStrictEqual(after, [], "the released id is never probed or signalled again");
	});

	it("keeps an incomplete exit-triggered teardown on the state alongside the earlier fatal error", async () => {
		const c = client("normal", { killGraceMs: 50, teardownBoundMs: 100 });
		await c.initialize();
		const pgid = c.pid;
		ok(pgid !== undefined);
		const seen: { first: McpError | null } = { first: null };
		const during = await recordGroupSignals(async () => {
			seen.first = await rejectsWithCode(c.callTool("crash", {}), "closed", /exited with code 3/);
			await waitFor(() => c.state().cleanupIncomplete, 1_500);
		}, true);
		const first = seen.first;
		ok(first !== null);
		const expected = { complete: false, reason: "group-survived-sigkill", pgid, boundMs: 150 };
		deepStrictEqual(c.state(), { status: "failed", reason: first.message, cleanupIncomplete: true, teardown: expected });
		deepStrictEqual(signalsOnly(during), [
			[-pgid, "SIGTERM"],
			[-pgid, "SIGKILL"],
		]);
		const after = await recordGroupSignals(async () => {
			deepStrictEqual(await c.close(), expected);
		});
		deepStrictEqual(after, []);
		const settled = c.state();
		strictEqual(settled.status, "failed");
		strictEqual(settled.cleanupIncomplete, true);
		strictEqual(await rejectsWithCode(c.callTool("echo", {}), "closed"), first, "the fatal cause is untouched");
	});

	it("does not signal the group id once the group has been observed gone", async () => {
		const c = client();
		const first = await rejectsWithCode(c.callTool("crash", {}), "closed");
		await waitFor(() => !processAlive(c.pid));
		// The exit-triggered cleanup observed ESRCH; nothing below may aim at the group id.
		await new Promise((settle) => setTimeout(settle, 50));
		const groupSignals = await recordGroupSignals(async () => {
			await c.close();
			await c.close();
		});
		deepStrictEqual(groupSignals, [], "the released id is never probed or signalled");
		strictEqual(await rejectsWithCode(c.callTool("echo", {}), "closed"), first);
	});

	it("closes when the client-level signal aborts", async () => {
		const controller = new AbortController();
		const c = client("normal", { signal: controller.signal });
		await c.initialize();
		const pid = c.pid;
		controller.abort();
		await waitFor(() => c.state().status === "closed" && !processAlive(pid));
	});
});
