import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { parseFleetCommands } from "../../src/domains/agents/fleet-commands.js";
import { parseFleetContract } from "../../src/domains/agents/fleet-contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { getStoredAssignment, settleStoredAssignment } from "../../src/domains/dispatch/assignment-store.js";
import { resolveCommandArgv } from "../../src/domains/dispatch/code-step.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import {
	buildDelegationProposalBriefing,
	DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES,
	validateDelegationPlan,
} from "../../src/domains/dispatch/delegation-plan.js";
import { spliceExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import { gateBaselineFailure, gateFailureLines } from "../../src/domains/dispatch/fleet-gate.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";
import { executeFleetRun, planFleetResume } from "../../src/domains/dispatch/fleet-run.js";
import { readFleetRun } from "../../src/domains/dispatch/state.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { formatFleetRunPreviewStep } from "../../src/interactive/overlays/fleet-run-approval.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { agentRecipeFixture } from "../harness/agent-recipe.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function source(version: number, extra: string, top = ""): string {
	return [
		"---",
		`version: ${version}`,
		"name: dynamic",
		top,
		"steps:",
		extra,
		"maxWorkers: 4",
		"onFailure: stop",
		"---",
		"Implement the requested change.",
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

const AGENT = [
	"  - kind: agent",
	"    id: build",
	"    agent: coder",
	"    scope: workspace",
	"    writes: [src]",
	"    dependencies: []",
].join("\n");

function v5AgentHarness(): { context: ReturnType<typeof dispatchStubContext>; agents: AgentsContract } {
	const context = dispatchStubContext({ agentTools: [ToolNames.Read, ToolNames.Write, ToolNames.Edit] });
	const recipes: AgentRecipe[] = ["architect", "coder", "tester"].map((id) =>
		agentRecipeFixture({
			id,
			name: id,
			description: `${id} fleet fixture`,
			tools: [ToolNames.Read, ToolNames.Write, ToolNames.Edit],
			toolRequirements: { required: [ToolNames.Read, ToolNames.Write, ToolNames.Edit], optional: [] },
			capabilityClass: "workspace-edit",
			resultContract: { kind: "artifact-report" },
			filepath: `/test/${id}.md`,
		}),
	);
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		diagnostics: () => [],
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((candidate) => candidate.id === id);
			return recipe === undefined ? null : normalizeAgentSpec(recipe);
		},
		reload() {},
	};
	return {
		agents,
		context: {
			...context,
			getContract<T extends object>(name: string): T | undefined {
				if (name === "agents") return agents as T;
				return context.getContract<T>(name);
			},
		},
	};
}

function compileV5(contract: ReturnType<typeof parseFleetContract>, agents: AgentsContract) {
	return compileFleetExecutionPlan({
		contract,
		task: "Implement the requested change.",
		resolveAgent(context) {
			const spec = agents.getSpec(context.agentId);
			if (spec === null) throw new Error(`missing agent '${context.agentId}'`);
			if (spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
				throw new Error(`agent '${context.agentId}' is not automatable`);
			}
			return {
				requestedAuthority: spec.capabilityClass,
				approvedAuthority: spec.capabilityClass,
				expectedResultContract:
					context.planRole === true
						? "delegation-plan"
						: context.gateAuthorRole === true
							? "artifact-report"
							: spec.resultContract.kind,
				executionRole: context.attempt > 0 ? "recovery" : "builder",
			};
		},
	});
}

function gitWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-fleet-v5-"));
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "tests"), { recursive: true });
	writeFileSync(join(root, "src", ".keep"), "src\n");
	writeFileSync(join(root, "tests", ".keep"), "tests\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Fleet Test"], { cwd: root });
	execFileSync("git", ["config", "user.email", "fleet@example.test"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
	const commit = execFileSync("git", ["commit-tree", tree, "-m", "baseline"], { cwd: root, encoding: "utf8" }).trim();
	execFileSync("git", ["update-ref", "HEAD", commit], { cwd: root });
	return root;
}

interface FixtureToolCall {
	tool: string;
	args: Record<string, unknown>;
}

/** The run wrote this path through the write tool, which names its target. */
function wrote(path: string): FixtureToolCall {
	return { tool: ToolNames.Write, args: { path } };
}

/** The run shelled out, which can write a path no argument names. */
function ran(command: string): FixtureToolCall {
	return { tool: ToolNames.Bash, args: { command } };
}

/**
 * A finished worker run. `calls` are emitted as the same `tool_execution_*`
 * pairs a real worker publishes: that stream is the only record of what a run
 * touched, and the write boundary reads it to tell a step's own change from one
 * made under it. A fixture that writes a file without emitting the call is a
 * worker that wrote through a channel nobody can observe, which is a different
 * case and is spelled here by adding `ran(...)`.
 */
function spawnedWorker(text: string, onSettle?: () => void, calls: ReadonlyArray<FixtureToolCall> = []): SpawnedWorker {
	return {
		pid: 700,
		promise: Promise.resolve().then(() => {
			onSettle?.();
			return { exitCode: 0, signal: null };
		}),
		events: (async function* () {
			for (const [index, call] of calls.entries()) {
				const toolCallId = `call-${index}`;
				yield { type: "tool_execution_start", toolCallId, toolName: call.tool, args: call.args };
				yield { type: "tool_execution_end", toolCallId, isError: false };
			}
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		})(),
		abort() {},
		heartbeatAt: { current: Date.now() },
	};
}

describe("fleet contract version 5", () => {
	it("version 4 refuses every version 5 field by name", () => {
		for (const [field, declaration] of [
			["target", `${AGENT}\n    target: frontier`],
			["profile", `${AGENT}\n    profile: local`],
			["writers", AGENT],
		] as const) {
			throws(
				() => parseFleetContract(source(4, declaration, field === "writers" ? "writers: 1" : ""), "fleet.md"),
				new RegExp(field),
			);
		}
		throws(() => parseFleetContract(source(4, AGENT.replace("kind: agent", "kind: plan")), "fleet.md"), /plan/);
		throws(() => parseFleetContract(source(4, AGENT.replace("kind: agent", "kind: gate")), "fleet.md"), /gate/);
	});

	it("version 5 parses agent routes, writers, a gate, and a plan", () => {
		const contract = parseFleetContract(
			source(
				5,
				[
					AGENT.replace("    dependencies: []", "    target: frontier\n    dependencies: []"),
					"  - kind: gate",
					"    id: acceptance",
					"    agent: tester",
					"    path: tests/acceptance.mjs",
					"    run: acceptance",
					"    profile: local",
					"    dependencies: []",
					"  - kind: plan",
					"    id: architect",
					"    roster: [coder, tester]",
					"    maxTasks: 4",
					"    proposals: true",
					"    scope: workspace",
					"    writes: [src, tests]",
					"    dependencies: [acceptance]",
				].join("\n"),
				"writers: 1",
			),
			"fleet.md",
		);
		strictEqual(contract.version, 5);
		strictEqual(contract.writers, 1);
		strictEqual(contract.steps[1]?.kind, "gate");
		strictEqual(contract.steps[2]?.kind, "plan");
	});

	it("gate steps refuse writes by step id because path defines the boundary", () => {
		const gate = [
			"  - kind: gate",
			"    id: acceptance",
			"    agent: tester",
			"    path: tests/acceptance.mjs",
			"    run: acceptance",
			"    writes: [tests/]",
			"    dependencies: []",
		].join("\n");
		throws(() => parseFleetContract(source(5, gate), "fleet.md"), {
			message:
				"fleet contract fleet.md: gate step 'acceptance' must not declare 'writes'; its write boundary is derived from 'path'",
		});
	});

	it("target and profile are mutually exclusive on every agent position", () => {
		throws(
			() => parseFleetContract(source(5, `${AGENT}\n    target: frontier\n    profile: local`), "fleet.md"),
			/never both/,
		);
	});

	it("renders plan, gate, and route facts in the approval artifact", () => {
		const plan = formatFleetRunPreviewStep({
			stepId: "architect",
			kind: "agent",
			scope: "workspace",
			agentId: "architect",
			writes: ["src"],
			target: "frontier",
			plan: { roster: ["coder", "tester"], maxTasks: 4, proposals: true },
		});
		match(plan, /target frontier/);
		match(plan, /roster coder, tester/);
		match(plan, /maxTasks 4/);
		match(plan, /proposals/);
		const gate = formatFleetRunPreviewStep({
			stepId: "acceptance",
			kind: "agent",
			scope: "workspace",
			agentId: "tester",
			writes: ["tests/acceptance.mjs"],
			profile: "local",
			gate: { path: "tests/acceptance.mjs", commandId: "acceptance" },
		});
		match(gate, /profile local/);
		match(gate, /gate path tests\/acceptance\.mjs/);
		match(gate, /run acceptance/);
		match(gate, /baseline acceptance/);
	});
});

describe("fleet gates", () => {
	it("binds a gate path as one command argv element", () => {
		const commands = parseFleetCommands(
			"version: 1\ncommands:\n  acceptance:\n    argv: [node, '{{path}}']\n",
			"commands.yaml",
		);
		const command = commands.commands.get("acceptance");
		if (command === undefined) throw new Error("missing acceptance command");
		deepStrictEqual(resolveCommandArgv(command, { path: "tests/gate file.mjs" }), ["node", "tests/gate file.mjs"]);
	});

	it("admits a red untouched-tree baseline and refuses a green one", () => {
		strictEqual(gateBaselineFailure(false), null);
		strictEqual(gateBaselineFailure(true), "gate_not_discriminating");
	});

	it("threads only FAIL lines to a loop repair", () => {
		strictEqual(gateFailureLines("setup\nFAIL first\nnoise\nFAIL second\n"), "FAIL first\nFAIL second");
	});
});

describe("delegation plan validation and splicing", () => {
	const validPlan = {
		tasks: [
			{ id: "build", agent: "coder", description: "Build", depends_on: [], writes: ["src"] },
			{ id: "test", agent: "tester", description: "Test", depends_on: ["build"], writes: ["tests"] },
		],
	};
	const validate = (value: unknown, maxTasks = 4) =>
		validateDelegationPlan({ value, roster: ["coder", "tester"], maxTasks, writes: ["src", "tests"] });

	it("names roster, cycle, count, boundary, and duplicate failures", () => {
		const reason = (value: unknown, maxTasks = 4): string => {
			const result = validate(value, maxTasks);
			return result.ok ? "ok" : result.reason;
		};
		strictEqual(reason({ tasks: [{ ...validPlan.tasks[0], agent: "scout" }] }), "delegation_plan_roster_violation");
		strictEqual(reason(validPlan, 1), "delegation_plan_over_max_tasks");
		strictEqual(
			reason({ tasks: [{ ...validPlan.tasks[0], writes: ["docs"] }] }),
			"delegation_plan_writes_outside_boundary",
		);
		strictEqual(reason({ tasks: [validPlan.tasks[0], { ...validPlan.tasks[0] }] }), "delegation_plan_duplicate_id");
		strictEqual(
			reason({
				tasks: [
					{ ...validPlan.tasks[0], depends_on: ["test"] },
					{ ...validPlan.tasks[1], depends_on: ["build"] },
				],
			}),
			"delegation_plan_dependency_cycle",
		);
		strictEqual(
			validateDelegationPlan({
				value: { tasks: [{ ...validPlan.tasks[0], writes: ["src/file.ts"] }] },
				roster: ["coder"],
				maxTasks: 1,
				writes: ["src/"],
			}).ok,
			true,
		);
	});

	it("labels proposal answers and bounds the architect briefing", () => {
		const briefing = buildDelegationProposalBriefing([
			{ agent: "coder", output: "implementation proposal" },
			{ agent: "tester", output: "validation proposal" },
		]);
		strictEqual(briefing, "PROPOSAL coder\nimplementation proposal\n\nPROPOSAL tester\nvalidation proposal");
		const bounded = buildDelegationProposalBriefing([{ agent: "coder", output: "x".repeat(20_000) }]);
		strictEqual(Buffer.byteLength(bounded, "utf8") <= DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES, true);
		strictEqual(bounded.endsWith("[truncated]"), true);
	});

	it("splices dependencies, route defaults, lineage, and the writer token", () => {
		const contract = parseFleetContract(
			source(
				5,
				[
					"  - kind: plan",
					"    id: architect",
					"    roster: [coder, tester]",
					"    maxTasks: 4",
					"    scope: workspace",
					"    writes: [src, tests]",
					"    target: frontier",
					"    dependencies: []",
				].join("\n"),
				"writers: 1",
			),
			"fleet.md",
		);
		const plan = compileFleetExecutionPlan({
			contract,
			task: "task",
			resolveAgent: () => ({
				requestedAuthority: "workspace-edit",
				approvedAuthority: "workspace-edit",
				expectedResultContract: "delegation-plan",
				executionRole: "builder",
			}),
		});
		const validated = validate(validPlan);
		if (!validated.ok) throw new Error(validated.detail);
		const spliced = spliceExecutionPlan(
			plan,
			"architect",
			validated.plan.tasks.map((task) => ({
				id: task.id,
				agentId: task.agent,
				task: task.description,
				dependencies: task.depends_on,
				writes: task.writes,
				target: "frontier",
				requestedAuthority: "workspace-edit",
				approvedAuthority: "workspace-edit",
				expectedResultContract: "mutation-report",
				executionRole: "builder",
			})),
		);
		strictEqual(spliced.writers, 1);
		deepStrictEqual(spliced.steps.find((step) => step.id === "build")?.dependencies, ["architect"]);
		deepStrictEqual(spliced.steps.find((step) => step.id === "test")?.dependencies, ["architect", "build"]);
		const build = spliced.steps.find((step) => step.id === "build");
		strictEqual(build?.kind === "agent" ? build.planParentId : null, "architect");
		strictEqual(build?.kind === "agent" ? build.target : null, "frontier");
		match(validated.hash, /^[a-f0-9]{64}$/u);
	});
});

describe("fleet v5 execution", () => {
	const roots: string[] = [];
	beforeEach(isolateDispatchState);
	afterEach(() => {
		restoreDispatchState();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	const workspace = (): string => {
		const root = gitWorkspace();
		roots.push(root);
		return root;
	};

	it("admits spliced writers through scheduler waves with lineage and dynamic boundary enforcement", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const planAnswer = JSON.stringify({
			tasks: [
				{ id: "build", agent: "coder", description: "Build", depends_on: [], writes: ["src/"] },
				{ id: "verify", agent: "tester", description: "Verify", depends_on: ["build"], writes: ["tests/"] },
			],
		});
		const spawnOrder: string[] = [];
		const settleOrder: string[] = [];
		const waveEvents: Array<{ stepId: string; waveIndex: number }> = [];
		const bundle = makeDispatchBundle(context, {
			spawnWorker(spec, opts) {
				spawnOrder.push(spec.agentId);
				if (spec.agentId === "coder") writeFileSync(join(opts?.cwd ?? "", "src", "built.ts"), "built\n");
				if (spec.agentId === "tester") writeFileSync(join(opts?.cwd ?? "", "tests", "verified.ts"), "verified\n");
				return spawnedWorker(spec.agentId === "architect" ? planAnswer : `${spec.agentId} complete`, () => {
					settleOrder.push(spec.agentId);
				});
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: plan",
						"    id: architect",
						"    roster: [coder, tester]",
						"    maxTasks: 4",
						"    scope: workspace",
						"    writes: [src/, tests/]",
						"    dependencies: []",
					].join("\n"),
					"writers: 1",
				),
				"fleet.md",
			);
			const staticPlan = compileV5(contract, agents);
			const outcome = await executeFleetRun({
				plan: staticPlan,
				contractName: contract.name,
				commands: null,
				workspaceRoot: root,
				fleetRootId: "fleet-v5-splice",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
				onStepDispatched: ({ stepId, waveIndex }) => waveEvents.push({ stepId, waveIndex }),
			});
			deepStrictEqual(spawnOrder, ["architect", "coder", "tester"], JSON.stringify([...outcome.result.results.entries()]));
			deepStrictEqual(settleOrder, ["architect", "coder", "tester"]);
			deepStrictEqual(waveEvents, [
				{ stepId: "architect", waveIndex: 0 },
				{ stepId: "build", waveIndex: 1 },
				{ stepId: "verify", waveIndex: 2 },
			]);
			const architect = outcome.receipts.find((receipt) => receipt.agentId === "architect");
			const coder = outcome.receipts.find((receipt) => receipt.agentId === "coder");
			const tester = outcome.receipts.find((receipt) => receipt.agentId === "tester");
			ok(architect && coder && tester);
			strictEqual(coder.lineage?.parentRunId, architect.runId);
			strictEqual(tester.lineage?.parentRunId, architect.runId);
			const record = readFleetRun("fleet-v5-splice");
			ok(record?.dynamicPlans?.[0]?.hash);
			strictEqual(record?.dynamicPlans?.[0]?.hash, outcome.result.results.get("architect")?.delegationPlanHash);
			if (record === null) throw new Error("fleet run record missing");
			const resumed = planFleetResume(record, staticPlan, contract, {});
			strictEqual(resumed.ok, true);
			if (resumed.ok) deepStrictEqual([...resumed.replayed.keys()], []);
			strictEqual(outcome.result.results.get("build")?.succeeded, true);
			strictEqual(outcome.result.results.get("verify")?.succeeded, true);
			deepStrictEqual(
				record.steps.map((entry) => entry.stepId),
				["architect", "build", "verify"],
			);
		} finally {
			await bundle.extension.stop?.();
		}

		const violationRoot = workspace();
		const violatingHarness = v5AgentHarness();
		const violatingAnswer = JSON.stringify({
			tasks: [{ id: "escape", agent: "coder", description: "Escape", depends_on: [], writes: ["src/"] }],
		});
		const violatingBundle = makeDispatchBundle(violatingHarness.context, {
			spawnWorker(spec, opts) {
				if (spec.agentId !== "coder") return spawnedWorker(violatingAnswer);
				const escaped = join(opts?.cwd ?? "", "outside.txt");
				writeFileSync(escaped, "outside\n");
				return spawnedWorker("escaped", undefined, [wrote(escaped)]);
			},
		});
		await violatingBundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: plan",
						"    id: architect",
						"    roster: [coder]",
						"    maxTasks: 1",
						"    scope: workspace",
						"    writes: [src/]",
						"    dependencies: []",
					].join("\n"),
					"writers: 1",
				),
				"fleet.md",
			);
			const outcome = await executeFleetRun({
				plan: compileV5(contract, violatingHarness.agents),
				contractName: contract.name,
				commands: null,
				workspaceRoot: violationRoot,
				fleetRootId: "fleet-v5-boundary",
				dispatch: violatingBundle.contract,
				agents: violatingHarness.agents,
				attributionEnabled: false,
			});
			strictEqual(outcome.result.results.get("escape")?.boundaryViolated, true);
			strictEqual(outcome.result.results.get("escape")?.succeeded, false);
			strictEqual(existsSync(join(violationRoot, "outside.txt")), false);
		} finally {
			await violatingBundle.extension.stop?.();
		}
	});

	/**
	 * The two halves of the attribution argument, differing by one bash call.
	 *
	 * Both runs write their declared path through the write tool, and in both a
	 * second tracked file changes underneath them. The run that only used tools
	 * whose arguments name their targets has a closed write record, so the file
	 * it never wrote survives. The run that also shelled out could have written
	 * anywhere, so its record clears nothing and the same change is rolled back
	 * exactly as it was before any of this.
	 */
	const concurrentChangeRun = async (
		fleetRootId: string,
		extraCalls: ReadonlyArray<FixtureToolCall>,
	): Promise<{ root: string; outcome: Awaited<ReturnType<typeof executeFleetRun>> }> => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const bundle = makeDispatchBundle(context, {
			spawnWorker(spec, opts) {
				const cwd = opts?.cwd ?? "";
				const declared = join(cwd, "src", "built.ts");
				writeFileSync(declared, "built\n");
				// An operator editing a tracked file in the same checkout while the
				// wave runs. No tool call is emitted for it, because the step is not
				// what changed it.
				writeFileSync(join(cwd, "tests", ".keep"), "the operator's uncommitted edit\n");
				return spawnedWorker(`${spec.agentId} complete`, undefined, [wrote(declared), ...extraCalls]);
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: agent",
						"    id: build",
						"    agent: coder",
						"    scope: workspace",
						"    writes: [src/]",
						"    dependencies: []",
					].join("\n"),
					"writers: 1",
				),
				"fleet.md",
			);
			const outcome = await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands: null,
				workspaceRoot: root,
				fleetRootId,
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
			});
			return { root, outcome };
		} finally {
			await bundle.extension.stop?.();
		}
	};

	it("leaves a file that changed under a step but that the step never wrote", async () => {
		const { root, outcome } = await concurrentChangeRun("fleet-v5-concurrent", []);

		strictEqual(outcome.result.results.get("build")?.boundaryViolated, undefined);
		strictEqual(outcome.result.results.get("build")?.succeeded, true);
		// The edit survives the run. Before this, it was restored from the
		// baseline commit and the operator's work was gone.
		strictEqual(readFileSync(join(root, "tests", ".keep"), "utf8"), "the operator's uncommitted edit\n");
	});

	it("rolls that same change back when the step also shelled out, because its record is a lower bound", async () => {
		const { root, outcome } = await concurrentChangeRun("fleet-v5-concurrent-opaque", [ran("npm run build")]);

		// One bash call to a clean exit and the run can no longer clear anything:
		// enforcement is exactly as strong here as it was before attribution.
		strictEqual(outcome.result.results.get("build")?.boundaryViolated, true);
		strictEqual(outcome.result.results.get("build")?.succeeded, false);
		strictEqual(readFileSync(join(root, "tests", ".keep"), "utf8"), "tests\n");
	});

	it("refuses an architect task outside the roster without dispatching it", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const spawns: WorkerSpec[] = [];
		const bundle = makeDispatchBundle(context, {
			spawnWorker(spec) {
				spawns.push(spec);
				return spawnedWorker(
					JSON.stringify({
						tasks: [{ id: "bad", agent: "tester", description: "Bad", depends_on: [], writes: ["src/"] }],
					}),
				);
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: plan",
						"    id: architect",
						"    roster: [coder]",
						"    maxTasks: 2",
						"    scope: workspace",
						"    writes: [src/]",
						"    dependencies: []",
					].join("\n"),
				),
				"fleet.md",
			);
			const outcome = await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands: null,
				workspaceRoot: root,
				fleetRootId: "fleet-v5-roster",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
			});
			strictEqual(outcome.result.results.get("architect")?.failureReason, "delegation_plan_roster_violation");
			strictEqual(spawns.length, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("seals a red gate and threads only FAIL lines through a gate-checked loop", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const gateBytes = [
			'import { existsSync } from "node:fs";',
			'if (existsSync("src/fixed.txt")) process.exit(0);',
			'console.log("setup noise");',
			'console.log("FAIL first acceptance fact");',
			'console.log("FAIL second acceptance fact");',
			"process.exit(1);",
			"",
		].join("\n");
		const spawns: WorkerSpec[] = [];
		const bundle = makeDispatchBundle(context, {
			spawnWorker(spec, opts) {
				spawns.push(spec);
				if (spec.agentId === "tester") writeFileSync(join(opts?.cwd ?? "", "tests", "acceptance.mjs"), gateBytes);
				if (spec.agentId === "coder") writeFileSync(join(opts?.cwd ?? "", "src", "fixed.txt"), "fixed\n");
				return spawnedWorker("complete");
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: gate",
						"    id: acceptance",
						"    agent: tester",
						"    path: tests/acceptance.mjs",
						"    run: acceptance",
						"    dependencies: []",
						"  - kind: loop",
						"    id: repair",
						"    maxAttempts: 2",
						"    dependencies: [acceptance]",
						"    check: {kind: gate, gate: acceptance}",
						"    repair: {kind: agent, agent: coder, scope: workspace, writes: [src/]}",
					].join("\n"),
				),
				"fleet.md",
			);
			const commands = parseFleetCommands(
				"version: 1\ncommands:\n  acceptance:\n    argv: [node, '{{path}}']\n",
				"commands.yaml",
			);
			const outcome = await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands,
				workspaceRoot: root,
				fleetRootId: "fleet-v5-gate",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
			});
			strictEqual(
				outcome.cleanRun,
				true,
				JSON.stringify({ results: [...outcome.result.results.entries()], loops: outcome.result.loops }),
			);
			const gateReceipt = outcome.receipts.find((receipt) => receipt.agentId === "tester");
			deepStrictEqual(gateReceipt?.fleetGate, {
				path: "tests/acceptance.mjs",
				pathHash: createHash("sha256").update(gateBytes).digest("hex"),
			});
			const repair = spawns.find((spec) => spec.agentId === "coder");
			const repairBriefing = (repair?.dynamicPromptMessages ?? []).map((message) => message.body).join("\n");
			match(repairBriefing, /FAIL first acceptance fact/);
			match(repairBriefing, /FAIL second acceptance fact/);
			strictEqual(repairBriefing.includes("setup noise"), false);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("fails a green untouched-tree gate as not discriminating", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const bundle = makeDispatchBundle(context, {
			spawnWorker(_spec, opts) {
				writeFileSync(join(opts?.cwd ?? "", "tests", "green.mjs"), "process.exit(0);\n");
				return spawnedWorker("complete");
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: gate",
						"    id: acceptance",
						"    agent: tester",
						"    path: tests/green.mjs",
						"    run: acceptance",
						"    dependencies: []",
					].join("\n"),
				),
				"fleet.md",
			);
			const commands = parseFleetCommands(
				"version: 1\ncommands:\n  acceptance:\n    argv: [node, '{{path}}']\n",
				"commands.yaml",
			);
			const settled: Array<{ stepId: string; succeeded: boolean; failureReason?: string }> = [];
			const notices: string[] = [];
			const outcome = await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands,
				workspaceRoot: root,
				fleetRootId: "fleet-v5-green-gate",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
				onStepSettled(step) {
					settled.push({
						stepId: step.stepId,
						succeeded: step.succeeded,
						...(step.failureReason !== undefined ? { failureReason: step.failureReason } : {}),
					});
				},
				onNotice(text) {
					notices.push(text);
				},
			});
			strictEqual(outcome.result.results.get("acceptance")?.failureReason, "gate_not_discriminating");
			strictEqual(outcome.cleanRun, false);
			// The operator-facing settlement carries the same verdict as the
			// sealed result: the receipt succeeded, the step did not.
			deepStrictEqual(settled, [{ stepId: "acceptance", succeeded: false, failureReason: "gate_not_discriminating" }]);
			ok(
				notices.some((text) => text.startsWith("step acceptance tester: failed reason=gate_not_discriminating ")),
				notices.join("\n"),
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("runs labelled read-only proposals before the architect", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const spawns: WorkerSpec[] = [];
		const bundle = makeDispatchBundle(context, {
			spawnWorker(spec) {
				spawns.push(spec);
				if (spawns.length === 1) return spawnedWorker("coder proposal");
				if (spawns.length === 2) return spawnedWorker("tester proposal");
				if (spec.agentId === "architect") {
					return spawnedWorker(
						JSON.stringify({
							tasks: [{ id: "inspect", agent: "coder", description: "Inspect", depends_on: [], writes: [] }],
						}),
					);
				}
				return spawnedWorker("inspected");
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(
					5,
					[
						"  - kind: plan",
						"    id: architect",
						"    roster: [coder, tester]",
						"    maxTasks: 2",
						"    proposals: true",
						"    scope: workspace",
						"    writes: [src/, tests/]",
						"    dependencies: []",
					].join("\n"),
				),
				"fleet.md",
			);
			await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands: null,
				workspaceRoot: root,
				fleetRootId: "fleet-v5-proposals",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
			});
			deepStrictEqual(
				spawns.slice(0, 3).map((spec) => spec.agentId),
				["coder", "tester", "architect"],
			);
			strictEqual(spawns[0]?.autonomy, "read-only");
			strictEqual(spawns[1]?.autonomy, "read-only");
			const briefing = (spawns[2]?.dynamicPromptMessages ?? []).map((message) => message.body).join("\n");
			match(briefing, /PROPOSAL coder/);
			match(briefing, /PROPOSAL tester/);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

/**
 * `assignments.json` is the row an operator and any automation reads to ask
 * whether a run worked. A fleet gathers every step under one lineage root, so
 * every agent step used to settle that row on its own receipt: the last step to
 * finish wrote the verdict, and code steps never entered the record at all.
 * These cover the three shapes that were reported `succeeded` and were not.
 */
describe("fleet assignment ledger", () => {
	const roots: string[] = [];
	beforeEach(isolateDispatchState);
	afterEach(() => {
		restoreDispatchState();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	const workspace = (): string => {
		const root = gitWorkspace();
		roots.push(root);
		return root;
	};

	const codeCommands = (): ReturnType<typeof parseFleetCommands> =>
		parseFleetCommands(
			["version: 1", "commands:", "  ok:", '    argv: ["true"]', "  bad:", '    argv: ["false"]', ""].join("\n"),
			"commands.yaml",
		);

	const codeStep = (id: string, command: string, dependencies: string): string =>
		[
			"  - kind: code",
			`    id: ${id}`,
			`    command: ${command}`,
			"    scope: readonly",
			`    dependencies: ${dependencies}`,
		].join("\n");

	const BUILDER = [
		"  - kind: agent",
		"    id: build",
		"    agent: coder",
		"    scope: workspace",
		"    writes: [src/]",
		"    dependencies: []",
	].join("\n");

	it("records every step of a green fleet and settles the row succeeded", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const bundle = makeDispatchBundle(context, {
			spawnWorker(_spec, opts) {
				const declared = join(opts?.cwd ?? "", "src", "built.ts");
				writeFileSync(declared, "built\n");
				return spawnedWorker("built", undefined, [wrote(declared)]);
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(5, [BUILDER, codeStep("verify", "ok", "[build]")].join("\n")),
				"fleet.md",
			);
			const outcome = await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands: codeCommands(),
				workspaceRoot: root,
				fleetRootId: "fleet-ledger-green",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
			});
			strictEqual(outcome.cleanRun, true, JSON.stringify([...outcome.result.results.entries()]));
			await bundle.contract.assignments?.flushWrites?.();
			const stored = getStoredAssignment("fleet-ledger-green");
			strictEqual(stored?.status, "succeeded");
			strictEqual(stored?.verdictOwner, "fleet");
			// Both kinds of step are in the record: the agent's receipt id and the
			// deterministic step's `code-*` run id, whose report is durable under
			// code-steps/fleet-ledger-green/.
			const agentRunId = outcome.receipts[0]?.runId;
			ok(agentRunId !== undefined && stored.attempts.includes(agentRunId), JSON.stringify(stored.attempts));
			ok(
				stored.attempts.some((runId) => runId.startsWith("code-")),
				JSON.stringify(stored.attempts),
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("fails the row when a code step fails after every agent step went green", async () => {
		const root = workspace();
		const { context, agents } = v5AgentHarness();
		const bundle = makeDispatchBundle(context, {
			spawnWorker(_spec, opts) {
				const declared = join(opts?.cwd ?? "", "src", "built.ts");
				writeFileSync(declared, "built\n");
				return spawnedWorker("built", undefined, [wrote(declared)]);
			},
		});
		await bundle.extension.start();
		try {
			const contract = parseFleetContract(
				source(5, [BUILDER, codeStep("verify", "bad", "[build]")].join("\n")),
				"fleet.md",
			);
			const outcome = await executeFleetRun({
				plan: compileV5(contract, agents),
				contractName: contract.name,
				commands: codeCommands(),
				workspaceRoot: root,
				fleetRootId: "fleet-ledger-red-code",
				dispatch: bundle.contract,
				agents,
				attributionEnabled: false,
			});
			strictEqual(outcome.result.results.get("build")?.succeeded, true);
			strictEqual(outcome.result.results.get("verify")?.succeeded, false);
			strictEqual(outcome.cleanRun, false);
			await bundle.contract.assignments?.flushWrites?.();
			const stored = getStoredAssignment("fleet-ledger-red-code");
			strictEqual(stored?.status, "failed");
			// The green agent step is filed as an attempt and still does not decide
			// the row, whichever order the two writes land in.
			const agentRunId = outcome.receipts[0]?.runId;
			ok(agentRunId !== undefined && stored.attempts.includes(agentRunId), JSON.stringify(stored.attempts));
			await settleStoredAssignment("fleet-ledger-red-code", String(agentRunId), "succeeded");
			strictEqual(getStoredAssignment("fleet-ledger-red-code")?.status, "failed");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("fails the row for a fleet that stopped before its last step and for one that threw", async () => {
		const stub = { abort() {} } as unknown as DispatchContract;
		const stoppedContract = parseFleetContract(
			source(
				5,
				[codeStep("first", "ok", "[]"), codeStep("second", "bad", "[first]"), codeStep("third", "ok", "[second]")].join(
					"\n",
				),
			),
			"fleet.md",
		);
		const stoppedPlan = compileV5(stoppedContract, v5AgentHarness().agents);
		const stopped = await executeFleetRun({
			plan: stoppedPlan,
			contractName: stoppedContract.name,
			commands: codeCommands(),
			workspaceRoot: workspace(),
			fleetRootId: "fleet-ledger-stopped",
			dispatch: stub,
			agents: { getSpec: () => null },
			attributionEnabled: false,
		});
		strictEqual(stopped.cleanRun, false);
		strictEqual(stoppedPlan.steps.length, 3);
		// The run halted under `onFailure: stop`, so its last step has no result at
		// all. That is the shape that used to be reported succeeded.
		deepStrictEqual(
			readFleetRun("fleet-ledger-stopped")?.steps.map((entry) => entry.stepId),
			["first", "second"],
		);
		strictEqual(getStoredAssignment("fleet-ledger-stopped")?.status, "failed");

		const thrownContract = parseFleetContract(source(5, codeStep("only", "ok", "[]")), "fleet.md");
		await rejects(
			executeFleetRun({
				plan: compileV5(thrownContract, v5AgentHarness().agents),
				contractName: thrownContract.name,
				// No registry, so the step's command cannot be resolved and the
				// scheduler throws rather than returning a result.
				commands: null,
				workspaceRoot: workspace(),
				fleetRootId: "fleet-ledger-thrown",
				dispatch: stub,
				agents: { getSpec: () => null },
				attributionEnabled: false,
			}),
			/has no registered command/,
		);
		strictEqual(getStoredAssignment("fleet-ledger-thrown")?.status, "failed");
	});
});
