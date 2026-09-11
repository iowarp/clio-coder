import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");

type Home = { root: string; env: NodeJS.ProcessEnv; cleanup(): void };
type Inbound = { id: number; method: string; params: Record<string, unknown> };
function home(): Home {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-acp-boundary-"));
	return {
		root,
		env: {
			...process.env,
			NODE_ENV: "test",
			NO_COLOR: "1",
			CLIO_CODER_HOME: root,
			CLIO_CODER_CONFIG_DIR: join(root, "config"),
			CLIO_CODER_DATA_DIR: join(root, "data"),
			CLIO_CODER_STATE_DIR: join(root, "state"),
			CLIO_CODER_CACHE_DIR: join(root, "cache"),
			CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
	const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: "ignore" });
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
}
async function initialize(target: Home): Promise<void> {
	strictEqual(await runCli(["doctor", "--fix"], target.env), 0);
}
function seedTarget(target: Home, endpoint: string): void {
	const path = join(target.root, "config", "settings.yaml");
	const settings = readFileSync(path, "utf8")
		.replace(
			/^targets: \[\]$/m,
			[
				"targets:",
				"  - id: acp-local",
				"    runtime: openai-compat",
				`    url: ${endpoint}`,
				"    defaultModel: mock-model",
				"    wireModels: [mock-model]",
				"    lifecycle: user-managed",
				"    capabilities:",
				"      chat: true",
				"      tools: true",
				"      toolCallFormat: openai",
				"      contextWindow: 32768",
				"      maxTokens: 4096",
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: acp-local")
		.replace(/^ {2}model: null$/m, "  model: mock-model")
		.replace(/^ {2}autonomy: auto-edit$/m, "  autonomy: suggest");
	writeFileSync(path, settings);
}
class AcpClient {
	readonly updates: Array<Record<string, unknown>> = [];
	private nextId = 1;
	private buffer = "";
	private stderr = "";
	private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
	private inbound: Inbound[] = [];
	private inboundWaiters: Array<(request: Inbound) => void> = [];
	private readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	constructor(private readonly child: ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (text: string) => this.consume(text));
		child.stderr.on("data", (text: string) => {
			this.stderr += text;
		});
		this.exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	}
	assertRunningChild(expectedPid?: number): number {
		const pid = this.child.pid;
		ok(pid !== undefined && Number.isSafeInteger(pid) && pid > 1, "ACP child has an OS process identity");
		if (expectedPid !== undefined) strictEqual(pid, expectedPid, "ACP close/new keeps the same child");
		strictEqual(this.child.exitCode, null, "ACP child has not exited");
		strictEqual(this.child.signalCode, null, "ACP child has not been terminated");
		process.kill(pid, 0);
		return pid;
	}
	private consume(text: string): void {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			const frame = JSON.parse(line) as Record<string, unknown>;
			if (typeof frame.id === "number" && ("result" in frame || "error" in frame)) {
				const pending = this.pending.get(frame.id);
				if (!pending) continue;
				this.pending.delete(frame.id);
				if (frame.error) pending.reject(frame);
				else pending.resolve(frame.result);
			} else if (typeof frame.id === "number" && typeof frame.method === "string") {
				const request = { id: frame.id, method: frame.method, params: (frame.params ?? {}) as Record<string, unknown> };
				const waiter = this.inboundWaiters.shift();
				if (waiter) waiter(request);
				else this.inbound.push(request);
			} else if (frame.method === "session/update") {
				const params = frame.params as { update?: Record<string, unknown> };
				if (params.update) this.updates.push(params.update);
			}
		}
	}
	request<T>(method: string, params: unknown = {}): Promise<T> {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out; stderr=${this.stderr}`));
			}, 20_000);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}
	waitInbound(): Promise<Inbound> {
		const queued = this.inbound.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`permission request timed out; stderr=${this.stderr}`)), 20_000);
			this.inboundWaiters.push((request) => {
				clearTimeout(timer);
				resolve(request);
			});
		});
	}
	respond(id: number, result: unknown): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}
	async close(sessionId: string): Promise<void> {
		await this.request("session/close", { sessionId });
		this.child.stdin.end();
		const exited = await this.exit;
		strictEqual(exited.code, 0, this.stderr);
	}
	kill(): void {
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
	}
	async killAndWait(): Promise<void> {
		this.kill();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.exit,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("ACP child cleanup exceeded 5 seconds")), 5_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}
function launch(target: Home, project: string): AcpClient {
	return new AcpClient(
		spawn(
			process.execPath,
			[CLI, "--no-context-files", "--no-skills", "acp", "--cwd", project, "--permission-timeout", "10000"],
			{ cwd: target.root, env: target.env, stdio: ["pipe", "pipe", "pipe"] },
		),
	);
}
async function openSession(client: AcpClient, project: string): Promise<string> {
	const initialized = await client.request<{ protocolVersion: number }>("initialize", {
		protocolVersion: 1,
		clientInfo: { name: "smoke", version: "1" },
	});
	strictEqual(initialized.protocolVersion, 1);
	const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
	return session.sessionId;
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	request.setEncoding("utf8");
	for await (const chunk of request) text += chunk;
	return JSON.parse(text) as Record<string, unknown>;
}
async function provider(options: {
	reply: string;
	authorization?: string;
	tool?: boolean;
	toolCallId?: string;
	next?: () => { reply?: string; tool?: { name: string; args: Record<string, unknown> } };
}): Promise<{ server: Server; url: string; requests: Array<Record<string, unknown>> }> {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "mock-model", tools: true }] }));
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.statusCode = 404;
			response.end();
			return;
		}
		if (options.authorization && request.headers.authorization !== options.authorization) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Fixture requires its saved credential" } }));
			return;
		}
		const payload = await readBody(request);
		if (payload.stream === false) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: options.reply } }] }));
			return;
		}
		requests.push(payload);
		const next = options.next?.();
		const messages = payload.messages as Array<{ role?: string }>;
		const callTool = next?.tool !== undefined || (options.tool && !messages.some((message) => message.role === "tool"));
		const delta = callTool
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: options.toolCallId ?? "call-write",
							type: "function",
							function: next?.tool
								? { name: next.tool.name, arguments: JSON.stringify(next.tool.args) }
								: { name: "write", arguments: '{"path":"note.txt","content":"from ACP"}' },
						},
					],
				}
			: { role: "assistant", content: next?.reply ?? options.reply };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
		response.write(
			`data: ${JSON.stringify({
				choices: [{ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}
async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
describe("smoke/ACP stdio boundary", { concurrency: false }, () => {
	it("reports missing service credentials before admission and uses saved auth after reopening", async () => {
		const target = home();
		const fixture = await provider({
			reply: "SAVED_CREDENTIAL_REPLY",
			authorization: "Bearer synthetic-service-test-key",
		});
		let client: AcpClient | undefined;
		try {
			await initialize(target);
			seedTarget(target, fixture.url);
			const settingsPath = join(target.root, "config", "settings.yaml");
			writeFileSync(
				settingsPath,
				readFileSync(settingsPath, "utf8").replace(
					"    runtime: openai-compat",
					"    runtime: openai-compat\n    auth:\n      apiKeyEnvVar: CLIO_ACP_TEST_ONLY_KEY",
				),
			);
			delete target.env.CLIO_ACP_TEST_ONLY_KEY;
			delete target.env.OPENAI_API_KEY;
			const project = join(target.root, "project");
			mkdirSync(project);
			client = launch(target, project);
			const sessionId = await openSession(client, project);
			const rejected = await client
				.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "hi" }],
				})
				.then(
					() => null,
					(error: unknown) =>
						error as { error: { message: string; data: { _meta: Record<string, Record<string, unknown>> } } },
				);
			ok(rejected);
			strictEqual(rejected.error.data._meta["clio-coder/error"]?.code, "prompt_not_admitted");
			strictEqual(rejected.error.data._meta["clio-coder/error"]?.reason, "authentication-required");
			doesNotMatch(JSON.stringify(rejected), /CLIO_ACP_TEST_ONLY_KEY|settings.yaml|credentials.yaml/);
			strictEqual(client.updates.length, 0);
			strictEqual(fixture.requests.length, 0);
			await client.close(sessionId);
			strictEqual(await runCli(["auth", "login", "acp-local", "--api-key", "synthetic-service-test-key"], target.env), 0);
			client = launch(target, project);
			await client.request("initialize", { protocolVersion: 1 });
			await client.request("session/load", { sessionId, cwd: project, mcpServers: [] });
			const turn = await client.request<{ stopReason: string }>("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "hi" }],
			});
			strictEqual(turn.stopReason, "end_turn");
			match(JSON.stringify(client.updates), /SAVED_CREDENTIAL_REPLY/);
			doesNotMatch(JSON.stringify(client.updates), /synthetic-service-test-key/);
			strictEqual(fixture.requests.length, 1);
			await client.close(sessionId);
		} finally {
			await client?.killAndWait();
			await closeServer(fixture.server);
			target.cleanup();
		}
	});

	it("serves a real text turn and rejects an unadmitted prompt before updates", async () => {
		const configured = home();
		const empty = home();
		const fixture = await provider({ reply: "ACP_TEXT_REPLY" });
		let textClient: AcpClient | undefined;
		let emptyClient: AcpClient | undefined;
		try {
			await initialize(configured);
			seedTarget(configured, fixture.url);
			const project = join(configured.root, "project");
			mkdirSync(project);
			textClient = launch(configured, project);
			const sessionId = await openSession(textClient, project);
			const turn = await textClient.request<{ stopReason: string }>("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "say it" }],
			});
			strictEqual(turn.stopReason, "end_turn");
			match(JSON.stringify(textClient.updates), /ACP_TEXT_REPLY/u);
			await textClient.close(sessionId);

			await initialize(empty);
			const emptyProject = join(empty.root, "project");
			mkdirSync(emptyProject);
			emptyClient = launch(empty, emptyProject);
			const emptySession = await openSession(emptyClient, emptyProject);
			const rejected = await emptyClient
				.request("session/prompt", { sessionId: emptySession, prompt: [{ type: "text", text: "cannot run" }] })
				.then(
					() => null,
					(error: unknown) => error as Record<string, unknown>,
				);
			ok(rejected, "unconfigured prompt unexpectedly succeeded");
			const error = rejected.error as { code: number; data: { _meta: Record<string, Record<string, unknown>> } };
			strictEqual(error.code, -32000);
			strictEqual(error.data._meta["clio-coder/error"]?.code, "prompt_not_admitted");
			strictEqual(emptyClient.updates.length, 0);
			await emptyClient.close(emptySession);
		} finally {
			textClient?.kill();
			emptyClient?.kill();
			await closeServer(fixture.server);
			configured.cleanup();
			empty.cleanup();
		}
	});

	it("direct ACP close/new resets history, ancestry and tasks on the same child and still resumes the original session", async (t) => {
		const target = home();
		let phase: "first" | "second" | "resume" = "first";
		let step = 0;
		const fixture = await provider({
			reply: "ACP_FIRST_ANSWER",
			next: () => {
				const current = step++;
				if (phase === "first" && current === 0) {
					return { tool: { name: "tasks", args: { action: "plan", title: "ACP_FIRST_BOARD", tasks: ["ACP_FIRST_TASK"] } } };
				}
				if (phase === "first" && current === 1) return { tool: { name: "tasks", args: { action: "start", id: "t1" } } };
				if (phase !== "first" && current === 0) return { tool: { name: "tasks", args: { action: "list" } } };
				return {
					reply: phase === "first" ? "ACP_FIRST_ANSWER" : phase === "second" ? "ACP_SECOND_ANSWER" : "ACP_RESUME_ANSWER",
				};
			},
		});
		let client: AcpClient | undefined;
		try {
			await initialize(target);
			seedTarget(target, fixture.url);
			const project = join(target.root, "project");
			mkdirSync(project);
			client = launch(target, project);
			const first = await openSession(client, project);
			const childPid = client.assertRunningChild();
			const prompt = async (sessionId: string, text: string): Promise<void> => {
				const turn = await client?.request<{ stopReason: string }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text }],
				});
				strictEqual(turn?.stopReason, "end_turn");
			};
			const ledger = (sessionId: string): Array<Record<string, unknown>> => {
				const root = join(target.root, "state", "sessions");
				const path = readdirSync(root, { recursive: true }).find((name) =>
					String(name).endsWith(`${sessionId}/current.jsonl`),
				);
				ok(path, "scratch session ledger exists");
				return readFileSync(join(root, String(path)), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
			};
			await prompt(first, "ACP_FIRST_PROMPT");
			match(JSON.stringify(client.updates), /ACP_FIRST_ANSWER/);
			match(JSON.stringify(fixture.requests.at(-1)), /\[>\] t1 ACP_FIRST_TASK/);
			await client.request("session/close", { sessionId: first });
			client.assertRunningChild(childPid);
			const firstEntries = ledger(first);
			const firstTurnIds = new Set(firstEntries.map((entry) => entry.turnId).filter(Boolean));
			ok(firstTurnIds.size > 0);

			phase = "second";
			step = 0;
			const second = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
			client.assertRunningChild(childPid);
			notStrictEqual(second.sessionId, first);
			const secondStart = fixture.requests.length;
			client.updates.length = 0;
			await prompt(second.sessionId, "ACP_SECOND_PROMPT");
			match(JSON.stringify(client.updates), /ACP_SECOND_ANSWER/);
			const secondRequests = fixture.requests.slice(secondStart);
			ok(secondRequests.length >= 2, "second turn used the real tasks tool");
			match(JSON.stringify(secondRequests), /no task board yet/, "the new session has no task board");
			doesNotMatch(JSON.stringify(secondRequests), /ACP_FIRST_(PROMPT|ANSWER|BOARD|TASK)/);
			await client.request("session/close", { sessionId: second.sessionId });
			const secondEntries = ledger(second.sessionId);
			ok(secondEntries.length > 0, "new-session ancestry assertions inspect a nonempty ledger");
			match(JSON.stringify(secondEntries), /ACP_SECOND_PROMPT/);
			doesNotMatch(JSON.stringify(secondEntries), /ACP_FIRST_(PROMPT|ANSWER|BOARD|TASK)/);
			for (const entry of secondEntries) {
				strictEqual(firstTurnIds.has(entry.turnId), false, "turn identity belongs to the new session");
				strictEqual(firstTurnIds.has(entry.parentTurnId), false, "turn ancestry belongs to the new session");
			}

			phase = "resume";
			step = 0;
			await client.request("session/load", { sessionId: first, cwd: project, mcpServers: [] });
			const resumeStart = fixture.requests.length;
			await prompt(first, "ACP_RESUME_PROMPT");
			const resumed = JSON.stringify(fixture.requests.slice(resumeStart));
			match(resumed, /ACP_FIRST_PROMPT/);
			match(resumed, /ACP_FIRST_ANSWER/);
			match(resumed, /\[>\] t1 ACP_FIRST_TASK/);
			doesNotMatch(resumed, /ACP_SECOND_(PROMPT|ANSWER)/);
			client.assertRunningChild(childPid);
			t.diagnostic(`direct ACP same child: pid=${childPid}; sessions=${first} -> ${second.sessionId} -> ${first}`);
			await client.close(first);
		} finally {
			await client?.killAndWait();
			await closeServer(fixture.server);
			target.cleanup();
		}
	});

	it("a cancelled permission response aborts the turn before the tool can resume the model", async () => {
		const target = home();
		const fixture = await provider({ reply: "unexpected continuation", tool: true });
		let client: AcpClient | undefined;
		try {
			await initialize(target);
			seedTarget(target, fixture.url);
			const project = join(target.root, "project");
			mkdirSync(project);
			client = launch(target, project);
			const sessionId = await openSession(client, project);
			const prompt = client.request<{ stopReason: string }>("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Create note.txt after approval." }],
			});
			const permission = await client.waitInbound();
			strictEqual(permission.method, "session/request_permission");
			// No session/cancel notification follows this response.
			client.respond(permission.id, { outcome: { outcome: "cancelled" } });
			const turn = await prompt;
			strictEqual(existsSync(join(project, "note.txt")), false);
			strictEqual(
				turn.stopReason,
				"cancelled",
				JSON.stringify({
					stopReason: turn.stopReason,
					streamingRequests: fixture.requests.length,
				}),
			);
			strictEqual(fixture.requests.length, 1);
			doesNotMatch(JSON.stringify(client.updates), /unexpected continuation/);
			await client.close(sessionId);
		} finally {
			client?.kill();
			await closeServer(fixture.server);
			target.cleanup();
		}
	});

	it("mediates one write allow and one write reject", async () => {
		for (const decision of ["allow-once", "reject-once"] as const) {
			const target = home();
			const fixture = await provider({
				reply: `permission ${decision}`,
				tool: true,
				toolCallId: decision === "allow-once" ? "x".repeat(256) : "clio-tool-7",
			});
			let client: AcpClient | undefined;
			try {
				await initialize(target);
				seedTarget(target, fixture.url);
				const project = join(target.root, "project");
				mkdirSync(project);
				client = launch(target, project);
				const sessionId = await openSession(client, project);
				const prompt = client.request<{ stopReason: string }>("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "write note" }],
				});
				const permission = await client.waitInbound();
				strictEqual(permission.method, "session/request_permission");
				const toolCall = permission.params.toolCall as Record<string, unknown>;
				strictEqual(toolCall.status, "pending");
				if (decision === "allow-once") match(String(toolCall.toolCallId), /^clio-coder-tool-\d+$/u);
				else strictEqual(toolCall.toolCallId, "clio-coder-tool-7");
				client.respond(permission.id, { outcome: { outcome: "selected", optionId: decision } });
				strictEqual((await prompt).stopReason, "end_turn");
				const file = join(project, "note.txt");
				strictEqual(existsSync(file), decision === "allow-once");
				if (decision === "allow-once") strictEqual(readFileSync(file, "utf8"), "from ACP");
				const terminal = client.updates
					.filter((update) => update.sessionUpdate === "tool_call_update")
					.reverse()
					.find((update) => update.toolCallId === toolCall.toolCallId);
				strictEqual(terminal?.status, decision === "allow-once" ? "completed" : "failed");
				await client.close(sessionId);
			} finally {
				client?.kill();
				await closeServer(fixture.server);
				target.cleanup();
			}
		}
	});
});
