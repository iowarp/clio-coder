/**
 * `clio-coder fleet status` projection contract: the totals built from the durable
 * ledger must carry the input/output token split the receipts record, both
 * for rows finalized after the ledger learned the split and for pre-split
 * rows whose only source of truth is the receipt artifact (bt-02 finding 2).
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { statusSnapshot } from "../../src/cli/fleet.js";
import { setCapacityDraining } from "../../src/domains/dispatch/capacity-lease.js";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

async function withIsolatedClioHome<T>(fn: (scratch: string) => T | Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const scratch = await newScratchClioHome("clio-fleet-status-");
	return Promise.resolve()
		.then(() => fn(scratch))
		.finally(() => {
			for (const k of Object.keys(process.env)) {
				if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
			}
			for (const [k, v] of Object.entries(originalEnv)) {
				if (v !== undefined) process.env[k] = v;
			}
			clearScratchClioHome(scratch);
		});
}

function completedRow(overrides: Partial<RunEnvelope> & { id: string }): RunEnvelope {
	return {
		agentId: "coder",
		executionRole: "builder",
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
			const stateDir = join(scratch, "state");
			mkdirSync(join(stateDir, "receipts"), { recursive: true });

			// Pre-split row: no input/output on the envelope; the receipt carries it.
			const receiptPath = join(stateDir, "receipts", "oldrow0000001.json");
			writeFileSync(receiptPath, JSON.stringify({ runId: "oldrow0000001", inputTokenCount: 4780, outputTokenCount: 167 }));
			const rows: RunEnvelope[] = [
				completedRow({ id: "newrow0000001", tokenCount: 5575, inputTokenCount: 2606, outputTokenCount: 189 }),
				completedRow({ id: "oldrow0000001", tokenCount: 4947, receiptPath }),
				// Running row from another process: no live meters cross-process.
				completedRow({
					id: "running000001",
					status: "running",
					endedAt: null,
					tokenCount: 0,
					budget: {
						version: 1,
						policy: {
							recipeId: "architect",
							default: { toolCalls: 32, readReserve: 5, synthesis: true },
							maximum: { toolCalls: 150, readReserve: 16 },
							exact: false,
						},
						request: { toolCalls: 64, readReserve: 8 },
						effective: { toolCalls: 64, readReserve: 8, synthesis: true, hardCap: 150 },
						reasons: [],
					},
				}),
			];
			writeFileSync(join(stateDir, "runs.json"), JSON.stringify(rows, null, 2));

			const snapshot = statusSnapshot();
			strictEqual(snapshot.totals.inputTokens, 2606 + 4780);
			strictEqual(snapshot.totals.outputTokens, 189 + 167);
			strictEqual(snapshot.totals.totalTokens, 5575 + 4947);
			deepStrictEqual(snapshot.running[0]?.budget, rows[2]?.budget);
		});
	});

	it("a pre-split row with a missing receipt contributes zero split without failing the snapshot", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const stateDir = join(scratch, "state");
			mkdirSync(stateDir, { recursive: true });
			const rows: RunEnvelope[] = [completedRow({ id: "orphan0000001", tokenCount: 100 })];
			writeFileSync(join(stateDir, "runs.json"), JSON.stringify(rows, null, 2));

			const snapshot = statusSnapshot();
			strictEqual(snapshot.totals.inputTokens, 0);
			strictEqual(snapshot.totals.outputTokens, 0);
			strictEqual(snapshot.totals.totalTokens, 100);
		});
	});

	it("surfaces the durable admission drain as a valid discriminated state", async () => {
		await withIsolatedClioHome(async () => {
			const nowMs = Date.now();
			const drain = setCapacityDraining(true, { nowMs, ttlMs: 60_000 });
			const snapshot = statusSnapshot();
			strictEqual(snapshot.admission.state, "draining");
			if (snapshot.admission.state !== "draining") return;
			strictEqual(snapshot.admission.requestedByPid, process.pid);
			strictEqual(snapshot.admission.requestedAt, drain?.requestedAt);
			strictEqual(snapshot.admission.expiresAt, drain?.expiresAt);
		});
	});
});
