/**
 * `clio fleet status` projection contract: the totals built from the durable
 * ledger must carry the input/output token split the receipts record, both
 * for rows finalized after the ledger learned the split and for pre-split
 * rows whose only source of truth is the receipt artifact (bt-02 finding 2).
 */

import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { statusSnapshot } from "../../src/cli/fleet.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";

function withIsolatedClioHome<T>(fn: (scratch: string) => T | Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const scratch = mkdtempSync(join(tmpdir(), "clio-fleet-status-"));
	process.env.CLIO_HOME = scratch;
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	return Promise.resolve()
		.then(() => fn(scratch))
		.finally(() => {
			for (const k of Object.keys(process.env)) {
				if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
			}
			for (const [k, v] of Object.entries(originalEnv)) {
				if (v !== undefined) process.env[k] = v;
			}
			rmSync(scratch, { recursive: true, force: true });
			resetXdgCache();
		});
}

function completedRow(overrides: Partial<RunEnvelope> & { id: string }): RunEnvelope {
	return {
		agentId: "coder",
		task: "test task",
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: "openai-completions",
		runtimeKind: "http",
		startedAt: "2026-06-12T00:00:00.000Z",
		endedAt: "2026-06-12T00:00:10.000Z",
		status: "completed",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/tmp",
		tokenCount: 0,
		costUsd: 0,
		...overrides,
	};
}

describe("contracts/fleet-status", () => {
	it("totals carry the token split from ledger rows and fall back to receipts for pre-split rows", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const dataDir = join(scratch, "data");
			mkdirSync(join(dataDir, "state"), { recursive: true });
			mkdirSync(join(dataDir, "receipts"), { recursive: true });

			// Pre-split row: no input/output on the envelope; the receipt carries it.
			const receiptPath = join(dataDir, "receipts", "oldrow0000001.json");
			writeFileSync(receiptPath, JSON.stringify({ runId: "oldrow0000001", inputTokenCount: 4780, outputTokenCount: 167 }));
			const rows: RunEnvelope[] = [
				completedRow({ id: "newrow0000001", tokenCount: 5575, inputTokenCount: 2606, outputTokenCount: 189 }),
				completedRow({ id: "oldrow0000001", tokenCount: 4947, receiptPath }),
				// Running row from another process: no live meters cross-process.
				completedRow({ id: "running000001", status: "running", endedAt: null, tokenCount: 0 }),
			];
			writeFileSync(join(dataDir, "state", "runs.json"), JSON.stringify(rows, null, 2));

			const snapshot = statusSnapshot();
			strictEqual(snapshot.totals.inputTokens, 2606 + 4780);
			strictEqual(snapshot.totals.outputTokens, 189 + 167);
			strictEqual(snapshot.totals.totalTokens, 5575 + 4947);
		});
	});

	it("a pre-split row with a missing receipt contributes zero split without failing the snapshot", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const dataDir = join(scratch, "data");
			mkdirSync(join(dataDir, "state"), { recursive: true });
			const rows: RunEnvelope[] = [completedRow({ id: "orphan0000001", tokenCount: 100 })];
			writeFileSync(join(dataDir, "state", "runs.json"), JSON.stringify(rows, null, 2));

			const snapshot = statusSnapshot();
			strictEqual(snapshot.totals.inputTokens, 0);
			strictEqual(snapshot.totals.outputTokens, 0);
			strictEqual(snapshot.totals.totalTokens, 100);
		});
	});
});
