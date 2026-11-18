import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { mapExitCode } from "../../src/cli/run.js";
import {
	parseVerifierResult,
	resultContractShape,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import { mergeWithheldDetail, removedTestCases } from "../../src/domains/dispatch/merge-gate.js";
import {
	deriveRunVerification,
	settledVerifyCall,
	typedValidationFactsFromObservedEffects,
	typedValidationFactsFromVerifyCalls,
	type VerifyCallOutcome,
	verifyCallStart,
} from "../../src/domains/dispatch/run-findings.js";
import type { RunResult } from "../../src/domains/dispatch/types.js";
import { groundClaimedValidations } from "../../src/domains/dispatch/validation-grounding.js";
import { type CallVerdict, classifyCall } from "../../src/domains/safety/check-classifier.js";
import { checkOutputReader, createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { clearTaskGates, configureTaskGates } from "../../src/tools/verify/task-gates.js";

/** A run with no workspace mutation, where every check ran on the final tree. */
const unchanged = createRunEffectsRecorder(process.cwd()).checkFreshness();

it("every reader of a verifier report agrees on a closing report, and a second report decides nothing", () => {
	const report = '{"verdict":"pass","checks":[{"name":"make test","passed":true,"evidence":"exit 0"}]}';
	const prose = "calc.c has int sub(int a) { return a; } as planned.";
	const fenced = (text: string) => `\`\`\`json\n${text}\n\`\`\``;
	const closingAnswers = [
		`${prose}\n\n${report}`,
		`\`\`\`c\nint sub(int a) { return a; }\n\`\`\`\n${fenced(report)}`,
		`${prose}\n\n${JSON.stringify(JSON.parse(report), null, 2)}`,
	];
	for (const answer of closingAnswers) {
		strictEqual(parseVerifierResult(answer)?.verdict, "pass", answer);
		// Claim grounding reads the same report, so a claim with no command behind it is not measured.
		strictEqual(
			groundClaimedValidations({
				contractKind: "verifier-report",
				output: answer,
				executedCommands: new Set<string>(),
				executedCheckingCalls: 0,
				readOnly: true,
			})?.grounded,
			0,
			answer,
		);
	}
	strictEqual(parseVerifierResult(`Example:\n${fenced(report)}\n${report.replace("pass", "fail")}`), null);
});
it("blocked-only verify checks seal no typed validation, including unattributed finishes", () => {
	const stats = [{ tool: "verify", count: 1, ok: 0, errors: 0, blocked: 1 }];
	for (const check of ["test", null])
		deepStrictEqual(typedValidationFactsFromVerifyCalls(stats, [{ check, outcome: "blocked" }], unchanged), []);
	deepStrictEqual(typedValidationFactsFromVerifyCalls(stats, [], unchanged), []);
});
it("read-only read claims do not require command evidence, but test claims still do", () => {
	const input = {
		contractKind: "mutation-report" as const,
		executedCommands: new Set<string>(),
		executedCheckingCalls: 0,
		readOnly: true,
	};
	strictEqual(
		groundClaimedValidations({
			...input,
			output: JSON.stringify({ validations: [{ name: "read src/math.ts", passed: true }] }),
		}),
		null,
	);
	strictEqual(
		groundClaimedValidations({ ...input, output: JSON.stringify({ validations: [{ name: "npm test", passed: true }] }) })
			?.grounded,
		0,
	);
	strictEqual(
		groundClaimedValidations({
			...input,
			readOnly: false,
			output: JSON.stringify({ validations: [{ name: "read src/math.ts", passed: true }] }),
		})?.grounded,
		0,
	);
	strictEqual(
		groundClaimedValidations({
			...input,
			readOnly: false,
			output: JSON.stringify({ validations: [{ name: "npm test", passed: true, baseline: true }] }),
		}),
		null,
	);
});
it("mutation reports accept omitted denied checks as an empty array without asserting validation", () => {
	const contract = { kind: "mutation-report" as const };
	const result = validateResultContract({
		contract,
		output: '{"mutatedPaths":[],"validations":[],"summary":"Read the source."}',
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => null },
	});
	strictEqual(result.conformance, "pass");
	strictEqual(result.quality, "unmeasured");
	match(resultContractShape(contract), /Checks that were denied.*declaredChecks/i);
});

it("read-only verifier verdicts and executable path claims still require command grounding", () => {
	for (const [contractKind, name] of [
		["verifier-report", "reviewed src/foo.ts"],
		["mutation-report", "./gradlew"],
		["mutation-report", "scripts/test.sh"],
	] as const) {
		const result = groundClaimedValidations({
			contractKind,
			readOnly: true,
			output: JSON.stringify({ checks: [{ name, passed: true }] }),
			executedCommands: new Set(),
			executedCheckingCalls: 0,
		});
		strictEqual(result?.grounded, 0, name);
		strictEqual(result?.basis, "no-command-executed");
	}
	strictEqual(
		groundClaimedValidations({
			contractKind: "mutation-report",
			readOnly: true,
			output: JSON.stringify({ validations: [{ name: "checked src/math.ts exports add", passed: true }] }),
			executedCommands: new Set(),
			executedCheckingCalls: 0,
		}),
		null,
	);
});
it("successful writes without executed checks conform without claiming validation", () => {
	const recorder = createRunEffectsRecorder(process.cwd());
	recorder.start("write", "write", { path: "src/math.ts" });
	recorder.finish("write", false);
	const output = JSON.stringify({
		mutatedPaths: ["src/math.ts"],
		validations: [],
		observations: ["Read and edited source; this is not a passed check."],
		declaredChecks: ["Run npm test on the host; execution tools unavailable."],
	});
	const result = validateResultContract({
		contract: { kind: "mutation-report" },
		output,
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => null },
		observedRunEffects: recorder.snapshot(),
	});
	strictEqual(result.conformance, "pass");
	strictEqual(result.quality, "unmeasured");
	strictEqual(
		groundClaimedValidations({
			contractKind: "mutation-report",
			output,
			executedCommands: new Set(),
			executedCheckingCalls: 0,
		}),
		null,
	);
});
it("anonymous verify successes are not failed by denied retries", () => {
	const stats = [{ tool: "verify", count: 2, ok: 1, errors: 0, blocked: 1 }];
	for (const calls of [
		[],
		[
			{ check: null, outcome: "ok" as const },
			{ check: null, outcome: "blocked" as const },
		],
	]) {
		deepStrictEqual(
			typedValidationFactsFromVerifyCalls(stats, calls, unchanged).map((fact) => fact.passed),
			[true],
		);
	}
});

