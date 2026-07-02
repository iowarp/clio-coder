import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runSkillsCommand } from "../../src/cli/skills.js";
import { extractBulletsObject, parseJudgeVerdicts } from "../../src/cli/skills-eval.js";
import { parseSkillEvals } from "../../src/domains/resources/skills/evals.js";

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
		ok(stderr.includes("scenario S9 not found"));
	});

	it("rejects a non-positive --timeout (exit 2)", async () => {
		const { result, stderr } = await captureStderr(() => runSkillsCommand(["eval", "anything", "--timeout", "0"]));
		strictEqual(result, 2);
		ok(stderr.includes("--timeout"));
	});
});
