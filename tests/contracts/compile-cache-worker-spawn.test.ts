import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { processTargetIsAlive, runBoundedParent } from "../harness/bounded-worker.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/**
 * Process-level regression for the direct fleet path: a parent that never ran
 * a boot entrypoint (so nothing pre-settled the cache) must establish the
 * cache at the native-spawn boundary and hand the worker the injected pair.
 *
 * Both boundaries are real processes: the parent runs spawnNativeWorker in a
 * child of its own so the settle-once module state cannot be polluted by (or
 * pollute) other tests sharing this runner process, and the worker is a stub
 * entry that reports the environment it actually received.
 */
describe("contracts/compile cache at the native worker spawn boundary", () => {
	it("an initialized, previously uncached parent hands a worker the injected pair", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-cc-spawn-"));
		try {
			const homeEnv = scratchClioEnvVars(scratch, { requireHomePrefix: true });
			// Initialized install: the cache root exists, so the root gate passes.
			mkdirSync(join(scratch, "cache"), { recursive: true });
			const observation = join(scratch, "worker-env.json");

			const stubEntry = join(scratch, "stub-worker.cjs");
			writeFileSync(
				stubEntry,
				`require("node:fs").writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
	cache: process.env.NODE_COMPILE_CACHE ?? null,
	marker: process.env.CLIO_CODER_INJECTED_COMPILE_CACHE ?? null,
}));
process.exit(0);
`,
				"utf8",
			);

			const parentScript = join(scratch, "parent.mts");
			const workerPidFile = join(scratch, "worker.pid");
			writeFileSync(
				parentScript,
				`import { spawnNativeWorker } from ${JSON.stringify(join(REPO_ROOT, "src/domains/dispatch/worker-spawn.ts"))};
import { writeFileSync } from "node:fs";
import { fixtureSettingsFingerprint } from ${JSON.stringify(join(REPO_ROOT, "tests/harness/worker-attestation.ts"))};
import { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } from ${JSON.stringify(join(REPO_ROOT, "src/worker/spec-contract.ts"))};

const worker = spawnNativeWorker(
	{
		specVersion: WORKER_SPEC_VERSION,
		settingsFingerprint: fixtureSettingsFingerprint(),
		systemPrompt: "",
		agentId: "coder",
		task: "t",
		target: { id: "e", runtime: "x" } as never,
		runtime: {
			version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
			id: "x",
			kind: "http",
			apiFamily: "openai-responses",
			auth: "none",
		},
		runtimeId: "x",
		wireModelId: "m",
		allowedTools: ["bash"],
		budget: { toolCalls: 1, readReserve: 0, synthesis: true, hardCap: 1 },
	},
	{ workerEntryPath: ${JSON.stringify(stubEntry)} },
);
// The worker leads its own process group; hand its pid to the outer test so
// even a SIGKILLed parent leaves nothing behind.
if (worker.pid !== null) {
	writeFileSync(${JSON.stringify(workerPidFile)}, String(worker.pid));
	console.error("WORKER_PID=" + worker.pid);
}
// A regressed stub that never exits must not strand a detached process-group
// leader or hang the shard: past the deadline, abort the worker and fail.
const deadline = setTimeout(() => {
	process.exitCode = 1;
	console.error("worker did not settle within the deadline; aborting");
	worker.abort();
}, 30_000);
try {
	for await (const _event of worker.events) {
		// drain; the stub emits nothing meaningful
	}
	await worker.promise;
} catch (error) {
	process.exitCode = 1;
	console.error(error);
} finally {
	clearTimeout(deadline);
}
`,
				"utf8",
			);

			const result = await runBoundedParent(process.execPath, ["--import", "tsx", parentScript], {
				cwd: REPO_ROOT,
				env: {
					...process.env,
					...homeEnv,
					NODE_COMPILE_CACHE: undefined,
					NODE_DISABLE_COMPILE_CACHE: undefined,
				},
				outerDeadlineMs: 60_000,
				workerPidFile,
			});
			strictEqual(result.code, 0, result.stderr);
			strictEqual(result.cleanupRan, false, "the success path settled without failure cleanup");
			ok(result.workerPid !== null, `the real generated parent published its worker pid: ${result.stderr}`);

			ok(existsSync(observation), "the stub worker reported the environment it received");
			const observed = JSON.parse(readFileSync(observation, "utf8")) as { cache: string | null; marker: string | null };
			ok(observed.cache !== null, "the spawn boundary established and injected a cache directory");
			ok(
				observed.cache.startsWith(join(scratch, "cache")),
				`injected directory ${observed.cache} lives under the initialized install's cache root`,
			);
			strictEqual(observed.marker, observed.cache, "the provenance marker is bound to the injected directory");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("kills and reaps a published detached worker when its parent fails", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-cc-cleanup-"));
		try {
			const fixture = join(scratch, "failing-parent.cjs");
			const workerPidFile = join(scratch, "worker.pid");
			writeFileSync(
				fixture,
				`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	detached: true,
	stdio: "ignore",
});
writeFileSync(${JSON.stringify(workerPidFile)}, String(worker.pid));
process.stderr.write("WORKER_PID=" + worker.pid + "\\n", () => {
	setTimeout(() => process.exit(23), 20);
});
`,
				"utf8",
			);
			const result = await runBoundedParent(process.execPath, [fixture], {
				cwd: REPO_ROOT,
				env: process.env,
				outerDeadlineMs: 5_000,
				workerPidFile,
			});
			strictEqual(result.code, 23, result.stderr);
			strictEqual(result.cleanupRan, true, "an unexpected parent failure runs tree cleanup");
			ok(result.workerPid !== null, `the fixture published its detached worker pid: ${result.stderr}`);
			strictEqual(
				processTargetIsAlive(result.workerPid as number, process.platform !== "win32"),
				false,
				"the detached worker tree settled before the test returned",
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
