/**
 * Every fleet-facing cost render must consult the provenance sealed beside the
 * amount.
 *
 * A receipt honestly seals `costUsd: 0` with `costProvenance: "unknown"` when
 * no catalog and no `pricing:` block could price the wire model: the tokens
 * were counted and nobody put a number on them. The fleet surfaces used to
 * render only the amount, through `toFixed(4)`, and told an operator `$0.0000`.
 * That is a measured zero, a claim nobody made, and it is indistinguishable on
 * the line from work that genuinely cost nothing.
 *
 * Both directions are pinned here on purpose. A one-sided test passes for a
 * renderer that hardcodes "not measured" as easily as for a correct one.
 */

import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { statusSnapshot } from "../../src/cli/fleet.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { parseFleetContract } from "../../src/domains/agents/fleet-contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";
import { executeFleetRun, type FleetRunStepOutcome } from "../../src/domains/dispatch/fleet-run.js";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { COST_NOT_MEASURED, renderCostAggregate, renderCostAmount } from "../../src/domains/observability/cost.js";
import { agentRecipeFixture } from "../harness/agent-recipe.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

/**
 * Rates are per million tokens, so the fixture's {@link WORKER_OUTPUT_TOKENS}
 * price a run at a round $0.50. The rate is deliberately small: admission
 * prices its upper bound against `defaults.maxTokens` (32768) and refuses a
 * reservation at the $5 ceiling, so a rate large enough to be eye-catching
 * never reaches a receipt at all.
 */
const VISIBLE_PRICING = { input: 0, output: 100 } as const;

/** Enough output tokens that the priced case renders a figure no rounding hides. */
const WORKER_OUTPUT_TOKENS = 5_000;

function settingsForTarget(pricing?: { input: number; output: number }): typeof DEFAULT_SETTINGS {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{
			id: "mini",
			runtime: "llamacpp",
			url: "http://mini:8080",
			// A gateway alias no provider catalog knows, which is what makes the
			// unpriced case here the same case the operator hit.
			defaultModel: "fleet-model",
			maxConcurrentRequests: 1,
			...(pricing === undefined ? {} : { pricing }),
		},
	];
	settings.workers.default.target = "mini";
	settings.workers.default.model = "fleet-model";
	return settings;
}

