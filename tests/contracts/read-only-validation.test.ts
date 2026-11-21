import { deepStrictEqual, doesNotMatch, match, notStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { it } from "node:test";
import { mapExitCode } from "../../src/cli/run.js";
import { validateSettings } from "../../src/core/config.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import {
	parseVerifierResult,
	resultContractShape,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import {
	mergeWithheldDetail,
	removedTestCases,
	taskRequestsTestRemoval,
} from "../../src/domains/dispatch/merge-gate.js";
import {
	deriveRunVerification,
	settledVerifyCall,
	typedValidationFactsFromObservedEffects,
	typedValidationFactsFromVerifyCalls,
	type VerifyCallOutcome,
	verifyCallStart,
} from "../../src/domains/dispatch/run-findings.js";
import { receiptAssurance } from "../../src/domains/dispatch/run-settlement.js";
import type { RunResult } from "../../src/domains/dispatch/types.js";
import { groundClaimedValidations } from "../../src/domains/dispatch/validation-grounding.js";
import { type CallVerdict, classifyCall, settleCheckCall } from "../../src/domains/safety/check-classifier.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { extractCommandDeleteTargets, setValidationWrappers } from "../../src/domains/safety/protected-artifacts.js";
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
it("a builder's read claims are inspection prose and need no command evidence, but test claims still do", () => {
	const input = {
		contractKind: "mutation-report" as const,
		executedCommands: new Set<string>(),
		executedCheckingCalls: 0,
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
	for (const name of ["tests pass", "npm test: 12 passing"])
		strictEqual(
			groundClaimedValidations({ ...input, output: JSON.stringify({ validations: [{ name, passed: true }] }) })?.basis,
			"no-command-executed",
			name,
		);
	strictEqual(
		groundClaimedValidations({
			...input,
			output: JSON.stringify({ validations: [{ name: "npm test", passed: true, baseline: true }] }),
		}),
		null,
	);
});
it("mutation reports accept omitted denied checks as an empty array without asserting validation", () => {
	const contract = { kind: "mutation-report" as const };
	const result = validateResultContract({
		contract,
		output:
			'{"completion":{"state":"done","limitations":[],"unverified":[]},"mutatedPaths":[],"validations":[],"summary":"Read the source."}',
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => null },
	});
	strictEqual(result.conformance, "pass");
	strictEqual(result.quality, "unmeasured");
	match(resultContractShape(contract), /Checks that were denied.*declaredChecks/i);
});

it("verifier verdicts and executable path claims still require command grounding", () => {
	for (const [contractKind, name] of [
		["verifier-report", "reviewed src/foo.ts"],
		["mutation-report", "./gradlew"],
		["mutation-report", "scripts/test.sh"],
	] as const) {
		const result = groundClaimedValidations({
			contractKind,
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
		completion: { state: "done", limitations: [], unverified: [] },
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
			output:
				'{"completion":{"state":"done","limitations":[],"unverified":[]},"mutatedPaths":["src/math.ts"],"validations":[]}',
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

it("a verify that resolved to no check ran nothing, so a later pass under the declared check stands (c16-C)", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-verify-unresolved-"));
	try {
		mkdirSync(join(root, ".clio-coder"));
		writeFileSync(
			join(root, ".clio-coder", "verifiers.yaml"),
			"version: 2\nchecks:\n  - id: python-unittest\n    description: unittest\n    command: [python3, -m, unittest, discover, -s, tests]\n    cwd: .\n    timeoutMs: 60000\n    tags: [test]\n",
		);
		const quality = (unresolved: boolean) => {
			const recorder = createRunEffectsRecorder(root);
			recorder.start("refused", "verify", { check: "python3 -m unittest" });
			recorder.checkOutcome("refused", "error", unresolved);
			recorder.finish("refused", true);
			recorder.start("passed", "verify", { check: "python-unittest" });
			recorder.checkOutcome("passed", "ok");
			recorder.finish("passed", false);
			return validateResultContract({
				contract: { kind: "mutation-report" },
				output: JSON.stringify({
					completion: { state: "done", limitations: [], unverified: [] },
					mutatedPaths: [],
					validations: [{ name: "verify python-unittest", passed: true, evidence: "exit 0" }],
				}),
				cwd: root,
				networkAllowed: false,
				filesystem: { readFile: () => null },
				observedRunEffects: recorder.snapshot(),
			}).quality;
		};
		strictEqual(quality(true), "pass");
		strictEqual(quality(false), "fail");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("the merge gate reads the run's assurance, never the task's words (M9)", () => {
	const input = {
		assurance: "unverified" as const,
		contract: { kind: "mutation-report" as const },
		output: '{"validations":[]}',
		branch: "clio-coder/task/check",
	};
	strictEqual(mergeWithheldDetail(input), null);
	strictEqual(mergeWithheldDetail({ ...input, assurance: "grounded" }), null);
	strictEqual(mergeWithheldDetail({ ...input, assurance: "reviewed" }), null);
	match(
		mergeWithheldDetail({ ...input, assurance: "compromised" }) ?? "",
		/^merge withheld: its result is not trusted/u,
	);
	const failing = {
		...input,
		assurance: "compromised" as const,
		output: '{"validations":[{"name":"npm test","passed":false}]}',
	};
	const detail = mergeWithheldDetail(failing) ?? "";
	match(detail, /the worker's own report lists a failing validation \(npm test\)/u);
	match(
		detail,
		/`clio-coder fleet land clio-coder\/task\/check` previews the merge and `clio-coder fleet land clio-coder\/task\/check --yes` lands it if that failure was already there/u,
	);
	doesNotMatch(detail, /requested validation/u);
});

it("a declared unrun check holds an unverified merge, and a grounded one merges", () => {
	const input = {
		assurance: "unverified" as const,
		contract: { kind: "mutation-report" as const },
		output: '{"validations":[],"declaredChecks":["Tests not run as requested."]}',
		branch: "clio-coder/task/check",
	};
	match(mergeWithheldDetail(input) ?? "", /host did not run \(Tests not run as requested\.\)/u);
	strictEqual(mergeWithheldDetail({ ...input, assurance: "grounded" }), null);
});

it("the recorder keeps only cleanly executed commands, a passing verify run resolved to what it ran", () => {
	const shell = createRunEffectsRecorder("/w");
	shell.start("c1", "bash", { command: "python3 -B -c 'import calc'" });
	shell.checkOutcome("c1", "error");
	shell.finish("c1", false);
	shell.start("c2", "bash", { command: "python3 --version" });
	shell.checkOutcome("c2", "ok");
	shell.finish("c2", false);
	deepStrictEqual(shell.snapshot().executedShellCommands ?? [], ["python3 --version"]);
	const repo = mkdtempSync(join(tmpdir(), "named-verify-"));
	try {
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e 0" } }));
		const ran = (args: Record<string, unknown>, outcome: "ok" | "error") => {
			const recorder = createRunEffectsRecorder(repo);
			recorder.start("v1", "verify", args);
			recorder.checkOutcome("v1", outcome);
			recorder.finish("v1", outcome === "error");
			return recorder.snapshot().executedShellCommands ?? [];
		};
		deepStrictEqual(ran({ check: "test" }, "ok"), ["npm run test"]);
		strictEqual(ran({ check: "test" }, "error").includes("npm run test"), false);
		strictEqual(ran({}, "ok").includes("npm run test"), false);
		const gated = "Verify the change by running: `python3 -m pytest -q tests`";
		configureTaskGates(gated, { confined: false });
		try {
			deepStrictEqual(ran({ check: "gate-1" }, "ok"), ["python3 -m pytest -q tests"]);
		} finally {
			clearTaskGates();
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
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
		assurance: "grounded" as const,
		contract: null,
		output: null,
		branch: "clio-coder/task/dropped",
		removedTests: removedTestCases(replaced),
	};
	const detail = mergeWithheldDetail(input) ?? "";
	match(detail, /removes existing test cases.*totalDuration sums every part/u);
	match(detail, /if removing those tests was intended/u);
	strictEqual(mergeWithheldDetail({ ...input, removedTests: [] }), null);
	// The settle path clears removedTests when a clause of the task asks for the removal.
	strictEqual(taskRequestsTestRemoval("Delete the obsolete totalDuration test."), true);
	strictEqual(taskRequestsTestRemoval("Do not delete tests; fix totalDuration."), false);
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
		const output = JSON.stringify({
			completion: { state: "done", limitations: [], unverified: [] },
			mutatedPaths: [],
			validations,
		});
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

it("an observed red judges only the tree it ran on, and respelled runs of one check settle each other (bt-27)", async () => {
	// The last sealed result-contract fact, so the exit code below reads the assurance the receipt would carry.
	let sealedFact: ReturnType<typeof validateResultContract> | null = null;
	const seal = (steps: ReadonlyArray<readonly [string, string, boolean?]>, validations: unknown[]) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [id, command, failed] of steps) {
			if (command === "edit") recorder.start(id, "edit", { path: "src/calc.c" });
			else recorder.start(id, "bash", { command });
			recorder.checkOutcome(id, failed === true ? "error" : "ok");
			recorder.finish(id, failed === true);
		}
		const effects = recorder.snapshot();
		sealedFact = validateResultContract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				completion: { state: "done", limitations: [], unverified: [] },
				mutatedPaths: steps.some(([, step]) => step === "edit") ? ["src/calc.c"] : [],
				validations,
			}),
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: { readFile: () => "" },
			observedRunEffects: effects,
		});
		const quality = sealedFact.quality;
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
	// Called on a seal() result, so the seal it reads ran first.
	const exitCode = (_sealed: string) =>
		mapExitCode({
			exitCode: 0,
			verdict: {
				assurance: receiptAssurance({
					quality: { typedValidations: [], resultContract: sealedFact },
					verification: { state: "unverified", basis: "no-validation-tool" },
				}),
			},
		} as unknown as RunResult);
	strictEqual(
		await exitCode(
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
	strictEqual(await exitCode(seal([["base", "pytest", true]], [{ ...red, name: "pytest" }, green]).quality), 0);
});

it("a green claim against a red latest verify on the final tree seals fail, as the bash equivalent does (bt-27)", () => {
	const seal = (steps: string) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [index, step] of steps.split(" ").entries()) {
			const id = `call-${index}`;
			// `sh` and `shred` run the same check through bash as `npm test`, green and red.
			const bash = step === "sh" || step === "shred";
			recorder.start(
				id,
				step === "edit" ? "edit" : bash ? "bash" : "verify",
				step === "edit" ? { path: "src/calc.c" } : bash ? { command: "npm test" } : { check: "test" },
			);
			recorder.checkOutcome(id, step === "red" || step === "shred" ? "error" : "ok");
			recorder.finish(id, step === "red" || step === "shred");
		}
		return validateResultContract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				completion: { state: "done", limitations: [], unverified: [] },
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
	// A later run of the same check through bash settles a red verify, and a red one settles a green verify (SF-2).
	strictEqual(seal("edit red sh"), "pass");
	strictEqual(seal("edit pass shred"), "fail");
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
	// The red after `;` is the check's own, since only a known writer ran before it (bt-46 S2).
	deepStrictEqual(seal("npm test", "!git apply fix.patch; npm test"), [
		[],
		"unverified",
		["git apply fix.patch; npm test"],
	]);
	deepStrictEqual(seal("npm test", "npm test && node codemod.mjs"), stale);
	deepStrictEqual(seal("npm test", "pytest; git stash pop"), stale);
	deepStrictEqual(seal("npm test", "npm ci | npm test"), stale);
	deepStrictEqual(seal("npm test", "npm test > package.json"), stale);
	// A check that rewrites the tree is a change, in bash or verify (x3-3).
	deepStrictEqual(seal("npm test", "npm run lint:fix"), stale);
	deepStrictEqual(seal("npm test && npm run format"), stale);
	deepStrictEqual(seal("npm test", { check: "format" }), stale);
	deepStrictEqual(seal("!npm test", { check: "format" }), stale);
	// One check vocabulary with the task board: a read-only check changes no tree and files its pass under the
	// classifier's name when no vocabulary labels it (S1), a writer that runs none is a
	// change (x5-1), and a runner flag after `--` files a check while a loader refuses one that settles nothing (x5-2).
	const red = [[], "unverified", ["npm test"]];
	for (const check of ["npx tsc --noEmit", "npx vitest run src/a.test.ts", "npx eslint src", "node --check a.js"])
		deepStrictEqual(seal("npm test", check), [["npm test", check], "verified", []], check);
	// A bash pass is filed under its full command, the name the board and a red give it, not its vocabulary label (x8-2).
	for (const check of ["pytest -q", "npm run lint && npx tsc --noEmit", "python3 -m pytest -q tests"])
		deepStrictEqual(seal("npm test", check), [["npm test", check], "verified", []], check);
	// A validated runner's own snapshot or golden update rewrites what it compares against (x7-2).
	for (const change of [
		`node -e "fs.writeFileSync('src/a.ts', '')"`,
		"tsc",
		"npx jest -u",
		"npm test -- -u",
		"go test ./... -update",
		"pytest --snapshot-update",
		"python -m pytest --force-regen",
		"poetry run pytest --snapshot-update",
		"bun test -u",
	])
		deepStrictEqual(seal("npm test", change), stale, change);
	deepStrictEqual(seal("!npm test", "npx tsc --noEmit"), [["npx tsc --noEmit"], "unverified", ["npm test"]]);
	// A red from a check no receipt vocabulary names still settles under the classifier's name (x6-1).
	for (const check of ["npx tsc --noEmit", "npx eslint ."])
		deepStrictEqual(seal("npm test", `!${check}`), [["npm test"], "unverified", [check]], check);
	deepStrictEqual(seal("!npm test", "npm test -- -t parses"), [["npm test -- -t parses"], "unverified", ["npm test"]]);
	// A leading cd into the directory the call runs in moves nothing, so its green settles the plain spelling's red (XR-9).
	for (const prefix of [`cd ${process.cwd()} && `, `cd "${process.cwd()}"; `])
		deepStrictEqual(seal("!npm test", `${prefix}npm test`), green, prefix);
	// The shell keeps a backslash in `"\."`, expands an unquoted glob, and lets CDPATH redirect a bare relative operand,
	// so none of those cds is read as staying put; `.` and a `./` path are.
	const linked = mkdtempSync(join(tmpdir(), "xr9-cd-"));
	symlinkSync(".", join(linked, "self"));
	symlinkSync(".", join(linked, "s*"));
	const named = (command: string) => classifyCall("bash", { command }, { cwd: linked }).name;
	for (const command of ['cd "\\." && npm test', "cd ./s* && npm test", "cd self && npm test", "cd self; npm test"])
		strictEqual(named(command), command, command);
	for (const command of ["cd . && npm test", "cd ./self && npm test", "cd './s*' && npm test"])
		strictEqual(named(command), "npm test", command);
	rmSync(linked, { recursive: true, force: true });
	// A line continuation separates nothing, so the continued check's red stands under its single-line name (x7-4).
	deepStrictEqual(seal("!npm test \\\n  -- --reporter=dot"), [[], "unverified", ["npm test -- --reporter=dot"]]);
	// A here-document body is data no continuation joins, so its quoted terminator still ends it in the check's name (S2).
	const continued = "cat > /tmp/n.md <<'EOF'\nline one \\\nEOF\nnpm test";
	strictEqual(classifyCall("bash", { command: continued }, { cwd: process.cwd() }).name, continued);
	// A write on an earlier line leaves the status of the check ending the command its own; a line that may exit, move
	// the shell or run another check does not (bt-46 S2).
	for (const lines of [continued, "echo x > src/b.ts\nnpm test"])
		deepStrictEqual(seal(lines), [[lines], "verified", []], lines);
	for (const lines of ["exit 0\nnpm test", "cd pkg\nnpm test", "npm test\nnpm run lint"])
		strictEqual(seal(lines)[1], "unverified", lines);
	deepStrictEqual(seal("!npm test", "npm test -- --import ./x.mjs"), red);
	deepStrictEqual(seal("npm test -- --run"), [["npm test -- --run"], "verified", []]);
	// Every change ran before the check through `&&`, or the call held only checks, cd and plumbing.
	deepStrictEqual(seal("npm test", "npm ci && npm test"), [["npm ci && npm test"], "verified", []]);
	deepStrictEqual(seal("npm test", "cd pkg && npm test 2>&1 | tail -5"), [
		["npm test", "cd pkg && npm test"],
		"verified",
		[],
	]);
	// A read-only stdout filter is plumbing too (x3-4).
	deepStrictEqual(seal("npm test", "npm test 2>&1 | sed -n 1,80p"), [
		["npm test", "npm test 2>&1 | sed -n 1,80p"],
		"verified",
		[],
	]);
	// A log the check's output lands in is output, not a change, so its green verifies and a red behind it stands (x4-2).
	deepStrictEqual(seal("npm test 2>&1 | tee /tmp/t.log"), green);
	deepStrictEqual(seal("npm test > test.log 2>&1"), green);
	deepStrictEqual(seal("!pytest", "!pytest 2>&1 | tee /tmp/pytest.log", "pytest tests/test_one.py"), [
		["pytest tests/test_one.py"],
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
	// A write that lands only outside the workspace changes no tree; one inside it, an opaque writer or a move out does (x7-1).
	// A here-document body is data, so a check it spells neither runs nor retires a pass (S3).
	for (const scratch of [
		"echo hi > /tmp/x.txt",
		"cat > /tmp/c.py <<'EOF'\nimport os\nEOF",
		"rm -rf /tmp/scratch",
		"cat > $TMPDIR/c.sh <<'EOF'\npytest\nEOF",
	])
		deepStrictEqual(seal("npm test", scratch), green, scratch);
	for (const change of ["echo hi > notes.txt", "echo hi > /tmp/x && npm ci", "mv src/a.ts /tmp/a.ts"])
		deepStrictEqual(seal("npm test", change), stale, change);
	// So does a check's own step that writes only targets it names outside the workspace (x8-5).
	for (const check of ["npm test && cp coverage/lcov.info /tmp/", "mkdir -p /tmp/out && npm test"])
		deepStrictEqual(seal("npm run lint", check), [["npm run lint", check], "verified", []], check);
	// A scratch root inside the workspace holds a check's log, but a write there changes the tree (x8-4).
	const workspace = mkdtempSync(join(tmpdir(), "in-tree-scratch-"));
	try {
		mkdirSync(join(workspace, ".scratch"));
		const recorder = createRunEffectsRecorder(workspace, { scratchRoots: [join(workspace, ".scratch")] });
		const standing = (index: number, tool: string, args: Record<string, unknown>) => {
			recorder.start(`call-${index}`, tool, args);
			recorder.checkOutcome(`call-${index}`, "ok");
			recorder.finish(`call-${index}`, false);
			return [...recorder.snapshot().checkOutcomes.keys()];
		};
		standing(0, "edit", { path: "src/a.ts" });
		deepStrictEqual(standing(1, "bash", { command: "npm test > .scratch/out.txt" }), ["npm test"]);
		deepStrictEqual(standing(2, "bash", { command: "echo x > .scratch/f.txt" }), []);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
	// An untracked file there before the run is not the check's log, so clobbering it is a change (bt-verify8b).
	const repo = mkdtempSync(join(tmpdir(), "clobbered-log-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "notes.txt"), "mine");
		const startedAt = Date.now() + 1;
		const reader = checkOutputReader(repo, process.env, [], new Map(), startedAt);
		const isOutput = reader(repo, new Set(["notes.txt", "out.txt"]));
		deepStrictEqual([isOutput("notes.txt"), isOutput("out.txt")], [false, true]);
		// A log the run made itself, as a replay after the run finds it, stays output.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		writeFileSync(join(repo, "out.txt"), "log");
		strictEqual(isOutput("out.txt"), true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
	// A check's own report, coverage directory or binary is a write judged as its logs are, and a golden update by
	// environment rewrites the tree (SF-2): a gitignored or new target is output, a tracked or older one is a change.
	const reports = mkdtempSync(join(tmpdir(), "check-reports-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: reports });
		writeFileSync(join(reports, ".gitignore"), "coverage/\n");
		for (const older of ["report.json", "tool", basename(reports)]) writeFileSync(join(reports, older), "older");
		const outputTarget = checkOutputReader(reports, process.env, [], new Map(), Date.now() + 1);
		const changes = (command: string) => classifyCall("bash", { command }, { cwd: reports, outputTarget }).changesTree;
		for (const [command, expected] of [
			["npx eslint . -o report.json", true],
			["npx eslint . --output-file=lint.json", false],
			["npx vitest run --coverage", false],
			["npx jest --coverage --coverageDirectory=report.json", true],
			["pytest --cov=src", false],
			["UPDATE_GOLDEN=1 go test ./...", true],
			["INSTA_UPDATE=always cargo test", true],
			["UPDATE_SNAPSHOTS=1 npm test", true],
			["NO_UPDATE_NOTIFIER=1 npm test", false],
			["go build", true],
			["go build ./cmd/tool", true],
			["go build ./cmd/fresh", false],
			["go build ./...", false],
			["go build -o report.json ./cmd/x", true],
		] as const)
			strictEqual(changes(command), expected, command);
	} finally {
		rmSync(reports, { recursive: true, force: true });
	}
	// Shell setup changes no tree, so a standing red stands beside a narrower green (x3-1).
	for (const setup of ["source .venv/bin/activate", "export CI=1"])
		deepStrictEqual(seal("!npm test", `${setup} && npm test -- unit.js`), [
			[`${setup} && npm test -- unit.js`],
			"unverified",
			["npm test"],
		]);
	// A red behind head or grep may be that filter's own, so it settles nothing; behind tail it is the check's (x3-2).
	deepStrictEqual(seal("npm test", "!npm test 2>&1 | head -30"), green);
	deepStrictEqual(seal("npm test", "!npm test 2>&1 | grep FAIL"), green);
	deepStrictEqual(seal("npm test", "!npm test 2>&1 | tail -5"), [["npm test"], "unverified", ["npm test"]]);
	// A check run in another directory is not this workspace's check (x3-5).
	deepStrictEqual(seal("cd /elsewhere && npm test"), stale);
	deepStrictEqual(seal("cd pkg/.. && npm test"), [["cd pkg/.. && npm test"], "verified", []]);
	// A check's own directory option or test path operand can leave the workspace too; root containment decides (x4-4).
	for (const outside of [
		"npm test --prefix ../other",
		"make test -C ../other",
		"pytest ../other",
		"go test -run X ../o",
	])
		deepStrictEqual(seal(outside), stale, outside);
	// A runner option's value is a test name, not a path, so its regex anchor reads inside and a green rerun clears a red.
	deepStrictEqual(seal("!go test -run '^TestA$' ./pkg", "go test -run '^TestA$' ./pkg"), [
		["go test -run '^TestA$' ./pkg"],
		"verified",
		[],
	]);
	deepStrictEqual(seal("npm test --prefix packages/a"), [["npm test --prefix packages/a"], "verified", []]);
	// A subshell or pushd cd ends at its `)` or popd, and `) &&` hands its status on, so a red there stands (x4-7).
	for (const check of ["(cd ../lib && make) && npm test", "pushd ../lib && make && popd && npm test"])
		deepStrictEqual(seal(check), [[check], "verified", []], check);
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
				completion: { state: "done", limitations: [], unverified: [] },
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
	// FL-2: a bare interpreter beside uv.lock with no .venv tested the system Python, not the locked environment, so its
	// pass seals nothing; the locked `uv run` command, and the bare one once the project is provisioned, still verify.
	const uvProject = mkdtempSync(join(tmpdir(), "uv-unprovisioned-"));
	try {
		writeFileSync(join(uvProject, "uv.lock"), "version = 1\n");
		const sealIn = (command: string) => {
			const recorder = createRunEffectsRecorder(uvProject);
			recorder.start("call-0", "bash", { command });
			recorder.checkOutcome("call-0", "ok");
			recorder.finish("call-0", false);
			const typedValidations = typedValidationFactsFromObservedEffects(recorder.snapshot());
			return deriveRunVerification({ toolStats: [], typedValidations }).state;
		};
		const bare = `cd ${uvProject} && python3 -B -m pytest tests/test_add.py -q 2>&1 | tail -30`;
		deepStrictEqual(
			[bare, "pytest -q", "python -m unittest", "uv run python -m pytest", "uv run pytest -q"].map(sealIn),
			["unverified", "unverified", "unverified", "verified", "verified"],
		);
		mkdirSync(join(uvProject, ".venv"));
		strictEqual(sealIn(bare), "verified");
	} finally {
		rmSync(uvProject, { recursive: true, force: true });
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
		// pnpm and yarn run a check-named script bare and past workspace selectors (x6-4).
		["pnpm lint", "check"],
		["yarn lint", "check"],
		["pnpm typecheck", "check"],
		["pnpm --filter web test", "check"],
		["pnpm -r test", "check"],
		["yarn workspace web test", "check"],
		["git status", "inspection"],
		["git diff", "inspection"],
		["git log -p", "inspection"],
		// Repository selectors preserve reads only at the recorder's cwd (x6).
		["git -C . status", "inspection"],
		[`git -C "${cwd}" log`, "inspection"],
		[`git --git-dir="${join(cwd, ".git")}" diff`, "inspection"],
		["git --work-tree=. status", "inspection"],
		["git -C . --git-dir=.git --work-tree=. --no-pager diff", "inspection"],
		// Value-free globals and read-only plumbing read (x6-2).
		["git --no-pager diff", "inspection"],
		["git -P --no-optional-locks log -1", "inspection"],
		["git -c color.ui=never status", "inspection"],
		["git ls-files", "inspection"],
		["git rev-list HEAD", "inspection"],
		["git describe --tags", "inspection"],
		["git cat-file -p HEAD", "inspection"],
		["git ls-tree HEAD", "inspection"],
		["git grep -n foo", "inspection"],
		["git blame a.ts", "inspection"],
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
		// A global that relocates the repository or a config key that may name a program (x6-2).
		["git -C .. status", "mutation"],
		["git --git-dir=../.git diff", "mutation"],
		["git --work-tree=.. status", "mutation"],
		["cd .. && git -C . status", "mutation"],
		["git -C . commit", "mutation"],
		["git -C . push", "mutation"],
		["git --git-dir=.git reset", "mutation"],
		["git --work-tree=. checkout main", "mutation"],
		["git --paginate diff", "mutation"],
		["git -c core.pager=./x.sh diff", "mutation"],
		["git -c alias.st=!./x.sh st", "mutation"],
		["git -c diff.x.textconv=./x.sh diff", "mutation"],
		["git -c diff.external=./x.sh diff", "mutation"],
		["git -c core.fsmonitor=./x.sh status", "mutation"],
		["git -c credential.helper=./x.sh status", "mutation"],
		["git cat-file --textconv HEAD:a.ts", "mutation"],
		["git grep -O foo", "mutation"],
		["git grep --open-files-in-pager=./x.sh foo", "mutation"],
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
		// Other ecosystems' read-only checks, behind environment runners too, while their fixing forms write (x8-2).
		["cargo clippy --all-targets", "check"],
		["cargo clippy --fix --allow-dirty", "mutation"],
		["go vet ./...", "check"],
		["gofmt -l .", "check"],
		["gofmt -l -w .", "mutation"],
		["poetry run mypy .", "check"],
		["bundle exec rspec", "check"],
		["tox -e py311", "check"],
		["make -j 4 lint", "check"],
		["npx prettier --check .", "check"],
		["npx prettier --write .", "mutation"],
		["npx biome check .", "check"],
		["biome check --write .", "mutation"],
		["ruff check --fix", "mutation"],
		["npx playwright test -u", "mutation"],
		// Format checks read the tree while their bare forms rewrite it (x10-2).
		["isort --check-only .", "check"],
		["isort -c .", "check"],
		["python -m isort --check-only .", "check"],
		["black --check src", "check"],
		["ruff format --check .", "check"],
		["cargo fmt --check", "check"],
		["cargo fmt --all -- --check", "check"],
		["rustfmt --check src/lib.rs", "check"],
		["isort .", "mutation"],
		["ruff format .", "mutation"],
		["cargo fmt", "mutation"],
		// Writer-named nox sessions and tox environments write; `cargo insta test` checks while its accept forms write (SF-2).
		["nox -s lint_fix", "mutation"],
		["tox -e format", "mutation"],
		["nox -s lint", "check"],
		["cargo insta test", "check"],
		["cargo insta test --accept", "mutation"],
		["cargo insta test --unreferenced=delete", "mutation"],
		// Go and Rust's routine third-party runner and linters (x10-3).
		["cargo nextest run --workspace", "check"],
		["golangci-lint run ./...", "check"],
		["staticcheck ./...", "check"],
		["golangci-lint run --fix ./...", "mutation"],
		// A writer behind `pnpm|yarn <bin>` writes as it does behind `exec` (x10-4).
		["pnpm prettier -w .", "mutation"],
		["pnpm tsc", "mutation"],
		// Neither a known check, reader nor writer: it neither settles nor clears.
		["node codemod.mjs", "unknown"],
		["python script.py", "unknown"],
		["make build", "unknown"],
		["npm test -- --import ./loader.mjs", "unknown"],
		// A loader runs code beside the check in either order, or handed on to the script (x6-5).
		["node --test --import tsx tests/", "unknown"],
		["node --import tsx --test tests/", "unknown"],
		["node --test --require=./x.cjs tests/", "unknown"],
		["pnpm test --import ./loader.mjs", "unknown"],
		["source env.sh", "unknown"],
		["echo $(npm test)", "unknown"],
		// A builtin, not the project's script (x6-4).
		["yarn check", "unknown"],
		["pnpm dev", "unknown"],
	];
	for (const [command, expected] of table) strictEqual(bash(command), expected, command);
	strictEqual(verdict("bash", { command: "git -C . status", cwd: ".." }), "mutation");
	strictEqual(classifyCall("bash", { command: "npm test && git -C . status" }, { cwd }).shape, "pure");
	// A check-named script that fixes or updates snapshots still rewrites the tree it checks (x6-4).
	for (const command of ["pnpm lint --fix", "pnpm --filter web lint:fix", "pnpm test -u", "yarn workspace web format"])
		strictEqual(classifyCall("bash", { command }, { cwd }).shape, "mixed", command);
	strictEqual(
		classifyCall("bash", { command: "pytest && isort --check-only . && black --check ." }, { cwd }).shape,
		"pure",
	);
	// A selected workspace's run keeps its selectors, so it never stands for the root's `pnpm test`.
	strictEqual(classifyCall("bash", { command: "pnpm --filter web test" }, { cwd }).check, "pnpm --filter web test");
	strictEqual(classifyCall("bash", { command: "pnpm lint" }, { cwd }).check, "pnpm run lint");
	strictEqual(classifyCall("bash", { command: "cargo nextest run" }, { cwd }).check, "cargo test");
	strictEqual(verdict("read", { path: "a.ts" }), "inspection");
	strictEqual(verdict("edit", { path: "src/a.ts" }), "mutation");
	strictEqual(verdict("verify", { check: "test" }), "check");
	strictEqual(verdict("verify", {}), "inspection");
	strictEqual(verdict("run_script", { script: "x" }), "mutation");
	strictEqual(verdict("mcp__server__tool", {}), "unknown");
	// Where git config names a helper program, only log and show with both helpers switched off still read.
	for (const command of [
		"git status",
		"git -C . status",
		"git diff --no-ext-diff --no-textconv",
		"git log -p",
		"git blame a.ts",
		"git ls-files",
	])
		strictEqual(bash(command, true), "mutation", command);
	strictEqual(bash("git log -p --no-ext-diff --no-textconv", true), "inspection");
	strictEqual(bash("git --no-pager cat-file -p HEAD", true), "inspection");
	// An unknown call after a pass keeps it and is listed beside it; an inspection is not, and a new outcome resets it.
	const recorder = createRunEffectsRecorder(cwd);
	for (const [id, tool, args] of [
		["early", "bash", { command: "node before.mjs" }],
		["test", "bash", { command: "npm test" }],
		["look", "bash", { command: `git -C "${cwd}" status` }],
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
	// A red unknown is disclosed with no outcome standing and stays named past a later pass; a green one is not (x8-2).
	const unknowns = createRunEffectsRecorder(cwd);
	for (const [id, command, outcome] of [
		["gen", "node gen.mjs", "ok"],
		["e2e", "node e2e.mjs", "error"],
		["test", "npm test", "ok"],
	] as const) {
		unknowns.start(id, "bash", { command });
		unknowns.checkOutcome(id, outcome);
		unknowns.finish(id, outcome === "error");
		if (id === "gen") deepStrictEqual(unknowns.snapshot().unclassifiedAfterLastCheck, []);
	}
	deepStrictEqual(unknowns.snapshot().unclassifiedAfterLastCheck, ["node e2e.mjs"]);
	deepStrictEqual(unknowns.snapshot().unclassifiedFailed, ["node e2e.mjs"]);
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

it("jq and read-only shell keep a pass undisclosed; an inline python script that writes retires it (c17-a, verify3)", () => {
	const after = (command: string) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [id, line] of [
			["test", "npm test"],
			["probe", command],
		] as const) {
			recorder.start(id, "bash", { command: line });
			recorder.checkOutcome(id, "ok");
			recorder.finish(id, false);
		}
		const { validationCommands, unclassifiedAfterLastCheck } = recorder.snapshot();
		return { standing: [...validationCommands], unclassifiedAfterLastCheck };
	};
	for (const command of [
		"jq .name package.json",
		"cat package.json 2>&1 | tail -n 3",
		"cd src && sed -n '1,5p' index.ts",
	])
		deepStrictEqual(after(command), { standing: ["npm test"], unclassifiedAfterLastCheck: [] }, command);
	for (const command of [
		`python3 -c 'open("out.txt", "w").write("x")'`,
		"python3 - <<'EOF'\nopen('out.txt', 'w').write('x')\nEOF",
		`python3 -c 'import os; os.remove("a")'`,
	])
		deepStrictEqual(after(command), { standing: [], unclassifiedAfterLastCheck: [] }, command);
});

it("a probe importing the workspace's module, `exit 0; npm test` and `cd pkg; npm test` leave a standing pass (bt-c17a a, d)", () => {
	const after = (command: string) => {
		const recorder = createRunEffectsRecorder(process.cwd());
		for (const [id, line] of [
			["test", "npm test"],
			["probe", command],
		] as const) {
			recorder.start(id, "bash", { command: line });
			recorder.checkOutcome(id, "ok");
			recorder.finish(id, false);
		}
		return [...recorder.snapshot().validationCommands];
	};
	// An inline script with no write-shaped operation is unknown: it neither settles nor retires the pass.
	for (const command of [
		`python3 -c "from textutil import slugify; print(slugify('Hello, World!'))"`,
		"python3 -B - <<'PY'\nfrom textutil import slugify\nassert slugify('Straße') == 'strasse'\nPY",
		// Shell control writes nothing; the check after it is not credited (its status is not its own) but retires nothing.
		"exit 0; npm test",
		"cd pkg; npm test",
	])
		deepStrictEqual(after(command), ["npm test"], command);
	// A write-shaped operation is a change whatever the script imports.
	for (const command of [
		`python3 -c "from textutil import slugify; open('out.txt', 'w').write(slugify('x'))"`,
		`python3 -c "import textutil, pathlib; pathlib.Path('o').write_text('x')"`,
		`python3 -c "import textutil, shutil; shutil.rmtree('build')"`,
	])
		deepStrictEqual(after(command), [], command);
	// A program the step reader cannot place ends before the list that runs the check, so the check judges what it left
	// and earns the pass again (SF-2); a function, a compound or a builtin that sets shell state still hides its status.
	deepStrictEqual(after("./gen.sh; npm test"), ["./gen.sh; npm test"]);
	for (const command of [
		"gen() { :; }; gen; npm test",
		"if true; then ./gen.sh; fi; npm test",
		"declare -x A=1; npm test",
	])
		deepStrictEqual(after(command), [], command);
});

it("wrapped and alternate spellings of a check read as that check, and a green after an edit settles the gate", async () => {
	const cwd = process.cwd();
	const read = (command: string) => classifyCall("bash", { command }, { cwd, outputTarget: checkOutputReader(cwd) });
	const gate = (command: string) => {
		const call = (id: string, name: string, args: Record<string, unknown>) => [
			{ kind: "message", role: "tool_call", turnId: id, payload: { name, toolCallId: id, args } },
			{ kind: "message", role: "tool_result", turnId: id, payload: { toolName: name, toolCallId: id, isError: false } },
		];
		const sessionEntries = [
			{ kind: "message", role: "user", turnId: "user", payload: { text: "fix it" } },
			...call("write", "write", { path: "src/a.ts", content: "x" }),
			...call("check", "bash", { command }),
			{ kind: "message", role: "assistant", turnId: "done", payload: { text: "Done.", stopReason: "stop" } },
		];
		const { kind, reason } = assessFinishContract({ sessionEntries, assistantTurnId: "done" });
		return `${kind}/${reason}`;
	};
	for (const command of [
		"timeout 300 npm test",
		"timeout -s KILL -k 10 5m pytest",
		"timeout 600 cargo test",
		"timeout 300 go test ./...",
		"timeout 300 npx vitest run",
		"nice -n 10 npm test",
		"nice -5 npm test",
		"xvfb-run -a -s '-screen 0 1x1x24' npm test",
		"python -m mypy src",
		"python3 -m ruff check .",
		"python -m pylint src",
		"python -m flake8",
		"pnpm vitest run",
		"yarn vitest run",
		"npm exec vitest run",
		"yarn exec -- vitest run",
		"npm --prefix web test",
		"pnpm -C web run lint",
		"yarn --cwd=web test",
		"cargo build",
		"php artisan test",
		// SF-2: stdbuf, ionice, nohup and valued sudo options are read past; make -C and pnpm or yarn selectors before a bin.
		"stdbuf -oL npm test",
		"ionice -c 3 -n 7 npm test",
		"nohup npm test",
		"sudo -u ci npm test",
		"env -u CI npm test",
		"make -C sub test",
		"pnpm --filter web vitest run",
		"yarn workspace web jest",
		// FX-44: a transparent prefix spelled with a path, and `time` with its options.
		"/usr/bin/timeout 300 npm test",
		"/usr/bin/env CI=1 npm test",
		"time -p npm test",
		"/usr/bin/time -v npm test",
		"/usr/bin/corepack pnpm test",
	]) {
		const call = read(command);
		deepStrictEqual([call.verdict, call.changesTree], ["check", false], command);
		strictEqual(settleCheckCall(call, false, "ok", true).settled, true, command);
		strictEqual(gate(command), "ok/validation_evidence", command);
	}
	// The wrapped check keeps its identity, and its red under timeout (exit 124 included) is its own.
	strictEqual(read("timeout 300 npm test").check, "npm test");
	strictEqual(read("npm --prefix web test").check, "npm --prefix web test");
	strictEqual(settleCheckCall(read("timeout 300 npm test"), true, "error", true).settled, true);
	// Transparent wrappers key with the check they run, so respellings settle each other; sudo and env keep their own.
	for (const command of ["stdbuf -oL npm test", "nohup npm run test", "timeout 300 npm run test"])
		strictEqual(read(command).identity, read("npm test").identity, command);
	notStrictEqual(read("sudo -u ci npm test").identity, read("npm test").identity);
	// A wrapper or directory that moves the check out of the workspace leaves it outside.
	for (const command of ["env -C /elsewhere npm test", "sudo -D /elsewhere npm test", "make -C ../other test"])
		strictEqual(read(command).shell?.outsideCwd, true, command);
	// Writers stay writers through a wrapper or an exec, and a wrapped delete names its target.
	for (const command of [
		"timeout 60 npx eslint --fix .",
		"nice prettier --write .",
		"npm exec vitest -u",
		"pnpm vitest -u",
		"python -m ruff format .",
		"python -m black src",
		"timeout 5 rm -rf build",
		"nohup rm -rf build",
		"stdbuf -oL make lint:fix",
	]) {
		strictEqual(read(command).verdict, "mutation", command);
		strictEqual(gate(command), "engage/unvalidated_mutation", command);
	}
	deepStrictEqual(extractCommandDeleteTargets("timeout 5 rm -rf build"), ["build"]);
	// FX-44: a declared wrapper, by path tail or basename, is read through to the check it runs, and the whole command's
	// exit is that check's; an undeclared script, a wrapper running no check, echo and printf stay unvalidated. The
	// wrapper is a program of the repository's that may write, so its call is a change its own check judged, never pure.
	const wrappers = mkdtempSync(join(tmpdir(), "clio-wrappers-"));
	mkdirSync(join(wrappers, ".mine", "bin"), { recursive: true });
	mkdirSync(join(wrappers, "scripts"));
	mkdirSync(join(wrappers, "real"));
	for (const file of [".mine/bin/test-slot.sh", "scripts/ci.sh", "scripts/run-node", "real/rm"])
		writeFileSync(join(wrappers, file), "#!/bin/sh\n");
	symlinkSync(join(wrappers, "real", "rm"), join(wrappers, "scripts", "wrap.sh"));
	const slot = join(wrappers, ".mine", "bin", "test-slot.sh");
	const ci = join(wrappers, "scripts", "ci.sh");
	setValidationWrappers([".mine/bin/test-slot.sh", "ci.sh", "run-node", "wrap.sh", "echo", "unlink"]);
	try {
		for (const command of [
			`${slot} corepack pnpm -s run test:file tests/a.test.ts`,
			`${ci} --quiet -- timeout 300 npm test`,
			// A wrapper that writes before its check still stands for that check, and its write is a change.
			`${join(wrappers, "scripts", "run-node")} --eval="require('fs').writeFileSync('a.txt','x')" npm test`,
		]) {
			const call = read(command);
			deepStrictEqual([call.verdict, call.shape, call.changesTree], ["check", "after-change", true], command);
			strictEqual(settleCheckCall(call, false, "ok", true).settled, true, command);
			strictEqual(settleCheckCall(call, true, "error", true).settled, true, command);
			strictEqual(gate(command), "ok/validation_evidence", command);
		}
		strictEqual(read(`${ci} npm test`).check, "npm test");
		for (const command of [
			"test-slot.sh npm test",
			`${ci} ls`,
			`${ci} echo npm test`,
			"echo npm test",
			"printf npm test",
			// A declared entry the shared list refuses (a file writer, a shell, true, xargs) never stands for a check.
			"unlink pytest",
			// What runs is the file a word resolves to: a link to rm, or a word naming no file, is no wrapper.
			`${join(wrappers, "scripts", "wrap.sh")} -rf pnpm test`,
			`${join(wrappers, "scripts", "missing", "ci.sh")} npm test`,
		])
			strictEqual(gate(command), "engage/unvalidated_mutation", command);
	} finally {
		setValidationWrappers([]);
	}
	strictEqual(gate(`${ci} npm test`), "engage/unvalidated_mutation");
	// `command -v` only resolves the names after it, so it runs no check.
	strictEqual(gate("command -v npm test"), "engage/unvalidated_mutation");
	// Settings refuse an entry naming an interpreter, a shell or a writer, and keep a script.
	const settings = validateSettings({ version: 2, safety: { validationWrappers: ["node", "scripts/ci.sh"] } });
	deepStrictEqual(settings.settings.safety.validationWrappers, ["scripts/ci.sh"]);
	deepStrictEqual(
		settings.issues.map((issue) => issue.path),
		["safety.validationWrappers"],
	);
	// The safety domain reads the list from live settings and leaves none behind when it stops.
	const safety = createSafetyBundle({
		bus: { subscribe: () => () => {}, emit: () => {} },
		getContract: (name: string) =>
			name === "config"
				? { get: () => ({ safety: { validationWrappers: ["ci.sh"] } }), onChange: () => () => {} }
				: undefined,
	} as unknown as DomainContext);
	try {
		await safety.extension.start();
		strictEqual(gate(`${ci} npm test`), "ok/validation_evidence");
		await safety.extension.stop?.();
		strictEqual(gate(`${ci} npm test`), "engage/unvalidated_mutation");
	} finally {
		setValidationWrappers([]);
		rmSync(wrappers, { recursive: true, force: true });
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
			output: JSON.stringify({
				completion: { state: "done", limitations: [], unverified: [] },
				mutatedPaths: ["src/a.ts"],
				validations: [{ name: claim, passed: true }],
			}),
			executedCommands: effects.verificationCommands,
			executedCheckingCalls: 1,
		})?.grounded;
	};
	strictEqual(grounded("node --check src/a.ts", "node --check"), 1);
	strictEqual(grounded("cd /tmp/wt && node --check src/a.ts", "node --check"), 1);
	strictEqual(grounded("cd /tmp/wt && node --check src/a.ts", "node --check syntax check"), 1);
	strictEqual(grounded("node src/a.mjs", "node --check"), 0);
});
