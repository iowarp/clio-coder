import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function main(): Promise<void> {
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
