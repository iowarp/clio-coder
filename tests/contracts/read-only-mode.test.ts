import { deepEqual, equal, ok } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	closeServer,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Doctor, `run --read-only` and read-only workers probe targets like any run, and
// a probe refreshes the per-target model snapshot and the endpoint slot count
// every later process reads (DOG-001). Read-only mode reads both and writes
// neither. Entering it for good is one-way per process, so the cases run in
// order: a scope first, then the whole process.
const home = mkdtempSync(join(tmpdir(), "clio-coder-read-only-mode-"));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
const { resetXdgCache } = await import("../../src/core/xdg.js");
resetXdgCache();
const { enterReadOnlyMode, withReadOnlyMode } = await import("../../src/core/read-only-mode.js");
const { readTargetModelSnapshot, recordTargetModelSnapshot, targetModelSnapshotPath } = await import(
	"../../src/domains/providers/target-model-cache.js"
);
const { endpointSlotsPath, readDiscoveredEndpointSlots, recordDiscoveredEndpointSlots } = await import(
	"../../src/domains/providers/endpoint-slots-store.js"
);
const { withStateFileLock } = await import("../../src/core/state-file-lock.js");
const { enableClioCompileCache } = await import("../../src/core/compile-cache.js");
const { initializeClioHome } = await import("../../src/core/init.js");
const { DEFAULT_SETTINGS_YAML } = await import("../../src/core/defaults.js");
const cliHome = mkdtempSync(join(tmpdir(), "clio-coder-read-only-cli-"));
const freshRoot = mkdtempSync(join(tmpdir(), "clio-coder-read-only-fresh-"));
const freshHome = join(freshRoot, "home");
after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cliHome, { recursive: true, force: true });
	rmSync(freshRoot, { recursive: true, force: true });
});

const target = { id: "local", runtime: "openai-compat", url: "http://127.0.0.1:9/v1" };
const endpointKey = "http://127.0.0.1:9";
const slots = (count: number) => ({ endpointKey, runtimeId: "llamacpp", slots: count });

