import { deepEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
const cliHome = mkdtempSync(join(tmpdir(), "clio-coder-read-only-cli-"));
after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cliHome, { recursive: true, force: true });
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
});
