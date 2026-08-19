import { strictEqual } from "node:assert/strict";
import { hostname } from "node:os";
import { describe, it } from "node:test";
import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunLineage, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const lineage: RunLineage = { parentRunId: null, rootRunId: "ledger-root", attempt: 0, depth: 0 };
// Recovery adjudicates only rows created by this host, so the fixture has to
// claim the real hostname or the abandoned-row pass skips it as someone else's.
const identity = { host: hostname(), user: "test-user", hpc: null };

/** A pid no live process owns, so recovery treats the row's worker as gone. */
function deadPid(): number {
	for (let candidate = 40_000; candidate < 60_000; candidate += 1) {
		try {
			process.kill(candidate, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("no free pid found for the abandoned-row fixture");
}

function receiptDraft(runId: string, startedAt: string, endedAt: string): RunReceiptDraft {
	return {
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId,
		agentId: "coder",
		executionRole: "builder",
		task: "ledger concurrency task",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 3,
		inputTokenCount: 2,
		outputTokenCount: 1,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		promptSignature: "prompt-signature",
		toolSignature: "tool-signature",
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		toolActivity: { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false },
		reproducibility: {
			cwd: "/tmp/ledger-concurrency",
			git: { branch: null, commit: null, dirty: null, dirtyEntries: null, statusHash: null },
			safetyPolicy: {
				version: 1,
				rulePackHash: null,
				rulePackVersion: null,
				projectPolicyPath: null,
				projectPolicyHash: null,
				projectPolicyValid: null,
			},
		},
		sessionId: null,
	};
}

function createRun(ledger: ReturnType<typeof openLedger>) {
	return ledger.create({
		agentId: "coder",
		executionRole: "builder",
		task: "ledger concurrency task",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/ledger-concurrency",
	});
}

describe("dispatch run ledger under concurrent processes", () => {
	it("does not let a sibling's stale snapshot revert a settled row", async () => {
		const isolated = await isolateClioEnv("clio-ledger-concurrency-");
		try {
			// Process A creates and publishes the run.
			const a = openLedger({ maxRuns: 20 });
			const run = createRun(a);
			a.update(run.id, { status: "running", pid: process.pid });
			await a.persist();

			// Process B opens the ledger now, so its mirror holds A's row as running.
			const b = openLedger({ maxRuns: 20 });
			strictEqual(b.get(run.id)?.status, "running");

			// A settles the run and publishes the terminal row.
			a.update(run.id, {
				status: "completed",
				outcome: "succeeded",
				outcomeDetail: null,
				endedAt: "2026-07-10T12:00:01.000Z",
				exitCode: 0,
			});
			await a.persist();

			// B now persists work of its own. Its mirror still says "running" for A's
			// row, and before the dirty-id fix that snapshot overwrote A's settlement.
			const ownRun = createRun(b);
			b.update(ownRun.id, { status: "running", pid: process.pid });
			await b.persist();

			const reopened = openLedger({ maxRuns: 20 });
			const settled = reopened.get(run.id);
			strictEqual(settled?.status, "completed");
			strictEqual(settled?.exitCode, 0);
			strictEqual(settled?.endedAt, "2026-07-10T12:00:01.000Z");
			// B's own row still lands, so the narrower merge did not cost a write.
			strictEqual(reopened.get(ownRun.id)?.status, "running");
		} finally {
			isolated.restore();
		}
	});

	it("does not resurrect a row a sibling evicted from the ring", async () => {
		const isolated = await isolateClioEnv("clio-ledger-eviction-");
		try {
			const a = openLedger({ maxRuns: 20 });
			const evicted = createRun(a);
			a.update(evicted.id, {
				status: "completed",
				startedAt: "2026-07-10T12:00:00.000Z",
				endedAt: "2026-07-10T12:00:01.000Z",
				exitCode: 0,
			});
			await a.persist();

			// B reads the row, then A drops it by capping the ring at a smaller size.
			const b = openLedger({ maxRuns: 20 });
			strictEqual(b.get(evicted.id)?.status, "completed");
			const capped = openLedger({ maxRuns: 1 });
			const newer = createRun(capped);
			capped.update(newer.id, {
				status: "completed",
				startedAt: "2026-07-10T12:00:01.000Z",
				endedAt: "2026-07-10T12:00:02.000Z",
				exitCode: 0,
			});
			await capped.persist();
			strictEqual(openLedger({ maxRuns: 20 }).get(evicted.id), null);

			// B persisting must not write the evicted row back from its stale mirror.
			await b.persist();
			strictEqual(openLedger({ maxRuns: 20 }).get(evicted.id), null);
		} finally {
			isolated.restore();
		}
	});
});

describe("orphan recovery of an abandoned row that has a receipt", () => {
	it("seals the row from its own verified receipt instead of stamping it dead", async () => {
		const isolated = await isolateClioEnv("clio-ledger-seal-");
		try {
			const ledger = openLedger({ maxRuns: 20 });
			const run = createRun(ledger);
			const endedAt = "2026-07-10T12:00:01.000Z";
			ledger.update(run.id, {
				status: "completed",
				outcome: "succeeded",
				outcomeDetail: null,
				lineage,
				identity,
				endedAt,
				exitCode: 0,
				tokenCount: 3,
				inputTokenCount: 2,
				outputTokenCount: 1,
				cacheReadTokenCount: 0,
				cacheWriteTokenCount: 0,
				reasoningTokenCount: 0,
				promptSignature: "prompt-signature",
				toolSignature: "tool-signature",
				costUsd: 0,
			});
			ledger.recordReceipt(run.id, receiptDraft(run.id, run.startedAt, endedAt));

			// Reproduce the wild failure: the receipt is sealed on disk, but the row
			// was reverted to running by a sibling's persist and its worker is gone.
			ledger.update(run.id, {
				status: "running",
				endedAt: null,
				exitCode: null,
				receiptPath: null,
				pid: deadPid(),
			});
			await ledger.persist();

			const reopened = openLedger({ maxRuns: 20 });
			const summary = recoverOrphanReceipts(reopened);
			strictEqual(summary.sealed, 1);
			strictEqual(summary.abandoned, 0);
			strictEqual(summary.recovered, 0);
			const row = reopened.get(run.id);
			strictEqual(row?.status, "completed");
			strictEqual(row?.outcome, "succeeded");
			strictEqual(row?.exitCode, 0);
			strictEqual(row?.endedAt, endedAt);
			strictEqual(row?.tokenCount, 3);
		} finally {
			isolated.restore();
		}
	});

	it("still closes an abandoned row that has no receipt to seal", async () => {
		const isolated = await isolateClioEnv("clio-ledger-stalled-");
		try {
			const ledger = openLedger({ maxRuns: 20 });
			const run = createRun(ledger);
			ledger.update(run.id, { status: "running", pid: deadPid() });

			const summary = recoverOrphanReceipts(ledger);
			strictEqual(summary.abandoned, 1);
			strictEqual(summary.sealed, 0);
			const row = ledger.get(run.id);
			strictEqual(row?.status, "dead");
			strictEqual(row?.outcome, "stalled");
			strictEqual(row?.exitCode, 1);
		} finally {
			isolated.restore();
		}
	});
});