describe("read-only mode", () => {
	it("a scope records no model snapshot or slot count across an await, and reading creates no cache root", async () => {
		await withReadOnlyMode(async () => {
			await Promise.resolve();
			equal(recordTargetModelSnapshot(target, ["model-a"]), false);
			await recordDiscoveredEndpointSlots(slots(4));
		});
		equal(readTargetModelSnapshot(target), null);
		ok(!existsSync(join(home, "cache")), "neither the refused write nor the read creates the cache root");
		ok(!existsSync(join(home, "state")), "the refused slot count creates no state root");

		equal(recordTargetModelSnapshot(target, ["model-a"]), true);
		deepEqual(readTargetModelSnapshot(target)?.models, ["model-a"]);
		await recordDiscoveredEndpointSlots(slots(4));
		equal(readDiscoveredEndpointSlots()[endpointKey]?.slots, 4, "outside the scope both are written");
	});

	it("a process in read-only mode for good reads both and leaves them as it found them", async () => {
		const snapshotFile = targetModelSnapshotPath(target.id);
		const before = [readFileSync(snapshotFile, "utf8"), readFileSync(endpointSlotsPath(), "utf8")];
		// A slot write already waiting for the lock when the mode turns on records nothing once it holds it.
		let waiting: Promise<void> | undefined;
		await withStateFileLock(endpointSlotsPath(), async () => {
			waiting = recordDiscoveredEndpointSlots(slots(2));
			await new Promise((resolve) => setTimeout(resolve, 50));
			enterReadOnlyMode();
		});
		await waiting;
		equal(recordTargetModelSnapshot(target, ["model-b"]), false);
		await recordDiscoveredEndpointSlots(slots(1));
		deepEqual([readFileSync(snapshotFile, "utf8"), readFileSync(endpointSlotsPath(), "utf8")], before);
		deepEqual(readTargetModelSnapshot(target)?.models, ["model-a"]);
		equal(readDiscoveredEndpointSlots()[endpointKey]?.slots, 4);
	});

	it("a process in read-only mode for good enables no bytecode cache and home setup creates no cache root", () => {
		ok(existsSync(join(home, "cache")), "the cache root exists, so only the mode can refuse the cache");
		equal(enableClioCompileCache({}), null);
		ok(!existsSync(join(home, "cache", "v8-compile-cache")));
		rmSync(join(home, "cache"), { recursive: true, force: true });
		initializeClioHome();
		ok(!existsSync(join(home, "cache")), "read-only home setup leaves a home without a cache root as it found it");
		ok(existsSync(join(home, "state")), "the rest of the home is still set up");
		// Setup over a home that has its settings and credentials takes no lock file beside them.
		const configMtime = statSync(join(home, "config")).mtimeMs;
		initializeClioHome();
		equal(statSync(join(home, "config")).mtimeMs, configMtime);
	});

	it("`run --read-only` enables no bytecode cache before the run enters the mode; a plain run still does", () => {
		const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
		const env: NodeJS.ProcessEnv = { ...process.env, ...scratchClioEnvVars(cliHome), HOME: cliHome };
		delete env.NODE_COMPILE_CACHE;
		delete env.NODE_DISABLE_COMPILE_CACHE;
		mkdirSync(join(cliHome, "cache"), { recursive: true });
		// No task: the run refuses with a usage error after the CLI's enable already ran.
		const run = (args: string[]) =>
			spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, ...args], {
				cwd: cliHome,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).status;
		equal(run(["run", "--json", "--read-only"]), 2);
		deepEqual(readdirSync(join(cliHome, "cache")), []);
		equal(run(["run", "--json"]), 2);
		deepEqual(readdirSync(join(cliHome, "cache")), ["v8-compile-cache"]);
	});

	it("`run --read-only` on a home never set up answers from its settings and writes nothing anywhere in it", {
		timeout: 120_000,
	}, async (t) => {
		const fixture = await startOpenAICompatFixture("done");
		t.after(() => closeServer(fixture.server));
		const configDir = join(freshHome, "config");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "settings.yaml"), DEFAULT_SETTINGS_YAML);
		seedOpenAICompatOrchestrator(configDir, fixture.url);
		const runTmp = join(freshRoot, "tmp");
		mkdirSync(runTmp);
		const run = freshRun(runTmp);
		const before = inventory(freshHome);
		const readOnly = await run(["--read-only", "Say done."]);
		equal(readOnly.code, 0, readOnly.stderr);
		ok(readOnly.stdout.includes("done"), readOnly.stdout);
		ok(fixture.requests.length > 0, "the run reached the model");
		deepEqual(inventory(freshHome), before, "no config, credentials, data, state or cache entry was made or changed");
		deepEqual(
			readdirSync(runTmp).filter((name) => name.startsWith("clio-coder-read-only-")),
			[],
			"the private home the run used is gone at exit",
		);
		// The same home is a working one: a plain run sets it up.
		const plain = await run(["Say done."]);
		equal(plain.code, 0, plain.stderr);
		ok(existsSync(join(freshHome, "state", "home.json")));
	});

	it("`run --read-only` on a set-up home leaves its record, offloads and sweep alone, and refuses pending migrations", {
		timeout: 120_000,
	}, async (t) => {
		const fixture = await startOpenAICompatFixture("done");
		t.after(() => closeServer(fixture.server));
		writeFileSync(join(freshHome, "config", "settings.yaml"), DEFAULT_SETTINGS_YAML);
		seedOpenAICompatOrchestrator(join(freshHome, "config"), fixture.url);
		const run = freshRun(join(freshRoot, "tmp"));
		const state = join(freshHome, "state");
		const record = join(state, "home.json");
		// A home last opened under another node, with an expired offload and the lesson sweep not yet recorded.
		writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), nodeVersion: "v0.0.1" }));
		const offload = join(state, "scratch", "old-session", "result.txt");
		mkdirSync(join(state, "scratch", "old-session"), { recursive: true });
		writeFileSync(offload, "old");
		utimesSync(offload, new Date(0), new Date(0));
		const marker = join(state, "memory", "flow-sweep-v1.json");
		rmSync(marker, { force: true });
		const manifest = join(freshHome, "config", "migrations.json");
		const facts = () => {
			const stat = statSync(record);
			const migrations = existsSync(manifest) ? readFileSync(manifest, "utf8") : null;
			return [readFileSync(record, "utf8"), stat.mode, stat.mtimeMs, stat.ctimeMs, migrations];
		};
		const before = facts();

		const answered = await run(["--read-only", "Say done."]);
		equal(answered.code, 0, answered.stderr);
		ok(answered.stdout.includes("done"), answered.stdout);
		deepEqual(facts(), before, "home.json is neither rewritten, re-moded nor locked");
		ok(existsSync(offload), "an earlier session's offload is left for a writable boot");
		ok(!existsSync(marker), "the sweep is not recorded, so a writable boot still runs it");

		const { REGISTERED_MIGRATION_IDS: applied } = await import("../../src/domains/lifecycle/migrations/registry-ids.js");
		writeFileSync(manifest, JSON.stringify({ applied: applied.slice(0, -1) }));
		const pending = facts();
		const requests = fixture.requests.length;
		const refused = await run(["--read-only", "Say done."]);
		equal(refused.code, 1, refused.stderr);
		ok(refused.stderr.includes(`1 pending migration (${applied.at(-1)})`), refused.stderr);
		equal(fixture.requests.length, requests, "nothing reached the model");
		deepEqual(facts(), pending, "the pending migration is not applied");
	});
});

/** Runs the CLI on the fresh home with a private TMPDIR, as an operator's shell would. */
function freshRun(runTmp: string) {
	const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...scratchClioEnvVars(freshHome),
		HOME: freshHome,
		TMPDIR: runTmp,
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
	};
	return (args: string[]) =>
		new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn(
				process.execPath,
				["--import", import.meta.resolve("tsx"), entry, "--no-context-files", "run", ...args],
				{ cwd: freshHome, env, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
}

/** Every entry under `root` with its kind, size and mtime, so any write shows. */
function inventory(root: string): string[] {
	const rows: string[] = [];
	const walk = (dir: string): void => {
		const stat = statSync(dir);
		rows.push(`${dir}\td\t${stat.mtimeMs}`);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				const file = statSync(path);
				rows.push(`${path}\tf\t${file.size}\t${file.mtimeMs}`);
			}
		}
	};
	walk(root);
	return rows.sort();
}
