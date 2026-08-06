import { strictEqual } from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SCICODE = join(REPO_ROOT, "benchmarks", "community", "scicode", "scicode_clio.py");
const HUMANEVAL = join(REPO_ROOT, "benchmarks", "community", "human-eval", "humaneval_clio.py");
const SWEBENCH = join(REPO_ROOT, "benchmarks", "community", "swe-bench-lite", "swebench_clio.py");
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

	/**
	 * Seed the bare-repo cache the adapter clones from, so the instance
	 * materializes offline and no dataset download is involved.
	 */
	function seedSweBenchInstance(root: string): { instancesFile: string; cacheDir: string } {
		const source = join(root, "source");
		const cacheDir = join(root, "cache");
		mkdirSync(source, { recursive: true });
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(source, "widget.py"), "def add_one(x):\n    return x + 2\n", "utf8");
		const git = (args: string[], cwd: string): string => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
		git(["init", "-q", "."], source);
		git(["add", "-A"], source);
		git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "seed"], source);
		const baseCommit = git(["rev-parse", "HEAD"], source);
		spawnSync("git", ["clone", "-q", "--bare", source, join(cacheDir, "acme__widget.git")], { encoding: "utf8" });
		const instancesFile = join(root, "instances.jsonl");
		writeFileSync(
			instancesFile,
			`${JSON.stringify({
				instance_id: "acme__widget-1",
				repo: "acme/widget",
				base_commit: baseCommit,
				problem_statement: "add_one returns x + 2.",
				patch: "",
			})}\n`,
			"utf8",
		);
		return { instancesFile, cacheDir };
	}

	function runSweBench(root: string, clioBin: string): SpawnSyncReturns<string> {
		const { instancesFile, cacheDir } = seedSweBenchInstance(root);
		return spawnSync(
			PYTHON,
			[SWEBENCH, "--instances-file", instancesFile, "--cache", cacheDir, "--out", join(root, "out")],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				// An isolated state dir is the point: receipt accounting must follow
				// the Clio that just ran, not whatever lives under the real $HOME.
				env: { ...process.env, CLIO_BIN: clioBin, CLIO_STATE_DIR: join(root, "state") },
			},
		);
	}

	it("a SWE-bench instance sums its message_end usage and republishes it once", () => {
		const fakeClio = join(scratch, "fake-clio");
		writeFakeClio(fakeClio, [700, 300]);

		const result = runSweBench(scratch, fakeClio);
		strictEqual(result.status, 0, result.stderr);

		const published = messageEndUsage(result.stdout);
		strictEqual(published.length, 1, "one aggregate usage line per instance");
		// The sum of the two completed messages. A maximum would report 999999
		// from the republished agent_end, and the largest message alone is 700.
		strictEqual(published[0]?.totalTokens, 1_000);

		const metric = JSON.parse(readFileSync(join(scratch, "out", "metrics.jsonl"), "utf8").trim()) as {
			tokens: number;
			tokens_measured: boolean;
		};
		strictEqual(metric.tokens, 1_000);
		strictEqual(metric.tokens_measured, true);

		const summary = JSON.parse(readFileSync(join(scratch, "out", "summary.json"), "utf8")) as {
			tokens: number | null;
			tokensMeasuredInstances: number;
			tokensTotalInstances: number;
		};
		strictEqual(summary.tokens, 1_000);
		strictEqual(summary.tokensMeasuredInstances, 1);
		strictEqual(summary.tokensTotalInstances, 1);
	});

	it("a SWE-bench instance whose run reported no usage publishes nothing rather than a zero", () => {
		const silentClio = join(scratch, "silent-clio");
		writeFileSync(silentClio, "#!/bin/sh\necho 'no events here'\n", "utf8");
		chmodSync(silentClio, 0o755);

		const result = runSweBench(scratch, silentClio);
		strictEqual(result.status, 0, result.stderr);
		strictEqual(messageEndUsage(result.stdout).length, 0, "unobserved usage publishes nothing");

		const metric = JSON.parse(readFileSync(join(scratch, "out", "metrics.jsonl"), "utf8").trim()) as {
			tokens: number | null;
			tokens_measured: boolean;
		};
		strictEqual(metric.tokens, null, "absent, never zero");
		strictEqual(metric.tokens_measured, false);

		const summary = JSON.parse(readFileSync(join(scratch, "out", "summary.json"), "utf8")) as {
			tokens: number | null;
			tokensMeasuredInstances: number;
		};
		strictEqual(summary.tokens, null);
		strictEqual(summary.tokensMeasuredInstances, 0);
	});
});
