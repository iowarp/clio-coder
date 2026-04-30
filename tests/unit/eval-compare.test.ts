import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compareEvalArtifacts,
	type EvalFailureClass,
	type EvalRunArtifact,
	type EvalRunRecord,
	renderEvalComparison,
	summarizeEvalResults,
} from "../../src/domains/eval/index.js";

describe("eval comparison", () => {
	it("summarizes regressions, improvements, unchanged results, missing and added results, and deltas", () => {
		const baseline = artifact("eval-baseline", [
			record("eval-baseline", "z-regresses", 0, true, { tokens: 10, costUsd: 10, wallTimeMs: 100 }),
			record("eval-baseline", "a-improves", 0, false, {
				tokens: 5,
				costUsd: 5,
				wallTimeMs: 50,
				failureClass: "verifier_failed",
			}),
			record("eval-baseline", "same-pass", 1, true, { tokens: 2, costUsd: 2, wallTimeMs: 20 }),
			record("eval-baseline", "same-fail", 0, false, {
				tokens: 3,
				costUsd: 3,
				wallTimeMs: 30,
				failureClass: "setup_failed",
			}),
			record("eval-baseline", "missing-only", 0, false, {
				tokens: 8,
				costUsd: 8,
				wallTimeMs: 80,
				failureClass: "timeout",
			}),
			record("eval-baseline", "class-change", 0, false, {
				tokens: 6,
				costUsd: 6,
				wallTimeMs: 60,
				failureClass: "setup_failed",
			}),
		]);
		const candidate = artifact("eval-candidate", [
			record("eval-candidate", "added-only", 0, true, { tokens: 9, costUsd: 9, wallTimeMs: 90 }),
			record("eval-candidate", "class-change", 0, false, {
				tokens: 7,
				costUsd: 7,
				wallTimeMs: 70,
				failureClass: "timeout",
			}),
			record("eval-candidate", "same-fail", 0, false, {
				tokens: 1,
				costUsd: 1,
				wallTimeMs: 10,
				failureClass: "setup_failed",
			}),
			record("eval-candidate", "same-pass", 1, true, { tokens: 3, costUsd: 3, wallTimeMs: 30 }),
			record("eval-candidate", "a-improves", 0, true, { tokens: 4, costUsd: 4, wallTimeMs: 40 }),
			record("eval-candidate", "z-regresses", 0, false, {
				tokens: 11,
				costUsd: 11,
				wallTimeMs: 110,
				failureClass: "verifier_failed",
			}),
		]);

		const summary = compareEvalArtifacts(baseline, candidate);

		strictEqual(summary.matchingRule, "taskId+repeatIndex");
		strictEqual(summary.matchedCount, 5);
		strictEqual(summary.addedCount, 1);
		strictEqual(summary.missingCount, 1);
		deepStrictEqual(summary.baseline, {
			passed: 2,
			failed: 4,
			passRate: 1 / 3,
			tokens: 34,
			costUsd: 34,
			wallTimeMs: 340,
		});
		deepStrictEqual(summary.candidate, {
			passed: 3,
			failed: 3,
			passRate: 0.5,
			tokens: 35,
			costUsd: 35,
			wallTimeMs: 350,
		});
		deepStrictEqual(summary.deltas, {
			passRate: 0.16666666666666669,
			tokens: 1,
			costUsd: 1,
			wallTimeMs: 10,
		});
		deepStrictEqual(
			summary.regressions.map((change) => change.taskId),
			["z-regresses"],
		);
		deepStrictEqual(
			summary.improvements.map((change) => change.taskId),
			["a-improves"],
		);
		strictEqual(summary.unchangedPassCount, 1);
		strictEqual(summary.unchangedFailCount, 2);
		deepStrictEqual(
			summary.failureClassChanges.map((change) => ({
				taskId: change.taskId,
				baselineFailureClass: change.baselineFailureClass,
				candidateFailureClass: change.candidateFailureClass,
			})),
			[{ taskId: "class-change", baselineFailureClass: "setup_failed", candidateFailureClass: "timeout" }],
		);
		deepStrictEqual(
			summary.added.map((result) => result.taskId),
			["added-only"],
		);
		deepStrictEqual(
			summary.missing.map((result) => result.taskId),
			["missing-only"],
		);
	});

	it("renders deterministic text output ordered by task id and repeat index", () => {
		const baseline = artifact("eval-baseline", [
			record("eval-baseline", "z-regresses", 0, true, { tokens: 10, costUsd: 0.1, wallTimeMs: 100 }),
			record("eval-baseline", "missing-only", 0, false, { failureClass: "timeout" }),
			record("eval-baseline", "same-pass", 1, true),
			record("eval-baseline", "a-improves", 0, false, { failureClass: "verifier_failed" }),
		]);
		const candidate = artifact("eval-candidate", [
			record("eval-candidate", "z-regresses", 0, false, { failureClass: "verifier_failed" }),
			record("eval-candidate", "a-improves", 0, true),
			record("eval-candidate", "same-pass", 1, true),
			record("eval-candidate", "added-only", 0, true),
		]);

		strictEqual(
			renderEvalComparison(compareEvalArtifacts(baseline, candidate)),
			[
				"baseline eval: eval-baseline",
				"candidate eval: eval-candidate",
				"matching: taskId+repeatIndex",
				"matched: 3",
				"added: 1",
				"missing: 1",
				"baseline passed: 2",
				"baseline failed: 2",
				"candidate passed: 3",
				"candidate failed: 1",
				"pass-rate delta: +25.00pp",
				"token delta: -10",
				"cost delta USD: -0.100000",
				"wall-time delta ms: -100",
				"regressions: 1",
				"  task=z-regresses repeat=0 baseline=eval-baseline-z-regresses-001 candidate=eval-candidate-z-regresses-001 failure=none->verifier_failed",
				"fixes/improvements: 1",
				"  task=a-improves repeat=0 baseline=eval-baseline-a-improves-001 candidate=eval-candidate-a-improves-001 failure=verifier_failed->none",
				"unchanged pass: 1",
				"unchanged fail: 0",
				"failure class changes: 0",
				"added results: 1",
				"  task=added-only repeat=0 run=eval-candidate-added-only-001 pass=true failure=none",
				"missing results: 1",
				"  task=missing-only repeat=0 run=eval-baseline-missing-only-001 pass=false failure=timeout",
				"",
			].join("\n"),
		);
	});

	it("rejects duplicate task and repeat identities", () => {
		const baseline = artifact("eval-baseline", [
			record("eval-baseline", "duplicate", 0, true),
			record("eval-baseline", "duplicate", 0, false, { failureClass: "verifier_failed" }),
		]);
		const candidate = artifact("eval-candidate", [record("eval-candidate", "duplicate", 0, true)]);

		throws(
			() => compareEvalArtifacts(baseline, candidate),
			/baseline eval eval-baseline has duplicate result identity: task=duplicate repeat=0/,
		);
	});
});

