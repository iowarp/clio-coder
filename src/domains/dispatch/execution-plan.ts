import { createHash } from "node:crypto";
import type { ExecutionRole } from "./execution-role.js";

export type ExecutionPlanTopology = "parallel" | "sequential" | "pipeline" | "review" | "compete" | "fleet";
export type ExecutionPlanScope = "readonly" | "workspace";
export type ExecutionPlanFailurePolicy = "stop" | "continue";

export interface ExecutionPlanStep {
	id: string;
	agentId: string;
	executionRole: ExecutionRole;
	scope: ExecutionPlanScope;
	dependencies: ReadonlyArray<string>;
	task: string;
}
export interface ExecutionPlan {
	version: 1;
	topology: ExecutionPlanTopology;
	rootTask: string;
	maxWorkers: number;
	onFailure: ExecutionPlanFailurePolicy;
	steps: ReadonlyArray<ExecutionPlanStep>;
	waves: ReadonlyArray<ReadonlyArray<string>>;
	hash: string;
}
export type ExecutionPlanInput = Omit<ExecutionPlan, "version" | "waves" | "hash">;

function canonicalSteps(steps: ReadonlyArray<ExecutionPlanStep>): ExecutionPlanStep[] {
	return steps.map((step) => ({ ...step, dependencies: [...step.dependencies].sort() }));
}

export function executionPlanWaves(
	steps: ReadonlyArray<Pick<ExecutionPlanStep, "id" | "dependencies">>,
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
		for (let offset = 0; offset < ready.length; offset += maxWorkers) {
			const wave = ready.slice(offset, offset + maxWorkers).map((step) => step.id);
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
		version: 1 as const,
		topology: input.topology,
		rootTask: input.rootTask,
		maxWorkers: input.maxWorkers,
		onFailure: input.onFailure,
		steps,
		waves,
	};
	return { ...canonical, hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}

export function compileLinearExecutionPlan(
	input: Omit<ExecutionPlanInput, "steps"> & { steps: ReadonlyArray<Omit<ExecutionPlanStep, "dependencies">> },
): ExecutionPlan {
	const parallel = input.topology === "parallel" || input.topology === "compete";
	return compileExecutionPlan({
		...input,
		steps: input.steps.map((step, index) => ({
			...step,
			dependencies: parallel || index === 0 ? [] : [input.steps[index - 1]?.id ?? ""],
		})),
	});
}
