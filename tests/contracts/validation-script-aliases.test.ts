import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { groundClaimedValidations } from "../../src/domains/dispatch/validation-grounding.js";
import { typedValidationSummary } from "../../src/domains/safety/finish-contract.js";
import { detectValidationCommand } from "../../src/domains/safety/protected-artifacts.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { settledRunTrust } from "../harness/settled-run.js";

it("grounds package-manager test aliases in both directions without equating different scripts", () => {
	for (const manager of ["npm", "pnpm", "yarn"]) {
		for (const [claim, command] of [
			[`${manager} test`, `${manager} run test`],
			[`${manager} run test`, `${manager} test`],
		]) {
			const result = groundClaimedValidations({
				contractKind: "mutation-report",
				output: JSON.stringify({ validations: [{ name: claim, passed: true }] }),
				executedCommands: new Set([command as string]),
				executedCheckingCalls: 1,
			});
			strictEqual(result?.grounded, 1);
		}
	}
	for (const command of ["npm run testing", "npm run test:unit"]) {
		const result = groundClaimedValidations({
			contractKind: "mutation-report",
			output: '{"validations":[{"name":"npm test","passed":true}]}',
			executedCommands: new Set([command]),
			executedCheckingCalls: 1,
		});
		strictEqual(result?.grounded, 0);
	}
	const effects = createRunEffectsRecorder(process.cwd());
	effects.start("test-unit", "bash", { command: "npm run test:unit" });
	effects.finish("test-unit", false);
	strictEqual(
		groundClaimedValidations({
			contractKind: "verifier-report",
			output: '{"checks":[{"name":"npm run test:integration","passed":true,"evidence":"exit 0"}]}',
			executedCommands: effects.snapshot().verificationCommands,
			executedCheckingCalls: 1,
		})?.grounded,
		0,
	);
});

it("keeps punctuation and quoted validation claims grounded", () => {
	for (const [claim, command] of [
		["`npm test`", "npm test"],
		['"npm test"', "npm test"],
		["npm test: 12 passing", "npm test"],
		["npm test:", "npm run test"],
		["npm test, 12 passing", "npm test"],
		["pytest: 3 passed", "pytest"],
		["cargo test.", "cargo test"],
		["make check: ok", "make check"],
		["npm run lint: clean", "npm run lint"],
		["npm run testing; then npm run test, 12 passing", "npm run test"],
	]) {
		const result = groundClaimedValidations({
			contractKind: "mutation-report",
			output: JSON.stringify({ validations: [{ name: claim, passed: true }] }),
			executedCommands: new Set([command as string]),
			executedCheckingCalls: 1,
		});
		strictEqual(result?.grounded, 1, claim);
	}
});

it("grounds production package-manager executions and verify summaries", () => {
	for (const manager of ["npm", "pnpm", "yarn"]) {
		for (const spelling of [`${manager} test`, `${manager} run test`]) {
			const detected = detectValidationCommand(spelling);
			strictEqual(detected.kind, "validation", spelling);
			const recorded = detected.kind === "validation" ? detected.matched : "";
			for (const command of [recorded, typedValidationSummary("verify", { args: { check: "test" } }) as string]) {
				const result = groundClaimedValidations({
					contractKind: "mutation-report",
					output: JSON.stringify({ validations: [{ name: spelling, passed: true }] }),
					executedCommands: new Set([command]),
					executedCheckingCalls: 1,
				});
				strictEqual(result?.grounded, 1, spelling);
			}
		}
	}
});

it("grounds a verify claim in its successful tool execution and preserves unmatched quality", () => {
	const effects = createRunEffectsRecorder(process.cwd());
	effects.start("verify-1", "verify", { check: "test" });
	effects.finish("verify-1", false);
	const result = groundClaimedValidations({
		contractKind: "verifier-report",
		output: JSON.stringify({ checks: [{ name: "verify", passed: true }] }),
		executedCommands: effects.snapshot().verificationCommands,
		executedCheckingCalls: 1,
	});
	strictEqual(result?.grounded, 1);
	strictEqual(result?.ungrounded.length, 0);
	strictEqual(
		settledRunTrust({
			...fixtureReceiptDraft(fixtureEnvelope()),
			...{
				runId: "verify-run",
				quality: {
					version: 1,
					typedValidations: [{ sourceId: "tool:verify", validatorDigest: "a".repeat(64), passed: true }],
					responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
					resultContract: null,
				},
				validationGrounding: { claimed: 1, grounded: 0, ungrounded: ["custom check"], basis: "unmatched-command" },
			},
		}).validationGrounding.state,
		"validated",
	);
});

