import { match, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "benchmarks", "community-benchmarks", "scicode", "scicode_clio.py");
const PYTHON = process.env.PYTHON ?? "python3";

function runPython(args: string[], cwd = REPO_ROOT): string {
	return execFileSync(PYTHON, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

describe("contracts/SciCode Clio adapter", () => {
	let scratch: string;
	let data: string;
	let refs: string;
	let runDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-scicode-adapter-"));
		data = join(scratch, "problems.jsonl");
		refs = join(scratch, "targets.json");
		runDir = join(scratch, "run");
		writeFileSync(
			data,
			`${JSON.stringify({
				problem_name: "fixture",
				problem_id: "1",
				problem_description_main: "Implement a tiny deterministic function.",
				problem_io: "Input: x. Output: x + 1.",
				required_dependencies: "",
				sub_steps: [
					{
						step_number: "1.1",
						step_description_prompt: "Write add_one.",
						function_header: "def add_one(x):\n    '''Return x plus one.'''",
						test_cases: ["assert add_one(1) == target", "assert add_one(-1) == target"],
						return_line: "    return out",
					},
				],
				general_tests: [],
			})}\n`,
			"utf8",
		);
		writeFileSync(
			refs,
			`${JSON.stringify({
				version: 1,
				problems: {
					"1": {
						steps: {
							"1.1": [{ expr: "2" }, { expr: "0" }],
						},
					},
				},
			})}\n`,
			"utf8",
		);
		mkdirSync(join(runDir, "generated_code"), { recursive: true });
		writeFileSync(join(runDir, "generated_code", "1.1.py"), "def add_one(x):\n    return x + 1\n", "utf8");
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("inspects data, generates clio eval tasks, and grades a JSON-reference fixture", () => {
		const inspected = JSON.parse(runPython(["inspect-data", "--data", data, "--references", refs])) as {
			problems: number;
			sub_steps: number;
			step_tests: number;
			faithful_scoring_ready: boolean;
		};
		strictEqual(inspected.problems, 1);
		strictEqual(inspected.sub_steps, 1);
		strictEqual(inspected.step_tests, 2);
		strictEqual(inspected.faithful_scoring_ready, true);

		const taskFile = join(scratch, "scicode-tasks.yaml");
		runPython([
			"generate-tasks",
			"--data",
			data,
			"--references",
			refs,
			"--out",
			taskFile,
			"--run-root",
			join(scratch, "runs"),
			"--limit",
			"1",
		]);
		const taskYaml = readFileSync(taskFile, "utf8");
		match(taskYaml, /id: scicode-1/);
		match(taskYaml, /run-problem/);
		match(taskYaml, /grade-problem/);

		const step = JSON.parse(
			runPython([
				"grade-step",
				"--data",
				data,
				"--references",
				refs,
				"--problem-id",
				"1",
				"--step-number",
				"1.1",
				"--run",
				runDir,
			]),
		) as { status: string; pass: boolean };
		strictEqual(step.status, "pass");
		strictEqual(step.pass, true);

		const problem = JSON.parse(
			runPython(["grade-problem", "--data", data, "--references", refs, "--problem-id", "1", "--run", runDir]),
		) as { main_pass: boolean; passed_steps: number; blocked_steps: number };
		strictEqual(problem.main_pass, true);
		strictEqual(problem.passed_steps, 1);
		strictEqual(problem.blocked_steps, 0);
	});

	it("marks grading blocked when no target artifact is supplied", () => {
		const result = spawnSync(PYTHON, [SCRIPT, "grade-problem", "--data", data, "--problem-id", "1", "--run", runDir], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		strictEqual(result.status, 2);
		const parsed = JSON.parse(result.stdout) as {
			main_pass: boolean;
			blocked_steps: number;
			results: Array<{ status: string }>;
		};
		strictEqual(parsed.main_pass, false);
		strictEqual(parsed.blocked_steps, 1);
		strictEqual(parsed.results[0]?.status, "blocked");
	});
});
