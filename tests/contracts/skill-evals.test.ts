import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runSkillsCommand } from "../../src/cli/skills.js";
import {
	armRunArgs,
	type CapturedRun,
	evalChildEnv,
	extractBulletsObject,
	materializeSkillEvalWorkspaces,
	parseJudgeVerdicts,
	parseRunStdout,
	permissionWallReason,
	resolveSkillBaseDir,
} from "../../src/cli/skills-eval.js";
import {
	HEADLESS_PERMISSION_DENIED_MARKER,
	HEADLESS_PERMISSION_DENIED_REASON,
} from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { parseSkillEvals } from "../../src/domains/resources/skills/evals.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { NO_NETWORK_TOOLS_ENV } from "../../src/tools/network-policy.js";
import { createRegistry } from "../../src/tools/registry.js";
import {
	closeServer,
	seedOpenAICompatFleetDefault,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome, runCli, seedDoctorFix } from "../harness/spawn.js";

const scratchRoots: string[] = [];

// Wrapped in its own describe so the top-level beforeEach/afterEach below
// scope to this file's suites, not the whole process, under
// --experimental-test-isolation=none (every file shares one root test
// context there, so an unscoped top-level hook runs around every test in
// every file).
describe("contracts/skill-evals", () => {
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

	/** Every function-tool name the recorded chat requests advertised, deduped. */
	function toolNamesInRequests(requests: ReadonlyArray<Record<string, unknown>>): string[] {
		const names = new Set<string>();
		for (const request of requests) {
			const tools = Array.isArray(request.tools) ? request.tools : [];
			for (const tool of tools) {
				const fn = (tool as { function?: { name?: unknown } }).function;
				if (typeof fn?.name === "string") names.add(fn.name);
			}
		}
		return [...names];
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
			// would silently turn `clio-coder skills eval` into a no-op.
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
				"TOOL artifact args={...}",
				"TERMINAL artifact content:",
				'{"bullets":[{"index":1,"pass":false,"reason":"gap"},{"index":2,"pass":true,"reason":"ok"}]}',
			].join("\n");
			const bullets = parseJudgeVerdicts(scenario, judgeRun("", transcript));
			deepStrictEqual(
				bullets.map((bullet) => bullet.verdict),
				["fail", "pass"],
			);
		});

		it("marks bullets the judge omitted as unmeasured, never silently passing them", () => {
			const bullets = parseJudgeVerdicts(scenario, judgeRun('{"bullets":[{"index":1,"pass":true,"reason":"ok"}]}'));
			strictEqual(bullets[0]?.verdict, "pass");
			strictEqual(bullets[1]?.verdict, "unmeasured");
			ok(bullets[1]?.reason.includes("omitted this bullet"));
			ok(bullets[1]?.reason.includes("not scored"));
		});

		// A judge that produced no verdict measured nothing. Scoring that as a
		// verdict reported the skill as broken when what broke was the judge run.
		it("marks every bullet unmeasured when the judge output has no parseable verdict", () => {
			const bullets = parseJudgeVerdicts(scenario, judgeRun("I could not decide.", "ASSISTANT: nothing useful"));
			deepStrictEqual(
				bullets.map((bullet) => bullet.verdict),
				["unmeasured", "unmeasured"],
			);
			for (const bullet of bullets) {
				ok(bullet.reason.includes("no parseable verdict object"), bullet.reason);
				ok(bullet.reason.includes("not scored"), bullet.reason);
				ok(!/\bfail/i.test(bullet.reason), bullet.reason);
			}
		});

		it("names truncation as the cause when the verdict object is cut off mid-object", () => {
			// The observed 30B failure: the response opens the object and the turn
			// ends before the closing brace.
			const truncated = '{"bullets":[{"index":1,"pass":true,"reason":"the treatment transcript shows the ski';
			const bullets = parseJudgeVerdicts(scenario, judgeRun(truncated));
			deepStrictEqual(
				bullets.map((bullet) => bullet.verdict),
				["unmeasured", "unmeasured"],
			);
			ok(bullets[0]?.reason.includes("truncated"), bullets[0]?.reason);
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
			ok(stderr.includes("usage: clio-coder skills eval"));
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

		it("materializes byte-equivalent disjoint arms and an empty judge workspace", async () => {
			const seed = mkdtempSync(join(tmpdir(), "clio-skill-eval-seed-contract-"));
			scratchRoots.push(seed);
			mkdirSync(join(seed, "nested"));
			writeFileSync(join(seed, "marker.txt"), "ready\n", "utf8");
			writeFileSync(join(seed, "nested", "input.txt"), "input\n", "utf8");

			const workspaces = await materializeSkillEvalWorkspaces(seed);
			try {
				ok(workspaces.baseline !== workspaces.treatment);
				ok(workspaces.baseline !== workspaces.judge);
				ok(workspaces.treatment !== workspaces.judge);
				deepStrictEqual(readdirSync(workspaces.baseline, { recursive: true }), [
					"marker.txt",
					"nested",
					"nested/input.txt",
				]);
				deepStrictEqual(readdirSync(workspaces.treatment, { recursive: true }), [
					"marker.txt",
					"nested",
					"nested/input.txt",
				]);
				strictEqual(readFileSync(join(workspaces.baseline, "marker.txt"), "utf8"), "ready\n");
				strictEqual(readFileSync(join(workspaces.treatment, "marker.txt"), "utf8"), "ready\n");
				strictEqual(readFileSync(join(workspaces.baseline, "nested", "input.txt"), "utf8"), "input\n");
				strictEqual(readFileSync(join(workspaces.treatment, "nested", "input.txt"), "utf8"), "input\n");
				deepStrictEqual(readdirSync(workspaces.judge), []);

				writeFileSync(join(workspaces.baseline, "baseline-only.txt"), "baseline\n", "utf8");
				strictEqual(existsSync(join(workspaces.treatment, "baseline-only.txt")), false);
				strictEqual(existsSync(join(seed, "baseline-only.txt")), false);
			} finally {
				await workspaces.cleanup();
			}
		});

		it("runs fixture commands from an immutable workspace copy before child runs", async () => {
			const scratch = makeScratchHome("clio-skill-eval-fixture-");
			const fixture = await startOpenAICompatFixture(
				'{"bullets":[{"index":1,"pass":true,"reason":"fixture marker observed"}]}',
			);
			try {
				const env = { ...scratch.env, HOME: scratch.dir, CLIO_CODER_TEST_OPENAI_KEY: "sk-test" };
				await seedDoctorFix(scratch.dir);
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
				writeFileSync(join(workspace, "source.txt"), "unchanged\n", "utf8");

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
				strictEqual(existsSync(join(workspace, "marker.txt")), false);
				deepStrictEqual(readdirSync(workspace), ["source.txt"]);
				strictEqual(readFileSync(join(workspace, "source.txt"), "utf8"), "unchanged\n");
				const rows = result.stdout
					.trim()
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as Record<string, unknown>);
				strictEqual(rows.length, 1);
				strictEqual(rows[0]?.verdict, "pass");
				const evalId = rows[0]?.evalId;
				strictEqual(typeof evalId, "string");
				// The id is the artifact filename, so the stamp plus content hash alone
				// would let two same-millisecond workers clobber each other's file.
				ok(/-[0-9a-f]{12}$/.test(evalId as string), `expected a random suffix on the eval id, got ${String(evalId)}`);
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

	describe("contracts/skill evals report an unscored scenario as unmeasured", () => {
		// The observed 30B failure end to end: the judge turn ends mid-object, so no
		// bullet is scored. Before this, every bullet took verdict "error" and the
		// scenario record said pass:false, exitCode:1, failureClass verifier_failed,
		// which is the artifact's way of saying the skill failed its rubric.
		const TRUNCATED_JUDGE = '{"bullets":[{"index":1,"pass":true,"reason":"the treatment transcript shows the ski';

		it("exits 3, tags the record unmeasured, and never calls the skill failed", async () => {
			const scratch = makeScratchHome("clio-skill-eval-unmeasured-");
			const fixture = await startOpenAICompatFixture(TRUNCATED_JUDGE);
			try {
				const env = { ...scratch.env, HOME: scratch.dir, CLIO_CODER_TEST_OPENAI_KEY: "sk-test" };
				await seedDoctorFix(scratch.dir);
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
						"Answer directly.",
						"",
					].join("\n"),
					"utf8",
				);
				writeFileSync(
					join(skillDir, "evals.md"),
					[
						"# Fixture evals",
						"",
						"## S1 - unscored",
						"Setup: answer directly.",
						"Expected:",
						"- Answers directly.",
						"",
					].join("\n"),
					"utf8",
				);

				const args = ["skills", "eval", skillDir, "--scenario", "1", "--target", "mock-chat"];
				const json = await runCli([...args, "--json"], { cwd: scratch.dir, env, timeoutMs: 90_000 });
				// 3, not 1: nothing was measured, so there is no rubric regression to
				// report, and the run is still not a pass.
				strictEqual(json.code, 3, json.stderr);
				const rows = json.stdout
					.trim()
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as Record<string, unknown>);
				strictEqual(rows.length, 1);
				strictEqual(rows[0]?.verdict, "unmeasured");
				ok(String(rows[0]?.reason).includes("truncated"), String(rows[0]?.reason));
				strictEqual(rows[0]?.network, "hermetic");

				const evalId = rows[0]?.evalId;
				strictEqual(typeof evalId, "string");
				const artifact = JSON.parse(readFileSync(join(scratch.dir, "data", "evals", `${evalId}.json`), "utf8")) as {
					results: Array<{ pass: boolean; exitCode: number; failureClass?: string; tags: string[] }>;
				};
				const record = artifact.results[0];
				ok(record);
				strictEqual(record.pass, false);
				strictEqual(record.exitCode, 3);
				strictEqual(record.failureClass, undefined);
				ok(record.tags.includes("scenario:unmeasured"), record.tags.join(", "));
				ok(record.tags.includes("bullet-1:unmeasured"), record.tags.join(", "));

				const human = await runCli(args, { cwd: scratch.dir, env, timeoutMs: 90_000 });
				strictEqual(human.code, 3, human.stderr);
				ok(human.stdout.includes("unmeasured"), human.stdout);
				ok(human.stdout.includes("1 unmeasured"), human.stdout);
				ok(human.stdout.includes("not evidence about the skill"), human.stdout);
				ok(human.stdout.includes("network: hermetic"), human.stdout);
				ok(!/\bfail(ed|s)?\b/i.test(human.stdout), human.stdout);
				// The policy the verdicts were measured under, stated before the first
				// arm and again in the tail: autonomy beside network, both times.
				ok(human.stderr.includes("policy: autonomy full-auto"), human.stderr);
				ok(human.stdout.includes("ran at autonomy full-auto"), human.stdout);
				strictEqual(rows[0]?.autonomy, "full-auto");
			} finally {
				await closeServer(fixture.server);
				scratch.cleanup();
			}
		});
	});

	describe("contracts/skill evals run their acting arms unattended", () => {
		// F3 of the 3b sweep: the arms carried no --autonomy flag, so they ran at the
		// settings default auto-edit, every git call in both arms came back "clio-coder run
		// cannot confirm permission requests", and the harness printed 0/4 with exit
		// 1. The same skill, model and target at full-auto completed the whole
		// workflow. HARNESS-NOTES.md item 4 carries the operator approval.
		function capturedRun(transcript: string): CapturedRun {
			return {
				sessionId: "s1",
				transcript,
				finalText: "",
				exitCode: 0,
				timedOut: false,
				wallTimeMs: 1,
				stderr: "",
			};
		}

		it("passes full-auto to the acting arms and not to the judge", () => {
			const baseline = armRunArgs("baseline", "do the task", { target: "mini" });
			deepStrictEqual(baseline, [
				"run",
				"--json",
				"--json-events",
				"full",
				"--no-skills",
				"--autonomy",
				"full-auto",
				"--target",
				"mini",
				"do the task",
			]);

			const treatment = armRunArgs("treatment", "/skill demo do the task", {
				target: "mini",
				skillBaseDir: "/skills/demo",
			});
			ok(treatment.includes("--autonomy"));
			strictEqual(treatment[treatment.indexOf("--autonomy") + 1], "full-auto");
			strictEqual(treatment[treatment.indexOf("--skill") + 1], "/skills/demo");

			// The judge scores text and is told to call no tools; unattended write and
			// exec would buy it nothing.
			strictEqual(armRunArgs("judge", "score this").includes("--autonomy"), false);

			// No --target flag at all when none was named, rather than an empty id.
			strictEqual(armRunArgs("baseline", "task").includes("--target"), false);
		});

		it("recognizes the harness's own permission wall in an arm transcript", () => {
			// The recognizer matches the clause the orchestrator writes, so the two
			// cannot drift apart silently.
			ok(HEADLESS_PERMISSION_DENIED_REASON.startsWith(HEADLESS_PERMISSION_DENIED_MARKER));

			const walled = capturedRun(
				[
					'TOOL bash args={"command":"git status"}',
					`RESULT bash error: ${HEADLESS_PERMISSION_DENIED_REASON}`,
					'TOOL bash args={"command":"git diff"}',
					`RESULT bash error: ${HEADLESS_PERMISSION_DENIED_REASON}`,
				].join("\n"),
			);
			const reason = permissionWallReason("treatment", walled);
			ok(reason !== null);
			ok(reason.includes("treatment arm"), reason);
			ok(reason.includes("2 time(s)"), reason);
			ok(reason.includes("not the skill"), reason);

			strictEqual(permissionWallReason("baseline", capturedRun("RESULT bash ok: nothing to commit")), null);
		});

		it("reads a walled arm as unmeasured infra, never as a failed bullet", async () => {
			// End to end: an arm whose transcript shows the wall exits 3 with the
			// truncated-judge vocabulary, and the judge run is never spent on it.
			const scratch = makeScratchHome("clio-skill-eval-walled-");
			const fixture = await startOpenAICompatFixture(HEADLESS_PERMISSION_DENIED_REASON);
			try {
				const env = { ...scratch.env, HOME: scratch.dir, CLIO_CODER_TEST_OPENAI_KEY: "sk-test" };
				await seedDoctorFix(scratch.dir);
				seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
				const skillDir = join(scratch.dir, "walled-skill");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					["---", 'name: "walled-skill"', 'description: "Fixture skill for eval contracts."', "---", "", "Act.", ""].join(
						"\n",
					),
					"utf8",
				);
				writeFileSync(
					join(skillDir, "evals.md"),
					[
						"# Fixture evals",
						"",
						"## S1 - walled",
						"Setup: commit the work.",
						"Expected:",
						"- Creates one commit.",
						"",
					].join("\n"),
					"utf8",
				);

				const args = ["skills", "eval", skillDir, "--scenario", "1", "--target", "mock-chat"];
				const human = await runCli(args, { cwd: scratch.dir, env, timeoutMs: 90_000 });
				strictEqual(human.code, 3, human.stderr);
				ok(human.stdout.includes("unmeasured"), human.stdout);
				ok(human.stdout.includes("infra error"), human.stdout);
				ok(human.stdout.includes("headless permission wall"), human.stdout);
				ok(human.stdout.includes("not evidence about the skill"), human.stdout);
				ok(!/\bfail(ed|s)?\b/i.test(human.stdout), human.stdout);
			} finally {
				await closeServer(fixture.server);
				scratch.cleanup();
			}
		});
	});

	describe("contracts/skill evals select the copy an activation would select", () => {
		function writeSkill(dir: string, name: string, marker: string): void {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				["---", `name: ${name}`, `description: ${marker}`, "---", "", marker, ""].join("\n"),
				"utf8",
			);
			writeFileSync(
				join(dir, "evals.md"),
				["## S1 - a scenario", "", `Setup: ${marker}`, "", "Expected:", "- it works", ""].join("\n"),
				"utf8",
			);
		}

		it("prefers an installed skill over a same-named catalog entry", () => {
			const scratch = mkdtempSync(join(tmpdir(), "clio-eval-select-"));
			scratchRoots.push(scratch);
			const workspace = join(scratch, "repo");
			// Same name in two places. The catalog is what a bare name used to
			// resolve to, so the eval measured an artifact the agent would never
			// load and said nothing about which copy it ran.
			writeSkill(join(workspace, "skills", "review"), "review", "THE CATALOG COPY");
			writeSkill(join(workspace, ".clio-coder", "skills", "review"), "review", "THE INSTALLED COPY");

			const resolved = resolveSkillBaseDir("review", workspace);
			strictEqual(resolved.baseDir, join(workspace, ".clio-coder", "skills", "review"));
			strictEqual(resolved.origin, "clio/project");
			ok(readFileSync(join(String(resolved.baseDir), "SKILL.md"), "utf8").includes("THE INSTALLED COPY"));
		});

		it("still resolves a catalog skill no root installed", () => {
			const scratch = mkdtempSync(join(tmpdir(), "clio-eval-select-"));
			scratchRoots.push(scratch);
			const workspace = join(scratch, "repo");
			// The skill author's case in this repository: skills/ is a catalog, not
			// a discovery root, so nothing installs these names.
			writeSkill(join(workspace, "skills", "authoring"), "authoring", "THE CATALOG COPY");
			writeFileSync(join(workspace, "skills", "registry.yaml"), "skills: []\n", "utf8");

			const resolved = resolveSkillBaseDir("authoring", workspace);
			strictEqual(resolved.origin, "catalog");
			ok(readFileSync(join(String(resolved.baseDir), "SKILL.md"), "utf8").includes("THE CATALOG COPY"));
		});
	});

	describe("contracts/skill evals run hermetic", () => {
		function allowReadSafety() {
			return {
				classify: () => ({ actionClass: "read" as const, reasons: [] }),
				evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
				observeLoop: () => ({ looping: false, key: "test", count: 0 }),
				scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
				isSubset: () => true,
				audit: { recordCount: () => 0 },
			};
		}

		function registerWithEnv(value: string | undefined): ReturnType<typeof createRegistry> {
			const previous = process.env[NO_NETWORK_TOOLS_ENV];
			if (value === undefined) Reflect.deleteProperty(process.env, NO_NETWORK_TOOLS_ENV);
			else process.env[NO_NETWORK_TOOLS_ENV] = value;
			try {
				const registry = createRegistry({ safety: allowReadSafety() });
				registerAllTools(registry);
				return registry;
			} finally {
				if (previous === undefined) Reflect.deleteProperty(process.env, NO_NETWORK_TOOLS_ENV);
				else process.env[NO_NETWORK_TOOLS_ENV] = previous;
			}
		}

		it("registers no network plane in a hermetic process, and the surface invariants still hold", () => {
			// Registration is the lever: an unregistered name is not a tool the model
			// is offered and can be refused, it is a tool that does not exist for
			// this run.
			const hermetic = registerWithEnv("1");
			strictEqual(hermetic.listRegistered().includes(ToolNames.WebFetch), false);
			ok(hermetic.listRegistered().includes(ToolNames.Read));

			const normal = registerWithEnv(undefined);
			strictEqual(normal.listRegistered().includes(ToolNames.WebFetch), true);
		});

		it("sets the hermetic switch on arm child runs and clears it for --allow-network", () => {
			const hermetic = evalChildEnv(false, { PATH: "/usr/bin" });
			strictEqual(hermetic[NO_NETWORK_TOOLS_ENV], "1");
			strictEqual(hermetic.PATH, "/usr/bin");

			// An ambient setting must not survive the explicit flag, or the run would
			// report network as allowed while the child stripped it anyway.
			const allowed = evalChildEnv(true, { PATH: "/usr/bin", [NO_NETWORK_TOOLS_ENV]: "1" });
			strictEqual(Object.hasOwn(allowed, NO_NETWORK_TOOLS_ENV), false);

			// The harness must not mutate its own environment while building a child's.
			const source = { PATH: "/usr/bin" };
			evalChildEnv(false, source);
			strictEqual(Object.hasOwn(source, NO_NETWORK_TOOLS_ENV), false);
		});

		it("keeps web_fetch out of the tool schemas a hermetic child run sends to the model", async () => {
			const scratch = makeScratchHome("clio-eval-hermetic-");
			const fixture = await startOpenAICompatFixture("done");
			try {
				const env = { ...scratch.env, HOME: scratch.dir, CLIO_CODER_TEST_OPENAI_KEY: "sk-test" };
				await seedDoctorFix(scratch.dir);
				const configDir = join(scratch.dir, "config");
				seedOpenAICompatOrchestrator(configDir, fixture.url);
				// The orchestrator seeder alone declares no tool capability, so the run
				// would send no tool schemas at all and prove nothing either way.
				seedOpenAICompatFleetDefault(configDir);

				const args = ["run", "--target", "mock-chat", "--no-skills", "say hi"];
				const allowed = await runCli(args, { cwd: scratch.dir, env, timeoutMs: 60_000 });
				strictEqual(allowed.code, 0, allowed.stderr);
				const allowedTools = toolNamesInRequests(fixture.requests.splice(0));
				ok(allowedTools.includes(ToolNames.Read), `tool schemas: ${allowedTools.join(", ")}`);
				ok(allowedTools.includes(ToolNames.WebFetch), `tool schemas: ${allowedTools.join(", ")}`);

				const hermetic = await runCli(args, {
					cwd: scratch.dir,
					env: { ...env, [NO_NETWORK_TOOLS_ENV]: "1" },
					timeoutMs: 60_000,
				});
				strictEqual(hermetic.code, 0, hermetic.stderr);
				const hermeticTools = toolNamesInRequests(fixture.requests.splice(0));
				ok(hermeticTools.includes(ToolNames.Read), `tool schemas: ${hermeticTools.join(", ")}`);
				strictEqual(hermeticTools.includes(ToolNames.WebFetch), false, `tool schemas: ${hermeticTools.join(", ")}`);
			} finally {
				await closeServer(fixture.server);
				scratch.cleanup();
			}
		});
	});

	describe("contracts/skill evals judge grounding", () => {
		// The judge scores the treatment transcript. When that transcript carried
		// the SKILL.md body verbatim (the result of context(scope="skills",
		// name=...)), a 30B judge passed bullets by quoting the instructions the
		// model had read rather than the behavior it had produced.
		function events(lines: ReadonlyArray<Record<string, unknown>>): string {
			return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		}

		it("withholds the loaded skill body from the transcript while keeping the load visible", () => {
			const body = "SECRET-SKILL-BODY: always stage explicit paths and never push.";
			const parsed = parseRunStdout(
				events([
					{ type: "tool_execution_start", toolCallId: "c1", toolName: "context", args: { scope: "skills", name: "demo" } },
					{ type: "tool_execution_end", toolCallId: "c1", toolName: "context", result: body },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
				]),
			);
			ok(!parsed.transcript.includes("SECRET-SKILL-BODY"), `transcript=${parsed.transcript}`);
			ok(parsed.transcript.includes("skill body withheld"), `transcript=${parsed.transcript}`);
			// The call itself must survive: "did it load the skill" is a real bullet.
			ok(parsed.transcript.includes("TOOL context"), `transcript=${parsed.transcript}`);
		});

		it("keeps every other tool result, including a skills listing that carries no body", () => {
			const parsed = parseRunStdout(
				events([
					{ type: "tool_execution_start", toolCallId: "c1", toolName: "context", args: { scope: "skills" } },
					{ type: "tool_execution_end", toolCallId: "c1", toolName: "context", result: "demo, other" },
					{ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "a.txt" } },
					{ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: "FILE-CONTENT" },
				]),
			);
			ok(parsed.transcript.includes("demo, other"), `transcript=${parsed.transcript}`);
			ok(parsed.transcript.includes("FILE-CONTENT"), `transcript=${parsed.transcript}`);
			ok(!parsed.transcript.includes("withheld"), `transcript=${parsed.transcript}`);
		});

		it("reassembles assistant text from the full stream's deltas", () => {
			const parsed = parseRunStdout(
				events([
					{ type: "text_delta", contentIndex: 0, delta: '{"bullets":[' },
					{ type: "text_delta", contentIndex: 0, delta: '{"index":1,"pass":true}]}' },
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", streamed: true, textLength: 37 }],
						},
					},
				]),
			);
			strictEqual(parsed.finalText, '{"bullets":[{"index":1,"pass":true}]}');
			strictEqual(parsed.transcript, 'ASSISTANT: {"bullets":[{"index":1,"pass":true}]}');
		});
	});
});
