import { ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLEANUP_SETTLE_MS = 5_000;

function workerPidFrom(stderr: string): number | null {
	const match = stderr.match(/WORKER_PID=(\d+)/);
	return match?.[1] === undefined ? null : Number(match[1]);
}

function workerPidFromFile(path: string | undefined): number | null {
	if (path === undefined || !existsSync(path)) return null;
	const pid = Number(readFileSync(path, "utf8").trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}

function waitForCloseBounded(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("generated parent survived cleanup")), CLEANUP_SETTLE_MS);
		void waitForClose(child).then(() => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

function processTargetIsAlive(pid: number, group: boolean): boolean {
	try {
		process.kill(group ? -pid : pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessTargetExit(pid: number, group: boolean): Promise<void> {
	const deadline = Date.now() + CLEANUP_SETTLE_MS;
	while (processTargetIsAlive(pid, group) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (processTargetIsAlive(pid, group)) {
		throw new Error(`detached worker ${group ? "group " : ""}${pid} survived cleanup`);
	}
}

async function killWindowsProcessTree(pid: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
		const deadline = setTimeout(() => {
			killer.kill("SIGKILL");
			resolve();
		}, CLEANUP_SETTLE_MS);
		killer.once("error", () => {
			clearTimeout(deadline);
			resolve();
		});
		killer.once("close", () => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

/**
 * Build one idempotent failure cleanup for a generated parent and the detached
 * worker it published. POSIX workers lead process groups; Windows has no
 * negative-pid signaling, so taskkill is the explicit process-tree fallback.
 */
function createFailureCleanup(child: ReturnType<typeof spawn>, workerPid: () => number | null): () => Promise<void> {
	let cleanup: Promise<void> | undefined;
	return () => {
		cleanup ??= (async () => {
			const pid = workerPid();
			if (pid !== null) {
				if (process.platform === "win32") {
					await killWindowsProcessTree(pid);
				} else {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// The worker already settled.
						}
					}
				}
			}
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await waitForCloseBounded(child);
			if (pid !== null) await waitForProcessTargetExit(pid, process.platform !== "win32");
		})();
		return cleanup;
	};
}

interface BoundedParentResult {
	code: number | null;
	stderr: string;
	workerPid: number | null;
	cleanupRan: boolean;
}

function runBoundedParent(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	outerDeadlineMs: number,
	workerPidFile?: string,
): Promise<BoundedParentResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let settled = false;
		let cleanupRan = false;
		let publishedWorkerPid: number | null = null;
		const cleanup = createFailureCleanup(child, () => publishedWorkerPid);
		const finish = async (code: number | null, relevantFailure: boolean): Promise<void> => {
			if (settled) return;
			settled = true;
			clearTimeout(overallDeadline);
			publishedWorkerPid ??= workerPidFromFile(workerPidFile);
			if (relevantFailure) {
				cleanupRan = true;
				try {
					await cleanup();
				} catch (error) {
					stderr += `\n[test] cleanup failed: ${String(error)}`;
					code = -1;
				}
			} else if (publishedWorkerPid !== null) {
				try {
					await waitForProcessTargetExit(publishedWorkerPid, process.platform !== "win32");
				} catch (error) {
					stderr += `\n[test] ${String(error)}`;
					code = -1;
				}
			}
			resolve({ code, stderr, workerPid: publishedWorkerPid, cleanupRan });
		};
		const overallDeadline = setTimeout(() => {
			stderr += "\n[test] parent exceeded the outer deadline";
			void finish(-1, true);
		}, outerDeadlineMs);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			publishedWorkerPid ??= workerPidFrom(stderr);
		});
		child.once("error", (error) => {
			stderr += `\n[test] spawn error: ${String(error)}`;
			void finish(-1, true);
		});
		child.once("close", (code) => void finish(code, code !== 0));
	});
}

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

			const result = await runBoundedParent(
				process.execPath,
				["--import", "tsx", parentScript],
				{
					...process.env,
					...homeEnv,
					NODE_COMPILE_CACHE: undefined,
					NODE_DISABLE_COMPILE_CACHE: undefined,
				},
				60_000,
				workerPidFile,
			);
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
			const result = await runBoundedParent(process.execPath, [fixture], process.env, 5_000, workerPidFile);
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
