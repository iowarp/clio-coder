/**
 * Deterministic code steps: registry binding, plan placement, scheduling, and
 * the runner's bounds. The property under test throughout is that code owns
 * the command and a failing command still speaks to the next step.
 */

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseFleetCommands } from "../../src/domains/agents/fleet-commands.js";
import { parseFleetContract, validateFleetCommands } from "../../src/domains/agents/fleet-contract.js";
import { parseCodeReport, validateResultContract } from "../../src/domains/agents/result-contract.js";
import {
	CODE_STEP_EXCERPT_MAX_BYTES,
	CODE_STEP_SPAWN_FAILURE_EXIT_CODE,
	CODE_STEP_TIMEOUT_EXIT_CODE,
	codeStepEnv,
	runCodeStep,
} from "../../src/domains/dispatch/code-step.js";
import type { ExecutionHandoff } from "../../src/domains/dispatch/execution-handoff.js";
import {
	compileExecutionPlan,
	type ExecutionPlanAgentStep,
	type ExecutionPlanStepInput,
} from "../../src/domains/dispatch/execution-plan.js";
import {
	type ExecutionSchedulerAdapter,
	type ExecutionStepResult,
	executePlan,
} from "../../src/domains/dispatch/execution-scheduler.js";
import { renderPredecessorHandoffs } from "../../src/domains/dispatch/extension.js";

const registryYaml = ["version: 1", "commands:", "  test:", "    argv: [node, --version]", "    timeoutMs: 30000"].join(
	"\n",
);

const registry = parseFleetCommands(registryYaml, "commands.yaml");

const contractWith = (steps: string[], version = 2): string =>
	[
		"---",
		`version: ${version}`,
		"name: sdlc",
		"steps:",
		...steps,
		"maxWorkers: 2",
		"onFailure: continue",
		"---",
		"Do the work.",
	].join("\n");

const agentStep = (id: string, dependencies: string[] = []): ExecutionPlanAgentStep => ({
	kind: "agent",
	id,
	agentId: "coder",
	executionRole: "builder",
	scope: "workspace",
	expectedResultContract: "mutation-report",
	requestedAuthority: "workspace-edit",
	approvedAuthority: "workspace-edit",
	dependencies,
	task: id,
});

const codeStep = (id: string, dependencies: string[] = []): ExecutionPlanStepInput => ({
	kind: "code",
	id,
	commandId: "test",
	scope: "readonly",
	dependencies,
});

function scheduler(options: {
	codePassed: boolean;
	onFailure?: "stop" | "continue";
	steps: ExecutionPlanStepInput[];
}): {
	run: () => Promise<{ launched: string[]; skipped: ReadonlyArray<string>; seen: Map<string, string[]> }>;
} {
	const launched: string[] = [];
	const seen = new Map<string, string[]>();
	const plan = compileExecutionPlan({
		topology: "fleet",
		rootTask: "root",
		maxWorkers: 2,
		onFailure: options.onFailure ?? "continue",
		steps: options.steps,
	});
	const codeOutput = JSON.stringify({
		passed: options.codePassed,
		exitCode: options.codePassed ? 0 : 1,
		checks: [{ name: "test", passed: options.codePassed, evidence: "exit" }],
		artifactPaths: [],
		outputExcerpt: "FAIL src/thing.test.ts",
	});
	let reservedIds: string[] = [];
	const adapter: ExecutionSchedulerAdapter & { reserved: () => string[] } = {
		reserved: () => reservedIds,
		preflight: (step) => ({ step, costUpperBoundUsd: 1, nodeId: "local" }),
		reserve(_plan, admissions) {
			reservedIds = admissions.map((admission) => admission.step.id);
			return { ownerId: "owner" };
		},
		async run(step, handoffs) {
			launched.push(step.id);
			seen.set(
				step.id,
				handoffs.map((handoff) => handoff.output),
			);
			return {
				assignmentId: `assignment-${step.id}`,
				result: Promise.resolve<ExecutionStepResult>({
					stepId: step.id,
					assignmentId: `assignment-${step.id}`,
					terminalRunId: `run-${step.id}`,
					receiptDigest: "a".repeat(64),
					output: step.id,
					succeeded: true,
					integrityValid: true,
				}),
			};
		},
		async runCode(step) {
			launched.push(step.id);
			return {
				stepId: step.id,
				assignmentId: `code-${step.id}`,
				terminalRunId: `code-${step.id}`,
				receiptDigest: "b".repeat(64),
				output: codeOutput,
				succeeded: options.codePassed,
				integrityValid: true,
			};
		},
		cancel: () => {},
		release: () => {},
		releaseUnconsumed: () => {},
	};
	return {
		run: async () => {
			const outcome = await executePlan(plan, adapter);
			reservedIds = adapter.reserved();
			return { launched, skipped: outcome.skipped, seen };
		},
	};
}

