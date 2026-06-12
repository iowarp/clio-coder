import { match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	version: string;
};
const VERSION_STDOUT = `Clio Coder ${PACKAGE_JSON.version}\n`;
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

interface JsonRpcProcessClient {
	request<T>(method: string, params?: unknown): Promise<T>;
	notifications: unknown[];
	close(): void;
	wait(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function createJsonRpcProcessClient(args: string[], env: NodeJS.ProcessEnv, cwd: string): JsonRpcProcessClient {
	const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let nextId = 1;
	let stdoutBuffer = "";
	let stderr = "";
	const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
	const notifications: unknown[] = [];
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
			const message = JSON.parse(line) as Record<string, unknown>;
			if ("id" in message && ("result" in message || "error" in message)) {
				const entry = pending.get(Number(message.id));
				if (!entry) continue;
				pending.delete(Number(message.id));
				if (message.error && typeof message.error === "object") {
					entry.reject(new Error(String((message.error as { message?: unknown }).message ?? "RPC error")));
				} else {
					entry.resolve(message.result);
				}
			} else {
				notifications.push(message);
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("exit", (code, signal) => {
		for (const entry of pending.values()) {
			entry.reject(new Error(`ACP subprocess exited before reply: code=${code ?? "null"} signal=${signal ?? "null"}`));
		}
		pending.clear();
	});
	return {
		notifications,
		request<T>(method: string, params?: unknown): Promise<T> {
			const id = nextId++;
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: (value) => resolve(value as T), reject });
			});
		},
		close(): void {
			child.stdin.end();
		},
		wait(timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`ACP subprocess timeout. stderr=${stderr}`));
				}, timeoutMs);
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					resolve({ code, signal, stderr });
				});
			});
		},
	};
}

async function closeServer(server: Server | null): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
	});
}

