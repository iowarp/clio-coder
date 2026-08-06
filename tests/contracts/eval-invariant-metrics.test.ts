import { strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { RunOutcome, RunReceipt, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { readRunJournal, receiptInvariantMetrics } from "../../src/domains/eval/metrics/invariants.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

interface SealOptions {
	outcome?: RunOutcome;
	exitCode?: number;
}

/** Seal one genuine, integrity-valid receipt into the isolated state directory. */
async function sealRun(options: SealOptions = {}): Promise<string> {
	const outcome: RunOutcome = options.outcome ?? "succeeded";
	const exitCode = options.exitCode ?? 0;
	const ledger = openLedger({ maxRuns: 20 });
	const envelope = ledger.create({
		agentId: "main-agent",
		executionRole: "builder",
		task: "soak invariant task",
		targetId: "mini",
		wireModelId: "model",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/soak-workspace",
	});
	const lineage = { parentRunId: null, rootRunId: envelope.id, attempt: 0, depth: 0 };
	const endedAt = "2026-08-06T12:00:01.000Z";
	ledger.update(envelope.id, {
		status: outcome === "succeeded" ? "completed" : "failed",
		outcome,
		outcomeDetail: null,
		lineage,
		endedAt,
		exitCode,
		tokenCount: 12,
		inputTokenCount: 8,
		outputTokenCount: 4,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
	});
	const draft: RunReceiptDraft = {
		runId: envelope.id,
		agentId: "main-agent",
		executionRole: "builder",
		task: "soak invariant task",
		targetId: "mini",
		wireModelId: "model",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		outcome,
		outcomeDetail: null,
		lineage,
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "manual",
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
		startedAt: envelope.startedAt,
		endedAt,
		exitCode,
		tokenCount: 12,
		inputTokenCount: 8,
		outputTokenCount: 4,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		sessionId: null,
	};
	ledger.recordReceipt(envelope.id, draft);
	await ledger.persist();
	return envelope.id;
}

function stateDirOf(root: string): string {
	return join(root, "state");
}

function receiptPath(root: string, runId: string): string {
	return join(stateDirOf(root), "receipts", `${runId}.json`);
}

function metricsFor(root: string, processExitCode = 0): Record<string, number | boolean> {
	return receiptInvariantMetrics(readRunJournal(stateDirOf(root)), processExitCode);
}

describe("contracts/eval invariant metrics", { concurrency: false }, () => {
	it("reads a sealed, authenticated, self-consistent run as intact", async () => {
		const isolated = isolateClioEnv("clio-soak-intact-");
		try {
			await sealRun();

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.sealed"], true);
			strictEqual(metrics["receipt.count"], 1);
			strictEqual(metrics["receipt.rootCount"], 1);
			strictEqual(metrics["receipt.integrityValid"], true);
			strictEqual(metrics["receipt.outcomeMatchesExit"], true);
		} finally {
			isolated.restore();
		}
	});

	it("reports an unsealed run as unsealed and judges no seal it does not have", async () => {
		const isolated = isolateClioEnv("clio-soak-unsealed-");
		try {
			// A journal that exists and is empty is an observation: the item ran
			// and sealed nothing. It is not an absence, and it is not success.
			mkdirSync(stateDirOf(isolated.dir), { recursive: true });

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.sealed"], false);
			strictEqual(metrics["receipt.count"], 0);
			strictEqual("receipt.integrityValid" in metrics, false);
			strictEqual("receipt.outcomeMatchesExit" in metrics, false);
		} finally {
			isolated.restore();
		}
	});

	it("leaves every invariant absent when there is no journal to read", () => {
		strictEqual(readRunJournal(join("/nonexistent-soak-state", "state")), null);
		strictEqual(Object.keys(receiptInvariantMetrics(null, 0)).length, 0);
	});

	it("fails receipt.integrityValid when a sealed receipt is edited after sealing", async () => {
		const isolated = isolateClioEnv("clio-soak-tampered-");
		try {
			const runId = await sealRun();
			strictEqual(metricsFor(isolated.dir)["receipt.integrityValid"], true);

			// One field moves and the digest does not. The receipt still parses,
			// still names its run, and no longer authenticates.
			const path = receiptPath(isolated.dir, runId);
			const receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
			receipt.tokenCount = 999_999;
			writeFileSync(path, JSON.stringify(receipt, null, 2), "utf8");

			strictEqual(metricsFor(isolated.dir)["receipt.integrityValid"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.integrityValid when the ledger no longer carries the run the receipt names", async () => {
		const isolated = isolateClioEnv("clio-soak-no-envelope-");
		try {
			await sealRun();
			strictEqual(metricsFor(isolated.dir)["receipt.integrityValid"], true);

			// A receipt with no envelope has no authority to verify against.
			// Unauthenticated is a failure, never an absence.
			writeFileSync(join(stateDirOf(isolated.dir), "runs.json"), "[]", "utf8");

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.sealed"], true);
			strictEqual(metrics["receipt.integrityValid"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.integrityValid when a sealed receipt no longer parses", async () => {
		const isolated = isolateClioEnv("clio-soak-unreadable-");
		try {
			const runId = await sealRun();

			writeFileSync(receiptPath(isolated.dir, runId), "{ truncated", "utf8");

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.count"], 1);
			strictEqual(metrics["receipt.sealed"], true);
			strictEqual(metrics["receipt.integrityValid"], false);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.outcomeMatchesExit when a receipt claims success beside a nonzero exit", async () => {
		const isolated = isolateClioEnv("clio-soak-outcome-drift-");
		try {
			await sealRun({ outcome: "succeeded", exitCode: 3 });

			const metrics = metricsFor(isolated.dir, 3);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("fails receipt.outcomeMatchesExit when the sealed run disagrees with the process exit status", async () => {
		const isolated = isolateClioEnv("clio-soak-process-drift-");
		try {
			// The receipt is internally consistent and integrity-valid. It says the
			// run succeeded; the process it ran in exited nonzero.
			await sealRun({ outcome: "succeeded", exitCode: 0 });
			strictEqual(metricsFor(isolated.dir, 0)["receipt.outcomeMatchesExit"], true);

			const metrics = metricsFor(isolated.dir, 1);
			strictEqual(metrics["receipt.integrityValid"], true);
			strictEqual(metrics["receipt.outcomeMatchesExit"], false);
		} finally {
			isolated.restore();
		}
	});

	it("ignores files that are not receipts and keeps a stray directory out of the count", async () => {
		const isolated = isolateClioEnv("clio-soak-stray-");
		try {
			await sealRun();
			writeFileSync(join(stateDirOf(isolated.dir), "receipts", "notes.txt"), "not a receipt", "utf8");

			const metrics = metricsFor(isolated.dir);
			strictEqual(metrics["receipt.count"], 1);
			strictEqual(metrics["receipt.integrityValid"], true);
		} finally {
			isolated.restore();
		}
	});
});
