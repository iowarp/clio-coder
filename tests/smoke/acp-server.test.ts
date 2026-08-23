/**
 * Real-server ACP end-to-end smoke: the built `dist/cli/index.js acp` binary,
 * spawned over the exact argv an ACP frontend uses, against a loopback
 * OpenAI-compat stub and an isolated scratch home. No network, no in-process
 * seams, no source hooks. Everything asserted here is observed on the wire.
 *
 * The sibling `tests/smoke/cli.test.ts` keeps its own one-shot ACP case; this
 * file adds the contract surface (CONTRACT C001 §0-§6) that a client binds to:
 * error identity, admission failure, tool lifecycle, permission allow/reject,
 * and cancel while a permission is parked.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	closeServer,
	seedOpenAICompatOrchestrator,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome, seedDoctorFix } from "../harness/spawn.js";

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const PERMISSION_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 20_000;

/** One JSON-RPC frame as it crossed the pipe, for the published transcript. */
interface WireFrame {
	direction: ">" | "<";
	text: string;
}

interface RpcFailure {
	code: number;
	message: string;
	data?: unknown;
}

class RpcError extends Error {
	constructor(readonly failure: RpcFailure) {
		super(failure.message);
		this.name = "RpcError";
	}
}

interface InboundRequest {
	id: number | string;
	method: string;
	params: Record<string, unknown>;
}