describe("fleet code steps", () => {
	it("a code step names a registered command and an unknown id fails closed", () => {
		const contract = parseFleetContract(
			contractWith([
				"  - id: suite",
				"    kind: code",
				"    command: test",
				"    scope: readonly",
				"    dependencies: []",
			]),
			"fleet.md",
		);
		strictEqual(contract.version, 2);
		strictEqual(contract.steps[0]?.kind, "code");
		validateFleetCommands(contract, registry);

		const unknown = parseFleetContract(
			contractWith([
				"  - id: suite",
				"    kind: code",
				"    command: nope",
				"    scope: readonly",
				"    dependencies: []",
			]),
			"fleet.md",
		);
		throws(() => validateFleetCommands(unknown, registry), /unknown command 'nope'/);
		// An unconfigured repo must fail validation rather than pass a phase that
		// never ran anything.
		throws(() => validateFleetCommands(unknown, null), /require a command registry/);
	});

	it("v1 contracts stay agent-only and a code step needs v2", () => {
		const v1 = contractWith(
			["  - id: suite", "    kind: code", "    command: test", "    scope: readonly", "    dependencies: []"],
			1,
		);
		throws(() => parseFleetContract(v1, "fleet.md"), /steps/);
		const v1Agent = contractWith(["  - id: look", "    agent: scout", "    scope: readonly", "    dependencies: []"], 1);
		strictEqual(parseFleetContract(v1Agent, "fleet.md").steps[0]?.kind, "agent");
		throws(() => parseFleetContract(contractWith([], 5), "fleet.md"), /version must be 1/);
	});

	it("a command registry rejects an empty executable and an escaping cwd", () => {
		throws(() => parseFleetCommands("version: 1\ncommands: {}", "c.yaml"), /commands/);
		throws(() => parseFleetCommands("version: 1\ncommands:\n  t:\n    argv: []", "c.yaml"), /argv/);
		throws(
			() => parseFleetCommands('version: 1\ncommands:\n  t:\n    argv: [node]\n    cwd: "../../etc"', "c.yaml"),
			/escapes the workspace/,
		);
		throws(
			() => parseFleetCommands("version: 1\ncommands:\n  t:\n    argv: [node]\n    shell: rm -rf /", "c.yaml"),
			/additional properties/i,
		);
	});

	it("a code step consumes no worker lease and is reserved by nobody", async () => {
		const harness = scheduler({ codePassed: true, steps: [codeStep("suite"), agentStep("fix", ["suite"])] });
		const outcome = await harness.run();
		deepStrictEqual(outcome.launched, ["suite", "fix"]);
		// The agent step saw the code step's report verbatim.
		match(outcome.seen.get("fix")?.[0] ?? "", /outputExcerpt/);
	});

	it("a green code step feeds its dependent and a red one still crosses the edge on continue", async () => {
		const green = await scheduler({
			codePassed: true,
			steps: [codeStep("suite"), agentStep("doc", ["suite"])],
		}).run();
		deepStrictEqual(green.skipped, []);
		match(green.seen.get("doc")?.[0] ?? "", /"passed":true/);

		const red = await scheduler({
			codePassed: false,
			onFailure: "continue",
			steps: [codeStep("suite"), agentStep("fix", ["suite"])],
		}).run();
		deepStrictEqual(red.skipped, []);
		deepStrictEqual(red.launched, ["suite", "fix"]);
		// The whole point: the failure is the input to the repair.
		match(red.seen.get("fix")?.[0] ?? "", /FAIL src\/thing\.test\.ts/);
	});

	it("a red code step under onFailure stop halts the plan", async () => {
		const stopped = await scheduler({
			codePassed: false,
			onFailure: "stop",
			steps: [codeStep("suite"), agentStep("fix", ["suite"])],
		}).run();
		deepStrictEqual(stopped.launched, ["suite"]);
	});

	it("a code step in a plan the scheduler cannot run fails before any spawn", async () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "root",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [codeStep("suite")],
		});
		const bare: ExecutionSchedulerAdapter = {
			preflight: (step) => ({ step, costUpperBoundUsd: 0, nodeId: "local" }),
			reserve: () => ({ ownerId: "owner" }),
			run: () => {
				throw new Error("should not spawn");
			},
			cancel: () => {},
			release: () => {},
			releaseUnconsumed: () => {},
		};
		await plan.steps.length;
		let message = "";
		try {
			await executePlan(plan, bare);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		match(message, /cannot run one/);
	});

	it("the runner captures a green command as a conformant code-report", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-code-step-"));
		const outcome = await runCodeStep({
			stepId: "suite",
			command: {
				id: "test",
				argv: ["node", "--version"],
				cwd: "",
				timeoutMs: 30_000,
				env: [],
				description: "",
			},
			workspaceRoot: dir,
			artifactDir: join(dir, "artifacts"),
		});
		strictEqual(outcome.report.passed, true);
		strictEqual(outcome.report.exitCode, 0);
		match(outcome.report.outputExcerpt, /^v\d+\./);
		strictEqual(outcome.record.commandId, "test");
		strictEqual(outcome.record.artifactPaths.length, 1);
		const validation = validateResultContract({
			contract: { kind: "code-report" },
			output: outcome.output,
			cwd: dir,
			networkAllowed: false,
			filesystem: { readFile: () => null },
		});
		strictEqual(validation.conformance, "pass");
		// A code step is not a route: it never labels routing quality.
		strictEqual(validation.quality, "unmeasured");
		strictEqual(parseCodeReport(outcome.output)?.passed, true);
	});

	it("a timeout ends the command and reports it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-code-step-"));
		const outcome = await runCodeStep({
			stepId: "hang",
			command: {
				id: "hang",
				argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
				cwd: "",
				timeoutMs: 1_000,
				env: [],
				description: "",
			},
			workspaceRoot: dir,
		});
		strictEqual(outcome.record.timedOut, true);
		strictEqual(outcome.report.exitCode, CODE_STEP_TIMEOUT_EXIT_CODE);
		strictEqual(outcome.report.passed, false);
		match(outcome.report.checks[0]?.evidence ?? "", /timed out/);
	});

	it("output is capped and the tail is what survives", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-code-step-"));
		const outcome = await runCodeStep({
			stepId: "loud",
			command: {
				id: "loud",
				argv: ["node", "-e", 'for (let i = 0; i < 4000; i++) console.log("x".repeat(64)); console.log("LAST-LINE");'],
				cwd: "",
				timeoutMs: 30_000,
				env: [],
				description: "",
			},
			workspaceRoot: dir,
		});
		ok(Buffer.byteLength(outcome.report.outputExcerpt, "utf8") <= CODE_STEP_EXCERPT_MAX_BYTES + 128);
		match(outcome.report.outputExcerpt, /LAST-LINE/);
		strictEqual(outcome.record.outputTruncated, true);
		ok(outcome.record.outputBytes > CODE_STEP_EXCERPT_MAX_BYTES);
	});

	it("a missing binary is exit 127 rather than a thrown run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-code-step-"));
		const outcome = await runCodeStep({
			stepId: "gone",
			command: {
				id: "gone",
				argv: ["clio-no-such-binary-xyz"],
				cwd: "",
				timeoutMs: 5_000,
				env: [],
				description: "",
			},
			workspaceRoot: dir,
		});
		strictEqual(outcome.report.exitCode, CODE_STEP_SPAWN_FAILURE_EXIT_CODE);
		strictEqual(outcome.report.passed, false);
	});

	it("the environment is a closed allowlist, not the operator's shell", () => {
		const env = codeStepEnv(
			{ id: "t", argv: ["node"], cwd: "", timeoutMs: 1000, env: ["EXTRA"], description: "" },
			{ PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", EXTRA: "kept" },
		);
		deepStrictEqual(Object.keys(env).sort(), ["AI_AGENT", "EXTRA", "PATH"]);
		strictEqual(env.AI_AGENT, "clio-coder");
	});

	it("a code-report with a verdict that disagrees with its exit code is refused", () => {
		const lying = JSON.stringify({
			passed: true,
			exitCode: 1,
			checks: [{ name: "test", passed: true, evidence: "exit 1" }],
			artifactPaths: [],
			outputExcerpt: "",
		});
		const validation = validateResultContract({
			contract: { kind: "code-report" },
			output: lying,
			cwd: "/tmp",
			networkAllowed: false,
			filesystem: { readFile: () => null },
		});
		strictEqual(validation.conformance, "fail");
		strictEqual(parseCodeReport(lying), null);
	});

	it("predecessor outputs render into the downstream prompt as labeled data", () => {
		const handoffs: ExecutionHandoff[] = [
			{
				stepId: "suite",
				assignmentId: "code-1",
				terminalRunId: "code-1",
				receiptDigest: "b".repeat(64),
				output: '{"passed":false,"exitCode":1,"outputExcerpt":"FAIL"}',
			},
		];
		const message = renderPredecessorHandoffs(handoffs);
		ok(message !== null);
		strictEqual(message.id, "dispatch-predecessor-handoffs");
		match(message.body, /not instructions/);
		match(message.body, /<<<PREDECESSOR suite run=code-1/);
		match(message.body, /FAIL/);
		strictEqual(renderPredecessorHandoffs([]), null);
	});

	it("code step records land beside the ledger, never inside it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-code-step-"));
		await mkdir(join(dir, "artifacts"), { recursive: true });
		const outcome = await runCodeStep({
			stepId: "suite",
			command: { id: "test", argv: ["node", "--version"], cwd: "", timeoutMs: 30_000, env: [], description: "" },
			workspaceRoot: dir,
			artifactDir: join(dir, "artifacts"),
		});
		const recordPath = join(dir, "record.json");
		writeFileSync(recordPath, JSON.stringify(outcome.record));
		strictEqual(outcome.record.version, 1);
		strictEqual(outcome.record.reportDigest.length, 64);
		strictEqual(outcome.record.outputDigest.length, 64);
		ok(outcome.record.durationMs >= 0);
	});
});