it("mutation-report recipes omit denied checks and put source reads in summary", () => {
	for (const recipe of ["coder", "documenter", "git-master"]) {
		const prompt = readFileSync(new URL(`../../src/domains/agents/builtins/${recipe}.md`, import.meta.url), "utf8");
		doesNotMatch(
			prompt,
			/validations.*(?:never empty|nonempty)|inspection evidence as a validation|source read as the check/iu,
		);
		match(prompt, /declaredChecks/iu);
		match(prompt, /source (?:reads|citations).*summary/iu);
	}
});

it("editing reports distinguish lack of measured checks from execution success", () => {
	const cwd = process.cwd();
	for (const outcomes of [
		[],
		[null],
		["blocked"],
		["blocked", "blocked"],
		["blocked", "error"],
		["blocked", "ok"],
	] as const) {
		const recorder = createRunEffectsRecorder(cwd);
		recorder.start("write", "write", { path: "src/math.ts" });
		recorder.finish("write", false);
		outcomes.forEach((outcome, index) => {
			const id = String(index);
			recorder.start(id, "verify", { check: "test" });
			if (outcome !== null) recorder.checkOutcome(id, outcome);
			recorder.finish(id, outcome !== "ok");
		});
		const result = validateResultContract({
			contract: { kind: "mutation-report" },
			output: '{"mutatedPaths":["src/math.ts"],"validations":[]}',
			cwd,
			networkAllowed: false,
			filesystem: { readFile: () => null },
			observedRunEffects: recorder.snapshot(),
		});
		strictEqual(result.conformance, "pass");
		// A red verify on the final tree is an observed failure, as a red bash check is (bt-27).
		strictEqual(result.quality, (outcomes as ReadonlyArray<string | null>).includes("error") ? "fail" : "unmeasured");
	}
});

it("withholds requested validation even when the worker omits declaredChecks", () => {
	const input = {
		quality: "unmeasured",
		hostStatus: undefined,
		contract: { kind: "mutation-report" as const },
		output: '{"validations":[]}',
		branch: "clio-coder/task/check",
		task: "Implement parseDuration. The worker runs npm test and commits.",
		executedCheckingCalls: 0,
	};
	match(mergeWithheldDetail(input) ?? "", /requested validation.*executed no check/u);
	strictEqual(mergeWithheldDetail({ ...input, hostStatus: "verified" }), null);
	strictEqual(mergeWithheldDetail({ ...input, executedCheckingCalls: 1 }), null);
	strictEqual(mergeWithheldDetail({ ...input, task: "Edit the parser." }), null);
	for (const task of [
		"Do not run the tests.",
		"No need to test.",
		"No need to run npm test.",
		"Don't run npm test.",
		"Running the tests is not required.",
		"Never run npm test.",
		"Implement the parser without running tests.",
	]) {
		strictEqual(mergeWithheldDetail({ ...input, task }), null, task);
	}
	match(
		mergeWithheldDetail({ ...input, task: "Do not run the tests, but run lint checks." }) ?? "",
		/requested validation/u,
	);
});

it("withholds a task-named check the worker never ran, though unrelated shell calls succeeded", () => {
	const input = {
		quality: "unmeasured",
		hostStatus: undefined,
		contract: { kind: "mutation-report" as const },
		output: '{"validations":[]}',
		branch: "clio-coder/task/calc",
		task: "Add mul(a,b) to calc.py. Verify the change by running: python3 -B -c 'import calc'",
		executedCheckingCalls: 2,
		executedShellCommands: ["python3 --version", 'echo "hello"'],
	};
	match(mergeWithheldDetail(input) ?? "", /python3 -B -c 'import calc'.*never ran/u);
	strictEqual(mergeWithheldDetail({ ...input, executedShellCommands: ["cd /w && python3 -B -c 'import calc'"] }), null);
	strictEqual(mergeWithheldDetail({ ...input, hostStatus: "verified" }), null);
	strictEqual(
		mergeWithheldDetail({ ...input, task: "Add mul. Run `python3 -B -c 'import calc'` to verify it." }) === null,
		false,
	);
	strictEqual(mergeWithheldDetail({ ...input, task: "Add mul and run the app." }), null);
	match(mergeWithheldDetail({ ...input, task: "Add mul. Verify by running `make check`." }) ?? "", /make check/u);
	for (const task of [
		"Verify the change by running the tests",
		"Test it by running pytest and fix any failures",
		"check it works by running the app",
	]) {
		strictEqual(mergeWithheldDetail({ ...input, task }), null, task);
	}
	// The named command present only as a failed run is not a clean execution.
	const recorder = createRunEffectsRecorder("/w");
	recorder.start("c1", "bash", { command: "python3 -B -c 'import calc'" });
	recorder.checkOutcome("c1", "error");
	recorder.finish("c1", false);
	recorder.start("c2", "bash", { command: "python3 --version" });
	recorder.checkOutcome("c2", "ok");
	recorder.finish("c2", false);
	const ran = recorder.snapshot().executedShellCommands ?? [];
	deepStrictEqual(ran, ["python3 --version"]);
	match(mergeWithheldDetail({ ...input, executedShellCommands: ran }) ?? "", /never ran/u);
});