interface AcpProcess {
	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	requestFailure(method: string, params?: unknown, timeoutMs?: number): Promise<RpcFailure>;
	notify(method: string, params?: unknown): void;
	respond(id: number | string, result: unknown): void;
	/** Resolves with the next server-initiated request for `method`. */
	awaitInbound(method: string, timeoutMs?: number): Promise<InboundRequest>;
	notifications: Array<Record<string, unknown>>;
	sessionUpdates: Array<Record<string, unknown>>;
	frames: WireFrame[];
	endStdin(): void;
	kill(): void;
	wait(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startAcpProcess(args: string[], env: NodeJS.ProcessEnv, cwd: string): AcpProcess {
	const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let nextId = 1;
	let stdoutBuffer = "";
	let stderr = "";
	let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	const frames: WireFrame[] = [];
	const notifications: Array<Record<string, unknown>> = [];
	const sessionUpdates: Array<Record<string, unknown>> = [];
	const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
	const inbound: InboundRequest[] = [];
	const inboundWaiters: Array<{ method: string; resolve(request: InboundRequest): void }> = [];

	const deliverInbound = (request: InboundRequest): void => {
		const index = inboundWaiters.findIndex((waiter) => waiter.method === request.method);
		if (index === -1) {
			inbound.push(request);
			return;
		}
		const [waiter] = inboundWaiters.splice(index, 1);
		waiter?.resolve(request);
	};

	const send = (message: Record<string, unknown>): void => {
		const line = JSON.stringify(message);
		frames.push({ direction: ">", text: line });
		child.stdin.write(`${line}\n`);
	};

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		for (;;) {
			const idx = stdoutBuffer.indexOf("\n");
			if (idx === -1) break;
			const line = stdoutBuffer.slice(0, idx);
			stdoutBuffer = stdoutBuffer.slice(idx + 1);
			if (line.trim().length === 0) continue;
			frames.push({ direction: "<", text: line });
			const message = JSON.parse(line) as Record<string, unknown>;
			const hasId = "id" in message && message.id !== null;
			if (hasId && ("result" in message || "error" in message)) {
				const entry = pending.get(Number(message.id));
				if (!entry) continue;
				pending.delete(Number(message.id));
				if (isRecord(message.error)) {
					entry.reject(
						new RpcError({
							code: Number(message.error.code),
							message: String(message.error.message ?? ""),
							...("data" in message.error ? { data: message.error.data } : {}),
						}),
					);
				} else {
					entry.resolve(message.result);
				}
				continue;
			}
			if (typeof message.method === "string" && hasId) {
				deliverInbound({
					id: message.id as number | string,
					method: message.method,
					params: isRecord(message.params) ? message.params : {},
				});
				continue;
			}
			notifications.push(message);
			if (message.method === "session/update" && isRecord(message.params)) {
				const update = message.params.update;
				if (isRecord(update)) sessionUpdates.push(update);
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("exit", (code, signal) => {
		exited = { code, signal };
		for (const entry of pending.values()) {
			entry.reject(new Error(`ACP subprocess exited before reply: code=${code ?? "null"} signal=${signal ?? "null"}`));
		}
		pending.clear();
		for (const waiter of inboundWaiters.splice(0)) {
			// A waiter outliving the process is a test bug, not a protocol event;
			// fail it loudly instead of hanging on the suite timeout.
			waiter.resolve({ id: -1, method: `${waiter.method}:process-exited`, params: {} });
		}
	});

	const api: AcpProcess = {
		notifications,
		sessionUpdates,
		frames,
		request<T>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
			const id = nextId++;
			send({ jsonrpc: "2.0", id, method, params });
			return new Promise<T>((resolvePromise, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms. stderr=${stderr}`));
				}, timeoutMs);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer);
						resolvePromise(value as T);
					},
					reject: (reason) => {
						clearTimeout(timer);
						reject(reason);
					},
				});
			});
		},
		async requestFailure(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<RpcFailure> {
			try {
				const result = await api.request<unknown>(method, params, timeoutMs);
				throw new Error(`${method} unexpectedly succeeded: ${JSON.stringify(result)}`);
			} catch (err) {
				if (err instanceof RpcError) return err.failure;
				throw err;
			}
		},
		notify(method: string, params?: unknown): void {
			send({ jsonrpc: "2.0", method, params });
		},
		respond(id: number | string, result: unknown): void {
			send({ jsonrpc: "2.0", id, result });
		},
		awaitInbound(method: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<InboundRequest> {
			const index = inbound.findIndex((request) => request.method === method);
			if (index !== -1) {
				const [request] = inbound.splice(index, 1);
				return Promise.resolve(request as InboundRequest);
			}
			return new Promise<InboundRequest>((resolvePromise, reject) => {
				const timer = setTimeout(() => {
					const waiterIndex = inboundWaiters.findIndex((waiter) => waiter.resolve === wrapped);
					if (waiterIndex !== -1) inboundWaiters.splice(waiterIndex, 1);
					reject(new Error(`no inbound ${method} within ${timeoutMs}ms. stderr=${stderr}`));
				}, timeoutMs);
				const wrapped = (request: InboundRequest): void => {
					clearTimeout(timer);
					resolvePromise(request);
				};
				inboundWaiters.push({ method, resolve: wrapped });
			});
		},
		endStdin(): void {
			child.stdin.end();
		},
		kill(): void {
			if (exited === null) child.kill("SIGKILL");
		},
		wait(timeoutMs = EXIT_TIMEOUT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
			return new Promise((resolvePromise, reject) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`ACP subprocess did not exit within ${timeoutMs}ms. stderr=${stderr}`));
				}, timeoutMs);
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					resolvePromise({ code, signal, stderr });
				});
			});
		},
	};
	return api;
}

function acpArgv(project: string, permissionTimeoutMs = PERMISSION_TIMEOUT_MS): string[] {
	return [
		"--no-context-files",
		"--no-skills",
		"acp",
		"--cwd",
		project,
		"--permission-timeout",
		String(permissionTimeoutMs),
	];
}

/** The `clio-coder/error` payload a `-32000`/`-32602` frame must carry (§0). */
function errorMeta(failure: RpcFailure): Record<string, unknown> {
	ok(isRecord(failure.data), `error.data is not an object: ${JSON.stringify(failure.data)}`);
	const meta = (failure.data as { _meta?: unknown })._meta;
	ok(isRecord(meta), `error.data._meta is not an object: ${JSON.stringify(failure.data)}`);
	const detail = meta["clio-coder/error"];
	ok(isRecord(detail), `error.data._meta["clio-coder/error"] missing: ${JSON.stringify(failure.data)}`);
	return detail;
}

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

function assertSessionUpdatesConformant(client: AcpProcess): void {
	for (const message of client.notifications) {
		strictEqual(
			message.method,
			"session/update",
			`non-session/update notification on the wire: ${JSON.stringify(message)}`,
		);
		const params = message.params as { update?: { sessionUpdate?: unknown } } | undefined;
		const variant = params?.update?.sessionUpdate;
		ok(
			typeof variant === "string" && VALID_SESSION_UPDATES.has(variant),
			`non-spec sessionUpdate emitted: ${JSON.stringify(variant)}`,
		);
	}
}

/** No stack frames and no host paths anywhere in what the server put on stdout. */
function assertNoLeakedInternals(client: AcpProcess): void {
	for (const frame of client.frames) {
		if (frame.direction !== "<") continue;
		ok(!frame.text.includes("    at "), `stack frame leaked onto the wire: ${frame.text}`);
		ok(!frame.text.includes(REPO_ROOT), `repo path leaked onto the wire: ${frame.text}`);
	}
}

/**
 * Optional wire dump. Set `CLIO_ACP_E2E_TRANSCRIPT_DIR` to have each case write
 * its frames, one per line with a `>`/`<` direction marker and the scratch
 * paths replaced by `<project>`/`<home>`, so the published transcript in the
 * integration mailbox is regenerated rather than transcribed by hand.
 */
const TRANSCRIPT_DIR = process.env.CLIO_ACP_E2E_TRANSCRIPT_DIR;

function dumpTranscript(name: string, client: AcpProcess, projectDir: string, homeDir: string): void {
	if (TRANSCRIPT_DIR === undefined || TRANSCRIPT_DIR.length === 0) return;
	mkdirSync(TRANSCRIPT_DIR, { recursive: true });
	const redact = (text: string): string => {
		let out = text;
		for (const dir of new Set([realpathSync(projectDir), projectDir])) out = out.split(dir).join("<project>");
		for (const dir of new Set([realpathSync(homeDir), homeDir])) out = out.split(dir).join("<home>");
		return out;
	};
	const body = client.frames.map((frame) => `${frame.direction} ${redact(frame.text)}`).join("\n");
	writeFileSync(join(TRANSCRIPT_DIR, `${name}.txt`), `${body}\n`, "utf8");
}

function updatesOfKind(client: AcpProcess, kind: string): Array<Record<string, unknown>> {
	return client.sessionUpdates.filter((update) => update.sessionUpdate === kind);
}

/**
 * The permission frame has to describe the call the client already rendered:
 * same wire id, and a `rawInput` byte-identical to the one on the preceding
 * `tool_call` update. A client that diffs the two payloads before showing an
 * approval prompt must see nothing, so key order is asserted too, not just
 * structural equality. Returns the permission's `toolCall` for the caller.
 */
function assertPermissionEchoesToolCall(client: AcpProcess, permission: InboundRequest): Record<string, unknown> {
	const toolCall = permission.params.toolCall as Record<string, unknown>;
	const started = updatesOfKind(client, "tool_call");
	strictEqual(started.length, 1, `expected one tool_call update, got ${JSON.stringify(started)}`);
	const update = started[0];
	strictEqual(toolCall.toolCallId, update?.toolCallId, "permission toolCallId does not match the tool_call update");
	deepStrictEqual(
		toolCall.rawInput,
		update?.rawInput,
		`permission rawInput diverged from the tool_call update: ${JSON.stringify(toolCall.rawInput)} vs ${JSON.stringify(update?.rawInput)}`,
	);
	strictEqual(
		JSON.stringify(toolCall.rawInput),
		JSON.stringify(update?.rawInput),
		"permission rawInput is not byte-identical to the tool_call update",
	);
	return toolCall;
}

function chunkText(client: AcpProcess, kind: "agent_message_chunk" | "agent_thought_chunk"): string {
	return updatesOfKind(client, kind)
		.map((update) => {
			const content = update.content;
			return isRecord(content) && typeof content.text === "string" ? content.text : "";
		})
		.join("");
}

describe("clio-coder acp real-server smoke", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;
	let project: string;
	let clients: AcpProcess[];

	beforeEach(() => {
		scratch = makeScratchHome("clio-acp-e2e-");
		project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		clients = [];
	});

	afterEach(() => {
		for (const client of clients) client.kill();
		scratch.cleanup();
	});

	function launch(env: NodeJS.ProcessEnv, args = acpArgv(project)): AcpProcess {
		const client = startAcpProcess(args, env, scratch.dir);
		clients.push(client);
		return client;
	}

	const testEnv = (): NodeJS.ProcessEnv => ({ ...scratch.env, CLIO_CODER_TEST_OPENAI_KEY: "sk-test" });

	it("streams a text turn end to end and exits 0 on stdin EOF", { timeout: 90_000 }, async () => {
		await seedDoctorFix(scratch.dir);
		const fixture = await startOpenAICompatFixture("acp e2e text reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const client = launch({ ...testEnv(), CLIO_CODER_INTERACTIVE: "1" });
			const init = await client.request<{
				protocolVersion: number;
				agentInfo: { name: string };
				agentCapabilities: { loadSession: boolean; _meta: Record<string, unknown> };
			}>("initialize", {
				protocolVersion: 1,
				clientInfo: { name: "acp-e2e", version: "1" },
			});
			strictEqual(init.protocolVersion, 1);
			strictEqual(init.agentInfo.name, "clio-coder");
			strictEqual(init.agentCapabilities.loadSession, true);
			deepStrictEqual(init.agentCapabilities._meta["clio-coder/session"], {
				close: true,
				list: true,
				label: true,
				delete: true,
				autonomy: true,
			});
			deepStrictEqual(init.agentCapabilities._meta["clio-coder/settings"], {
				get_safe: true,
				patch_safe: true,
			});
			deepStrictEqual(init.agentCapabilities._meta["clio-coder/targets"], { list: true, probe: true });
			ok(isRecord(init.agentCapabilities._meta["clio-coder/events"]));
			strictEqual(init.agentCapabilities._meta["clio-coder/tools"], "mediated");
			const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
			ok(session.sessionId.length > 0 && session.sessionId.length <= 128, `sessionId=${session.sessionId}`);
			const prompt = await client.request<{ stopReason: string; _meta?: Record<string, unknown> }>("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "say the reply" }],
			});
			strictEqual(prompt.stopReason, "end_turn");
			const usage = prompt._meta?.["clio-coder/usage"];
			ok(isRecord(usage), `usage meta missing: ${JSON.stringify(prompt._meta)}`);
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
				strictEqual(typeof usage[key], "number", `usage.${key} is not a number: ${JSON.stringify(usage)}`);
			}
			match(chunkText(client, "agent_message_chunk"), /acp e2e text reply/);
			assertSessionUpdatesConformant(client);
			assertNoLeakedInternals(client);
			await client.request("session/close", { sessionId: session.sessionId });
			client.endStdin();
			const exit = await client.wait();
			strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
			strictEqual(exit.stderr.includes("Hydrating session services"), false);
			strictEqual(exit.stderr.includes("\u001b[?2004h"), false, "ambient interactive state cannot mount an ACP TUI");
			dumpTranscript("case1-text-turn", client, project, scratch.dir);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("answers every contract error with its namespaced code", { timeout: 90_000 }, async () => {
		await seedDoctorFix(scratch.dir);
		const fixture = await startOpenAICompatFixture("acp e2e text reply");
		const sibling = join(scratch.dir, "sibling");
		mkdirSync(sibling, { recursive: true });
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const client = launch(testEnv());

			const badVersion = await client.requestFailure("initialize", { protocolVersion: 2 });
			strictEqual(badVersion.code, -32602);
			const badVersionMeta = errorMeta(badVersion);
			strictEqual(badVersionMeta.code, "protocol_version_unsupported");
			deepStrictEqual(badVersionMeta.supported, [1]);

			const notInitialized = await client.requestFailure("session/new", { cwd: project });
			strictEqual(notInitialized.code, -32000);
			strictEqual(errorMeta(notInitialized).code, "not_initialized");

			await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "acp-e2e", version: "1" } });

			const alreadyInitialized = await client.requestFailure("initialize", { protocolVersion: 1 });
			strictEqual(alreadyInitialized.code, -32000);
			strictEqual(errorMeta(alreadyInitialized).code, "already_initialized");

			// cwd identity is checked before the one-session limit is spent.
			const mismatch = await client.requestFailure("session/new", { cwd: sibling, mcpServers: [] });
			strictEqual(mismatch.code, -32000);
			strictEqual(errorMeta(mismatch).code, "session_cwd_mismatch");
			ok(!mismatch.message.includes("/"), `cwd mismatch message leaked a path: ${mismatch.message}`);

			const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });

			const secondSession = await client.requestFailure("session/new", { cwd: project, mcpServers: [] });
			strictEqual(secondSession.code, -32000);
			strictEqual(errorMeta(secondSession).code, "session_limit");

			const unknownSession = await client.requestFailure("session/prompt", {
				sessionId: "no-such-session",
				prompt: [{ type: "text", text: "hello" }],
			});
			strictEqual(unknownSession.code, -32000);
			strictEqual(errorMeta(unknownSession).code, "session_unknown");

			const emptyPrompt = await client.requestFailure("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "   " }],
			});
			strictEqual(emptyPrompt.code, -32602);
			strictEqual(errorMeta(emptyPrompt).code, "invalid_params");

			strictEqual(client.notifications.length, 0, `errors emitted updates: ${JSON.stringify(client.notifications)}`);
			assertNoLeakedInternals(client);
			await client.request("session/close", { sessionId: session.sessionId });
			client.endStdin();
			const exit = await client.wait();
			strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("fails an unadmitted prompt with prompt_not_admitted and no updates", { timeout: 90_000 }, async () => {
		// No settings patch at all: the scratch home has `targets: []` and a null
		// orchestrator target, which is exactly the empty-success defect's input.
		await seedDoctorFix(scratch.dir);
		const client = launch({ ...scratch.env });
		await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "acp-e2e", version: "1" } });
		const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
		const failure = await client.requestFailure("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		strictEqual(failure.code, -32000);
		const meta = errorMeta(failure);
		strictEqual(meta.code, "prompt_not_admitted");
		strictEqual(meta.reason, "orchestrator-not-configured");
		strictEqual(client.notifications.length, 0, `updates preceded the refusal: ${JSON.stringify(client.notifications)}`);
		ok(!failure.message.includes("/"), `admission message leaked a path: ${failure.message}`);
		assertNoLeakedInternals(client);
		await client.request("session/close", { sessionId: session.sessionId });
		client.endStdin();
		const exit = await client.wait();
		strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
		dumpTranscript("case3-admission-failure", client, project, scratch.dir);
	});

	it("runs one tool call through permission allow", { timeout: 120_000 }, async () => {
		await seedDoctorFix(scratch.dir);
		const fixture = await startOpenAICompatFixture("wrote the note", {
			toolCall: { name: "write", arguments: { path: "note.txt", content: "hello from tool" } },
		});
		try {
			seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "suggest");
			const client = launch(testEnv());
			await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "acp-e2e", version: "1" } });
			const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
			const prompt = client.request<{ stopReason: string }>("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "write note.txt" }],
			});
			const permission = await client.awaitInbound("session/request_permission");
			strictEqual(permission.params.sessionId, session.sessionId);
			const toolCall = assertPermissionEchoesToolCall(client, permission);
			strictEqual(toolCall.sessionUpdate, "tool_call");
			strictEqual(toolCall.kind, "edit");
			strictEqual(toolCall.status, "pending");
			deepStrictEqual(permission.params.options, [
				{ optionId: "allow-once", name: "Approve workspace action once", kind: "allow_once" },
				{ optionId: "reject-once", name: "Deny this request", kind: "reject_once" },
			]);
			const started = updatesOfKind(client, "tool_call");
			deepStrictEqual(toolCall.locations, [{ path: join(project, "note.txt") }]);
			deepStrictEqual(started[0]?.locations, [{ path: join(project, "note.txt") }]);
			client.respond(permission.id, { outcome: { outcome: "selected", optionId: "allow-once" } });
			const result = await prompt;
			strictEqual(result.stopReason, "end_turn");
			const completed = updatesOfKind(client, "tool_call_update").filter(
				(update) => update.toolCallId === toolCall.toolCallId,
			);
			ok(completed.length > 0, `no tool_call_update for ${String(toolCall.toolCallId)}`);
			strictEqual(completed.at(-1)?.status, "completed");
			const written = join(project, "note.txt");
			ok(existsSync(written), "write tool did not create note.txt");
			strictEqual(readFileSync(written, "utf8"), "hello from tool");
			assertSessionUpdatesConformant(client);
			assertNoLeakedInternals(client);
			await client.request("session/close", { sessionId: session.sessionId });
			client.endStdin();
			const exit = await client.wait();
			strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
			dumpTranscript("case4-tool-permission-allow", client, project, scratch.dir);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("rejects one tool call through permission reject", { timeout: 120_000 }, async () => {
		await seedDoctorFix(scratch.dir);
		const fixture = await startOpenAICompatFixture("could not write", {
			toolCall: { name: "write", arguments: { path: "note.txt", content: "hello from tool" } },
		});
		try {
			seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "suggest");
			const client = launch(testEnv());
			await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "acp-e2e", version: "1" } });
			const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
			const prompt = client.request<{ stopReason: string }>("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "write note.txt" }],
			});
			const permission = await client.awaitInbound("session/request_permission");
			const toolCall = assertPermissionEchoesToolCall(client, permission);
			client.respond(permission.id, { outcome: { outcome: "selected", optionId: "reject-once" } });
			const result = await prompt;
			strictEqual(result.stopReason, "end_turn");
			const terminal = updatesOfKind(client, "tool_call_update").filter(
				(update) => update.toolCallId === toolCall.toolCallId,
			);
			ok(terminal.length > 0, `no tool_call_update for ${String(toolCall.toolCallId)}`);
			strictEqual(terminal.at(-1)?.status, "failed");
			ok(!existsSync(join(project, "note.txt")), "rejected write still created note.txt");
			assertSessionUpdatesConformant(client);
			assertNoLeakedInternals(client);
			await client.request("session/close", { sessionId: session.sessionId });
			client.endStdin();
			const exit = await client.wait();
			strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("cancels a turn while a permission request is parked", { timeout: 120_000 }, async () => {
		await seedDoctorFix(scratch.dir);
		const fixture = await startOpenAICompatFixture("never reached", {
			toolCall: { name: "write", arguments: { path: "note.txt", content: "hello from tool" } },
		});
		try {
			seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "suggest");
			const client = launch(testEnv());
			await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "acp-e2e", version: "1" } });
			const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
			const prompt = client.request<{ stopReason: string }>("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "write note.txt" }],
			});
			const permission = await client.awaitInbound("session/request_permission");
			assertPermissionEchoesToolCall(client, permission);
			// The permission stays unanswered: cancel has to break the park on its own.
			const cancelAck = await client.request<Record<string, never>>(
				"session/cancel",
				{ sessionId: session.sessionId },
				10_000,
			);
			deepStrictEqual(cancelAck, {});
			const result = await Promise.race([
				prompt,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("cancelled prompt did not settle within 5s")), 5_000),
				),
			]);
			strictEqual(result.stopReason, "cancelled");
			// The stale answer must be inert, not an error frame.
			client.respond(permission.id, { outcome: { outcome: "cancelled" } });
			ok(!existsSync(join(project, "note.txt")), "cancelled write still created note.txt");
			const stillHealthy = await client
				.request<{ sessionId: string }>("session/new", {
					cwd: project,
					mcpServers: [],
				})
				.then(
					() => "unexpected-success",
					(err: unknown) => (err instanceof RpcError ? String(errorMeta(err.failure).code) : "non-rpc-error"),
				);
			strictEqual(stillHealthy, "session_limit");
			assertSessionUpdatesConformant(client);
			assertNoLeakedInternals(client);
			await client.request("session/close", { sessionId: session.sessionId });
			client.endStdin();
			const exit = await client.wait();
			strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
			dumpTranscript("case6-cancel-parked-permission", client, project, scratch.dir);
		} finally {
			await closeServer(fixture.server);
		}
	});
});
