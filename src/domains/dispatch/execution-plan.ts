import { createHash } from "node:crypto";
import type { ResultContract } from "../agents/result-contract.js";
import type { AgentAutomationAuthority } from "../agents/spec.js";
import type { ExecutionRole } from "./execution-role.js";

export type ExecutionPlanTopology = "parallel" | "sequential" | "pipeline" | "review" | "compete" | "fleet";
export type ExecutionPlanScope = "readonly" | "workspace";
export type ExecutionPlanFailurePolicy = "stop" | "continue";

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
}

export type ExecutionPlanStep = ExecutionPlanAgentStep | ExecutionPlanCodeStep;

/** Agent steps may omit the discriminant; it normalizes to "agent". */
export type ExecutionPlanStepInput =
	| (Omit<ExecutionPlanAgentStep, "kind"> & { kind?: "agent" })
	| ExecutionPlanCodeStep;

export interface ExecutionPlan {
	/** v3 adds the step-kind discriminant; v2 plans were agent-only. */
	version: 3;
	topology: ExecutionPlanTopology;
	rootTask: string;
	maxWorkers: number;
	onFailure: ExecutionPlanFailurePolicy;
	steps: ReadonlyArray<ExecutionPlanStep>;
	waves: ReadonlyArray<ReadonlyArray<string>>;
	hash: string;
}
export type ExecutionPlanInput = Omit<ExecutionPlan, "version" | "waves" | "hash" | "steps"> & {
	steps: ReadonlyArray<ExecutionPlanStepInput>;
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

export function compileExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
	const steps = canonicalSteps(input.steps);
	const waves = executionPlanWaves(steps, input.maxWorkers);
	const canonical = {
		version: 3 as const,
		topology: input.topology,
		rootTask: input.rootTask,
		maxWorkers: input.maxWorkers,
		onFailure: input.onFailure,
		steps,
		waves,
	};
	return { ...canonical, hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
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