it("a passing verify run of the task's named check satisfies it; a failed or bare listing call does not", () => {
	const repo = mkdtempSync(join(tmpdir(), "named-verify-"));
	try {
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e 0" } }));
		const input = {
			quality: "unmeasured",
			hostStatus: undefined,
			contract: { kind: "mutation-report" as const },
			output: '{"validations":[]}',
			branch: "clio-coder/task/calc",
			task: "Add mul. Verify by running `pnpm test`.",
			executedCheckingCalls: 1,
		};
		const ran = (args: Record<string, unknown>, outcome: "ok" | "error") => {
			const recorder = createRunEffectsRecorder(repo);
			recorder.start("v1", "verify", args);
			recorder.checkOutcome("v1", outcome);
			recorder.finish("v1", outcome === "error");
			return recorder.snapshot().executedShellCommands ?? [];
		};
		const passed = ran({ check: "test" }, "ok");
		deepStrictEqual(passed, ["npm run test"]);
		strictEqual(mergeWithheldDetail({ ...input, executedShellCommands: passed }), null);
		const goReason = mergeWithheldDetail({ ...input, executedShellCommands: ["go run test.go"] }) ?? "";
		match(goReason, /\(pnpm test\) but the worker never ran/u);
		doesNotMatch(goReason, /npm-script/u);
		match(mergeWithheldDetail({ ...input, executedShellCommands: ran({ check: "test" }, "error") }) ?? "", /never ran/u);
		match(mergeWithheldDetail({ ...input, executedShellCommands: ran({}, "ok") }) ?? "", /never ran/u);
		// A verifier's task gate resolves in the worker's recorder too.
		const gated = "Verify the change by running: `python3 -m pytest -q tests`";
		configureTaskGates(gated, { confined: false });
		try {
			const viaGate = ran({ check: "gate-1" }, "ok");
			deepStrictEqual(viaGate, ["python3 -m pytest -q tests"]);
			strictEqual(mergeWithheldDetail({ ...input, task: gated, executedShellCommands: viaGate }), null);
		} finally {
			clearTaskGates();
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

it("a declared unrun check holds the merge unless the task opted out of validation", () => {
	const input = {
		quality: "unmeasured",
		hostStatus: undefined,
		contract: { kind: "mutation-report" as const },
		output: '{"validations":[],"declaredChecks":["Tests not run as requested."]}',
		branch: "clio-coder/task/check",
		executedCheckingCalls: 0,
	};
	match(mergeWithheldDetail({ ...input, task: "Edit the parser." }) ?? "", /host did not run/u);
	strictEqual(mergeWithheldDetail({ ...input, task: "Edit the parser. Do not run the tests." }), null);
	for (const task of ["Skip tests", "No tests needed", "No need to test", "Do not run tests and lint"]) {
		strictEqual(mergeWithheldDetail({ ...input, task }), null, task);
	}
	for (const task of ["Run tests without changing snapshots", "Do not edit tests, but run lint checks"]) {
		match(mergeWithheldDetail({ ...input, task }) ?? "", /requested validation/u, task);
	}
});

it("allows moved and formatted tests, renamed suites and snapshot deletions", () => {
	const header = (path: string) => `diff --${"git"} a/${path} b/${path}`;
	for (const diff of [
		[
			header("tests/old.test.ts"),
			"deleted file mode 100644",
			"@@ -1 +0,0 @@",
			'-test("kept", () => {',
			header("tests/new.test.ts"),
			"@@ -0,0 +1 @@",
			'+test("kept", () => {',
		],
		[header("tests/old.test.ts"), "@@ -1 +1 @@", "-test('kept',()=>{", '+test("kept", () => {'],
		[header("tests/old.test.ts"), "@@ -1 +1 @@", '-describe("old suite", () => {', '+describe("new suite", () => {'],
		[header("tests/old.test.ts"), "@@ -1 +1,2 @@", '-test("kept", () => {', "+test(", '+  "kept",'],
		[
			header("tests/__snapshots__/old.snap.ts"),
			"deleted file mode 100644",
			"@@ -1 +0,0 @@",
			'-test("snapshot text", () => {',
		],
	]) {
		deepStrictEqual(removedTestCases(diff.join("\n")), []);
	}
});

it("withholds a verified merge whose diff replaces an existing test, but not an edited body", () => {
	const header = (path: string) => `diff --${"git"} a/${path} b/${path}`;
	const replaced = [
		header("test/duration.test.js"),
		"--- a/test/duration.test.js",
		"+++ b/test/duration.test.js",
		"@@ -1,2 +1,2 @@",
		'-import { formatDuration, totalDuration } from "../src/duration.js";',
		'+import { formatDuration, parseDuration } from "../src/duration.js";',
		"@@ -9,3 +9,3 @@",
		'-test("totalDuration sums every part", () => {',
		'+test("parseDuration parses concatenated units", () => {',
	].join("\n");
	deepStrictEqual(removedTestCases(replaced), ['test/duration.test.js: test("totalDuration sums every part", () => {']);
	const edited = [
		header("test/duration.test.js"),
		"@@ -9,3 +9,3 @@",
		"-  assert.equal(1, 1);",
		"+  assert.equal(2, 2);",
	].join("\n");
	deepStrictEqual(removedTestCases(edited), []);
	const deleted = [
		header("tests/test_parse.py"),
		"deleted file mode 100644",
		"--- a/tests/test_parse.py",
		"+++ /dev/null",
		"@@ -1,2 +0,0 @@",
		"-def test_parse():",
		"-    pass",
	].join("\n");
	deepStrictEqual(removedTestCases(deleted), ["tests/test_parse.py (file removed)"]);
	const input = {
		quality: "pass",
		hostStatus: "verified",
		contract: null,
		output: null,
		branch: "clio-coder/task/dropped",
		removedTests: removedTestCases(replaced),
	};
	const detail = mergeWithheldDetail(input) ?? "";
	match(detail, /removes existing test cases.*totalDuration sums every part/u);
	match(detail, /if removing those tests was intended/u);
	strictEqual(mergeWithheldDetail({ ...input, removedTests: [] }), null);
	strictEqual(mergeWithheldDetail({ ...input, task: "Delete the obsolete totalDuration test." }), null);
	match(
		mergeWithheldDetail({ ...input, task: "Do not delete tests; fix totalDuration." }) ?? "",
		/removes existing test cases/u,
	);
});

it("observed command outcomes preserve full failures and invalidate passes after edits", () => {
	const recorder = createRunEffectsRecorder(process.cwd());
	const run = (id: string, command: string, failed: boolean) => {
		recorder.start(id, "bash", { command });
		recorder.checkOutcome(id, failed ? "error" : "ok");
		recorder.finish(id, failed);
	};
	run("initial", "npm test", true);
	run("narrow", "npm test -- test/unit.js", false);
	strictEqual(recorder.snapshot().validationOutcomes.get("npm test"), false);
	recorder.start("other-cwd", "bash", { command: "npm test", cwd: "other" });
	recorder.finish("other-cwd", false);
	strictEqual(recorder.snapshot().validationOutcomes.get("npm test"), false);
	run("final", "npm test", false);
	strictEqual(recorder.snapshot().validationOutcomes.get("npm test"), true);
	recorder.start("edit", "edit", { path: "src/math.ts" });
	recorder.finish("edit", false);
	strictEqual(recorder.snapshot().validationOutcomes.has("npm test"), false);
	recorder.start("concurrent", "bash", { command: "npm test" });
	recorder.start("later-edit", "edit", { path: "src/math.ts" });
	recorder.finish("later-edit", false);
	recorder.finish("concurrent", false);
	strictEqual(recorder.snapshot().validationOutcomes.has("npm test"), false);
	run("failure", "npm test", true);
	strictEqual(recorder.snapshot().validationOutcomes.get("npm test"), false);
});

it("requires observed final outcomes to settle mutation-report failures", () => {
	const failed = { name: "npm test", passed: false, evidence: "exit 1" };
	const passed = { ...failed, passed: true, evidence: "claimed exit 0" };
	for (const validations of [
		[failed, passed],
		[passed, failed],
	]) {
		const output = JSON.stringify({ mutatedPaths: [], validations });
		strictEqual(
			validateResultContract({
				contract: { kind: "mutation-report" },
				output,
				cwd: process.cwd(),
				networkAllowed: false,
				filesystem: { readFile: () => null },
			}).quality,
			"fail",
		);
		for (const [outcomes, expected] of [
			[[["npm test", true]], "pass"],
			[[["npm test", false]], "fail"],
			[[["npm test -- test/unit.js", true]], "fail"],
			[
				[
					["npm test", true],
					["npm run lint", false],
				],
				"fail",
			],
		] as const) {
			const result = validateResultContract({
				contract: { kind: "mutation-report" },
				output,
				cwd: process.cwd(),
				networkAllowed: false,
				filesystem: { readFile: () => null },
				observedRunEffects: {
					mutatedPaths: new Set(),
					failedMutationPaths: new Set(),
					validationCommands: new Set(["npm test"]),
					validationOutcomes: new Map(outcomes),
				},
			});
			strictEqual(result.quality, expected);
		}
	}
});

it("an observed red judges only the tree it ran on, and respelled runs of one check settle each other (bt-27)", () => {
	const seal = (steps: ReadonlyArray<readonly [string, string, boolean?]>, validations: unknown[]) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [id, command, failed] of steps) {
			if (command === "edit") recorder.start(id, "edit", { path: "src/calc.c" });
			else recorder.start(id, "bash", { command });
			recorder.checkOutcome(id, failed === true ? "error" : "ok");
			recorder.finish(id, failed === true);
		}
		const effects = recorder.snapshot();
		const quality = validateResultContract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				mutatedPaths: steps.some(([, step]) => step === "edit") ? ["src/calc.c"] : [],
				validations,
			}),
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => "" },
			observedRunEffects: effects,
		}).quality;
		const typedValidations = typedValidationFactsFromObservedEffects(effects);
		return { quality, state: deriveRunVerification({ toolStats: [], typedValidations }).state };
	};
	const red = { name: "make test 2>&1 | tail -5", passed: false, evidence: "exit 2", baseline: true };
	const green = { name: "make test 2>&1", passed: true, evidence: "exit 0" };
	// S7: red baseline piped through tail, the fix, a green plain run.
	deepStrictEqual(
		seal(
			[
				["base", "make test 2>&1 | tail -5", true],
				["fix", "edit"],
				["final", "make test 2>&1"],
			],
			[red, green],
		),
		{ quality: "pass", state: "verified" },
	);
	// After the last edit, a later pass of the same check settles a red however it was piped.
	deepStrictEqual(
		seal(
			[
				["fix", "edit"],
				["piped", "make test | head -20", true],
				["final", "make test"],
			],
			[green],
		),
		{ quality: "pass", state: "verified" },
	);
	// A red after the last edit with no later pass of that check stays a failure, even when called a baseline.
	for (const after of [
		[["final", "make test 2>&1 | tail -5", true]],
		[
			["final", "pytest", true],
			["q", "pytest -q"],
		],
	] as const)
		strictEqual(seal([["fix", "edit"], ...after], [{ ...red, name: after[0][1] }, green]).quality, "fail");
	// A pass before the last edit never checked the final tree, alone or beside a red the edit cleared (bt-27b).
	deepStrictEqual(
		seal(
			[
				["pass", "make test"],
				["fix", "edit"],
			],
			[{ ...green, name: "make test" }],
		),
		{ quality: "unmeasured", state: "unverified" },
	);
	deepStrictEqual(
		seal(
			[
				["lint", "make lint"],
				["test", "make test", true],
				["fix", "edit"],
			],
			[
				{ ...green, name: "make lint" },
				{ ...red, name: "make test" },
			],
		),
		{ quality: "unmeasured", state: "unverified" },
	);
	// Read-only inspection after the last check changes no tree, so it neither clears a red nor stales a pass.
	deepStrictEqual(
		seal(
			[
				["fix", "edit"],
				["test", "make test", true],
				["diff", "git diff"],
			],
			[{ ...green, name: "make test" }],
		),
		{ quality: "fail", state: "unverified" },
	);
	deepStrictEqual(
		seal(
			[
				["test", "make test"],
				["fix", "edit"],
				["final", "make test", true],
				["look", "git status"],
			],
			[{ ...green, name: "make test" }],
		),
		{ quality: "fail", state: "unverified" },
	);
	deepStrictEqual(
		seal(
			[
				["fix", "edit"],
				["test", "make test"],
				["look", "git status && git diff"],
			],
			[{ ...green, name: "make test" }],
		),
		{ quality: "pass", state: "verified" },
	);
	// A redirect is a write, so the inspection it rides on is a mutation.
	deepStrictEqual(
		seal(
			[
				["test", "make test"],
				["patch", "git diff > patch.txt"],
			],
			[{ ...green, name: "make test" }],
		),
		{
			quality: "unmeasured",
			state: "unverified",
		},
	);
	// With no observed edit, a reported baseline excuses only its own observed red.
	strictEqual(seal([["base", "pytest", true]], [{ ...red, name: "pytest" }, green]).quality, "unmeasured");
	strictEqual(seal([["base", "pytest -q", true]], [{ ...red, name: "pytest" }, green]).quality, "fail");
	// x1-5: a sealed fail exits 1, so `run --agent coder ... && git push` stops; a baseline red stays 0.
	const exitCode = (quality: string) =>
		mapExitCode({ exitCode: 0, quality: { resultContract: { quality } } } as unknown as RunResult);
	strictEqual(
		exitCode(
			seal(
				[
					["fix", "edit"],
					["final", "pytest", true],
				],
				[{ ...red, name: "pytest" }],
			).quality,
		),
		1,
	);
	strictEqual(exitCode(seal([["base", "pytest", true]], [{ ...red, name: "pytest" }, green]).quality), 0);
});

