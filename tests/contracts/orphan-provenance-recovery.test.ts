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
	RunSteeringProvenance,
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
const briefing = { bytes: 17, contentHash: "c".repeat(64) };
const steering: ReadonlyArray<RunSteeringProvenance> = [
	{
		sequence: 1,
		bytes: 19,
		contentHash: "d".repeat(64),
		sentAt: "2026-07-10T12:00:00.500Z",
		acknowledged: true,
		acknowledgedAt: "2026-07-10T12:00:00.600Z",
	},
];

function sealOrphan(provenance: {
	gate?: RunGateProvenance;
	plan?: RunPlanProvenance;
	steering?: ReadonlyArray<RunSteeringProvenance>;
}): {
	runId: string;
	receiptPath: string;
} {
	const ledger = openLedger({ maxRuns: 20 });
	const envelope = ledger.create({
		agentId: "coder",
		executionRole: "builder",
		task: "orphan provenance task",
		briefing,
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
		outcomeCode: "worker_tool_call_cap_exhausted",
		...(provenance.steering !== undefined ? { steering: provenance.steering } : {}),
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
		verification: { state: "unverified", basis: "no-validation-tool" },
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId: envelope.id,
		agentId: "coder",
		executionRole: "builder",
		task: "orphan provenance task",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeDetail: null,
		outcomeCode: "worker_tool_call_cap_exhausted",
		briefing,
		...(provenance.steering !== undefined ? { steering: provenance.steering } : {}),
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
	it("quarantines a v4 orphan before it can adopt an injected v5-only field", () => {
		const isolated = isolateClioEnv("clio-orphan-v4-injection-");
		try {
			// Let the ledger resolve the repository-scoped state directory, then
			// replace its orphan artifact with a v4 artifact carrying an injected
			// field. The dedicated integrity contract test retains the genuine
			// hard-coded historical digest fixture.
			const orphan = sealOrphan({});
			const runId = orphan.runId;
			const receiptPath = orphan.receiptPath;
			const receipt = {
				runId,
				agentId: "coder",
				executionRole: "builder",
				task: "historical v4",
				targetId: "local",
				wireModelId: "model-a",
				runtimeId: "openai",
				runtimeKind: "http",
				startedAt: "2026-07-01T00:00:00.000Z",
				endedAt: "2026-07-01T00:00:01.000Z",
				outcome: "succeeded",
				outcomeDetail: null,
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
				staticShellHash: null,
				sessionShellHash: null,
				dynamicHash: null,
				clioVersion: "0.2.8",
				piMonoVersion: "0.80.3",
				platform: "linux",
				nodeVersion: "v22.19.0",
				toolCalls: 0,
				toolStats: [],
				reproducibility: {
					cwd: "/workspace",
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
				briefing: null,
				integrity: {
					version: 4,
					algorithm: "sha256",
					digest: "d3d3f9258807a23b0b895bd540aaefe4297bbe4dbbd2cc3ca10997f112ded052",
				},
			};
			writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

			const reopened = openLedger({ maxRuns: 20 });
			const summary = recoverOrphanReceipts(reopened);
			strictEqual(summary.recovered, 0);
			strictEqual(summary.corrupt, 1);
			strictEqual(reopened.get(runId), null);
			ok(existsSync(`${receiptPath}.corrupt`));
		} finally {
			isolated.restore();
		}
	});

	it("adopts gate-only, plan-only, and combined v7 receipts from the receipt-written crash window", () => {
		const isolated = isolateClioEnv("clio-orphan-matrix-");
		try {
			const gateOnly = sealOrphan({ gate });
			const planOnly = sealOrphan({ plan });
			const combined = sealOrphan({ gate, plan, steering });
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
			deepStrictEqual(reopened.get(combined.runId)?.briefing, briefing);
			deepStrictEqual(reopened.get(combined.runId)?.steering, steering);
			strictEqual(reopened.get(combined.runId)?.outcomeCode, "worker_tool_call_cap_exhausted");
		} finally {
			isolated.restore();
		}
	});

	it("quarantines a shape-valid v7 orphan whose authenticated steering provenance was tampered", () => {
		const isolated = isolateClioEnv("clio-orphan-tamper-");
		try {
			const orphan = sealOrphan({ gate, plan, steering });
			const receipt = JSON.parse(readFileSync(orphan.receiptPath, "utf8")) as Record<string, unknown>;
			receipt.steering = [{ ...steering[0], acknowledged: false }];
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
