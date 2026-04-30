import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type EvalRunArtifact,
	type EvalTask,
	type LoadedEvalTaskFile,
	parseEvalTaskFileYaml,
	renderEvalReport,
	runEvalTasks,
} from "../../src/domains/eval/index.js";

let scratch = "";

describe("eval task files and runner", () => {
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-eval-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("parses valid task files", () => {
		const result = parseEvalTaskFileYaml(`
version: 1
tasks:
  - id: example-fix
    prompt: "Fix the failing test."
    cwd: "."
    setup:
      - "npm ci"
    verifier:
      - "npm run test"
    timeoutMs: 600000
    tags:
      - "typescript"
      - "unit"
`);

		strictEqual(result.valid, true);
		if (!result.valid) throw new Error("expected valid task file");
		deepStrictEqual(result.taskFile.tasks, [
			{
				id: "example-fix",
				prompt: "Fix the failing test.",
				cwd: ".",
				setup: ["npm ci"],
				verifier: ["npm run test"],
				timeoutMs: 600000,
				tags: ["typescript", "unit"],
			},
		]);
	});

	it("reports invalid task-file diagnostics", () => {
		const result = parseEvalTaskFileYaml(`
version: 1
tasks:
  - id: bad task
    prompt: ""
    cwd: "/tmp"
    verifier: []
    timeoutMs: 0
    unexpected: true
`);

		strictEqual(result.valid, false);
		if (result.valid) throw new Error("expected invalid task file");
		deepStrictEqual(
			result.issues.map((issue) => `${issue.path}: ${issue.message}`),
			[
				"$.tasks[0].unexpected: unknown field",
				"$.tasks[0].id: expected id with letters, numbers, dots, underscores, or hyphens",
				"$.tasks[0].prompt: expected non-empty string",
				"$.tasks[0].cwd: expected repo-local relative path",
				"$.tasks[0].verifier: expected at least one command",
				"$.tasks[0].timeoutMs: expected positive integer",
			],
		);
	});

	it("preserves deterministic task and repeat ordering", async () => {
		const artifact = await runEvalTasks({
			loadedTaskFile: loadedTaskFile([
				task({ id: "b-task", verifier: ["true"] }),
				task({ id: "a-task", verifier: ["true"] }),
			]),
			repeat: 2,
			evalId: "eval-fixed",
			now: fixedNow,
		});

		deepStrictEqual(
			artifact.results.map((result) => result.runId),
			["eval-fixed-b-task-001", "eval-fixed-a-task-001", "eval-fixed-b-task-002", "eval-fixed-a-task-002"],
		);
	});

	it("records a pass result for successful verifier commands", async () => {
		const artifact = await runEvalTasks({
			loadedTaskFile: loadedTaskFile([task({ id: "passes", setup: ["true"], verifier: ["true"] })]),
			repeat: 1,
			evalId: "eval-pass",
			now: fixedNow,
		});

		const result = artifact.results[0];
		strictEqual(result?.pass, true);
		strictEqual(result?.exitCode, 0);
		strictEqual(result?.tokens, 0);
		strictEqual(result?.costUsd, 0);
		strictEqual(result?.failureClass, undefined);
		strictEqual(artifact.summary.passed, 1);
		strictEqual(artifact.summary.failed, 0);
	});

	it("records a fail result and failure class for failing verifier commands", async () => {
		const artifact = await runEvalTasks({
			loadedTaskFile: loadedTaskFile([task({ id: "fails", verifier: ["false"] })]),
			repeat: 1,
			evalId: "eval-fail",
			now: fixedNow,
		});

		const result = artifact.results[0];
		strictEqual(result?.pass, false);
		strictEqual(result?.exitCode, 1);
		strictEqual(result?.failureClass, "verifier_failed");
		deepStrictEqual(artifact.summary.failureClasses, [{ failureClass: "verifier_failed", count: 1 }]);
	});

	it("renders stable report output", () => {
		const artifact: EvalRunArtifact = {
			version: 1,
			evalId: "eval-fixed",
			taskFile: "/repo/tasks.yaml",
			taskFileHash: "a".repeat(64),
			repeat: 1,
			startedAt: "2026-04-29T00:00:00.000Z",
			endedAt: "2026-04-29T00:00:01.000Z",
			summary: {
				runs: 2,
				passed: 1,
				failed: 1,
				passRate: 0.5,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 123,
				failureClasses: [{ failureClass: "verifier_failed", count: 1 }],
			},
			results: [
				{
					taskId: "task-a",
					runId: "eval-fixed-task-a-001",
					repeatIndex: 0,
					cwd: "/repo",
					prompt: "Run verifier.",
					tags: [],
					pass: true,
					exitCode: 0,
					tokens: 0,
					costUsd: 0,
					wallTimeMs: 123,
					evidenceId: "eval-eval-fixed",
					commands: [],
				},
			],
		};

		strictEqual(
			renderEvalReport(artifact, "/data/evals/eval-fixed.json"),
			[
				"eval: eval-fixed",
				"task file: /repo/tasks.yaml",
				"artifact: /data/evals/eval-fixed.json",
				"evidence: eval-eval-fixed",
				"repeat: 1",
				"runs: 2",
				"passed: 1",
				"failed: 1",
				"pass rate: 50.00%",
				"tokens: 0",
				"cost USD: 0.000000",
				"wall time ms: 123",
				"failure classes: verifier_failed=1",
				"",
			].join("\n"),
		);
		match(
			renderEvalReport({ ...artifact, summary: { ...artifact.summary, failureClasses: [] } }),
			/failure classes: none/,
		);
	});
});

function task(overrides: Partial<EvalTask> = {}): EvalTask {
	return {
		id: "task",
		prompt: "Run verifier.",
		cwd: ".",
		setup: [],
		verifier: ["true"],
		timeoutMs: 10_000,
		tags: [],
		...overrides,
	};
}

function loadedTaskFile(tasks: EvalTask[]): LoadedEvalTaskFile {
	return {
		path: join(scratch, "tasks.yaml"),
		baseDir: scratch,
		contentHash: "b".repeat(64),
		taskFile: { version: 1, tasks },
	};
}

function fixedNow(): Date {
	return new Date("2026-04-29T00:00:00.000Z");
}