it("a green claim against a red latest verify on the final tree seals fail, as the bash equivalent does (bt-27)", () => {
	const seal = (steps: string) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [index, step] of steps.split(" ").entries()) {
			const id = `call-${index}`;
			recorder.start(
				id,
				step === "edit" ? "edit" : "verify",
				step === "edit" ? { path: "src/calc.c" } : { check: "test" },
			);
			recorder.checkOutcome(id, step === "red" ? "error" : "ok");
			recorder.finish(id, step === "red");
		}
		return validateResultContract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				mutatedPaths: ["src/calc.c"],
				validations: [{ name: "test", passed: true, evidence: "exit 0" }],
			}),
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => "" },
			observedRunEffects: recorder.snapshot(),
		}).quality;
	};
	strictEqual(seal("pass edit red"), "fail");
	strictEqual(seal("red edit pass"), "pass");
	strictEqual(seal("edit red pass"), "pass");
});

it("a check judges only the tree it ran on, sealed per verify call or from a tool's aggregate (bt-27c)", () => {
	const seal = (steps: string, tool = "verify", aggregate = false) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		const calls: VerifyCallOutcome[] = [];
		const stat = { tool, count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0 };
		for (const [index, step] of steps.split(" ").entries()) {
			const id = `call-${index}`;
			const [name, args] =
				step === "edit"
					? ["edit", { path: "src/calc.c" }]
					: step === "diff"
						? ["bash", { command: "git diff" }]
						: [tool, step === "list" ? {} : { check: "test" }];
			const outcome = step === "red" ? "error" : "ok";
			recorder.start(id, name, args);
			recorder.checkOutcome(id, outcome);
			recorder.finish(id, outcome === "error");
			if (name !== tool) continue;
			stat.count += 1;
			stat[outcome === "ok" ? "ok" : "errors"] += 1;
			calls.push(settledVerifyCall(verifyCallStart(args), outcome, id));
		}
		const checkFreshness = recorder.checkFreshness();
		const typedValidations =
			tool === "verify" ? typedValidationFactsFromVerifyCalls([stat], aggregate ? [] : calls, checkFreshness) : [];
		return deriveRunVerification(
			{ toolStats: [stat], ...(tool === "verify" ? { typedValidations } : {}) },
			{ checkFreshness },
		).state;
	};
	for (const aggregate of [false, true]) {
		strictEqual(seal("pass edit", "verify", aggregate), "unverified");
		strictEqual(seal("edit pass diff", "verify", aggregate), "verified");
	}
	strictEqual(seal("red edit pass"), "verified");
	// A listing ran no check, so it changes no tree either.
	strictEqual(seal("edit pass list"), "verified");
	// A tool named like a check is not one: only `verify` runs a check (x1-2).
	strictEqual(seal("edit pass", "run_tests"), "unverified");
});