it("grounds verifier claims that name a typed check by its id or its task gate command", () => {
	const ground = (claim: string, taskGates?: Array<{ id: string; text: string }>) =>
		groundClaimedValidations({
			contractKind: "verifier-report",
			output: JSON.stringify({ checks: [{ name: claim, passed: true, evidence: "exit 0" }] }),
			executedCommands: new Set(["verify gate-1", "tool:verify"]),
			executedCheckingCalls: 1,
			...(taskGates ? { taskGates } : {}),
		})?.grounded;
	const gates = [{ id: "gate-1", text: "python3 check.py" }];
	strictEqual(ground("gate-1: python3 check.py"), 1);
	strictEqual(ground("python3 check.py", gates), 1);
	strictEqual(ground("python3 check.py"), 0);
	strictEqual(ground("gate-2"), 0);
	strictEqual(ground("python3 other.py", gates), 0);
	const pytest = [{ id: "gate-1", text: "python3 -m pytest -q tests" }];
	strictEqual(ground("gate-1 (python3 -m pytest -q tests)", pytest), 1);
	strictEqual(ground("python3 -m pytest -q tests"), 0);
	strictEqual(ground("verify gate-1 (python3 -m pytest -q tests)"), 1);
	strictEqual(ground("verify gate-2 (python3 -m pytest -q tests)"), 0);
});

it("a receipt names the catalog check verify ran, not an npm script that never did", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-verify-receipt-"));
	try {
		mkdirSync(join(root, ".clio-coder"));
		writeFileSync(
			join(root, ".clio-coder", "verifiers.yaml"),
			"version: 2\nchecks:\n  - id: test\n    description: pytest\n    command: [python3, -m, pytest, -q]\n    cwd: .\n    timeoutMs: 60000\n    tags: [test]\n",
		);
		const effects = createRunEffectsRecorder(root);
		effects.start("verify-1", "verify", { check: "test" });
		effects.finish("verify-1", false);
		const snapshot = effects.snapshot();
		deepStrictEqual([...snapshot.validationCommands], ["python3 -m pytest -q"]);
		// Grounding still matches claims by the check's canonical identity.
		ok(snapshot.verificationCommands.has("npm run test"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
		const lint = createRunEffectsRecorder(root);
		lint.start("verify-2", "verify", { check: "lint" });
		lint.finish("verify-2", false);
		deepStrictEqual([...lint.snapshot().validationCommands], ["npm run lint"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("grounds a verify-only run's claim by its check id or resolved command, and never a failed or absent check", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-verify-grounding-"));
	try {
		mkdirSync(join(root, ".clio-coder"));
		writeFileSync(
			join(root, ".clio-coder", "verifiers.yaml"),
			"version: 2\nchecks:\n  - id: python-unittest\n    description: unittest\n    command: [python3, -m, unittest, discover, -s, tests]\n    cwd: .\n    timeoutMs: 60000\n    tags: [test]\n",
		);
		const run = (outcome: "ok" | "error") => {
			const effects = createRunEffectsRecorder(root);
			effects.start("verify-1", "verify", { check: "python-unittest" });
			effects.checkOutcome("verify-1", outcome);
			effects.finish("verify-1", outcome === "error");
			return effects.snapshot().verificationCommands;
		};
		const ground = (claim: string, executedCommands: ReadonlySet<string>) =>
			groundClaimedValidations({
				contractKind: "mutation-report",
				output: JSON.stringify({ validations: [{ name: claim, passed: true }] }),
				executedCommands,
				executedCheckingCalls: 1,
			});
		const passed = run("ok");
		const claim = "verify python-unittest (python3 -m unittest discover -s tests)";
		deepStrictEqual(ground(claim, passed), { claimed: 1, grounded: 1, ungrounded: [], basis: "grounded" });
		for (const named of ["verify python-unittest", "python3 -m unittest discover -s tests"])
			strictEqual(ground(named, passed)?.grounded, 1, named);
		for (const never of ["verify lint", "pytest -q", "verify python-unittest-integration"])
			strictEqual(ground(never, passed)?.grounded, 0, never);
		strictEqual(ground(claim, run("error"))?.grounded, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
