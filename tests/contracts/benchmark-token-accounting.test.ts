import { strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SCICODE = join(REPO_ROOT, "benchmarks", "community", "scicode", "scicode_clio.py");
const HUMANEVAL = join(REPO_ROOT, "benchmarks", "community", "human-eval", "humaneval_clio.py");
const PYTHON = process.env.PYTHON ?? "python3";

/**
 * A stand-in for `clio run --json` that emits the events a real headless turn
 * emits: two completed assistant messages plus the republished `turn_end` and
 * `agent_end` forms that must not be counted a second time.
 */
function writeFakeClio(path: string, messageTotals: number[]): void {
	const events = [
		...messageTotals.map((total) =>
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "```python\ndef add_one(x):\n    return x + 1\n```" }],
					usage: { input: total - 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: total },
				},
			}),
		),
		JSON.stringify({
			type: "turn_end",
			message: { role: "assistant", usage: { input: 100, output: 20, totalTokens: 120 } },
		}),
		JSON.stringify({ type: "agent_end", messageCount: messageTotals.length, usage: { totalTokens: 999_999 } }),
	];
	writeFileSync(path, `#!/bin/sh\ncat <<'CLIO_EVENTS'\n${events.join("\n")}\nCLIO_EVENTS\n`, "utf8");
	chmodSync(path, 0o755);
}

function messageEndUsage(stdout: string): Array<Record<string, number>> {
	return stdout.split("\n").flatMap((line) => {
		if (line.trim().length === 0) return [];
		try {
			const event = JSON.parse(line) as { type?: string; message?: { usage?: Record<string, number> } };
			return event.type === "message_end" && event.message?.usage !== undefined ? [event.message.usage] : [];
		} catch {
			return [];
		}
	});
}

describe("contracts/benchmark adapter token accounting", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-bench-usage-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("a SciCode problem republishes its summed sub-step usage on adapter stdout", () => {
		const data = join(scratch, "problems.jsonl");
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
						test_cases: ["assert add_one(1) == target"],
						return_line: "    return out",
					},
					{
						step_number: "1.2",
						step_description_prompt: "Write add_two.",
						function_header: "def add_two(x):\n    '''Return x plus two.'''",
						test_cases: ["assert add_two(1) == target"],
						return_line: "    return out",
					},
				],
				general_tests: [],
			})}\n`,
			"utf8",
		);
		const fakeClio = join(scratch, "fake-clio");
		writeFakeClio(fakeClio, [1_000, 500]);
		const runDir = join(scratch, "run");

		const result = spawnSync(
			PYTHON,
			[SCICODE, "run-problem", "--data", data, "--problem-id", "1", "--out", runDir, "--force"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: { ...process.env, CLIO_BIN: fakeClio, SCICODE_DATA_DIR: join(scratch, "absent") },
			},
		);
		strictEqual(result.status, 0, result.stderr);

		// Two sub-steps, two assistant messages each: republished usage is the
		// sum of the four message_end events and counts no republished form.
		const published = messageEndUsage(result.stdout);
		strictEqual(published.length, 1, "one aggregate usage line per problem");
		strictEqual(published[0]?.totalTokens, 3_000);

		const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as {
			tokens: number | null;
			tokensMeasuredSteps: number;
			tokensTotalSteps: number;
		};
		strictEqual(summary.tokens, 3_000);
		strictEqual(summary.tokensMeasuredSteps, 2);
		strictEqual(summary.tokensTotalSteps, 2);
	});

	it("a SciCode problem whose runs report no usage publishes nothing rather than a zero", () => {
		const data = join(scratch, "problems.jsonl");
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
						test_cases: ["assert add_one(1) == target"],
						return_line: "    return out",
					},
				],
				general_tests: [],
			})}\n`,
			"utf8",
		);
		const silentClio = join(scratch, "silent-clio");
		writeFileSync(silentClio, "#!/bin/sh\necho 'no events here'\n", "utf8");
		chmodSync(silentClio, 0o755);
		const runDir = join(scratch, "run");

		const result = spawnSync(
			PYTHON,
			[SCICODE, "run-problem", "--data", data, "--problem-id", "1", "--out", runDir, "--force"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: { ...process.env, CLIO_BIN: silentClio, SCICODE_DATA_DIR: join(scratch, "absent") },
			},
		);
		strictEqual(result.status, 0, result.stderr);
		strictEqual(messageEndUsage(result.stdout).length, 0, "unobserved usage publishes nothing");

		const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as {
			tokens: number | null;
			tokensMeasuredSteps: number;
		};
		strictEqual(summary.tokens, null, "absent, never zero");
		strictEqual(summary.tokensMeasuredSteps, 0);
	});

	it("a HumanEval attempt republishes its observed usage and records measurement", () => {
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
		const fakeClio = join(scratch, "fake-clio");
		writeFakeClio(fakeClio, [700, 300]);
		const runDir = join(scratch, "run");

		const result = spawnSync(
			PYTHON,
			[HUMANEVAL, "run-task", "--data", data, "--task-id", "HumanEval/0", "--out", runDir, "--force"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: { ...process.env, CLIO_BIN: fakeClio, SCICODE_DATA_DIR: join(scratch, "absent") },
			},
		);
		strictEqual(result.status, 0, result.stderr);

		const published = messageEndUsage(result.stdout);
		strictEqual(published.length, 1);
		strictEqual(published[0]?.totalTokens, 1_000);

		const metrics = JSON.parse(readFileSync(join(runDir, "metrics.jsonl"), "utf8").trim()) as {
			tokens: number;
			tokens_measured: boolean;
		};
		strictEqual(metrics.tokens, 1_000);
		strictEqual(metrics.tokens_measured, true);

		const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as {
			tokens: number | null;
			tokensMeasured: boolean;
		};
		strictEqual(summary.tokens, 1_000);
		strictEqual(summary.tokensMeasured, true);
	});
});
