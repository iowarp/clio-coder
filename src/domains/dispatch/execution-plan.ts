import { createHash } from "node:crypto";
import type { ResultContract } from "../agents/result-contract.js";
import type { AgentAutomationAuthority } from "../agents/spec.js";
import type { ExecutionRole } from "./execution-role.js";

export type ExecutionPlanTopology = "parallel" | "sequential" | "pipeline" | "review" | "compete" | "fleet";
export type ExecutionPlanScope = "readonly" | "workspace";
export type ExecutionPlanFailurePolicy = "stop" | "continue";

/**
 * Membership of one statically unrolled bounded loop.
 *
 * A loop in a fleet contract compiles to `maxAttempts` conditional check nodes
 * and `maxAttempts - 1` conditional repair nodes. Unrolling rather than
 * interpreting keeps the plan a deterministic hashed DAG whose waves are
 * computed once and whose every attempt owns a separate receipt; the only
 * runtime decision is whether a declared node is still needed.
 */
export interface ExecutionPlanLoopMembership {
	loopId: string;
	role: "check" | "repair";
	/** 1-based attempt ordinal within the loop. */
	attempt: number;
}

/** Declared loop, sealed in the plan hash beside the nodes it unrolled to. */
export interface ExecutionPlanLoop {
	id: string;
	/** What decides continuation: a command's exit code or a gate agent's verdict. */
	checkKind: "code" | "agent";
	maxAttempts: number;
	/** Unrolled check node ids, attempt order. */
	checkStepIds: ReadonlyArray<string>;
	/** Unrolled repair node ids, attempt order; one shorter than the checks. */
	repairStepIds: ReadonlyArray<string>;
}

/** A plan node a model executes. Authority, role, and route are all its own. */
export interface ExecutionPlanAgentStep {
	kind: "agent";
	id: string;
	agentId: string;
	executionRole: ExecutionRole;
	scope: ExecutionPlanScope;
	expectedResultContract: ResultContract["kind"];
	requestedAuthority: AgentAutomationAuthority;
	/** Required explicit grant; null means the plan is an approval request and cannot execute. */
	approvedAuthority: AgentAutomationAuthority | null;
	dependencies: ReadonlyArray<string>;
	task: string;
	/** Set on nodes a bounded loop unrolled to. */
	loop?: ExecutionPlanLoopMembership;
	/**
	 * Declared write boundary, sealed in the plan hash. An empty array is the
	 * checkable claim "this step changes nothing"; `undefined` is a plan whose
	 * contract declares no boundary at all and is therefore not enforced.
	 */
	writes?: ReadonlyArray<string>;
}

/**
 * A plan node code executes. It names a repo-registered command id and carries
 * no execution role, no authority grant, and no route: it is a subprocess, not
 * a model run, so it never consumes a worker capacity lease and never reaches
 * route history or the routing quality reducer.
 */
export interface ExecutionPlanCodeStep {
	kind: "code";
	id: string;
	commandId: string;
	scope: ExecutionPlanScope;
	dependencies: ReadonlyArray<string>;
	loop?: ExecutionPlanLoopMembership;
	/**
	 * This node's green result measures the workspace at the moment it ran. Any
	 * later step that can change the workspace makes that result stale, and the
	 * scheduler re-runs the node before a dependent may treat it as verified.
	 */
	verification?: boolean;
	/**
	 * Commit node. Candidate step ids, most recent first; the message is the
	 * first candidate that ran and authored one. A commit and a verification
	 * both leave the tree they act on unchanged, so neither invalidates a green.
	 */
	commitFrom?: ReadonlyArray<string>;
	/** Declared write boundary; see `ExecutionPlanAgentStep.writes`. */
	writes?: ReadonlyArray<string>;
}

export type ExecutionPlanStep = ExecutionPlanAgentStep | ExecutionPlanCodeStep;

/** Agent steps may omit the discriminant; it normalizes to "agent". */
export type ExecutionPlanStepInput =
	| (Omit<ExecutionPlanAgentStep, "kind"> & { kind?: "agent" })
	| ExecutionPlanCodeStep;

export interface ExecutionPlan {
	/**
	 * v4 adds bounded loops, verification staleness, and commit nodes; v3 added
	 * the step-kind discriminant and v2 plans were agent-only. A reader that
	 * does not understand loop membership would treat every unrolled node as
	 * unconditional and run every declared attempt, so the version is a refusal
	 * point rather than an optional field.
	 */
	version: 4;
	topology: ExecutionPlanTopology;
	rootTask: string;
	maxWorkers: number;
	/** Serialize writer admission when set. The only supported value in this cut is one. */
	writers?: 1;
	onFailure: ExecutionPlanFailurePolicy;
	steps: ReadonlyArray<ExecutionPlanStep>;
	loops: ReadonlyArray<ExecutionPlanLoop>;
	waves: ReadonlyArray<ReadonlyArray<string>>;
	hash: string;
}
export type ExecutionPlanInput = Omit<ExecutionPlan, "version" | "waves" | "hash" | "steps" | "loops"> & {
	steps: ReadonlyArray<ExecutionPlanStepInput>;
	loops?: ReadonlyArray<ExecutionPlanLoop>;
};

