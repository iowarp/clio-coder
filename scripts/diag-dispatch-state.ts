import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Diag harness for src/domains/dispatch/state.ts.
 *
 * Hermetic CLIO_HOME pattern: spin up an ephemeral data dir, exercise
 * create/update/list/recordReceipt/persist/reload, and assert the on-disk
 * shape + ring-buffer cap behavior.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-dispatch-state] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-dispatch-state] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function workerMain(home: string): Promise<void> {
	// Subprocess entrypoint used by the "lock:concurrent-processes" regression
	// test. Opens the ledger in the shared CLIO_HOME, creates one run tagged
	// with the worker's PID, and persists. The parent inspects runs.json to
	// verify all workers' entries survived the concurrent persist.
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR", "CLIO_MAX_RUNS"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	const { resetXdgCache } = await import("../src/core/xdg.js");
	resetXdgCache();
	const { resetPackageRootCache } = await import("../src/core/package-root.js");
	resetPackageRootCache();
	const { openLedger } = await import("../src/domains/dispatch/state.js");
	const ledger = openLedger();
	ledger.create({
		agentId: `worker-${process.pid}`,
		task: `task-${process.pid}`,
		providerId: "anthropic",
		modelId: "claude-opus",
		runtime: "native",
		sessionId: null,
		cwd: home,
	});
	await ledger.persist();
}