interface RecordOptions {
	tokens?: number;
	costUsd?: number;
	wallTimeMs?: number;
	failureClass?: EvalFailureClass;
}

function artifact(evalId: string, results: ReadonlyArray<EvalRunRecord>): EvalRunArtifact {
	return {
		version: 1,
		evalId,
		taskFile: "/repo/tasks.yaml",
		taskFileHash: "a".repeat(64),
		repeat: 1,
		startedAt: "2026-04-29T00:00:00.000Z",
		endedAt: "2026-04-29T00:00:01.000Z",
		summary: summarizeEvalResults(results),
		results: [...results],
	};
}

function record(
	evalId: string,
	taskId: string,
	repeatIndex: number,
	pass: boolean,
	options: RecordOptions = {},
): EvalRunRecord {
	const record: EvalRunRecord = {
		taskId,
		runId: `${evalId}-${taskId}-${String(repeatIndex + 1).padStart(3, "0")}`,
		repeatIndex,
		cwd: "/repo",
		prompt: "Run verifier.",
		tags: [],
		pass,
		exitCode: pass ? 0 : 1,
		tokens: options.tokens ?? 0,
		costUsd: options.costUsd ?? 0,
		wallTimeMs: options.wallTimeMs ?? 0,
		commands: [],
	};
	if (options.failureClass !== undefined) record.failureClass = options.failureClass;
	return record;
}
