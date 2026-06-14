import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
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

interface OpenAICompatFixtureOptions {
	models?: Array<Record<string, unknown> & { id: string }>;
}

async function startOpenAICompatFixture(
	reply: string,
	options: OpenAICompatFixtureOptions = {},
): Promise<{
	server: Server;
	url: string;
	requests: Array<Record<string, unknown>>;
}> {
	const models = options.models ?? [{ id: "mock-model", object: "model" }];
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: models }));
			return;
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const raw = await readRequestBody(req);
		const request = JSON.parse(raw) as Record<string, unknown>;
		requests.push(request);
		if (request.stream === false) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl-clio-probe",
					object: "chat.completion",
					model: request.model ?? "mock-model",
					choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
				}),
			);
			return;
		}
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

	it("doctor --fix self-heals a legacy v0.2.2 settings.yaml without losing targets", async () => {
		const configDir = join(scratch.dir, "config");
		mkdirSync(configDir, { recursive: true });
		const settingsFile = join(configDir, "settings.yaml");
		writeFileSync(
			settingsFile,
			[
				"version: 1",
				"safetyLevel: auto-edit",
				"endpoints:",
				"  - id: keepme",
				"    runtime: ollama-native",
				"    url: http://localhost:11434",
				"    defaultModel: m1",
				"orchestrator:",
				"  endpoint: keepme",
				"  model: m1",
				"state:",
				"  recentModels:",
				"    - keepme/m1",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(join(configDir, "credentials.yaml"), "{}\n", { mode: 0o600 });

		// Without --fix the strict validator refuses the legacy keys.
		const before = await runCli(["doctor"], { env: scratch.env });
		strictEqual(before.code, 1);
		match(before.stdout, /safetyLevel/);
		match(before.stdout, /clio doctor --fix/);

		// --fix repairs the known legacy keys and the whole gate goes green.
		const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(fixed.code, 0);
		match(fixed.stdout, /repaired legacy keys/);

		// The renamed target survived and the dropped recents were seeded.
		const repaired = readFileSync(settingsFile, "utf8");
		match(repaired, /autonomy: auto-edit/);
		match(repaired, /target: keepme/);
		strictEqual(/safetyLevel|endpoints:|\bstate:/.test(repaired), false);
		ok(existsSync(join(scratch.dir, "config", "settings.yaml.bak")), "the original file is backed up");
		const recents = JSON.parse(readFileSync(join(scratch.dir, "state", "recent-models.json"), "utf8")) as string[];
		deepStrictEqual(recents, ["keepme/m1"]);

		// Re-running --fix is a no-op: the file is already current.
		const again = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(again.code, 0);
		strictEqual(/repaired legacy keys/.test(again.stdout), false);
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

	it("reset requires --force and removes only the selected root", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const dataMarker = join(scratch.dir, "data", "marker.txt");
		const stateMarker = join(scratch.dir, "state", "marker.txt");
		writeFileSync(dataMarker, "data marker\n", "utf8");
		writeFileSync(stateMarker, "state marker\n", "utf8");

		const denied = await runCli(["reset", "--data"], { env: scratch.env });
		strictEqual(denied.code, 2);
		match(denied.stderr, /requires --force/);
		ok(existsSync(dataMarker), "force-gated reset must not remove data");

		const preview = await runCli(["reset", "--data", "--dry-run"], { env: scratch.env });
		strictEqual(preview.code, 0, `stderr=${preview.stderr}`);
		match(preview.stdout, /reset preview complete/);
		ok(existsSync(dataMarker), "dry-run reset must not remove data");

		const forced = await runCli(["reset", "--data", "--force"], { env: scratch.env });
		strictEqual(forced.code, 0, `stderr=${forced.stderr}`);
		match(forced.stdout, /reset complete/);
		strictEqual(existsSync(dataMarker), false, "forced --data reset removes data contents");
		ok(existsSync(join(scratch.dir, "data", "memory")), "reset reinitializes the data root structure");
		ok(existsSync(stateMarker), "reset --data must not touch state contents");
	});

	it("uninstall requires --force and removes all four roots only when forced", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const dirs = ["config", "data", "state", "cache"].map((name) => join(scratch.dir, name));

		const denied = await runCli(["uninstall"], { env: scratch.env });
		strictEqual(denied.code, 2);
		match(denied.stderr, /requires --force/);
		ok(
			dirs.every((dir) => existsSync(dir)),
			"force-gated uninstall must not remove roots",
		);

		const preview = await runCli(["uninstall", "--dry-run"], { env: scratch.env });
		strictEqual(preview.code, 0, `stderr=${preview.stderr}`);
		match(preview.stdout, /uninstall preview complete/);
		ok(
			dirs.every((dir) => existsSync(dir)),
			"dry-run uninstall must not remove roots",
		);

		const forced = await runCli(["uninstall", "--force"], { env: scratch.env });
		strictEqual(forced.code, 0, `stderr=${forced.stderr}`);
		match(forced.stdout, /removed Clio Coder state/);
		for (const dir of dirs) {
			strictEqual(existsSync(dir), false, `uninstall --force removed ${dir}`);
		}
	});

	it("uninstall --remove-binary preserves real files and removes only clio dist symlinks", async () => {
		const binDir = join(scratch.dir, "bin");
		const launcher = join(binDir, "clio");
		mkdirSync(binDir, { recursive: true });
		await runCli(["doctor", "--fix"], { env: scratch.env });

		writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
		const keepRealFile = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});
		strictEqual(keepRealFile.code, 0, `stderr=${keepRealFile.stderr}`);
		match(keepRealFile.stdout, /binary\s+keep/);
		ok(existsSync(launcher), "a real launcher file must be left for the package manager");

		rmSync(launcher, { force: true });
		await runCli(["doctor", "--fix"], { env: scratch.env });
		symlinkSync(CLI_ENTRY, launcher);
		const removeSymlink = await runCli(["uninstall", "--remove-binary", "--force"], {
			env: { ...scratch.env, CLIO_BIN_DIR: binDir },
		});
		strictEqual(removeSymlink.code, 0, `stderr=${removeSymlink.stderr}`);
		match(removeSymlink.stdout, /binary\s+remove/);
		strictEqual(existsSync(launcher), false, "a launcher symlink into dist/cli/index.js is removed");
	});

	it("targets --json returns an object with a targets array", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["targets", "--json"], { env: scratch.env });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as { targets: unknown[] };
		ok(parsed && typeof parsed === "object");
		ok(Array.isArray(parsed.targets));
	});

	it("configures an openai-compat target and lists fixture-backed models through the built CLI", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("probe reply", {
			models: [
				{
					id: "fixture-alpha",
					object: "model",
					status: "loaded",
					context_window: 32768,
					max_output_tokens: 2048,
					tools: true,
					reasoning: true,
				},
				{
					id: "fixture-beta",
					object: "model",
					status: { state: "unloaded", detail: "cold" },
					context_window: 16384,
					max_output_tokens: 1024,
					tools: false,
					reasoning: false,
				},
			],
		});
		try {
			const env = { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" };
			const configured = await runCli(
				[
					"configure",
					"--id",
					"fixture-openai",
					"--runtime",
					"openai-compat",
					"--url",
					fixture.url,
					"--model",
					"fixture-alpha",
					"--api-key-env",
					"CLIO_TEST_OPENAI_KEY",
					"--set-orchestrator",
					"--orchestrator-model",
					"fixture-alpha",
					"--set-fleet-default",
					"--fleet-model",
					"fixture-beta",
					"--context-window",
					"32768",
					"--max-tokens",
					"2048",
					"--reasoning",
					"true",
				],
				{ env, timeoutMs: 20_000 },
			);
			strictEqual(configured.code, 0, `stderr=${configured.stderr}`);
			match(configured.stdout, /saved target fixture-openai/);

			const settingsFile = join(scratch.dir, "config", "settings.yaml");
			const afterConfigure = parseYaml(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
			const configuredTargets = afterConfigure.targets as Array<Record<string, unknown>>;
			const configuredTarget = configuredTargets.find((target) => target.id === "fixture-openai");
			ok(configuredTarget, "configured target persisted in settings.yaml");
			strictEqual(configuredTarget.runtime, "openai-compat");
			strictEqual(configuredTarget.url, fixture.url);
			strictEqual(configuredTarget.defaultModel, "fixture-alpha");
			deepStrictEqual(configuredTarget.wireModels, ["fixture-alpha", "fixture-beta"]);
			deepStrictEqual(configuredTarget.auth, { apiKeyEnvVar: "CLIO_TEST_OPENAI_KEY" });
			deepStrictEqual(configuredTarget.capabilities, {
				contextWindow: 32768,
				maxTokens: 2048,
				reasoning: true,
			});
			strictEqual("endpoints" in afterConfigure, false, "settings must use target vocabulary, not legacy endpoints");
			strictEqual((afterConfigure.orchestrator as Record<string, unknown>).target, "fixture-openai");
			strictEqual((afterConfigure.orchestrator as Record<string, unknown>).model, "fixture-alpha");
			strictEqual(
				((afterConfigure.workers as Record<string, unknown>).default as Record<string, unknown>).target,
				"fixture-openai",
			);
			strictEqual(
				((afterConfigure.workers as Record<string, unknown>).default as Record<string, unknown>).model,
				"fixture-beta",
			);

			const targetsJson = await runCli(["targets", "--json"], { env });
			strictEqual(targetsJson.code, 0, `stderr=${targetsJson.stderr}`);
			const targets = JSON.parse(targetsJson.stdout) as {
				targets: Array<{
					target: {
						id: string;
						runtime: string;
						url?: string;
						defaultModel?: string;
						wireModels?: string[];
						auth?: { apiKeyEnvVar?: string };
					};
					available: boolean;
					health: { status: string };
					discoveredModels: string[];
				}>;
			};
			const listedTarget = targets.targets.find((target) => target.target.id === "fixture-openai");
			ok(listedTarget, `targets --json did not list fixture-openai: ${targetsJson.stdout}`);
			strictEqual(listedTarget.target.runtime, "openai-compat");
			strictEqual(listedTarget.target.defaultModel, "fixture-alpha");
			deepStrictEqual(listedTarget.target.wireModels, ["fixture-alpha", "fixture-beta"]);
			strictEqual(listedTarget.target.auth?.apiKeyEnvVar, "CLIO_TEST_OPENAI_KEY");

			const offlineModels = await runCli(["models", "--offline", "--json"], { env });
			strictEqual(offlineModels.code, 0, `stderr=${offlineModels.stderr}`);
			const offlineRows = JSON.parse(offlineModels.stdout) as Array<{ modelId: string; state: string }>;
			deepStrictEqual(
				offlineRows.map((row) => [row.modelId, row.state]),
				[
					["fixture-alpha", "-"],
					["fixture-beta", "-"],
				],
			);

			const noMatch = await runCli(["models", "missing-model", "--offline"], { env });
			strictEqual(noMatch.code, 0, `stderr=${noMatch.stderr}`);
			match(noMatch.stdout, /no models matched "missing-model" across 1 target\./);
			ok(!noMatch.stdout.includes("no targets configured"), noMatch.stdout);

			const liveModels = await runCli(["models", "--target", "fixture-openai", "--json"], {
				env,
				timeoutMs: 20_000,
			});
			strictEqual(liveModels.code, 0, `stderr=${liveModels.stderr}`);
			const liveRows = JSON.parse(liveModels.stdout) as Array<{
				targetId: string;
				runtimeId: string;
				modelId: string;
				state: string;
				contextWindow: number;
				maxTokens: number;
				reasoning: boolean;
			}>;
			deepStrictEqual(
				liveRows.map((row) => [row.targetId, row.runtimeId, row.modelId, row.state]),
				[
					["fixture-openai", "openai-compat", "fixture-alpha", "loaded"],
					["fixture-openai", "openai-compat", "fixture-beta", "unloaded"],
				],
			);
			strictEqual(liveRows[0]?.contextWindow, 32768);
			strictEqual(liveRows[0]?.maxTokens, 2048);

			const selected = await runCli(["targets", "use", "fixture-openai", "--model", "fixture-beta"], { env });
			strictEqual(selected.code, 0, `stderr=${selected.stderr}`);
			match(selected.stdout, /using target fixture-openai/);

			const afterUse = parseYaml(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
			strictEqual((afterUse.orchestrator as Record<string, unknown>).target, "fixture-openai");
			strictEqual((afterUse.orchestrator as Record<string, unknown>).model, "fixture-beta");
			strictEqual(
				((afterUse.workers as Record<string, unknown>).default as Record<string, unknown>).target,
				"fixture-openai",
			);
			strictEqual(
				((afterUse.workers as Record<string, unknown>).default as Record<string, unknown>).model,
				"fixture-beta",
			);
		} finally {
			await closeServer(fixture.server);
		}
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
