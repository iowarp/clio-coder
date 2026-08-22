import { match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const COMMUNITY = join(REPO_ROOT, "benchmarks", "community");
const SWEBENCH = join(COMMUNITY, "swe-bench-lite", "swebench_clio.py");
const HUMANEVAL = join(COMMUNITY, "human-eval", "humaneval_clio.py");
const SCICODE = join(COMMUNITY, "scicode", "scicode_clio.py");
const PYTHON = process.env.PYTHON ?? "python3";

describe("contracts/community adapter target selection", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-community-targets-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("rejects every model-running entry point without an explicit target before Clio or data access", () => {
		const marker = join(scratch, "clio-was-called");
		const fakeClio = join(scratch, "fake-clio");
		writeFileSync(fakeClio, `#!/bin/sh\ntouch "$CLIO_CODER_TEST_MARKER"\n`, "utf8");
		chmodSync(fakeClio, 0o755);
		const missingData = join(scratch, "data-that-does-not-exist.jsonl");
		const cases: Array<{ name: string; script: string; args: string[] }> = [
			{
				name: "SWE-bench",
				script: SWEBENCH,
				args: ["--instances-file", missingData, "--out", join(scratch, "swe-out")],
			},
			{
				name: "HumanEval direct suite",
				script: HUMANEVAL,
				args: ["run", "--data", missingData, "--limit", "1", "--out", join(scratch, "human-suite")],
			},
			{
				name: "HumanEval task",
				script: HUMANEVAL,
				args: ["run-task", "--data", missingData, "--task-id", "HumanEval/0", "--out", join(scratch, "human-task")],
			},
			{
				name: "HumanEval task generator",
				script: HUMANEVAL,
				args: ["generate-tasks", "--data", missingData, "--limit", "1", "--out", join(scratch, "human.yaml")],
			},
			{
				name: "SciCode problem",
				script: SCICODE,
				args: ["run-problem", "--data", missingData, "--problem-id", "1", "--out", join(scratch, "science-run")],
			},
			{
				name: "SciCode task generator",
				script: SCICODE,
				args: ["generate-tasks", "--data", missingData, "--limit", "1", "--out", join(scratch, "science.yaml")],
			},
		];

		for (const testCase of cases) {
			const result = spawnSync(PYTHON, [testCase.script, ...testCase.args], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					CLIO_CODER_BIN: fakeClio,
					CLIO_CODER_MAIN_TARGET: "inherited-default-must-not-be-used",
					CLIO_CODER_TEST_MARKER: marker,
					SCICODE_DATA_DIR: join(scratch, "absent-scicode-data"),
				},
			});
			strictEqual(result.status, 2, `${testCase.name}: ${result.stderr}`);
			match(result.stderr, /--target/, testCase.name);
			strictEqual(existsSync(marker), false, `${testCase.name} invoked Clio`);
		}
	});

	it("carries an explicit HumanEval target and model override into generated eval commands", () => {
		const data = join(scratch, "HumanEval.jsonl");
		writeFileSync(
			data,
			`${JSON.stringify({
				task_id: "HumanEval/0",
				prompt: "def add_one(x):\n    ",
				entry_point: "add_one",
				canonical_solution: "    return x + 1\n",
				test: "def check(candidate):\n    assert candidate(1) == 2\n",
			})}\n`,
			"utf8",
		);
		const taskFile = join(scratch, "humaneval.yaml");
		const result = spawnSync(
			PYTHON,
			[
				HUMANEVAL,
				"generate-tasks",
				"--data",
				data,
				"--limit",
				"1",
				"--out",
				taskFile,
				"--target",
				"fixture-target",
				"--model",
				"fixture-model",
			],
			{ cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env } },
		);
		strictEqual(result.status, 0, result.stderr);
		const taskYaml = readFileSync(taskFile, "utf8");
		match(taskYaml, /--target fixture-target/);
		match(taskYaml, /--model fixture-model/);
	});

	it("keeps an explicit dry run target-free because it cannot start a model run", () => {
		const data = join(scratch, "HumanEval.jsonl");
		writeFileSync(
			data,
			`${JSON.stringify({
				task_id: "HumanEval/0",
				prompt: "def add_one(x):\n    ",
				entry_point: "add_one",
				canonical_solution: "    return x + 1\n",
				test: "def check(candidate):\n    assert candidate(1) == 2\n",
			})}\n`,
			"utf8",
		);
		const result = spawnSync(
			PYTHON,
			[HUMANEVAL, "run-task", "--data", data, "--task-id", "HumanEval/0", "--out", join(scratch, "dry-run"), "--dry-run"],
			{ cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, CLIO_CODER_BIN: "/bin/true" } },
		);
		strictEqual(result.status, 0, result.stderr);
	});
});