it("a check sharing its bash call with a change judges the final tree only when every change ran first (x1-1, x3)", () => {
	// After an edit, each call runs in order: a string is a bash command (red when it starts with `!`), an object a verify call.
	const seal = (...calls: Array<string | Record<string, unknown>>) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [index, call] of [{ path: "src/a.ts" }, ...calls].entries()) {
			const red = typeof call === "string" && call.startsWith("!");
			const [tool, args] =
				typeof call === "string"
					? ["bash", { command: red ? call.slice(1) : call }]
					: [index === 0 ? "edit" : "verify", call];
			recorder.start(`call-${index}`, tool, args);
			recorder.checkOutcome(`call-${index}`, red ? "error" : "ok");
			recorder.finish(`call-${index}`, red);
		}
		const effects = recorder.snapshot();
		const typedValidations = typedValidationFactsFromObservedEffects(effects);
		// The reds still standing where the result contract judges claims, verify calls included.
		const reds = [...effects.checkOutcomes].filter(([, passed]) => !passed).map(([name]) => name);
		return [[...effects.validationCommands], deriveRunVerification({ toolStats: [], typedValidations }).state, reds];
	};
	const stale = [[], "unverified", []];
	const green = [["npm test"], "verified", []];
	// The earlier pass judged a tree the call then changed, whether the check ran before or after the change.
	deepStrictEqual(seal("npm test", "!git apply fix.patch; npm test"), stale);
	deepStrictEqual(seal("npm test", "npm test && node codemod.mjs"), stale);
	deepStrictEqual(seal("npm test", "pytest; git stash pop"), stale);
	deepStrictEqual(seal("npm test", "npm ci | npm test"), stale);
	deepStrictEqual(seal("npm test", "npm test > package.json"), stale);
	// A check that rewrites the tree is a change, in bash or verify (x3-3).
	deepStrictEqual(seal("npm test", "npm run lint:fix"), stale);
	deepStrictEqual(seal("npm test && npm run format"), stale);
	deepStrictEqual(seal("npm test", { check: "format" }), stale);
	deepStrictEqual(seal("!npm test", { check: "format" }), stale);
	// One check vocabulary with the task board: a read-only check changes no tree, a writer that runs none is a
	// change (x5-1), and a runner flag after `--` files a check while a loader refuses one that settles nothing (x5-2).
	const red = [[], "unverified", ["npm test"]];
	for (const check of ["npx tsc --noEmit", "npx vitest run src/a.test.ts", "npx eslint src", "node --check a.js"])
		deepStrictEqual(seal("npm test", check), green, check);
	deepStrictEqual(seal("npm test", "npm run lint && npx tsc --noEmit"), [["npm test", "npm run lint"], "verified", []]);
	for (const change of [`node -e "fs.writeFileSync('src/a.ts', '')"`, "tsc", "npx jest -u", "npm test -- -u"])
		deepStrictEqual(seal("npm test", change), stale, change);
	deepStrictEqual(seal("!npm test", "npx tsc --noEmit"), red);
	// A red from a check no receipt vocabulary names still settles under the classifier's name (x6-1).
	for (const check of ["npx tsc --noEmit", "npx eslint ."])
		deepStrictEqual(seal("npm test", `!${check}`), [["npm test"], "unverified", [check]], check);
	deepStrictEqual(seal("!npm test", "npm test -- -t parses"), [["npm test"], "unverified", ["npm test"]]);
	deepStrictEqual(seal("!npm test", "npm test -- --import ./x.mjs"), red);
	deepStrictEqual(seal("npm test -- --run"), green);
	// Every change ran before the check through `&&`, or the call held only checks, cd and plumbing.
	deepStrictEqual(seal("npm test", "npm ci && npm test"), green);
	deepStrictEqual(seal("npm test", "cd pkg && npm test 2>&1 | tail -5"), green);
	// A read-only stdout filter is plumbing too (x3-4).
	deepStrictEqual(seal("npm test", "npm test 2>&1 | sed -n 1,80p"), green);
	// A log the check's output lands in is output, not a change, so its green verifies and a red behind it stands (x4-2).
	deepStrictEqual(seal("npm test 2>&1 | tee /tmp/t.log"), green);
	deepStrictEqual(seal("npm test > test.log 2>&1"), green);
	deepStrictEqual(seal("!pytest", "!pytest 2>&1 | tee /tmp/pytest.log", "pytest tests/test_one.py"), [
		["pytest"],
		"unverified",
		["pytest"],
	]);
	// A home or scratch log, or an untracked one only the check's own pipeline writes, is output too (x5-4).
	deepStrictEqual(seal("npm run lint", "npm test 2>&1 | tee ~/t.txt", "npm test > test-output.txt 2>&1"), [
		["npm run lint", "npm test"],
		"verified",
		[],
	]);
	// A file the run itself changed, or one a step other than the check writes, stays a change.
	deepStrictEqual(seal("npm test", "npm test | tee src/a.ts"), stale);
	deepStrictEqual(seal("npm test", "npm test && cat package.json > notes.txt"), stale);
	// Shell setup changes no tree, so a standing red stands beside a narrower green (x3-1).
	for (const setup of ["source .venv/bin/activate", "export CI=1"])
		deepStrictEqual(seal("!npm test", `${setup} && npm test -- unit.js`), [["npm test"], "unverified", ["npm test"]]);
	// A red behind head or grep may be that filter's own, so it settles nothing; behind tail it is the check's (x3-2).
	deepStrictEqual(seal("npm test", "!npm test 2>&1 | head -30"), green);
	deepStrictEqual(seal("npm test", "!npm test 2>&1 | grep FAIL"), green);
	deepStrictEqual(seal("npm test", "!npm test 2>&1 | tail -5"), [["npm test"], "unverified", ["npm test"]]);
	// A check run in another directory is not this workspace's check (x3-5).
	deepStrictEqual(seal("cd /elsewhere && npm test"), stale);
	deepStrictEqual(seal("cd pkg/.. && npm test"), green);
	// A check's own directory option or test path operand can leave the workspace too; root containment decides (x4-4).
	for (const outside of [
		"npm test --prefix ../other",
		"make test -C ../other",
		"pytest ../other",
		"go test -run X ../o",
	])
		deepStrictEqual(seal(outside), stale, outside);
	// A runner option's value is a test name, not a path, so its regex anchor reads inside and a green rerun clears a red.
	deepStrictEqual(seal("!go test -run '^TestA$' ./pkg", "go test -run '^TestA$' ./pkg"), [["go test"], "verified", []]);
	deepStrictEqual(seal("npm test --prefix packages/a"), green);
	// A subshell or pushd cd ends at its `)` or popd, and `) &&` hands its status on, so a red there stands (x4-7).
	deepStrictEqual(seal("(cd ../lib && make) && npm test"), green);
	deepStrictEqual(seal("pushd ../lib && make && popd && npm test"), green);
	deepStrictEqual(seal("npm test", "!(cd ../lib && make) && npm test"), [
		[],
		"unverified",
		["(cd ../lib && make) && npm test"],
	]);
	// Its pass settles no outcome, so a red in the workspace still fails a green claim.
	for (const outside of [{ command: "cd /elsewhere && pytest" }, { command: "pytest", cwd: "/elsewhere" }]) {
		const recorder = createRunEffectsRecorder(process.cwd());
		const calls = [
			["edit", { path: "src/a.py" }, false],
			["bash", { command: "pytest" }, true],
			["bash", outside, false],
		] as const;
		for (const [index, [tool, args, red]] of calls.entries()) {
			recorder.start(`call-${index}`, tool, args);
			recorder.checkOutcome(`call-${index}`, red ? "error" : "ok");
			recorder.finish(`call-${index}`, red);
		}
		const effects = recorder.snapshot();
		deepStrictEqual(
			[...effects.validationOutcomes, ...effects.checkOutcomes],
			[
				["pytest", false],
				["pytest", false],
			],
		);
		const typedValidations = typedValidationFactsFromObservedEffects(effects);
		strictEqual(deriveRunVerification({ toolStats: [], typedValidations }).state, "unverified");
		const claim = validateResultContract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				mutatedPaths: ["src/a.py"],
				validations: [{ name: "pytest", passed: true, evidence: "exit 0" }],
			}),
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => "" },
			observedRunEffects: effects,
		});
		strictEqual(claim.quality, "fail");
	}
});