export function isCodeStep(step: ExecutionPlanStep): step is ExecutionPlanCodeStep {
	return step.kind === "code";
}
export function isAgentStep(step: ExecutionPlanStep): step is ExecutionPlanAgentStep {
	return step.kind === "agent";
}

/**
 * Narrow a plan to agent steps, refusing one that carries a code node. Callers
 * that model every step as a route (Scout continuation, the dispatch tool's
 * resolved plan artifact) use this so a code step can never be silently
 * projected into a route it does not have.
 */
export function requireAgentSteps(steps: ReadonlyArray<ExecutionPlanStep>): ExecutionPlanAgentStep[] {
	return steps.map((step) => {
		if (step.kind === "code") throw new Error(`execution plan: step '${step.id}' is a code step and has no route`);
		return step;
	});
}

function canonicalSteps(steps: ReadonlyArray<ExecutionPlanStepInput>): ExecutionPlanStep[] {
	return steps.map((step) =>
		step.kind === "code"
			? { ...step, kind: "code" as const, dependencies: [...step.dependencies].sort() }
			: { ...step, kind: "agent" as const, dependencies: [...step.dependencies].sort() },
	);
}

export function executionPlanWaves(
	steps: ReadonlyArray<{ id: string; dependencies: ReadonlyArray<string>; kind?: "agent" | "code" }>,
	maxWorkers: number,
): string[][] {
	if (!Number.isInteger(maxWorkers) || maxWorkers < 1)
		throw new Error("execution plan: maxWorkers must be a positive integer");
	if (steps.length === 0) throw new Error("execution plan: plan must contain at least one step");
	const ids = new Set<string>();
	for (const step of steps) {
		if (step.id.trim().length === 0) throw new Error("execution plan: step id must be non-empty");
		if (ids.has(step.id)) throw new Error(`execution plan: duplicate step id '${step.id}'`);
		ids.add(step.id);
	}
	for (const step of steps)
		for (const dependency of step.dependencies) {
			if (!ids.has(dependency))
				throw new Error(`execution plan: step '${step.id}' has missing dependency '${dependency}'`);
			if (dependency === step.id) throw new Error(`execution plan: cycle includes '${step.id}'`);
		}
	const remaining = new Set(steps.map((step) => step.id));
	const completed = new Set<string>();
	const waves: string[][] = [];
	while (remaining.size > 0) {
		const ready = steps.filter((step) => remaining.has(step.id) && step.dependencies.every((id) => completed.has(id)));
		if (ready.length === 0) throw new Error("execution plan: dependency cycle detected");
		// maxWorkers bounds concurrent model runs. Code steps hold no worker
		// capacity lease, so they ride the first chunk of their ready set without
		// displacing an agent step or forcing an extra wave.
		const codeReady = ready.filter((step) => step.kind === "code").map((step) => step.id);
		const agentReady = ready.filter((step) => step.kind !== "code").map((step) => step.id);
		const chunks: string[][] = [];
		for (let offset = 0; offset < agentReady.length; offset += maxWorkers) {
			chunks.push(agentReady.slice(offset, offset + maxWorkers));
		}
		if (chunks.length === 0) chunks.push([]);
		chunks[0] = [...codeReady, ...(chunks[0] ?? [])];
		for (const wave of chunks) {
			waves.push(wave);
			for (const id of wave) {
				remaining.delete(id);
				completed.add(id);
			}
		}
	}
	return waves;
}

/** Reject a loop whose declared membership does not match the compiled nodes. */
function checkLoops(steps: ReadonlyArray<ExecutionPlanStep>, loops: ReadonlyArray<ExecutionPlanLoop>): void {
	const byId = new Map(steps.map((step) => [step.id, step]));
	const seen = new Set<string>();
	for (const loop of loops) {
		if (seen.has(loop.id)) throw new Error(`execution plan: duplicate loop id '${loop.id}'`);
		seen.add(loop.id);
		if (!Number.isInteger(loop.maxAttempts) || loop.maxAttempts < 1) {
			throw new Error(`execution plan: loop '${loop.id}' must declare a positive attempt bound`);
		}
		if (loop.checkStepIds.length !== loop.maxAttempts || loop.repairStepIds.length !== loop.maxAttempts - 1) {
			throw new Error(`execution plan: loop '${loop.id}' membership does not match its bound of ${loop.maxAttempts}`);
		}
		for (const id of [...loop.checkStepIds, ...loop.repairStepIds]) {
			const step = byId.get(id);
			if (step === undefined) throw new Error(`execution plan: loop '${loop.id}' names unknown step '${id}'`);
			if (step.loop?.loopId !== loop.id) {
				throw new Error(`execution plan: step '${id}' is not a member of loop '${loop.id}'`);
			}
		}
	}
	for (const step of steps) {
		if (step.loop !== undefined && !seen.has(step.loop.loopId)) {
			throw new Error(`execution plan: step '${step.id}' belongs to undeclared loop '${step.loop.loopId}'`);
		}
	}
}

