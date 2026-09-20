import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { type AutonomyLevel, mapAutonomy } from "../../src/domains/safety/autonomy.js";
import {
	createSafetyPolicyEngine,
	PROJECT_SCRIPT_COMMANDS,
	type SafetyPolicyEngine,
	TEST_RUNNER_COMMANDS,
} from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import {
	detectValidationCommand,
	VALIDATION_COMMAND_LABELS,
	type ValidationCommandLabel,
} from "../../src/domains/safety/protected-artifacts.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/** One canonical spelling per validation label. */
const SPELLINGS: Record<ValidationCommandLabel, string> = {
	"npm test": "npm test",
	"node --test": "node --test sum.test.mjs",
	pytest: "pytest -q tests",
	"python -m pytest": "python3 -m pytest -q test_index_policy.py",
	"python -m unittest": "python3 -m unittest -q test_solver",
	"cargo test": "cargo test --workspace",
	"go test": "go test ./...",
	ctest: "ctest --output-on-failure",
	"make test": "make test",
	"make check": "make check",
	"ninja test": "ninja test",
	"meson test": "meson test -C build",
	"mvn test": "mvn test -Dtest=SolverTest",
	"gradle test": "./gradlew test",
};

/** The validation label each unattended test runner stands for. */
const TEST_RUNNER_LABELS: Record<string, ValidationCommandLabel> = {
	"builtin:npm-test": "npm test",
	"builtin:node-test": "node --test",
	"builtin:pytest": "pytest",
	"builtin:python-pytest": "python -m pytest",
	"builtin:python-unittest": "python -m unittest",
	"builtin:cargo-test": "cargo test",
	"builtin:go-test": "go test",
	"builtin:ctest": "ctest",
	"builtin:make-test": "make test",
	"builtin:make-check": "make check",
	"builtin:ninja-test": "ninja test",
	"builtin:meson-test": "meson test",
	"builtin:mvn-test": "mvn test",
	"builtin:gradle-test": "gradle test",
};

// The asymmetry: repository scripts that count as validation evidence through
// the `npm run <verification script>` family (isVerificationScriptName accepts
// lint, build, typecheck, and ci) but are not test runners, so they keep a
// one-shot confirmation instead of running unattended.
const CONFIRMED_SCRIPT_SPELLINGS: Record<string, string> = {
	"builtin:npm-lint": "npm run lint",
	"builtin:npm-build": "npm run build",
	"builtin:npm-typecheck": "npm run typecheck",
	"builtin:npm-ci-script": "npm run ci",
};

function disposition(policy: SafetyPolicyEngine, command: string, level: AutonomyLevel): string {
	const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
	return decision.kind === "allow"
		? mapAutonomy(level, decision.actionClass, { executeRecognized: decision.execRecognition !== "unrecognized" })
		: decision.kind;
}

describe("test runner vocabulary (#377)", () => {
	let scratch: string;
	let isolated: IsolatedClioEnv;
	let policy: SafetyPolicyEngine;

	before(async () => {
		isolated = await isolateClioEnv("clio-coder-test-runner-vocabulary-");
		scratch = mkdtempSync(join(tmpdir(), "clio-coder-test-runner-vocabulary-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch, "build"), { recursive: true });
		policy = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
	});

	after(() => {
		rmSync(scratch, { recursive: true, force: true });
		isolated.restore();
	});

	it("keeps the validation labels and the unattended test runners in step", () => {
		deepStrictEqual(Object.keys(SPELLINGS).sort(), [...VALIDATION_COMMAND_LABELS].sort());
		deepStrictEqual(Object.keys(TEST_RUNNER_LABELS).sort(), TEST_RUNNER_COMMANDS.map((entry) => entry.id).sort());
		deepStrictEqual(
			Object.keys(CONFIRMED_SCRIPT_SPELLINGS).sort(),
			PROJECT_SCRIPT_COMMANDS.map((entry) => entry.id).sort(),
		);
		deepStrictEqual(
			[...new Set(Object.values(TEST_RUNNER_LABELS))].sort(),
			[...VALIDATION_COMMAND_LABELS].sort(),
			"every validation label has an unattended test runner",
		);
		for (const label of VALIDATION_COMMAND_LABELS) {
			const spelling = SPELLINGS[label];
			deepStrictEqual(detectValidationCommand(spelling), { kind: "validation", matched: label }, spelling);
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command: spelling } });
			strictEqual(decision.kind, "allow", spelling);
			strictEqual(decision.execRecognition, "recognized", spelling);
			ok(decision.ruleId !== undefined, spelling);
			strictEqual(TEST_RUNNER_LABELS[decision.ruleId], label, spelling);
			strictEqual(disposition(policy, spelling, "auto-edit"), "allow", spelling);
		}
		for (const [id, spelling] of Object.entries(CONFIRMED_SCRIPT_SPELLINGS)) {
			strictEqual(detectValidationCommand(spelling).kind, "validation", spelling);
			ok(PROJECT_SCRIPT_COMMANDS.find((entry) => entry.id === id)?.re.test(spelling), spelling);
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command: spelling } });
			strictEqual(decision.kind, "ask", spelling);
			strictEqual(decision.ruleId, "project-script-confirm", spelling);
		}
	});

	it("runs the project's test command unattended at auto-edit and full-auto only", () => {
		for (const command of [
			"python3 -m unittest -q test_solver",
			"ctest --output-on-failure",
			"node --test sum.test.mjs",
		]) {
			strictEqual(disposition(policy, command, "auto-edit"), "allow", command);
			strictEqual(disposition(policy, command, "full-auto"), "allow", command);
			strictEqual(disposition(policy, command, "suggest"), "ask", command);
			strictEqual(disposition(policy, command, "read-only"), "deny", command);
		}
	});

	it("keeps compound, substituted, and redirected test runs behind a confirmation", () => {
		for (const command of [
			"node --test sum.test.mjs && curl https://example.com",
			"node --test $(cat f)",
			"node --test > /etc/x",
			"ctest; rm -rf x",
			"make check && curl https://example.com",
			"python3 -m unittest $(cat f)",
			"meson test > /etc/x",
			"ctest | tee out.txt",
			"ctest && npm run build",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			notStrictEqual(disposition(policy, command, "auto-edit"), "allow", command);
			notStrictEqual(decision.kind, "allow", `${command} must ask at every level`);
		}
		// A quoted argument leaves the bare-word charset, so the command is
		// unrecognized bash again: the autonomy level decides, as before #377.
		strictEqual(disposition(policy, "python3 -m unittest 'test solver'", "auto-edit"), "ask");
	});

	it("does not mistake a Node script argument or evaluation for the test runner", () => {
		for (const command of ["node sum.mjs --test", "node -e process.exit(0) -- --test", "node --test-only sum.mjs"]) {
			strictEqual(detectValidationCommand(command).kind, "none", command);
			strictEqual(disposition(policy, command, "auto-edit"), "ask", command);
		}
	});

	it("recognizes a cd into the build tree followed by a test runner", () => {
		const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd build && ctest" } });
		strictEqual(decision.kind, "allow");
		strictEqual(decision.ruleId, "bash-recognized-chain");
		strictEqual(decision.execRecognition, "recognized");
		strictEqual(disposition(policy, "cd build && ctest --output-on-failure", "auto-edit"), "allow");
		notStrictEqual(disposition(policy, "cd .. && ctest", "auto-edit"), "allow");
	});
});
