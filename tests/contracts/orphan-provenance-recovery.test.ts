import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type {
	RunGateProvenance,
	RunLineage,
	RunPlanProvenance,
	RunReceipt,
	RunReceiptDraft,
} from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const lineage: RunLineage = { parentRunId: null, rootRunId: "orphan-root", attempt: 0, depth: 0 };
const identity = { host: "test-host", user: "test-user", hpc: null };
const gate: RunGateProvenance = {
	role: "reviewer",
	group: "orphan-review",
	cycle: 1,
	subjects: [{ runId: "builder-receipt", digest: "a".repeat(64) }],
};
const plan: RunPlanProvenance = {
	hash: "b".repeat(64),
	topology: "review",
	taskCount: 2,
	approval: "operator",
	approvalRequestId: "apr-orphan",
	approvalRequestedBy: "operator-test",
	costCeilingUsd: 5,
};

function sealOrphan(provenance: { gate?: RunGateProvenance; plan?: RunPlanProvenance }): {
	runId: string;
	receiptPath: string;
} {
	const ledger = openLedger({ maxRuns: 20 });
	const envelope = ledger.create({
		agentId: "coder",
		task: "orphan provenance task",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/orphan-project",
	});
	const endedAt = "2026-07-10T12:00:01.000Z";
	ledger.update(envelope.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		...(provenance.gate !== undefined ? { gate: provenance.gate } : {}),
		...(provenance.plan !== undefined ? { plan: provenance.plan } : {}),
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
	const draft: RunReceiptDraft = {
		runId: envelope.id,
		agentId: "coder",
		task: "orphan provenance task",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage,
		identity,
		...(provenance.gate !== undefined ? { gate: provenance.gate } : {}),
		...(provenance.plan !== undefined ? { plan: provenance.plan } : {}),
		startedAt: envelope.startedAt,
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
			cwd: "/tmp/orphan-project",
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
	ledger.recordReceipt(envelope.id, draft);
	const receiptPath = ledger.get(envelope.id)?.receiptPath;
	if (receiptPath === null || receiptPath === undefined) throw new Error("orphan receipt path missing");
	return { runId: envelope.id, receiptPath };
}

describe("orphan provenance recovery", () => {
	it("adopts gate-only, plan-only, and combined v4 receipts from the receipt-written crash window", () => {
		const isolated = isolateClioEnv("clio-orphan-matrix-");
		try {
			const gateOnly = sealOrphan({ gate });
			const planOnly = sealOrphan({ plan });
			const combined = sealOrphan({ gate, plan });
			const reopened = openLedger({ maxRuns: 20 });
			const summary = recoverOrphanReceipts(reopened);
			strictEqual(summary.recovered, 3);
			strictEqual(summary.corrupt, 0);
			deepStrictEqual(reopened.get(gateOnly.runId)?.gate, gate);
			strictEqual(reopened.get(gateOnly.runId)?.plan, undefined);
			deepStrictEqual(reopened.get(planOnly.runId)?.plan, plan);
			strictEqual(reopened.get(planOnly.runId)?.gate, undefined);
			deepStrictEqual(reopened.get(combined.runId)?.gate, gate);
			deepStrictEqual(reopened.get(combined.runId)?.plan, plan);
		} finally {
			isolated.restore();
		}
	});

	it("quarantines a shape-valid v4 orphan whose authenticated provenance was tampered", () => {
		const isolated = isolateClioEnv("clio-orphan-tamper-");
		try {
			const orphan = sealOrphan({ gate, plan });
			const receipt = JSON.parse(readFileSync(orphan.receiptPath, "utf8")) as Record<string, unknown>;
			receipt.plan = { ...plan, taskCount: 99 };
			writeFileSync(orphan.receiptPath, JSON.stringify(receipt, null, 2));
			const reopened = openLedger({ maxRuns: 20 });
			const summary = recoverOrphanReceipts(reopened);
			strictEqual(summary.recovered, 0);
			strictEqual(summary.corrupt, 1);
			strictEqual(reopened.get(orphan.runId), null);
			ok(existsSync(`${orphan.receiptPath}.corrupt`));
		} finally {
			isolated.restore();
		}
	});

	it("quarantines an orphan sealed under a retired integrity version", () => {
		const isolated = isolateClioEnv("clio-orphan-retired-version-");
		try {
			const orphan = sealOrphan({ gate, plan });
			const receipt = JSON.parse(readFileSync(orphan.receiptPath, "utf8")) as RunReceipt;
			receipt.integrity = { ...receipt.integrity, version: 3 } as unknown as RunReceipt["integrity"];
			writeFileSync(orphan.receiptPath, JSON.stringify(receipt, null, 2));

			const reopened = openLedger({ maxRuns: 20 });
			const summary = recoverOrphanReceipts(reopened);
			strictEqual(summary.recovered, 0);
			strictEqual(summary.corrupt, 1);
			strictEqual(reopened.get(orphan.runId), null);
			ok(existsSync(`${orphan.receiptPath}.corrupt`));
		} finally {
			isolated.restore();
		}
	});
});