/**
 * Whether a wave's declared boundaries can be enforced honestly.
 *
 * Every step in a wave shares one checkout, and Clio gives a fleet step no
 * private worktree, so a path that changed while two steps ran cannot be
 * attributed to one of them. Two rules follow, and both are refusals at compile
 * time rather than surprises at enforcement time:
 *
 *   - A wave is enforced or it is not. One step with an undeclared boundary
 *     beside a step that declared one means every change is potentially the
 *     undeclared step's, which silently disables enforcement for its neighbour.
 *   - At most one step per wave may declare a non-empty allowlist. Disjoint
 *     allowlists do not help: nothing proves that the change inside B's paths
 *     was written by B rather than by A, so a second writer would let A write
 *     anywhere B is allowed. Readonly steps may still run alongside the writer;
 *     they claim nothing, so nothing is attributed to them alone.
 */
function checkWriteBoundaryWaves(
	steps: ReadonlyArray<ExecutionPlanStep>,
	waves: ReadonlyArray<ReadonlyArray<string>>,
	writerLimit?: 1,
): void {
	const byId = new Map(steps.map((step) => [step.id, step]));
	for (const [index, wave] of waves.entries()) {
		const members = wave.flatMap((id) => {
			const step = byId.get(id);
			return step === undefined ? [] : [step];
		});
		const declared = members.filter((step) => step.writes !== undefined);
		if (declared.length === 0) continue;
		const undeclared = members.filter((step) => step.writes === undefined);
		if (undeclared.length > 0 && writerLimit !== 1) {
			throw new Error(
				`execution plan: wave ${index} mixes boundary-enforced steps (${declared
					.map((step) => step.id)
					.join(", ")}) with steps that declare no boundary (${undeclared
					.map((step) => step.id)
					.join(", ")}); they share one checkout, so the undeclared step's writes cannot be told from a violation`,
			);
		}
		const writers = declared.filter((step) => (step.writes?.length ?? 0) > 0);
		if (writers.length > 1 && writerLimit !== 1) {
			throw new Error(
				`execution plan: wave ${index} schedules ${writers.length} steps that may write (${writers
					.map((step) => step.id)
					.join(
						", ",
					)}); a write boundary is verified by diffing one shared checkout, so concurrent writers cannot be attributed. Order them with dependencies or lower maxWorkers`,
			);
		}
	}
}

export function compileExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
	if (input.writers !== undefined && input.writers !== 1) {
		throw new Error("execution plan: writers must be 1 when present");
	}
	const steps = canonicalSteps(input.steps);
	const loops = (input.loops ?? []).map((loop) => ({
		...loop,
		checkStepIds: [...loop.checkStepIds],
		repairStepIds: [...loop.repairStepIds],
	}));
	checkLoops(steps, loops);
	const waves = executionPlanWaves(steps, input.maxWorkers);
	checkWriteBoundaryWaves(steps, waves, input.writers);
	const canonical = {
		version: 4 as const,
		topology: input.topology,
		rootTask: input.rootTask,
		maxWorkers: input.maxWorkers,
		...(input.writers === 1 ? { writers: 1 as const } : {}),
		onFailure: input.onFailure,
		steps,
		loops,
		waves,
	};
	return { ...canonical, hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}

/** Transitive dependency closure of one plan step. */
export function executionPlanAncestors(plan: ExecutionPlan, stepId: string): ReadonlySet<string> {
	const byId = new Map(plan.steps.map((step) => [step.id, step]));
	const ancestors = new Set<string>();
	const pending = [...(byId.get(stepId)?.dependencies ?? [])];
	while (pending.length > 0) {
		const next = pending.pop();
		if (next === undefined || ancestors.has(next)) continue;
		ancestors.add(next);
		pending.push(...(byId.get(next)?.dependencies ?? []));
	}
	return ancestors;
}

/** A linear step declares no dependencies; the compiler chains them by position. */
export type ExecutionPlanLinearStepInput =
	| (Omit<ExecutionPlanAgentStep, "kind" | "dependencies"> & { kind?: "agent" })
	| Omit<ExecutionPlanCodeStep, "dependencies">;

export function compileLinearExecutionPlan(
	input: Omit<ExecutionPlanInput, "steps"> & { steps: ReadonlyArray<ExecutionPlanLinearStepInput> },
): ExecutionPlan {
	const parallel = input.topology === "parallel" || input.topology === "compete";
	return compileExecutionPlan({
		...input,
		steps: input.steps.map((step, index): ExecutionPlanStepInput => {
			const dependencies = parallel || index === 0 ? [] : [input.steps[index - 1]?.id ?? ""];
			return step.kind === "code" ? { ...step, dependencies } : { ...step, dependencies };
		}),
	});
}
