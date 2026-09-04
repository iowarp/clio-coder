import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");
const V1_SETTINGS = `version: 1
autonomy: suggest
targets:
  - id: release-local
    runtime: lmstudio
    url: http://127.0.0.1:1234
    defaultModel: release-model
    lifecycle: user-managed
orchestrator:
  target: release-local
  model: release-model
  thinkingLevel: high
background:
  target: release-local
  model: release-model
  thinkingLevel: low
workers:
  default:
    target: release-local
    model: release-model
    thinkingLevel: medium
  maxRetries: 4
  onPermission: escalate
modelSelector:
  favorites: [release-local/release-model]
  recentLimit: 8
budget:
  sessionCeilingUsd: 9.5
  concurrency: 3
terminal:
  showTerminalProgress: true
  outputVerbosity: verbose
  tuiMode: fullscreen
  smoothStreaming: on
panes:
  enabled: off
  notifications: failures
  agents: off
  keepFailed: true
  yazi:
    enabled: false
    mode: chooser
    profile: user
    followCwd: false
retry:
  enabled: false
  maxRetries: 6
`;

interface Home {
	root: string;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

interface RunningCli {
	child: ChildProcessWithoutNullStreams;
	output(): string;
	waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
	waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	stop(): Promise<void>;
}

function isolatedHome(label: string): Home {
	const root = mkdtempSync(join(tmpdir(), label));
	const under = (name: string) => join(root, name);
	return {
		root,
		env: {
			...process.env,
			NODE_ENV: "test",
			NO_COLOR: "1",
			TERM: "xterm-256color",
			CLIO_CODER_HOME: root,
			CLIO_CODER_CONFIG_DIR: under("config"),
			CLIO_CODER_DATA_DIR: under("data"),
			CLIO_CODER_STATE_DIR: under("state"),
			CLIO_CODER_CACHE_DIR: under("cache"),
			CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function launch(args: string[], env: NodeJS.ProcessEnv, cwd = ROOT): RunningCli {
	const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	let cursor = 0;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		output += text;
	});
	child.stderr.on("data", (text: string) => {
		output += text;
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	const timeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`${message}\n${output.slice(-2_000)}`)), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	return {
		child,
		output: () => output,
		async waitFor(pattern, timeoutMs = 20_000) {
			const found = new Promise<RegExpMatchArray>((resolve) => {
				const inspect = () => {
					const match = output.slice(cursor).match(pattern);
					if (!match || match.index === undefined) return;
					cursor += match.index + match[0].length;
					child.stdout.off("data", inspect);
					child.stderr.off("data", inspect);
					resolve(match);
				};
				child.stdout.on("data", inspect);
				child.stderr.on("data", inspect);
				inspect();
			});
			return timeout(found, timeoutMs, `timed out waiting for ${pattern}`);
		},
		waitForExit: (timeoutMs = 20_000) => timeout(exited, timeoutMs, "CLI did not exit"),
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			try {
				await timeout(exited, 2_000, "CLI ignored SIGTERM");
			} catch {
				child.kill("SIGKILL");
				await exited;
			}
		},
	};
}

async function run(
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd = ROOT,
): Promise<{ code: number | null; output: string }> {
	const cli = launch(args, env, cwd);
	cli.child.stdin.end();
	const exit = await cli.waitForExit();
	return { code: exit.code, output: cli.output() };
}

async function reachEditor(cli: RunningCli): Promise<void> {
	try {
		await cli.waitFor(/Ask Clio/u, 30_000);
		cli.child.stdin.write("\u0004");
		const exit = await cli.waitForExit();
		strictEqual(exit.code, 0, cli.output().slice(-2_000));
	} finally {
		await cli.stop();
	}
}

async function answer(cli: RunningCli, prompt: RegExp, value = ""): Promise<void> {
	await cli.waitFor(prompt);
	cli.child.stdin.write(`${value}\n`);
}

describe("smoke/real built binary boot", { concurrency: false }, () => {
	let server: Server;
	let endpoint: string;

	before(async () => {
		server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/lmstudio-greeting") response.end(JSON.stringify({ lmstudio: true }));
			else if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "release-model" }] }));
			else {
				response.statusCode = 404;
				response.end(JSON.stringify({ error: "not found" }));
			}
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("upgrades the exact v1 release home once, keeps its backup, and boots it", async () => {
		const home = isolatedHome("clio-migrated-boot-");
		try {
			mkdirSync(join(home.root, "config"), { recursive: true });
			writeFileSync(join(home.root, "config", "settings.yaml"), V1_SETTINGS);
			const env = { ...home.env, CLIO_CODER_TEST_UPGRADE_NO_NETWORK: "1" };
			const first = await run(["upgrade"], env);
			strictEqual(first.code, 0, first.output);
			match(first.output, /5 migrations applied/u);
			strictEqual(readFileSync(join(home.root, "config", "settings.yaml.v1.bak"), "utf8"), V1_SETTINGS);
			const manifest = JSON.parse(readFileSync(join(home.root, "state", "migrations.json"), "utf8"));
			deepStrictEqual(manifest.applied, [
				"2026-09-01-settings-v2",
				"2026-09-01-extension-install-digests",
				"2026-09-01-clio-coder-naming",
				"2026-09-01-retire-panes-knobs",
				"2026-08-18-lmstudio-runtime-id",
			]);
			const migrated = readFileSync(join(home.root, "config", "settings.yaml"), "utf8");
			match(migrated, /^version: 2$/mu);
			match(migrated, /^chat:$/mu);
			match(migrated, /^interface:$/mu);
			ok(!/^panes:$/mu.test(migrated), "retired root panes map must be gone");

			const second = await run(["upgrade"], env);
			strictEqual(second.code, 0, second.output);
			match(second.output, /no pending migrations/u);
			strictEqual(readFileSync(join(home.root, "config", "settings.yaml"), "utf8"), migrated);
			strictEqual(readFileSync(join(home.root, "config", "settings.yaml.v1.bak"), "utf8"), V1_SETTINGS);

			// The release seed intentionally names port 1234. Point the already-
			// migrated v2 target at this test's isolated health endpoint so doctor
			// does not depend on, or interfere with, a developer's live LM Studio.
			writeFileSync(join(home.root, "config", "settings.yaml"), migrated.replace("http://127.0.0.1:1234", endpoint));
			const doctor = await run(["doctor", "--json"], home.env, home.root);
			strictEqual(doctor.code, 0, doctor.output);
			strictEqual(JSON.parse(doctor.output).ok, true);
			await reachEditor(launch([], { ...home.env, CLIO_CODER_INTERACTIVE: "1" }));
		} finally {
			home.cleanup();
		}
	});

	it("takes a genuinely empty home through first-run setup to the editor over ordinary process I/O", async () => {
		const home = isolatedHome("clio-fresh-boot-");
		let cli: RunningCli | undefined;
		try {
			deepStrictEqual(readdirSync(home.root), []);
			cli = launch([], { ...home.env, CLIO_CODER_INTERACTIVE: "1" });
			await answer(cli, /Selection \[1\]:/u, "1");
			await answer(cli, /Selection \(number or runtime id\):/u, "lmstudio");
			await answer(cli, /Target id \[[^\]]+\]:/u, "fresh-local");
			await answer(cli, /Target URL \[[^\]]+\]:/u, endpoint);
			await answer(cli, /Credential source .*:/u, "skip");
			await answer(cli, /Default target model \(number or id\) \[[^\]]+\]:/u);
			await answer(cli, /Mark as gateway\? \[y\/N\]:/u);
			await answer(cli, /use as orchestrator .*\[Y\/n\]:/u);
			await answer(cli, /use as fleet default\? \[Y\/n\]:/u);
			await answer(cli, /use as background memory target\? \[y\/N\]:/u);
			await answer(cli, /Orchestrator model \(number or id\) \[[^\]]+\]:/u);
			await answer(cli, /Fleet model \(number or id\) \[[^\]]+\]:/u);
			for (;;) {
				const next = await cli.waitFor(/Ask Clio|Add [^\n]+\? \[y\/N\]:/u, 30_000);
				if (next[0].startsWith("Ask Clio")) break;
				cli.child.stdin.write("n\n");
			}
			cli.child.stdin.write("\u0004");
			const exit = await cli.waitForExit();
			strictEqual(exit.code, 0, cli.output().slice(-2_000));
			ok(existsSync(join(home.root, "config", "settings.yaml")));
			match(readFileSync(join(home.root, "config", "settings.yaml"), "utf8"), /^version: 2$/mu);
		} finally {
			await cli?.stop();
			home.cleanup();
		}
	});
});