it("one classifier reads every call as a check, an inspection, a mutation or unknown (x5-1, x5-2, x1-3)", () => {
	const cwd = process.cwd();
	const verdict = (tool: string, args: Record<string, unknown>, gitHelpers = false): CallVerdict =>
		classifyCall(tool, args, { cwd, gitHelpers, outputTarget: checkOutputReader(cwd) }).verdict;
	const bash = (command: string, gitHelpers = false) => verdict("bash", { command }, gitHelpers);
	const table: ReadonlyArray<readonly [string, CallVerdict]> = [
		["npm test", "check"],
		["npm test -- --runInBand", "check"],
		["pnpm exec vitest run", "check"],
		["npx tsc --noEmit", "check"],
		["node --test tests/a.test.ts", "check"],
		["pytest -q", "check"],
		["cd lib && make test", "check"],
		["npm test && node codemod.mjs", "check"],
		["git status", "inspection"],
		["git diff", "inspection"],
		["git log -p", "inspection"],
		["sed -n 1,80p a.ts", "inspection"],
		// A bracket expression with no write behind it reads (x5-5).
		["sed -n '/^[[:space:]]*export/p' a.ts", "inspection"],
		["awk '{print $1}' a.ts", "inspection"],
		["sort --reverse --key=2 a.ts", "inspection"],
		["cd src && ls", "inspection"],
		["diff a.ts b.ts", "inspection"],
		["echo $(cat a.ts)", "inspection"],
		// Helpers that write the tree or run another program (x1-3, x4-3).
		["file -C -m mymagic", "mutation"],
		["rg --hostname-bin=./x.sh foo", "mutation"],
		["git diff --ext-diff", "mutation"],
		["git show --textconv", "mutation"],
		["sed -i s/a/b/ a.ts", "mutation"],
		["sed 's/a/b/w out' a.ts", "mutation"],
		["awk '{system(\"sh\")}' a.ts", "mutation"],
		["sort -o out a.ts", "mutation"],
		["sort --out=src/a.ts src/a.ts", "mutation"],
		["sort --out src/a.ts", "mutation"],
		["sort --compress-prog=sh a.ts", "mutation"],
		["sed -n 's/[/]/p/w out1' a.ts", "mutation"],
		["echo x > src/a.ts", "mutation"],
		["rm -rf dist", "mutation"],
		["npm install", "mutation"],
		["npx jest -u", "mutation"],
		['node -e \'require("fs").writeFileSync("a","")\'', "mutation"],
		["tsc", "mutation"],
		["black src", "mutation"],
		["ls && git stash pop", "mutation"],
		// Neither a known check, reader nor writer: it neither settles nor clears.
		["node codemod.mjs", "unknown"],
		["python script.py", "unknown"],
		["make build", "unknown"],
		["npm test -- --import ./loader.mjs", "unknown"],
		["source env.sh", "unknown"],
		["echo $(npm test)", "unknown"],
		["black --check src", "unknown"],
	];
	for (const [command, expected] of table) strictEqual(bash(command), expected, command);
	strictEqual(verdict("read", { path: "a.ts" }), "inspection");
	strictEqual(verdict("edit", { path: "src/a.ts" }), "mutation");
	strictEqual(verdict("verify", { check: "test" }), "check");
	strictEqual(verdict("verify", {}), "inspection");
	strictEqual(verdict("run_script", { script: "x" }), "mutation");
	strictEqual(verdict("mcp__server__tool", {}), "unknown");
	// Where git config names a helper program, only log and show with both helpers switched off still read.
	for (const command of ["git status", "git diff --no-ext-diff --no-textconv", "git log -p"])
		strictEqual(bash(command, true), "mutation", command);
	strictEqual(bash("git log -p --no-ext-diff --no-textconv", true), "inspection");
	// An unknown call after a pass keeps it and is listed beside it; an inspection is not, and a new outcome resets it.
	const recorder = createRunEffectsRecorder(cwd);
	for (const [id, tool, args] of [
		["early", "bash", { command: "node before.mjs" }],
		["test", "bash", { command: "npm test" }],
		["look", "bash", { command: "git status" }],
		["codemod", "bash", { command: "node codemod.mjs" }],
		["mcp", "mcp__server__tool", {}],
	] as const) {
		recorder.start(id, tool, args);
		recorder.checkOutcome(id, "ok");
		recorder.finish(id, false);
	}
	deepStrictEqual([...recorder.snapshot().validationCommands], ["npm test"]);
	deepStrictEqual(recorder.snapshot().unclassifiedAfterLastCheck, ["node codemod.mjs", "mcp__server__tool"]);
	recorder.start("again", "bash", { command: "npm test" });
	recorder.checkOutcome("again", "ok");
	recorder.finish("again", false);
	deepStrictEqual(recorder.snapshot().unclassifiedAfterLastCheck, []);
	// A later outcome keeps the disclosure while an earlier pass that predates the unknown call still stands (x6-3).
	for (const [id, command] of [
		["gen", "python scripts/gen.py"],
		["lint", "npm run lint"],
	] as const) {
		recorder.start(id, "bash", { command });
		recorder.checkOutcome(id, "ok");
		recorder.finish(id, false);
	}
	deepStrictEqual(recorder.snapshot().unclassifiedAfterLastCheck, ["python scripts/gen.py"]);
	// A change retires every outcome, so no disclosure is left pointing at a check that no longer stands (x6-6).
	recorder.start("fix", "edit", { path: "src/a.ts" });
	recorder.checkOutcome("fix", "ok");
	recorder.finish("fix", false);
	deepStrictEqual(recorder.snapshot().unclassifiedAfterLastCheck, []);
	// The recorder reads the repository's config: a core.fsmonitor hook makes a later git status a mutation.
	const repo = mkdtempSync(join(tmpdir(), "fsmonitor-"));
	const env: NodeJS.ProcessEnv = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG"))),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const standing = () => {
		const recorder = createRunEffectsRecorder(repo, { env });
		for (const [id, tool, args] of [
			["fix", "edit", { path: "src/a.ts" }],
			["test", "bash", { command: "npm test" }],
			["look", "bash", { command: "git status" }],
		] as const) {
			recorder.start(id, tool, args);
			recorder.checkOutcome(id, "ok");
			recorder.finish(id, false);
		}
		return [...recorder.snapshot().validationCommands];
	};
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo, env });
		deepStrictEqual(standing(), ["npm test"]);
		execFileSync("git", ["config", "core.fsmonitor", "./hook.sh"], { cwd: repo, env });
		deepStrictEqual(standing(), []);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

