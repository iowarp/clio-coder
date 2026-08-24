import { match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const COMMUNITY = join(REPO_ROOT, "benchmarks", "community");
const SWEBENCH = join(COMMUNITY, "swe-bench-lite", "swebench_clio.py");
const HUMANEVAL = join(COMMUNITY, "human-eval", "humaneval_clio.py");
const SCICODE = join(COMMUNITY, "scicode", "scicode_clio.py");
const DS1000 = join(COMMUNITY, "ds-1000", "ds1000_clio.py");
const LIVECODEBENCH = join(COMMUNITY, "livecodebench", "livecodebench_clio.py");
const BIGCODEBENCH = join(COMMUNITY, "bigcodebench", "bigcodebench_clio.py");
const MULTIPLE = join(COMMUNITY, "multipl-e", "multiple_clio.py");
const SCIENCEAGENTBENCH = join(COMMUNITY, "scienceagentbench", "scienceagentbench_clio.py");
const COREBENCH = join(COMMUNITY, "core-bench", "corebench_clio.py");
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
				name: "SciCode problem",
				script: SCICODE,
				args: ["run-problem", "--data", missingData, "--problem-id", "1", "--out", join(scratch, "science-run")],
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

	it("rejects the added suites' model-running entry points before Clio or data access", () => {
		const marker = join(scratch, "clio-was-called");
		const fakeClio = join(scratch, "fake-clio");
		writeFileSync(fakeClio, `#!/bin/sh\ntouch "$CLIO_CODER_TEST_MARKER"\n`, "utf8");
		chmodSync(fakeClio, 0o755);
		const missingData = join(scratch, "data-that-does-not-exist.jsonl");
		const missingDir = join(scratch, "dir-that-does-not-exist");
		const out = (name: string) => join(scratch, name);
		const cases: Array<{ name: string; script: string; args: string[] }> = [
			{
				name: "DS-1000 suite",
				script: DS1000,
				args: ["run", "--data", missingData, "--limit", "1", "--out", out("ds-suite")],
			},
			{
				name: "DS-1000 task",
				script: DS1000,
				args: ["run-task", "--data", missingData, "--task-id", "0", "--out", out("ds-task")],
			},
			{
				name: "LiveCodeBench suite",
				script: LIVECODEBENCH,
				args: ["run", "--data-dir", missingDir, "--release", "v6", "--limit", "1", "--out", out("lcb-suite")],
			},
			{
				name: "LiveCodeBench task",
				script: LIVECODEBENCH,
				args: ["run-task", "--data-dir", missingDir, "--release", "v6", "--task-id", "1", "--out", out("lcb-task")],
			},
			{
				name: "BigCodeBench suite",
				script: BIGCODEBENCH,
				args: ["run", "--data-dir", missingDir, "--limit", "1", "--out", out("bcb-suite")],
			},
			{
				name: "BigCodeBench task",
				script: BIGCODEBENCH,
				args: ["run-task", "--data-dir", missingDir, "--task-id", "0", "--out", out("bcb-task")],
			},
			{
				name: "MultiPL-E suite",
				script: MULTIPLE,
				args: ["run", "--data-dir", missingDir, "--language", "cpp", "--limit", "1", "--out", out("mpe-suite")],
			},
			{
				name: "MultiPL-E task",
				script: MULTIPLE,
				args: ["run-task", "--data-dir", missingDir, "--language", "cpp", "--task-id", "x", "--out", out("mpe-task")],
			},
			{
				name: "ScienceAgentBench suite",
				script: SCIENCEAGENTBENCH,
				args: ["run", "--data-dir", missingDir, "--limit", "1", "--out", out("sab-suite")],
			},
			{
				name: "ScienceAgentBench task",
				script: SCIENCEAGENTBENCH,
				args: ["run-task", "--data-dir", missingDir, "--task-id", "1", "--out", out("sab-task")],
			},
			{
				name: "CORE-Bench suite",
				script: COREBENCH,
				args: ["run", "--data-dir", missingDir, "--split", "train", "--limit", "1", "--out", out("core-suite")],
			},
			{
				name: "CORE-Bench task",
				script: COREBENCH,
				args: [
					"run-task",
					"--data-dir",
					missingDir,
					"--split",
					"train",
					"--task-id",
					"capsule-0",
					"--out",
					out("core-task"),
				],
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
				},
			});
			strictEqual(result.status, 2, `${testCase.name}: ${result.stderr}`);
			match(result.stderr, /--target/, testCase.name);
			// The target check must fire before the adapter looks at data. A
			// DATA_BLOCKED message here would mean it read the dataset path
			// first and only refused later.
			strictEqual(result.stderr.includes("DATA_BLOCKED"), false, `${testCase.name} reached data access`);
			strictEqual(existsSync(marker), false, `${testCase.name} invoked Clio`);
		}
	});
});