async function startOpenAICompatFixture(reply: string): Promise<{
	server: Server;
	url: string;
	requests: Array<Record<string, unknown>>;
}> {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const raw = await readRequestBody(req);
		requests.push(JSON.parse(raw) as Record<string, unknown>);
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: { content: reply } }],
			})}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${addr.port}`, requests };
}

function seedOpenAICompatOrchestrator(configDir: string, url: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(
			/^targets:.*$/m,
			[
				"targets:",
				"  - id: mock-chat",
				"    runtime: openai-compat",
				`    url: ${url}`,
				"    defaultModel: mock-model",
				"    auth:",
				"      apiKeyEnvVar: CLIO_TEST_OPENAI_KEY",
				"    capabilities:",
				"      vision: true",
				"    wireModels:",
				"      - mock-model",
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: mock-chat")
		.replace(/^ {2}model: null$/m, "  model: mock-model");
	writeFileSync(p, patched, "utf8");
}

function seedOpenAICompatFleetDefault(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(/^ {4}target: null$/m, "    target: mock-chat")
		.replace(/^ {4}model: null$/m, "    model: mock-model");
	writeFileSync(p, patched, "utf8");
}

function seedUnregisteredRuntimeTarget(configDir: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml.replace(
		/^targets:.*$/m,
		[
			"targets:",
			"  - id: codex-worker",
			"    runtime: codex-cli",
			"    defaultModel: gpt-5.4",
			"    wireModels:",
			"      - gpt-5.4",
		].join("\n"),
	);
	writeFileSync(p, patched, "utf8");
}

function writeSkill(dir: string, name: string, description: string, body = "Skill body."): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	const file = join(skillDir, "SKILL.md");
	writeFileSync(file, ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n"), "utf8");
	return file;
}

describe("clio cli smoke tests", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome();
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("--version exits 0 and prints the Clio Coder version", async () => {
		const result = await runCli(["--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, VERSION_STDOUT);
	});

	it("--help exits 0 and prints usage instructions", async () => {
		const result = await runCli(["--help"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /Usage:/);
		match(result.stdout, /clio doctor/);
		match(result.stdout, /clio run \[flags\] <task>/);
	});

	it("doctor --fix bootstraps the configurations and environment", async () => {
		const result = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /config dir/);
		match(result.stdout, /data dir/);
		match(result.stdout, /state dir/);
		match(result.stdout, /cache dir/);
	});

	it("doctor without --fix reports findings and exit code 1", async () => {
		const result = await runCli(["doctor"], { env: scratch.env });
		strictEqual(result.code, 1);
		match(result.stdout, /settings.yaml/);
	});

	it("paths --json prints the resolved directories read-only", async () => {
		const result = await runCli(["paths", "--json"], { env: scratch.env });
		strictEqual(result.code, 0);
		const dirs = JSON.parse(result.stdout) as { config: string; data: string; state: string; cache: string };
		strictEqual(dirs.config, scratch.env.CLIO_CONFIG_DIR);
		strictEqual(dirs.data, scratch.env.CLIO_DATA_DIR);
		strictEqual(dirs.state, scratch.env.CLIO_STATE_DIR);
		strictEqual(dirs.cache, scratch.env.CLIO_CACHE_DIR);
		// Read-only contract: asking for paths must not create them.
		strictEqual(existsSync(dirs.config), false);
		strictEqual(existsSync(dirs.data), false);
		strictEqual(existsSync(dirs.state), false);
		strictEqual(existsSync(dirs.cache), false);
	});

	it("targets --json returns an object with a targets array", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["targets", "--json"], { env: scratch.env });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as { targets: unknown[] };
		ok(parsed && typeof parsed === "object");
		ok(Array.isArray(parsed.targets));
	});

	it("agents --json lists built-in recipes", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["agents", "--json"], { env: scratch.env });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as unknown[];
		ok(Array.isArray(parsed) && parsed.length > 0);
	});

	it("targets use rejects a target whose runtime is not registered", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		seedUnregisteredRuntimeTarget(join(scratch.dir, "config"));
		const result = await runCli(["targets", "use", "codex-worker"], { env: scratch.env });
		strictEqual(result.code, 1);
		match(result.stderr, /not registered/);
		const settings = readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8");
		match(settings, /^ {2}target: null$/m);
	});

	it("skills list, inspect, validate, and create work in a scratch project", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const project = join(scratch.dir, "project");
		const skillFile = writeSkill(join(project, ".clio", "skills"), "smoke-skill", "Smoke test skill.");

		const list = await runCli(["skills", "list", "--json", "--all"], { env: scratch.env, cwd: project });
		strictEqual(list.code, 0, `stderr=${list.stderr}`);
		const listed = JSON.parse(list.stdout) as { skills: Array<{ name: string }> };
		ok(listed.skills.some((skill) => skill.name === "smoke-skill"));

		const inspect = await runCli(["skills", "inspect", "smoke-skill", "--json"], { env: scratch.env, cwd: project });
		strictEqual(inspect.code, 0, `stderr=${inspect.stderr}`);
		const inspected = JSON.parse(inspect.stdout) as { skill: { name: string; path: string } };
		strictEqual(inspected.skill.name, "smoke-skill");

		const validate = await runCli(["skills", "validate", skillFile, "--json"], { env: scratch.env, cwd: project });
		strictEqual(validate.code, 0, `stderr=${validate.stderr}`);
		const validated = JSON.parse(validate.stdout) as { ok: boolean };
		strictEqual(validated.ok, true);

		const created = await runCli(["skills", "create", "cli-made"], { env: scratch.env, cwd: project });
		strictEqual(created.code, 0, `stderr=${created.stderr}`);
		ok(existsSync(join(project, ".clio", "skills", "cli-made", "SKILL.md")));
	});

	it("runs non-interactively against a mock provider", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(["--no-context-files", "run", "hello"], {
				env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				timeoutMs: 20_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "mock reply\n");
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("prints the worker final answer for headless --agent dispatch", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("dispatch mock answer");
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			seedOpenAICompatFleetDefault(join(scratch.dir, "config"));
			const result = await runCli(["--no-context-files", "run", "--agent", "coder", "say hi"], {
				env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				cwd: project,
				timeoutMs: 30_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			match(result.stdout, /dispatch mock answer/);
			match(result.stdout, /receipt: /);
			// Human output carries the answer and the receipt, not the raw
			// event-name stream the worker emits.
			ok(!/^message_update$/m.test(result.stdout), `stdout=${result.stdout}`);
			ok(!/^message_update$/m.test(result.stderr), `stderr=${result.stderr}`);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("serves ACP over stdio against a mock provider", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("acp mock reply");
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const client = createJsonRpcProcessClient(
				["--no-context-files", "--no-skills", "acp"],
				{
					...scratch.env,
					CLIO_TEST_OPENAI_KEY: "sk-test",
				},
				project,
			);
			const init = await client.request<{ protocolVersion: number }>("initialize", {
				protocolVersion: 1,
				clientInfo: { name: "smoke-client", version: "1" },
			});
			strictEqual(init.protocolVersion, 1);
			const session = await client.request<{ sessionId: string }>("session/new", { cwd: project });
			const prompt = await client.request<{ stopReason: string }>("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});
			strictEqual(prompt.stopReason, "end_turn");
			ok(
				client.notifications.some((message) => JSON.stringify(message).includes("acp mock reply")),
				`notifications=${JSON.stringify(client.notifications)}`,
			);
			// Every session/update a live `clio acp` process emits must use an ACP v1
			// SessionUpdate variant. A non-spec discriminator (e.g. the old "progress")
			// would break strict serde clients such as Zed.
			const validSessionUpdates = new Set([
				"user_message_chunk",
				"agent_message_chunk",
				"agent_thought_chunk",
				"tool_call",
				"tool_call_update",
				"plan",
				"available_commands_update",
				"current_mode_update",
			]);
			for (const message of client.notifications) {
				if (typeof message !== "object" || message === null) continue;
				const record = message as { method?: unknown; params?: unknown };
				if (record.method !== "session/update") continue;
				const params = record.params as { update?: { sessionUpdate?: unknown } } | undefined;
				const variant = params?.update?.sessionUpdate;
				ok(
					typeof variant === "string" && validSessionUpdates.has(variant),
					`non-spec sessionUpdate emitted: ${JSON.stringify(variant)}`,
				);
			}
			await client.request("session/close", { sessionId: session.sessionId });
			client.close();
			const exit = await client.wait();
			strictEqual(exit.code, 0, `stderr=${exit.stderr}`);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("honors explicit --skill paths even with --no-skills", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		const explicitDir = join(scratch.dir, "explicit");
		const skillFile = writeSkill(explicitDir, "explicit-smoke", "Explicit smoke skill.", "Use explicit smoke guidance.");
		const fixture = await startOpenAICompatFixture("mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(
				["--no-context-files", "run", "--no-skills", "--skill", skillFile, "please use the skill named explicit-smoke"],
				{
					env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
					cwd: project,
					timeoutMs: 20_000,
				},
			);
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			ok(JSON.stringify(fixture.requests).includes("explicit-smoke"));
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("honors top-level skill flags before run subcommand", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		const explicitDir = join(scratch.dir, "explicit");
		const skillFile = writeSkill(
			explicitDir,
			"explicit-smoke-top",
			"Explicit smoke top skill.",
			"Use explicit smoke top guidance.",
		);
		const fixture = await startOpenAICompatFixture("mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(
				["--no-context-files", "--no-skills", "--skill", skillFile, "run", "please use the skill named explicit-smoke-top"],
				{
					env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
					cwd: project,
					timeoutMs: 20_000,
				},
			);
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			ok(JSON.stringify(fixture.requests).includes("explicit-smoke-top"));
		} finally {
			await closeServer(fixture.server);
		}
	});
});
