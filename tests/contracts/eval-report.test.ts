import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderSweJsonl } from "../../src/domains/eval/report.js";
import type { EvalRunArtifact, EvalRunRecord } from "../../src/domains/eval/types.js";

const ZERO_HARNESS = {
	receiptCount: 0,
	toolCalls: 0,
	retries: 0,
	safetyBlocks: 0,
	correctionLatencyMs: 0,
	validationEvidence: 0,
};

function record(input: {
	taskId: string;
	runId: string;
	pass: boolean;
	tokens: number;
	wallTimeMs: number;
	costUsd: number;
	receiptPath?: string;
}): EvalRunRecord {
	return {
		taskId: input.taskId,
		runId: input.runId,
		repeatIndex: 0,
		cwd: "/tmp",
		prompt: `prompt for ${input.taskId}`,
		tags: [],
		pass: input.pass,
		exitCode: input.pass ? 0 : 1,
		tokens: input.tokens,
		costUsd: input.costUsd,
		wallTimeMs: input.wallTimeMs,
		harness: { ...ZERO_HARNESS },
		commands: [],
		...(input.receiptPath === undefined ? {} : { receiptPath: input.receiptPath }),
	};
}

function artifact(results: EvalRunRecord[]): EvalRunArtifact {
	return {
		version: 1,
		evalId: "eval-fixture",
		taskFile: "/tmp/tasks.yaml",
		taskFileHash: "abc123",
		repeat: 1,
		startedAt: "2026-06-14T00:00:00.000Z",
		endedAt: "2026-06-14T00:00:01.000Z",
		summary: {
			runs: results.length,
			passed: results.filter((result) => result.pass).length,
			failed: results.filter((result) => !result.pass).length,
			passRate: results.length === 0 ? 0 : results.filter((result) => result.pass).length / results.length,
			tokens: results.reduce((total, result) => total + result.tokens, 0),
			costUsd: results.reduce((total, result) => total + result.costUsd, 0),
			wallTimeMs: results.reduce((total, result) => total + result.wallTimeMs, 0),
			harness: { ...ZERO_HARNESS },
			failureClasses: [],
		},
		results,
	};
}

describe("contracts/eval SWE JSONL report", () => {
	it("renders parseable JSONL records with metrics and receipt-backed model patches", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-report-"));
		try {
			const patch = "diff --git a/file.txt b/file.txt\n+patched\n";
			const receiptPath = join(root, "run-1.json");
			writeFileSync(receiptPath, JSON.stringify({ model_patch: patch }), "utf8");
			const results = [
				record({ taskId: "task-a", runId: "run-1", pass: true, tokens: 11, wallTimeMs: 101, costUsd: 0.001, receiptPath }),
				record({ taskId: "task-b", runId: "run-2", pass: false, tokens: 17, wallTimeMs: 203, costUsd: 0.002 }),
			];

			const lines = renderSweJsonl(artifact(results))
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);

			strictEqual(lines.length, 2);
			deepStrictEqual(
				lines.map((line) => ({
					instance_id: line.instance_id,
					status: line.status,
					pass: line.pass,
					tokens: line.tokens,
					wall_time_ms: line.wall_time_ms,
					cost_usd: line.cost_usd,
				})),
				[
					{
						instance_id: "task-a",
						status: "pass",
						pass: true,
						tokens: 11,
						wall_time_ms: 101,
						cost_usd: 0.001,
					},
					{
						instance_id: "task-b",
						status: "fail",
						pass: false,
						tokens: 17,
						wall_time_ms: 203,
						cost_usd: 0.002,
					},
				],
			);
			strictEqual(lines[0]?.model_patch, patch);
			strictEqual(lines[1]?.model_patch, "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns an empty string for an artifact with no results", () => {
		strictEqual(renderSweJsonl(artifact([])), "");
	});
});
