import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import type { SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import {
	createSafetyPolicyEngine,
	PROJECT_SCRIPT_COMMANDS,
	TEST_RUNNER_COMMANDS,
} from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import type { ValidationCommandLabel } from "../../src/domains/safety/protected-artifacts.js";
import { detectValidationCommand, VALIDATION_COMMAND_LABELS } from "../../src/domains/safety/protected-artifacts.js";
import { createSessionCodeConsent } from "../../src/domains/safety/session-code-consent.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry, type PermissionRequiredMeta } from "../../src/tools/registry.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** One canonical spelling per validation label. */
const SPELLINGS: Record<ValidationCommandLabel, string> = {
	"npm test": "npm test",
	"pnpm test": "pnpm test",
	"yarn test": "yarn run test -- tests/x.test.ts",
	"bun test": "bun test",
	"npm run test:<name>": "npm run test:unit -- tests/x.test.ts",
	"pnpm run test:<name>": "pnpm run test:file -- tests/x.test.ts",
	"yarn run test:<name>": "yarn run test:unit",
	"bun run test:<name>": "bun run test:unit",
	"uv run pytest": "uv run --no-sync pytest -q tests/x.py",
	"uv run python -m pytest": "uv run --frozen --no-sync --locked python -m pytest -q tests/x.py",
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

const SCRIPT_IDENTITIES: Partial<Record<ValidationCommandLabel, string>> = {
	"npm run test:<name>": "npm run test:unit",
	"pnpm run test:<name>": "pnpm run test:file",
	"yarn run test:<name>": "yarn run test:unit",
	"bun run test:<name>": "bun run test:unit",
};

/** The validation label each unattended test runner stands for. */
const TEST_RUNNER_LABELS: Record<string, ValidationCommandLabel> = {
	"builtin:npm-test": "npm test",
	"builtin:pnpm-test": "pnpm test",
	"builtin:yarn-test": "yarn test",
	"builtin:bun-test": "bun test",
	"builtin:npm-test-script": "npm run test:<name>",
	"builtin:pnpm-test-script": "pnpm run test:<name>",
	"builtin:yarn-test-script": "yarn run test:<name>",
	"builtin:bun-test-script": "bun run test:<name>",
	"builtin:uv-pytest": "uv run pytest",
	"builtin:uv-python-pytest": "uv run python -m pytest",
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

// These scripts count as validation evidence, but execute repository code.
// They therefore use the autonomy mapping after the safety scan.
const PROJECT_SCRIPT_SPELLINGS: Record<string, string> = {
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
			Object.keys(PROJECT_SCRIPT_SPELLINGS).sort(),
			PROJECT_SCRIPT_COMMANDS.map((entry) => entry.id).sort(),
		);
		deepStrictEqual(
			[...new Set(Object.values(TEST_RUNNER_LABELS))].sort(),
			[...VALIDATION_COMMAND_LABELS].sort(),
			"every validation label has an unattended test runner",
		);
		for (const label of VALIDATION_COMMAND_LABELS) {
			const spelling = SPELLINGS[label];
			deepStrictEqual(
				detectValidationCommand(spelling),
				{ kind: "validation", matched: SCRIPT_IDENTITIES[label] ?? label },
				spelling,
			);
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command: spelling } });
			strictEqual(decision.kind, "allow", spelling);
			strictEqual(decision.execRecognition, "recognized", spelling);
			ok(decision.ruleId !== undefined, spelling);
			strictEqual(TEST_RUNNER_LABELS[decision.ruleId], label, spelling);
			strictEqual(disposition(policy, spelling, "default"), "allow", spelling);
		}
		for (const [id, spelling] of Object.entries(PROJECT_SCRIPT_SPELLINGS)) {
			strictEqual(detectValidationCommand(spelling).kind, "validation", spelling);
			ok(PROJECT_SCRIPT_COMMANDS.find((entry) => entry.id === id)?.re.test(spelling), spelling);
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command: spelling } });
			strictEqual(decision.kind, "allow", spelling);
			strictEqual(decision.ruleId, id, spelling);
			strictEqual(decision.execRecognition, "unrecognized", spelling);
			strictEqual(disposition(policy, spelling, "default"), "ask", spelling);
			strictEqual(disposition(policy, spelling, "yolo"), "allow", spelling);
			strictEqual(disposition(policy, `npm test && ${spelling}`, "default"), "ask", spelling);
			strictEqual(disposition(policy, `npm test && ${spelling}`, "yolo"), "allow", spelling);
		}
	});

	it("runs the project's test command unattended at default and yolo", () => {
		for (const command of [
			"python3 -m unittest -q test_solver",
			"ctest --output-on-failure",
			"node --test sum.test.mjs",
			"npm run test -- tests/x.test.ts",
			"pnpm run test -- tests/x.test.ts",
			"yarn test",
			"bun run test -- tests/x.test.ts",
			"uv run --no-sync pytest -q tests/x.py",
			"uv run --locked --no-sync pytest -q tests/x.py",
			"uv run --no-sync --frozen python -m pytest -q tests/x.py",
		]) {
			strictEqual(disposition(policy, command, "default"), "allow", command);
			strictEqual(disposition(policy, command, "yolo"), "allow", command);
		}
		strictEqual(disposition(policy, "uv run pytest -q", "default"), "ask");
	});

	it("keeps substitution and unsafe destinations behind the hard safety rails", () => {
		for (const command of [
			"node --test $(cat f)",
			"node --test > /etc/x",
			"ctest; rm -rf ~/x",
			"python3 -m unittest $(cat f)",
			"meson test > /etc/x",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			notStrictEqual(disposition(policy, command, "default"), "allow", command);
			notStrictEqual(decision.kind, "allow", `${command} must keep its safety rail`);
		}
		for (const command of [
			"node --test sum.test.mjs && curl https://example.com",
			"make check && curl https://example.com",
			"ctest | tee out.txt",
			"ctest && npm run build",
		]) {
			strictEqual(disposition(policy, command, "default"), "ask", command);
			strictEqual(disposition(policy, command, "yolo"), "allow", command);
		}
		// A quoted argument leaves the bare-word charset, so the command is
		// unrecognized bash again: the autonomy level decides, as before #377.
		strictEqual(disposition(policy, "python3 -m unittest 'test solver'", "default"), "ask");
		strictEqual(disposition(policy, 'pnpm run test:file -- "$X"', "default"), "ask");
	});

	it("does not mistake a Node script argument or evaluation for the test runner", () => {
		for (const command of ["node sum.mjs --test", "node -e process.exit(0) -- --test", "node --test-only sum.mjs"]) {
			strictEqual(detectValidationCommand(command).kind, "none", command);
			strictEqual(disposition(policy, command, "default"), "ask", command);
		}
	});

	it("recognizes a cd into the build tree followed by a test runner", () => {
		const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd build && ctest" } });
		strictEqual(decision.kind, "allow");
		strictEqual(decision.ruleId, "bash-recognized-chain");
		strictEqual(decision.execRecognition, "recognized");
		strictEqual(disposition(policy, "cd build && ctest --output-on-failure", "default"), "allow");
		notStrictEqual(disposition(policy, "cd .. && ctest", "default"), "allow");
	});

	it("asks an attended main session once before a test runner after the session wrote a file", async () => {
		for (const command of ["pytest -q tests", "cd build && ctest", "PYTHONPATH=src python3 -m pytest -q"]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).runsWorkspaceCode, true, command);
		}
		strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command: "git status" } }).runsWorkspaceCode, undefined);

		const safety = createWorkerSafety({ cwd: scratch });
		const pytest = { tool: ToolNames.Bash, args: { command: "pytest -q tests", cwd: scratch } };
		const ask = evaluateAdmission({
			principal: "main",
			effects: [pytest],
			safety,
			autonomy: "default",
			sessionCodeConsentPending: true,
		});
		strictEqual(ask.kind === "ask" && `${ask.source}:${ask.approvalAuthority}`, "session-consent:operator");
		// Headless never passes the flag; yolo and workers are unchanged.
		for (const unchanged of [
			evaluateAdmission({ principal: "main", effects: [pytest], safety, autonomy: "default" }),
			evaluateAdmission({
				principal: "main",
				effects: [pytest],
				safety,
				autonomy: "yolo",
				sessionCodeConsentPending: true,
			}),
			evaluateAdmission({ principal: "worker", effects: [pytest], safety, sessionCodeConsentPending: true }),
		]) {
			strictEqual(unchanged.kind, "allow");
		}

		const consent = createSessionCodeConsent();
		const registry = createRegistry({ safety, autonomy: () => "default", sessionCodeConsent: consent });
		let runs = 0;
		registry.register({
			...bashTool,
			run: async () => {
				runs += 1;
				return { kind: "ok", output: "ran" };
			},
		});
		const asks: PermissionRequiredMeta[] = [];
		let answer: "deny" | "grant" = "deny";
		registry.onPermissionRequired((_call, decision, meta) => {
			asks.push(meta);
			if (answer === "deny") registry.cancelParkedCall(meta.requestId, "denied in this contract");
			else
				setImmediate(() => {
					void registry.resumeParkedCalls({
						actionClass: decision.classification.actionClass,
						requestId: meta.requestId,
						requestedBy: "tool:one_shot",
					});
				});
		});
		strictEqual((await registry.invoke(pytest)).kind, "ok", "nothing written yet: runs as #377 allows");
		consent.noteWrite();
		strictEqual((await registry.invoke(pytest)).kind, "blocked");
		strictEqual((await registry.invoke(pytest)).kind, "blocked", "a denial leaves consent ungiven");
		answer = "grant";
		const approved = await registry.invoke(pytest);
		strictEqual(approved.kind, "ok");
		ok(JSON.stringify(approved).includes("test runners run without asking for the rest of this session"));
		strictEqual((await registry.invoke(pytest)).kind, "ok");
		deepStrictEqual(
			asks.map((meta) => meta.axis),
			["net:session-code-consent", "net:session-code-consent", "net:session-code-consent"],
		);
		strictEqual(runs, 3);
		// A new session starts over.
		consent.reset();
		consent.noteWrite();
		strictEqual((await registry.invoke(pytest)).kind, "ok");
		strictEqual(asks.length, 4);
	});
});
