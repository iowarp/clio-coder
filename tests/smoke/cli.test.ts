import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import {
	closeServer,
	seedBootstrapTransportTargets,
	seedOpenAICompatFleetDefault,
	seedOpenAICompatOrchestrator,
	seedUnregisteredRuntimeTarget,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	version: string;
};
const VERSION_STDOUT = `Clio Coder ${PACKAGE_JSON.version}\n`;
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const FORBIDDEN_TERMINAL_STREAM_TYPES = new Set([
	"message_start",
	"message_update",
	"text_start",
	"text_delta",
	"text_end",
	"thinking",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_delta",
]);

interface JsonRpcProcessClient {
	request<T>(method: string, params?: unknown): Promise<T>;
	notifications: unknown[];
	close(): void;
	wait(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
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

	it("shows the experimental warning in the bare CLI startup banner", async () => {
		const result = await runCli([], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /EXPERIMENTAL/);
		match(result.stdout, /may break or change/i);
	});

	/**
	 * Demoting a command must not remove it. An agent driving Clio over bash
	 * reaches a wider surface than a person reading a help screen can hold, so
	 * only the default listing shrinks: every demoted name still resolves at the
	 * top level and every one is reachable under the prefix.
	 */
	it("keeps demoted commands working under both the dev prefix and their bare names", async () => {
		const listing = await runCli(["dev", "--help"], { env: scratch.env });
		strictEqual(listing.code, 0);
		for (const name of ["components", "evolve", "share"]) {
			match(listing.stdout, new RegExp(`clio dev ${name}`), `${name} must be listed under dev`);

			const prefixed = await runCli(["dev", name, "--help"], { env: scratch.env });
			const bare = await runCli([name, "--help"], { env: scratch.env });
			strictEqual(prefixed.code, bare.code, `${name}: dev prefix must exit like the bare name`);
			strictEqual(prefixed.stdout, bare.stdout, `${name}: dev prefix must forward, not reimplement`);
		}
	});

	it("hides the demoted commands from the default help and shows them under --all", async () => {
		const brief = await runCli(["--help"], { env: scratch.env });
		const full = await runCli(["--help", "--all"], { env: scratch.env });
		strictEqual(brief.code, 0);
		strictEqual(full.code, 0);
		for (const name of ["components", "evolve", "share"]) {
			strictEqual(brief.stdout.includes(`clio ${name} `), false, `${name} must not be in the default listing`);
			match(full.stdout, new RegExp(`clio dev ${name}`), `${name} must be in --all`);
		}
		match(brief.stdout, /clio dev <command>/);
	});

	it("refuses an unknown dev command with the listing instead of forwarding it", async () => {
		const result = await runCli(["dev", "definitely-not-a-dev-command"], { env: scratch.env });
		strictEqual(result.code, 2);
		match(result.stderr, /unknown dev command/);
		// A bare `clio dev` is the listing the top-level help tells the user to run
		// for ("harness instruments; run 'clio dev' for the list"), so printing it
		// is the command succeeding. It used to print the listing and exit 2,
		// contradicting the help that sent the user there.
		const bare = await runCli(["dev"], { env: scratch.env });
		strictEqual(bare.code, 0, `stderr=${bare.stderr}`);
		match(bare.stdout, /clio dev components/);
		strictEqual(bare.stderr.trim(), "");
	});

	it("-v routes through the lazily loaded version command", async () => {
		// Guards the WS3 lazy dispatch: the version path must import ./version.js
		// dynamically and still print the version, not fall through to a subcommand.
		const result = await runCli(["-v"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, VERSION_STDOUT);
	});

	it("an unknown subcommand exits 2 and prints usage (dispatch default branch)", async () => {
		const result = await runCli(["definitely-not-a-command"], { env: scratch.env });
		strictEqual(result.code, 2);
		match(result.stderr, /unknown subcommand: definitely-not-a-command/);
		match(result.stdout, /Usage:/);
	});

	it("rejects removed top-level context aliases", async () => {
		for (const alias of ["context-init", "context-index", "context-clear"]) {
			const result = await runCli([alias, "--help"], { env: scratch.env });
			strictEqual(result.code, 2, alias);
			match(result.stderr, new RegExp(`unknown subcommand: ${alias}`));
			match(result.stdout, /clio context init/);
		}
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
					"--set-background",
					"--background-model",
					"fixture-beta",
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
			strictEqual((afterConfigure.background as Record<string, unknown>).target, "fixture-openai");
			strictEqual((afterConfigure.background as Record<string, unknown>).model, "fixture-beta");
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

	it("skills list, inspect, and validate work in a scratch project", async () => {
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

		// `skills create` was removed with the artifact/skill split: a skill is a
		// SKILL.md folder written with the ordinary write tool and validated by
		// the loader, so an unknown subcommand must fail closed.
		const created = await runCli(["skills", "create", "cli-made"], { env: scratch.env, cwd: project });
		strictEqual(created.code, 2, `stderr=${created.stderr}`);
		match(created.stderr, /unknown skills command/);
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

	it("carries bootstrap schema and fallback contracts through the provider wire", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		// Cites `index.ts`, which the fixture project below actually contains. The
		// rule used to be that a Scout line had to be a verbatim copy of a sibling
		// file's line; it is now that the line has to cite something real, so this
		// fixture states its evidence instead of duplicating it.
		const groundedRule = "Always preserve the captured provider request in `index.ts` for bootstrap transport.";
		const bootstrapReply = JSON.stringify({
			projectName: "transport-fixture",
			identity: "A transport fixture for bootstrap dispatch.",
			conventions: [],
			invariants: [],
			sections: [{ title: "Transport evidence", body: groundedRule }],
		});
		const fixture = await startOpenAICompatFixture(bootstrapReply);
		const env = { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" };
		try {
			seedBootstrapTransportTargets(join(scratch.dir, "config"), fixture.url);
			const runBootstrap = async (target: string, projectDir: string) => {
				mkdirSync(projectDir, { recursive: true });
				writeFileSync(
					join(projectDir, "package.json"),
					JSON.stringify({ name: "transport-fixture", type: "module" }),
					"utf8",
				);
				writeFileSync(join(projectDir, "index.ts"), "export const transportFixture = true;\n", "utf8");
				writeFileSync(join(projectDir, "AGENTS.md"), `- ${groundedRule}\n`, "utf8");
				const result = await runCli(["context", "init", "--yes", "--json", "--target", target, "--model", "mock-model"], {
					env,
					cwd: projectDir,
					timeoutMs: 30_000,
				});
				strictEqual(result.code, 0, `target=${target} stderr=${result.stderr}`);
				const output = JSON.parse(result.stdout) as {
					generation?: {
						mode?: unknown;
						run?: {
							structuredOutputMode?: unknown;
							targetId?: unknown;
							wireModelId?: unknown;
							runtimeId?: unknown;
						};
					};
				};
				strictEqual(output.generation?.mode, "model", `target=${target} stdout=${result.stdout}`);
				strictEqual(output.generation?.run?.targetId, target);
				strictEqual(output.generation?.run?.wireModelId, "mock-model");
				ok(existsSync(join(projectDir, "CLIO.md")), `target=${target} did not write validated bootstrap output`);
				return output;
			};

			const llamaOutput = await runBootstrap("fixture-llama", join(scratch.dir, "llama-project"));
			strictEqual(llamaOutput.generation?.run?.structuredOutputMode, "native-schema");
			strictEqual(llamaOutput.generation?.run?.runtimeId, "llamacpp");
			strictEqual(fixture.requests.length, 1);
			const llamaRequest = fixture.requests[0];
			strictEqual(llamaRequest?.stream, true);
			ok(Array.isArray(llamaRequest?.tools) && llamaRequest.tools.length > 0, "Scout tools must reach llama.cpp");
			deepStrictEqual(llamaRequest?.response_format, {
				type: "json_object",
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["projectName", "identity", "conventions", "invariants", "sections"],
					properties: {
						projectName: { type: "string" },
						identity: { type: "string" },
						conventions: { type: "array", items: { type: "string" } },
						invariants: { type: "array", items: { type: "string" } },
						sections: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["title", "body"],
								properties: { title: { type: "string" }, body: { type: "string" } },
							},
						},
					},
				},
			});

			const compatOutput = await runBootstrap("fixture-openai-scout", join(scratch.dir, "openai-project"));
			strictEqual(compatOutput.generation?.run?.structuredOutputMode, "prompt-parser");
			strictEqual(compatOutput.generation?.run?.runtimeId, "openai-compat");
			strictEqual(fixture.requests.length, 2, "unsupported schema attempt must retry once without an HTTP preflight");
			const compatRequest = fixture.requests[1];
			strictEqual(compatRequest?.stream, true);
			ok(Array.isArray(compatRequest?.tools) && compatRequest.tools.length > 0, "Scout tools must survive fallback");
			strictEqual("response_format" in (compatRequest ?? {}), false);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("streams only terminal events with main-agent --json-events terminal", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("terminal mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(["--no-context-files", "run", "--json-events", "terminal", "hello"], {
				env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				timeoutMs: 20_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			const events = jsonLines(result.stdout);
			const types = events.map((event) => event.type);
			for (const expected of ["session", "turn_start", "agent_start", "message_end", "agent_end", "turn_end"]) {
				ok(types.includes(expected), `missing ${expected}: ${result.stdout}`);
			}
			for (const type of types) {
				ok(typeof type === "string");
				ok(!FORBIDDEN_TERMINAL_STREAM_TYPES.has(type), `unexpected partial event ${type}: ${result.stdout}`);
			}
			const messageEnd = events.find(
				(event) => event.type === "message_end" && JSON.stringify(event).includes("assistant"),
			);
			ok(JSON.stringify(messageEnd).includes("terminal mock reply"), `stdout=${result.stdout}`);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("the full --json stream carries increments, never repeated message snapshots", async () => {
		// A tool-heavy SciCode sub-step wrote 802 MB of stdout, 99.3% of it
		// `message_update` snapshots of a 44 KB message. The stream publishes
		// each piece of content once: deltas while it streams, one completed
		// message when it lands.
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("full stream mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(["--no-context-files", "run", "--json", "hello"], {
				env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				timeoutMs: 20_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			const events = jsonLines(result.stdout);
			const types = events.map((event) => event.type);
			ok(!types.includes("message_update"), `message_update leaked into the stream: ${result.stdout}`);
			ok(types.includes("message_end"), `missing message_end: ${result.stdout}`);
			for (const event of events) {
				if (event.type !== "text_delta" && event.type !== "thinking_delta") continue;
				strictEqual("partialText" in event, false, "a delta never carries the growing partial text");
				strictEqual("partialThinking" in event, false, "a delta never carries the growing partial thinking");
			}
			const agentEnd = events.find((event) => event.type === "agent_end");
			ok(agentEnd !== undefined, `missing agent_end: ${result.stdout}`);
			strictEqual("messages" in (agentEnd ?? {}), false, "agent_end summarizes instead of republishing messages");
			ok((agentEnd?.usage as { measured?: unknown } | undefined)?.measured !== undefined, "agent_end reports usage");
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("applies one-run autonomy without rewriting settings and seals it in the main receipt", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("autonomy mock reply");
		try {
			const configDir = join(scratch.dir, "config");
			seedOpenAICompatOrchestrator(configDir, fixture.url);
			const settingsPath = join(configDir, "settings.yaml");
			const fullAuto = readFileSync(settingsPath, "utf8").replace(/^autonomy: auto-edit$/m, "autonomy: full-auto");
			writeFileSync(settingsPath, fullAuto, "utf8");
			const before = readFileSync(settingsPath, "utf8");

			const result = await runCli(
				["--no-context-files", "--no-skills", "run", "--autonomy", "read-only", "report the autonomy level"],
				{
					env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
					timeoutMs: 20_000,
				},
			);
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			strictEqual(readFileSync(settingsPath, "utf8"), before, "one-run override must not persist");
			ok(JSON.stringify(fixture.requests).includes("read-only"), "effective posture reaches the model prompt");

			const receiptFiles = readdirSync(join(scratch.dir, "state", "receipts")).filter((name) => name.endsWith(".json"));
			strictEqual(receiptFiles.length, 1);
			const receipt = JSON.parse(
				readFileSync(join(scratch.dir, "state", "receipts", receiptFiles[0] ?? ""), "utf8"),
			) as Record<string, unknown>;
			deepStrictEqual(receipt.autonomyEnforcement, { grade: "mediated", autonomy: "read-only" });
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("prints the worker final answer for headless --agent dispatch", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture(
			JSON.stringify({
				mutatedPaths: [],
				validations: [{ name: "response", passed: true, evidence: "dispatch mock answer" }],
			}),
		);
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