it("the review gate reads a verifier report that closes prose containing braces, and nothing weaker", () => {
	const report = '{"verdict":"pass","checks":[{"name":"make test","passed":true,"evidence":"exit 0"}]}';
	const prose = "calc.c has int sub(int a) { return a; } as planned.";
	strictEqual(parseVerifierResult(`${prose}\n\n${report}`)?.verdict, "pass");
	strictEqual(
		validateResultContract({
			contract: { kind: "verifier-report" },
			output: `${prose}\n\n${report}`,
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => null },
		}).conformance,
		"pass",
	);
	strictEqual(parseVerifierResult(`${prose}, so the verdict is **pass**.`), null);
	strictEqual(parseVerifierResult('{"verdict":"pass","checks":[]}'), null);
	strictEqual(parseVerifierResult(`${prose} ${report.replace("pass", "fail")} Quoting: ${report}`), null);
});
it("a run that executed node --check grounds its node --check claim, also behind cd", () => {
	const grounded = (command: string, claim: string) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		recorder.start("bash", "bash", { command });
		recorder.finish("bash", false);
		const effects = recorder.snapshot();
		return groundClaimedValidations({
			contractKind: "mutation-report",
			output: JSON.stringify({ mutatedPaths: ["src/a.ts"], validations: [{ name: claim, passed: true }] }),
			executedCommands: effects.verificationCommands,
			executedCheckingCalls: 1,
		})?.grounded;
	};
	strictEqual(grounded("node --check src/a.ts", "node --check"), 1);
	strictEqual(grounded("cd /tmp/wt && node --check src/a.ts", "node --check"), 1);
	strictEqual(grounded("cd /tmp/wt && node --check src/a.ts", "node --check syntax check"), 1);
	strictEqual(grounded("node src/a.mjs", "node --check"), 0);
});