function agentHarness(settings: typeof DEFAULT_SETTINGS): {
	context: ReturnType<typeof dispatchStubContext>;
	agents: AgentsContract;
} {
	const context = dispatchStubContext({ settings, agentTools: [ToolNames.Read, ToolNames.Write, ToolNames.Edit] });
	const recipes: AgentRecipe[] = [
		agentRecipeFixture({
			id: "coder",
			name: "coder",
			description: "cost provenance fixture",
			tools: [ToolNames.Read, ToolNames.Write, ToolNames.Edit],
			toolRequirements: { required: [ToolNames.Read, ToolNames.Write, ToolNames.Edit], optional: [] },
			capabilityClass: "workspace-edit",
			resultContract: { kind: "artifact-report" },
			filepath: "/test/coder.md",
		}),
	];
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

function spawnedWorker(): SpawnedWorker {
	return {
		pid: 700,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events: (async function* () {
			yield {
				type: "message_end",
				message: { role: "assistant", content: "inspected", usage: { input: 0, output: WORKER_OUTPUT_TOKENS } },
			};
		})(),
		abort() {},
		heartbeatAt: { current: Date.now() },
	};
}

function gitWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-fleet-cost-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", ".keep"), "src\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Fleet Test"], { cwd: root });
	execFileSync("git", ["config", "user.email", "fleet@example.test"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
	const commit = execFileSync("git", ["commit-tree", tree, "-m", "baseline"], { cwd: root, encoding: "utf8" }).trim();
	execFileSync("git", ["update-ref", "HEAD", commit], { cwd: root });
	return root;
}

const READONLY_FLEET = [
	"---",
	"version: 5",
	"name: costcheck",
	"steps:",
	"  - kind: agent",
	"    id: inspect",
	"    agent: coder",
	"    scope: readonly",
	"    dependencies: []",
	"maxWorkers: 4",
	"onFailure: stop",
	"---",
	"Inspect the workspace.",
].join("\n");

interface FleetProbe {
	settled: FleetRunStepOutcome[];
	notices: string[];
	summary: string;
}

/** Drives one real readonly fleet step and captures everything an operator would read. */
async function runProbeFleet(pricing?: { input: number; output: number }): Promise<FleetProbe> {
	const root = gitWorkspace();
	const { context, agents } = agentHarness(settingsForTarget(pricing));
	const bundle = makeDispatchBundle(context, { spawnWorker: () => spawnedWorker() });
	await bundle.extension.start();
	try {
		const contract = parseFleetContract(READONLY_FLEET, "fleet.md");
		const settled: FleetRunStepOutcome[] = [];
		const notices: string[] = [];
		const outcome = await executeFleetRun({
			plan: compileFleetExecutionPlan({
				contract,
				task: "Inspect the workspace.",
				resolveAgent(resolution) {
					const spec = agents.getSpec(resolution.agentId);
					if (spec === null) throw new Error(`missing agent '${resolution.agentId}'`);
					return {
						// The single fixture recipe is a workspace editor; the step is
						// readonly, so nothing here needs the wider resolver v5 uses.
						requestedAuthority: "workspace-edit",
						approvedAuthority: "workspace-edit",
						expectedResultContract: spec.resultContract.kind,
						executionRole: "builder",
					};
				},
			}),
			contractName: contract.name,
			commands: null,
			workspaceRoot: root,
			fleetRootId: `fleet-cost-${pricing === undefined ? "unpriced" : "priced"}`,
			dispatch: bundle.contract,
			agents,
			attributionEnabled: false,
			onStepSettled: (step) => settled.push(step),
			onNotice: (text) => notices.push(text),
		});
		// The exact string `src/cli/fleet.ts` prints for the run summary.
		return { settled, notices, summary: `total cost ${renderCostAggregate(outcome.totalCost)}` };
	} finally {
		await bundle.extension.stop?.();
		rmSync(root, { recursive: true, force: true });
	}
}

async function withIsolatedClioHome<T>(fn: (scratch: string) => T | Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const scratch = await newScratchClioHome("clio-fleet-cost-");
	return Promise.resolve()
		.then(() => fn(scratch))
		.finally(() => {
			for (const key of Object.keys(process.env)) {
				if (!(key in originalEnv)) Reflect.deleteProperty(process.env, key);
			}
			for (const [key, value] of Object.entries(originalEnv)) {
				if (value !== undefined) process.env[key] = value;
			}
			clearScratchClioHome(scratch);
		});
}

function ledgerRow(overrides: Partial<RunEnvelope> & { id: string }): RunEnvelope {
	return {
		agentId: "coder",
		executionRole: "builder",
		task: "test task",
		targetId: "mini",
		wireModelId: "code",
		runtimeId: "openai-completions",
		runtimeKind: "http",
		startedAt: "2026-06-12T00:00:00.000Z",
		endedAt: "2026-06-12T00:00:10.000Z",
		status: "completed",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/tmp",
		tokenCount: 16_319,
		costUsd: 0,
		...overrides,
	};
}

describe("contracts/fleet-cost-provenance", () => {
	describe("the shared derivation", () => {
		it("renders an unpriced amount as not measured and a priced one as dollars", () => {
			strictEqual(renderCostAmount(0, "unknown"), COST_NOT_MEASURED);
			strictEqual(renderCostAmount(0, undefined), COST_NOT_MEASURED);
			strictEqual(renderCostAmount(0.42, "known"), "$0.42");
			strictEqual(renderCostAmount(0.0034, "known"), "$0.0034");
		});

		it("keeps a genuinely free call distinct from an unpriced one", () => {
			// Both carry `costUsd: 0`. Only one of them was measured, and an
			// operator who gives a self-hosted gateway a zero `pricing:` block is
			// asking for exactly this second line.
			strictEqual(renderCostAmount(0, "unknown"), COST_NOT_MEASURED);
			strictEqual(renderCostAmount(0, "known_free"), "$0.00 local");
		});

		it("folds a total rather than summing unpriced zeros into priced dollars", () => {
			strictEqual(
				renderCostAggregate({ knownUsd: 0, hasEstimated: false, hasUnknown: true, allKnownFree: false, calls: 2 }),
				COST_NOT_MEASURED,
			);
			strictEqual(
				renderCostAggregate({ knownUsd: 1.5, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 2 }),
				"$1.50",
			);
			// Nothing priced at all is the absence of a claim, not zero dollars.
			strictEqual(
				renderCostAggregate({ knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 0 }),
				COST_NOT_MEASURED,
			);
		});
	});

	describe("a fleet run", () => {
		beforeEach(isolateDispatchState);
		afterEach(restoreDispatchState);

		it("renders an unpriced step and total as not measured, never as $0.0000", async () => {
			const probe = await runProbeFleet();
			const step = probe.settled[0];
			ok(step, "the readonly step settled");
			strictEqual(step.costUsd, 0);
			strictEqual(step.costProvenance, "unknown");

			const line = probe.notices.find((text) => text.startsWith("step inspect coder:"));
			ok(line, `the step notice was emitted: ${probe.notices.join(" | ")}`);
			match(line, /cost=not measured$/u);
			doesNotMatch(line, /\$0\.0000/u);

			strictEqual(probe.summary, `total cost ${COST_NOT_MEASURED}`);
		});

		it("renders a priced step and total as a dollar amount", async () => {
			const probe = await runProbeFleet(VISIBLE_PRICING);
			const step = probe.settled[0];
			ok(step, "the readonly step settled");
			strictEqual(step.costProvenance, "known");
			ok(step.costUsd > 0, `a priced route sealed a nonzero cost, got ${step.costUsd}`);

			const line = probe.notices.find((text) => text.startsWith("step inspect coder:"));
			ok(line, `the step notice was emitted: ${probe.notices.join(" | ")}`);
			match(line, /cost=\$0\.50$/u);

			strictEqual(probe.summary, "total cost $0.50");
		});
	});

	describe("fleet status", () => {
		it("folds unpriced ledger rows into an absent cost claim and carries their provenance", async () => {
			await withIsolatedClioHome(async (scratch) => {
				const stateDir = join(scratch, "state");
				mkdirSync(stateDir, { recursive: true });
				writeFileSync(
					join(stateDir, "runs.json"),
					JSON.stringify([
						ledgerRow({ id: "unpriced00001", costProvenance: "unknown" }),
						// A pre-provenance row, which readers must treat as unknown.
						ledgerRow({ id: "unpriced00002", status: "running", endedAt: null }),
					]),
				);
				const snapshot = statusSnapshot();
				strictEqual(snapshot.totals.cost.calls, 2);
				strictEqual(snapshot.totals.cost.hasUnknown, true);
				strictEqual(renderCostAggregate(snapshot.totals.cost), COST_NOT_MEASURED);
				strictEqual(snapshot.running[0]?.costProvenance, undefined);
				strictEqual(
					renderCostAmount(snapshot.running[0]?.costUsd as number, snapshot.running[0]?.costProvenance as undefined),
					COST_NOT_MEASURED,
				);
			});
		});

		it("still reports priced ledger rows as dollars", async () => {
			await withIsolatedClioHome(async (scratch) => {
				const stateDir = join(scratch, "state");
				mkdirSync(stateDir, { recursive: true });
				writeFileSync(
					join(stateDir, "runs.json"),
					JSON.stringify([
						ledgerRow({ id: "priced0000001", costUsd: 0.25, costProvenance: "known" }),
						ledgerRow({ id: "priced0000002", status: "running", endedAt: null, costUsd: 1.25, costProvenance: "known" }),
					]),
				);
				const snapshot = statusSnapshot();
				strictEqual(renderCostAggregate(snapshot.totals.cost), "$1.50");
				strictEqual(snapshot.running[0]?.costProvenance, "known");
				strictEqual(
					renderCostAmount(snapshot.running[0]?.costUsd as number, snapshot.running[0]?.costProvenance as "known"),
					"$1.25",
				);
			});
		});
	});

	/**
	 * The two CLI step and status lines are inline template literals inside
	 * non-exported closures, so nothing above can call them. This reads the
	 * source instead: any cost formatted without going through the shared
	 * derivation is the defect returning, whatever the surrounding text says.
	 */
	it("leaves no fleet render site formatting a cost by hand", () => {
		for (const path of ["src/cli/fleet.ts", "src/domains/dispatch/fleet-run.ts"]) {
			const source = readFileSync(join(process.cwd(), path), "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				if (!/cost/iu.test(line)) continue;
				doesNotMatch(
					line,
					/cost[A-Za-z]*(\s+as\s+number\))?\.toFixed\(/u,
					`${path}:${index + 1} formats a cost without consulting its provenance`,
				);
			}
		}
	});
});
