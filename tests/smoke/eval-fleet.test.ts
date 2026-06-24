import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const ZERO_HARNESS = {
	receiptCount: 0,
	toolCalls: 0,
	retries: 0,
	safetyBlocks: 0,
	correctionLatencyMs: 0,
	validationEvidence: 0,
};

describe("clio eval and fleet smoke tests", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome();
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("eval report renders text and SWE JSONL from a stored artifact", async () => {
		const dataDir = scratch.env.CLIO_DATA_DIR;
		if (dataDir === undefined) throw new Error("scratch CLIO_DATA_DIR missing");
		const stateDir = scratch.env.CLIO_STATE_DIR;
		if (stateDir === undefined) throw new Error("scratch CLIO_STATE_DIR missing");
		const evalDir = join(dataDir, "evals");
		const receiptDir = join(stateDir, "receipts");
		mkdirSync(evalDir, { recursive: true });
		mkdirSync(receiptDir, { recursive: true });
		const receiptPath = join(receiptDir, "eval-smoke-run.json");
		writeFileSync(receiptPath, JSON.stringify({ model_patch: "diff --git a/app.py b/app.py\n+print('ok')\n" }), "utf8");
		writeFileSync(
			join(evalDir, "eval-smoke.json"),
			`${JSON.stringify(
				{
					version: 1,
					evalId: "eval-smoke",
					taskFile: "/tmp/tasks.yaml",
					taskFileHash: "abc123",
					repeat: 1,
					startedAt: "2026-06-24T00:00:00.000Z",
					endedAt: "2026-06-24T00:00:01.000Z",
					summary: {
						runs: 1,
						passed: 1,
						failed: 0,
						passRate: 1,
						tokens: 0,
						costUsd: 0,
						wallTimeMs: 12,
						harness: ZERO_HARNESS,
						failureClasses: [],
					},
					results: [
						{
							taskId: "task-a",
							runId: "eval-smoke-run",
							repeatIndex: 0,
							cwd: "/tmp",
							prompt: "prompt",
							tags: ["smoke"],
							pass: true,
							exitCode: 0,
							tokens: 0,
							costUsd: 0,
							wallTimeMs: 12,
							harness: ZERO_HARNESS,
							commands: [],
							receiptPath,
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const text = await runCli(["eval", "report", "eval-smoke"], { env: scratch.env });
		strictEqual(text.code, 0, `stderr=${text.stderr}`);
		match(text.stdout, /eval: eval-smoke/);
		match(text.stdout, /passed: 1/);

		const jsonl = await runCli(["eval", "report", "eval-smoke", "--format", "swe-jsonl"], { env: scratch.env });
		strictEqual(jsonl.code, 0, `stderr=${jsonl.stderr}`);
		const parsed = JSON.parse(jsonl.stdout) as { instance_id: string; status: string; model_patch: string };
		strictEqual(parsed.instance_id, "task-a");
		strictEqual(parsed.status, "pass");
		match(parsed.model_patch, /diff --git/);
	});

	it("fleet status --json is provider-free and reports an empty ledger", async () => {
		const result = await runCli(["fleet", "status", "--json"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const parsed = JSON.parse(result.stdout) as {
			running: unknown[];
			retrying: unknown[];
			totals: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
		};
		strictEqual(Array.isArray(parsed.running), true);
		strictEqual(Array.isArray(parsed.retrying), true);
		strictEqual(parsed.running.length, 0);
		strictEqual(parsed.retrying.length, 0);
		strictEqual(parsed.totals.inputTokens, 0);
		strictEqual(parsed.totals.outputTokens, 0);
		strictEqual(parsed.totals.totalTokens, 0);
		strictEqual(parsed.totals.costUsd, 0);
	});
});
