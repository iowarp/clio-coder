import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { resultContractShape, validateResultContract } from "../../src/domains/agents/result-contract.js";
import { mergeWithheldDetail } from "../../src/domains/dispatch/merge-gate.js";
import { typedValidationFactsFromVerifyCalls } from "../../src/domains/dispatch/receipt-findings.js";
import { groundClaimedValidations } from "../../src/domains/dispatch/validation-grounding.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";

it("blocked-only verify checks seal no typed validation, including unattributed finishes", () => {
	const stats = [{ tool: "verify", count: 1, ok: 0, errors: 0, blocked: 1 }];
	for (const check of ["test", null])
		deepStrictEqual(typedValidationFactsFromVerifyCalls(stats, [{ check, outcome: "blocked" }]), []);
	deepStrictEqual(typedValidationFactsFromVerifyCalls(stats, []), []);
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
			typedValidationFactsFromVerifyCalls(stats, calls).map((fact) => fact.passed),
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
		strictEqual(result.quality, "unmeasured");
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
});
