import { match, ok, strictEqual } from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const root = mkdtempSync(join(tmpdir(), "clio-acp-boundary-"));
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
			CLIO_CODER_RESIDENCY: "observe",
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
async function provider(options: { reply: string; tool?: boolean }): Promise<{ server: Server; url: string }> {
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
		const payload = await readBody(request);
		if (payload.stream === false) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: options.reply } }] }));
			return;
		}
		const messages = payload.messages as Array<{ role?: string }>;
		const callTool = options.tool && !messages.some((message) => message.role === "tool");
		const delta = callTool
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call-write",
							type: "function",
							function: { name: "write", arguments: '{"path":"note.txt","content":"from ACP"}' },
						},
					],
				}
			: { role: "assistant", content: options.reply };
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
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
describe("smoke/ACP stdio boundary", { concurrency: false }, () => {
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

	it("mediates one write allow and one write reject", async () => {
		for (const decision of ["allow-once", "reject-once"] as const) {
			const target = home();
			const fixture = await provider({ reply: `permission ${decision}`, tool: true });
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
