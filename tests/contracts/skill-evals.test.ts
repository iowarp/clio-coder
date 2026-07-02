import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runSkillsCommand } from "../../src/cli/skills.js";
import { extractBulletsObject, parseJudgeVerdicts } from "../../src/cli/skills-eval.js";
import { parseSkillEvals } from "../../src/domains/resources/skills/evals.js";
import {
	closeServer,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchSkillDir(options: { evals?: string } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "clio-skill-evals-"));
	scratchRoots.push(root);
	const dir = join(root, "fixture-skill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		["---", 'name: "fixture-skill"', 'description: "Fixture skill for eval contracts."', "---", "", "Body.", ""].join(
			"\n",
		),
		"utf8",
	);
	if (options.evals !== undefined) writeFileSync(join(dir, "evals.md"), options.evals, "utf8");
	return dir;
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stderr };
	} finally {
		process.stderr.write = original;
	}
}

describe("contracts/skill-evals parser", () => {
	it("parses well-formed scenario blocks with wrapped bullets", () => {
		const parsed = parseSkillEvals(
			[
				"# Evals - fixture",
				"",
				"Intro prose that is not a scenario.",
				"",
				"## S1 - first scenario",
				"",
				"Setup: a project with a failing test.",
				'Prompt: "fix it".',
				"",
				"Expected:",
				"",
				"- First bullet on one line.",
				"- Second bullet wraps onto the",
				"  next line and stays one bullet.",
				"",
				"## S2: colon separator",
				"Setup: another project.",
				"Expected:",
				"- Only bullet.",
				"",
				"## Baseline failure modes to watch for (RED)",
				"",
				"- This section is prose, not a scenario.",
				"",
			].join("\n"),
		);
		strictEqual(parsed.diagnostics.length, 0);
		strictEqual(parsed.scenarios.length, 2);
		const s1 = parsed.scenarios[0];
		ok(s1);
		strictEqual(s1.id, "S1");
		strictEqual(s1.title, "first scenario");
		strictEqual(s1.setup, 'a project with a failing test. Prompt: "fix it".');
		deepStrictEqual(s1.expected, [
			"First bullet on one line.",
			"Second bullet wraps onto the next line and stays one bullet.",
		]);
		strictEqual(parsed.scenarios[1]?.expected.length, 1);
	});

	it("tolerates en/em dash heading separators used by older evals files", () => {
		const parsed = parseSkillEvals("## S1 — em dash\nSetup: x.\nExpected:\n- Bullet.\n");
		strictEqual(parsed.scenarios.length, 1);
		strictEqual(parsed.scenarios[0]?.title, "em dash");
	});

	it("parses optional fenced fixture commands without changing prose-only scenarios", () => {
		const parsed = parseSkillEvals(
			[
				"## S1 - fixture",
				"Setup: read the generated input file.",
				"Fixture:",
				"```bash",
				"mkdir -p src",
				"printf 'ready\\n' > src/input.txt",
				"```",
				"Expected:",
				"- Mentions the generated file.",
				"",
				"## S2 - prose only",
				"Setup: answer directly.",
				"Expected:",
				"- Answers directly.",
				"",
			].join("\n"),
		);
		strictEqual(parsed.diagnostics.length, 0);
		strictEqual(parsed.scenarios.length, 2);
		strictEqual(parsed.scenarios[0]?.fixtureCommands, "mkdir -p src\nprintf 'ready\\n' > src/input.txt");
		strictEqual(parsed.scenarios[1]?.fixtureCommands, undefined);
	});

	it("skips scenario-shaped blocks missing Setup or Expected with a diagnostic each", () => {
		const parsed = parseSkillEvals(
			[
				"## S1 - no setup",
				"Expected:",
				"- A bullet.",
				"",
				"## S2 - no expected",
				"Setup: something.",
				"",
				"## S3 - complete",
				"Setup: fine.",
				"Expected:",
				"- Works.",
				"",
			].join("\n"),
		);
		strictEqual(parsed.scenarios.length, 1);
		strictEqual(parsed.scenarios[0]?.id, "S3");
		strictEqual(parsed.diagnostics.length, 2);
		ok(parsed.diagnostics[0]?.includes("S1"));
		ok(parsed.diagnostics[1]?.includes("S2"));
	});

	it("returns empty results for empty or scenario-free input", () => {
		deepStrictEqual(parseSkillEvals(""), { scenarios: [], diagnostics: [] });
		deepStrictEqual(parseSkillEvals("# Just prose\n\nNothing here.\n"), { scenarios: [], diagnostics: [] });
	});

	it("parses every catalog skill's evals.md into at least one scenario", () => {
		// The catalog is the production input; a parser that regresses against it
		// would silently turn `clio skills eval` into a no-op.
		const catalog = join(process.cwd(), "skills");
		for (const entry of readdirSync(catalog, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const evalsPath = join(catalog, entry.name, "evals.md");
			if (!existsSync(evalsPath)) continue;
			const parsed = parseSkillEvals(readFileSync(evalsPath, "utf8"));
			ok(parsed.scenarios.length > 0, `${entry.name}/evals.md parsed no scenarios`);
		}
	});
});

describe("contracts/skill-evals judge parsing", () => {
	const scenario = {
		id: "S1",
		number: 1,
		title: "fixture",
		setup: "a fixture setup",
		expected: ["First expectation.", "Second expectation."],
	};

	function judgeRun(finalText: string, transcript = ""): Parameters<typeof parseJudgeVerdicts>[1] {
		return { sessionId: null, transcript, finalText, exitCode: 0, timedOut: false, wallTimeMs: 1, stderr: "" };
	}

	it("scores bullets from strict JSON in the judge's final text", () => {
		const bullets = parseJudgeVerdicts(
			scenario,
			judgeRun('{"bullets":[{"index":1,"pass":true,"reason":"seen"},{"index":2,"pass":false,"reason":"absent"}]}'),
		);
		deepStrictEqual(
			bullets.map((bullet) => bullet.verdict),
			["pass", "fail"],
		);
		strictEqual(bullets[1]?.reason, "absent");
	});

	it("tolerates prose and code fences around the verdict object", () => {
		const text = [
			"Here is my assessment:",
			"```json",
			'{"bullets":[{"index":1,"pass":true,"reason":"ok"},{"index":2,"pass":true,"reason":"ok"}]}',
			"```",
			"Hope that helps.",
		].join("\n");
		const bullets = parseJudgeVerdicts(scenario, judgeRun(text));
		deepStrictEqual(
			bullets.map((bullet) => bullet.verdict),
			["pass", "pass"],
		);
	});

	it("falls back to the transcript when the final text has no verdict (terminating-tool turns)", () => {
		const transcript = [
			"TOOL write_review args={...}",
			"TERMINAL write_review content:",
			'{"bullets":[{"index":1,"pass":false,"reason":"gap"},{"index":2,"pass":true,"reason":"ok"}]}',
		].join("\n");
		const bullets = parseJudgeVerdicts(scenario, judgeRun("", transcript));
		deepStrictEqual(
			bullets.map((bullet) => bullet.verdict),
			["fail", "pass"],
		);
	});

	it("marks bullets the judge omitted as error, never silently passing them", () => {
		const bullets = parseJudgeVerdicts(scenario, judgeRun('{"bullets":[{"index":1,"pass":true,"reason":"ok"}]}'));
		strictEqual(bullets[0]?.verdict, "pass");
		strictEqual(bullets[1]?.verdict, "error");
		ok(bullets[1]?.reason.includes("missing"));
	});

	it("marks every bullet error when the judge output has no parseable verdict", () => {
		const bullets = parseJudgeVerdicts(scenario, judgeRun("I could not decide.", "ASSISTANT: nothing useful"));
		deepStrictEqual(
			bullets.map((bullet) => bullet.verdict),
			["error", "error"],
		);
	});

	it("extracts the bullets object from nested and prefixed braces", () => {
		const nested = extractBulletsObject('prefix {"a":{"b":1}} {"note":"x","bullets":[{"index":1,"pass":true}]}');
		ok(nested);
		ok(Array.isArray(nested.bullets));
		strictEqual(extractBulletsObject("no json here"), null);
		strictEqual(extractBulletsObject('{"bullets": "not an array"}'), null);
	});
});

describe("contracts/skill-evals CLI argument contract", () => {
	it("rejects eval without a skill name (exit 2)", async () => {
		const { result, stderr } = await captureStderr(() => runSkillsCommand(["eval"]));
		strictEqual(result, 2);
		ok(stderr.includes("usage: clio skills eval"));
	});

	it("rejects an unknown skill name before any run (exit 2)", async () => {
		const { result, stderr } = await captureStderr(() => runSkillsCommand(["eval", "no-such-skill-xyz"]));
		strictEqual(result, 2);
		ok(stderr.includes("skill not found"));
	});

	it("rejects a skill without evals.md before any run (exit 2)", async () => {
		const dir = scratchSkillDir();
		const { result, stderr } = await captureStderr(() => runSkillsCommand(["eval", dir]));
		strictEqual(result, 2);
		ok(stderr.includes("no evals.md"));
	});

	it("rejects an unknown --scenario id before any run (exit 2)", async () => {
		const dir = scratchSkillDir({ evals: "## S1 - only\nSetup: x.\nExpected:\n- Bullet.\n" });
		const { result, stderr } = await captureStderr(() => runSkillsCommand(["eval", dir, "--scenario", "9"]));
		strictEqual(result, 2);
		ok(stderr.includes("scenario 9 not found"));
		ok(stderr.includes("have: S1"));
	});

	it("selects a scenario by full letter-prefixed id (exit 2 when absent)", async () => {
		const dir = scratchSkillDir({ evals: "## D1 - discipline\nSetup: x.\nExpected:\n- Bullet.\n" });
		const missing = await captureStderr(() => runSkillsCommand(["eval", dir, "--scenario", "S1"]));
		strictEqual(missing.result, 2);
		ok(missing.stderr.includes("scenario S1 not found"));
		ok(missing.stderr.includes("have: D1"));
		const invalid = await captureStderr(() => runSkillsCommand(["eval", dir, "--scenario", "S1x"]));
		strictEqual(invalid.result, 2);
		ok(invalid.stderr.includes('invalid --scenario "S1x"'));
	});

	it("rejects a non-positive --timeout (exit 2)", async () => {
		const { result, stderr } = await captureStderr(() => runSkillsCommand(["eval", "anything", "--timeout", "0"]));
		strictEqual(result, 2);
		ok(stderr.includes("--timeout"));
	});

	it("runs fixture commands in the scenario workspace before child runs", async () => {
		const scratch = makeScratchHome("clio-skill-eval-fixture-");
		const fixture = await startOpenAICompatFixture(
			'{"bullets":[{"index":1,"pass":true,"reason":"fixture marker observed"}]}',
		);
		try {
			const env = { ...scratch.env, HOME: scratch.dir, CLIO_TEST_OPENAI_KEY: "sk-test" };
			const doctor = await runCli(["doctor", "--fix"], { cwd: scratch.dir, env, timeoutMs: 30_000 });
			strictEqual(doctor.code, 0, doctor.stderr);
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const skillDir = join(scratch.dir, "fixture-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					'name: "fixture-skill"',
					'description: "Fixture skill for eval contracts."',
					"---",
					"",
					"Report the marker file status.",
					"",
				].join("\n"),
				"utf8",
			);
			writeFileSync(
				join(skillDir, "evals.md"),
				[
					"# Fixture evals",
					"",
					"## S1 - materialized workspace",
					"Setup: inspect marker.txt and report whether it exists.",
					"Fixture:",
					"```bash",
					"printf 'ready\\n' > marker.txt",
					"```",
					"Expected:",
					"- The treatment transcript has evidence that marker.txt was available.",
					"",
				].join("\n"),
				"utf8",
			);
			const workspace = join(scratch.dir, "workspace");
			mkdirSync(workspace);

			// Fixtures are third-party shell: without the explicit opt-in they
			// must not execute, and the scenario reports the refusal.
			const untrusted = await runCli(
				["skills", "eval", skillDir, "--scenario", "1", "--workspace", workspace, "--target", "mock-chat", "--json"],
				{ cwd: scratch.dir, env, timeoutMs: 90_000 },
			);
			strictEqual(untrusted.code, 1, untrusted.stderr);
			strictEqual(existsSync(join(workspace, "marker.txt")), false);
			ok(untrusted.stdout.includes("--trust-fixtures"));

			const result = await runCli(
				[
					"skills",
					"eval",
					skillDir,
					"--scenario",
					"1",
					"--workspace",
					workspace,
					"--target",
					"mock-chat",
					"--trust-fixtures",
					"--json",
				],
				{ cwd: scratch.dir, env, timeoutMs: 90_000 },
			);
			strictEqual(result.code, 0, result.stderr);
			strictEqual(readFileSync(join(workspace, "marker.txt"), "utf8"), "ready\n");
			const rows = result.stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			strictEqual(rows.length, 1);
			strictEqual(rows[0]?.verdict, "pass");
			const evalId = rows[0]?.evalId;
			strictEqual(typeof evalId, "string");
			const artifact = JSON.parse(readFileSync(join(scratch.dir, "data", "evals", `${evalId}.json`), "utf8")) as {
				summary: { tokens: number; harness: { receiptCount: number } };
				results: Array<{ tokens: number; harness: { receiptCount: number } }>;
			};
			ok(artifact.summary.tokens > 0);
			ok(artifact.summary.harness.receiptCount >= 3);
			ok((artifact.results[0]?.tokens ?? 0) > 0);
			ok((artifact.results[0]?.harness.receiptCount ?? 0) >= 3);
		} finally {
			await closeServer(fixture.server);
			scratch.cleanup();
		}
	});
});