async function main(): Promise<void> {
	const workerIdx = process.argv.indexOf("--worker");
	if (workerIdx !== -1) {
		const home = process.argv[workerIdx + 1];
		if (!home) {
			process.stderr.write("worker requires --worker <home>\n");
			process.exit(2);
		}
		await workerMain(home);
		return;
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-state-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR", "CLIO_MAX_RUNS"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR", "CLIO_MAX_RUNS"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { openLedger } = await import("../src/domains/dispatch/state.js");
		const types = await import("../src/domains/dispatch/types.js");
		void types;

		// Step 1: open ledger.
		const ledger = openLedger();

		// Step 2: create a run.
		const created = ledger.create({
			agentId: "writer",
			task: "demo task",
			providerId: "anthropic",
			modelId: "claude-opus",
			runtime: "native",
			sessionId: null,
			cwd: home,
		});
		check("create:id-shape", typeof created.id === "string" && created.id.length === 12, `id=${created.id}`);
		check("create:status-queued", created.status === "queued", `status=${created.status}`);
		check("create:counters-zero", created.tokenCount === 0 && created.costUsd === 0);
		check("create:nullable-defaults", created.endedAt === null && created.pid === null && created.receiptPath === null);
		created.status = "dead";
		created.tokenCount = 999;
		const afterCreateMutation = ledger.get(created.id);
		check(
			"create:returns-clone",
			afterCreateMutation?.status === "queued" && afterCreateMutation?.tokenCount === 0,
			`got=${JSON.stringify(afterCreateMutation)}`,
		);

		// Step 3: update to running.
		const heartbeat = new Date().toISOString();
		const updated = ledger.update(created.id, { status: "running", pid: 12345, heartbeatAt: heartbeat });
		check("update:returns-updated", updated !== null && updated.status === "running" && updated.pid === 12345);
		check("update:heartbeat-set", updated?.heartbeatAt === heartbeat);
		check("update:unknown-id-returns-null", ledger.update("nonexistent!!", { status: "dead" }) === null);
		if (updated) {
			updated.pid = 77777;
			updated.heartbeatAt = "tampered";
		}
		const afterUpdateMutation = ledger.get(created.id);
		check(
			"update:returns-clone",
			afterUpdateMutation?.pid === 12345 && afterUpdateMutation?.heartbeatAt === heartbeat,
			`got=${JSON.stringify(afterUpdateMutation)}`,
		);

		const fetched = ledger.get(created.id);
		if (fetched) {
			fetched.status = "dead";
			fetched.receiptPath = "/tmp/tampered";
		}
		const refetched = ledger.get(created.id);
		check(
			"get:returns-clone",
			refetched?.status === "running" && refetched?.receiptPath === null,
			`got=${JSON.stringify(refetched)}`,
		);

		// Step 4: list filtered by status.
		const running = ledger.list({ status: "running" });
		check("list:running-has-1", running.length === 1, `len=${running.length}`);
		check("list:running-id-matches", running[0]?.id === created.id);
		check("list:queued-empty", ledger.list({ status: "queued" }).length === 0);
		check("list:returns-frozen-array", Object.isFrozen(running));
		if (running[0]) {
			running[0].status = "dead";
			running[0].pid = 4242;
		}
		const afterListMutation = ledger.get(created.id);
		check(
			"list:returns-cloned-elements",
			afterListMutation?.status === "running" && afterListMutation?.pid === 12345,
			`got=${JSON.stringify(afterListMutation)}`,
		);

		// Step 5: recordReceipt writes file and updates envelope.
		const receipt = {
			runId: created.id,
			agentId: created.agentId,
			task: created.task,
			providerId: created.providerId,
			modelId: created.modelId,
			runtime: created.runtime,
			startedAt: created.startedAt,
			endedAt: new Date().toISOString(),
			exitCode: 0,
			tokenCount: 42,
			costUsd: 0.0001,
			compiledPromptHash: null,
			staticCompositionHash: null,
			clioVersion: "0.0.0-test",
			piMonoVersion: "0.0.0-test",
			platform: process.platform,
			nodeVersion: process.version,
			toolCalls: 3,
			sessionId: null,
		};
		ledger.recordReceipt(created.id, receipt);
		const expectedReceiptPath = join(clioDataDir(), "receipts", `${created.id}.json`);
		check("receipt:file-written", existsSync(expectedReceiptPath), expectedReceiptPath);
		const envelopeAfterReceipt = ledger.get(created.id);
		check(
			"receipt:envelope-receipt-path",
			envelopeAfterReceipt?.receiptPath === expectedReceiptPath,
			`got=${envelopeAfterReceipt?.receiptPath}`,
		);
		const receiptOnDisk = JSON.parse(readFileSync(expectedReceiptPath, "utf8")) as { runId: string; toolCalls: number };
		check("receipt:contents-runid", receiptOnDisk.runId === created.id);
		check("receipt:contents-toolcalls", receiptOnDisk.toolCalls === 3);

		// Step 6: persist writes runs.json.
		await ledger.persist();
		const runsPath = join(clioDataDir(), "state", "runs.json");
		check("persist:runs.json-written", existsSync(runsPath), runsPath);
		const persisted = JSON.parse(readFileSync(runsPath, "utf8")) as Array<{ id: string; status: string }>;
		check("persist:contains-1-entry", persisted.length === 1, `len=${persisted.length}`);
		check("persist:status-running", persisted[0]?.status === "running");

		// Step 7: reload by opening a new ledger.
		const ledger2 = openLedger();
		const list2 = ledger2.list();
		check("reload:list-has-1", list2.length === 1, `len=${list2.length}`);
		check("reload:id-roundtrip", list2[0]?.id === created.id);
		check("reload:receipt-path-roundtrip", list2[0]?.receiptPath === expectedReceiptPath);

		// reload() on an existing instance also re-reads disk.
		const reloadable = openLedger();
		// mutate in memory only, do not persist
		reloadable.create({
			agentId: "ghost",
			task: "phantom",
			providerId: "anthropic",
			modelId: "claude-opus",
			runtime: "native",
			sessionId: null,
			cwd: home,
		});
		check("reload-pre:has-2-in-memory", reloadable.list().length === 2);
		reloadable.reload();
		check("reload-post:back-to-1", reloadable.list().length === 1);

		// Step 8: max-runs cap. maxRuns=3, create 5, persist, reload -> 3 newest.
		// Wipe the on-disk state first so this case starts clean.
		rmSync(runsPath, { force: true });
		const capped = openLedger({ maxRuns: 3 });
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = capped.create({
				agentId: `agent-${i}`,
				task: `task-${i}`,
				providerId: "anthropic",
				modelId: "claude-opus",
				runtime: "native",
				sessionId: null,
				cwd: home,
			});
			ids.push(r.id);
		}
		await capped.persist();
		const cappedReload = openLedger({ maxRuns: 3 });
		const cappedList = cappedReload.list();
		check("cap:reload-has-3", cappedList.length === 3, `len=${cappedList.length}`);
		// Newest first means the last 3 ids created sit at the head.
		const newestThreeIds = ids.slice(-3).reverse();
		check(
			"cap:newest-first",
			cappedList.map((r) => r.id).join(",") === newestThreeIds.join(","),
			`got=${cappedList.map((r) => r.id).join(",")} want=${newestThreeIds.join(",")}`,
		);

		// Step 9: concurrent-processes regression for the ledger lock. Fork
		// 5 tsx subprocesses, each creating + persisting one run; all 5 must
		// survive. Before the fix, concurrent waiters would delete each
		// other's live locks after a 5s deadline and clobber state.
		const concurrentHome = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-lock-"));
		const selfPath = fileURLToPath(import.meta.url);
		const spawnWorker = (): Promise<{ code: number; stderr: string }> =>
			new Promise((resolvePromise) => {
				const child = spawn(process.execPath, ["--import", "tsx", selfPath, "--worker", concurrentHome], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stderrBuf = "";
				child.stderr.on("data", (chunk: Buffer) => {
					stderrBuf += chunk.toString("utf8");
				});
				child.stdout.on("data", () => {
					// drain
				});
				child.on("close", (code) => resolvePromise({ code: code ?? -1, stderr: stderrBuf }));
			});
		const workerResults = await Promise.all([spawnWorker(), spawnWorker(), spawnWorker(), spawnWorker(), spawnWorker()]);
		const allSucceeded = workerResults.every((r) => r.code === 0);
		check(
			"lock:concurrent-exit-codes",
			allSucceeded,
			workerResults.map((r, i) => `w${i}=${r.code}${r.code !== 0 ? ` err=${r.stderr.slice(0, 200)}` : ""}`).join(" "),
		);
		const concurrentRunsPath = join(concurrentHome, "data", "state", "runs.json");
		const concurrentPersisted = existsSync(concurrentRunsPath)
			? (JSON.parse(readFileSync(concurrentRunsPath, "utf8")) as Array<{ id: string; agentId: string }>)
			: [];
		check(
			"lock:concurrent-all-5-survived",
			concurrentPersisted.length === 5,
			`len=${concurrentPersisted.length} ids=${concurrentPersisted.map((r) => r.agentId).join(",")}`,
		);
		try {
			rmSync(concurrentHome, { recursive: true, force: true });
		} catch {
			// best-effort
		}

		// Step 10: stale lock with dead PID must be reclaimed quickly.
		const staleHome = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-stale-"));
		const staleEnvSnapshot = process.env.CLIO_HOME;
		process.env.CLIO_HOME = staleHome;
		try {
			const { resetXdgCache: resetStale, clioDataDir: staleClioDataDir } = await import("../src/core/xdg.js");
			resetStale();
			const { resetPackageRootCache: resetStalePkg } = await import("../src/core/package-root.js");
			resetStalePkg();
			const { openLedger: openStaleLedger } = await import("../src/domains/dispatch/state.js");
			const staleRunsPath = join(staleClioDataDir(), "state", "runs.json");
			const staleLockPath = `${staleRunsPath}.lock`;
			const { mkdirSync } = await import("node:fs");
			mkdirSync(dirname(staleLockPath), { recursive: true });
			// PID far above any plausible active PID range; kill(pid, 0) throws ESRCH.
			writeFileSync(staleLockPath, "2147483646");
			const staleLedger = openStaleLedger();
			staleLedger.create({
				agentId: "stale-reclaim",
				task: "reclaim-dead-pid-lock",
				providerId: "anthropic",
				modelId: "claude-opus",
				runtime: "native",
				sessionId: null,
				cwd: staleHome,
			});
			const staleStart = Date.now();
			await staleLedger.persist();
			const staleElapsed = Date.now() - staleStart;
			check("lock:stale-pid-reclaimed", existsSync(staleRunsPath), `elapsed=${staleElapsed}ms`);
			check(
				"lock:stale-pid-reclaimed-fast",
				staleElapsed < 5_000,
				`persist took ${staleElapsed}ms with a dead-PID stale lock`,
			);
		} finally {
			const k = "CLIO_HOME";
			if (staleEnvSnapshot === undefined) delete process.env[k];
			else process.env[k] = staleEnvSnapshot;
			try {
				rmSync(staleHome, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}

		// Step 11: lockfile containing a live PID (our own) must NOT be
		// reclaimed. The waiter should back off until the lock is released.
		const liveHome = mkdtempSync(join(tmpdir(), "clio-diag-dispatch-live-"));
		const liveEnvSnapshot = process.env.CLIO_HOME;
		process.env.CLIO_HOME = liveHome;
		try {
			const { resetXdgCache: resetLive, clioDataDir: liveClioDataDir } = await import("../src/core/xdg.js");
			resetLive();
			const { resetPackageRootCache: resetLivePkg } = await import("../src/core/package-root.js");
			resetLivePkg();
			const { openLedger: openLiveLedger } = await import("../src/domains/dispatch/state.js");
			const liveRunsPath = join(liveClioDataDir(), "state", "runs.json");
			const liveLockPath = `${liveRunsPath}.lock`;
			const { mkdirSync } = await import("node:fs");
			mkdirSync(dirname(liveLockPath), { recursive: true });
			writeFileSync(liveLockPath, String(process.pid));
			const liveLedger = openLiveLedger();
			liveLedger.create({
				agentId: "live-backoff",
				task: "backoff-on-live-pid",
				providerId: "anthropic",
				modelId: "claude-opus",
				runtime: "native",
				sessionId: null,
				cwd: liveHome,
			});
			const persistPromise = liveLedger.persist();
			// Give the waiter time to observe the lock and back off at least once.
			await new Promise((resolve) => setTimeout(resolve, 300));
			const stillPlanted = existsSync(liveLockPath) && readFileSync(liveLockPath, "utf8").trim() === String(process.pid);
			check("lock:live-pid-not-reclaimed", stillPlanted, "waiter unlinked the live-PID lockfile instead of backing off");
			try {
				unlinkSync(liveLockPath);
			} catch {
				// ok if already gone
			}
			await persistPromise;
			check("lock:live-pid-persist-completes-after-release", existsSync(liveRunsPath));
		} finally {
			const k = "CLIO_HOME";
			if (liveEnvSnapshot === undefined) delete process.env[k];
			else process.env[k] = liveEnvSnapshot;
			try {
				rmSync(liveHome, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-dispatch-state] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-dispatch-state] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-dispatch-state] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
