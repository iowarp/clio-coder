import { type ExecutionHandoff, projectExecutionHandoffs } from "./execution-handoff.js";
import type {
	ExecutionPlan,
	ExecutionPlanAgentStep,
	ExecutionPlanCodeStep,
	ExecutionPlanStep,
} from "./execution-plan.js";

export interface ExecutionStepResult extends ExecutionHandoff {
	succeeded: boolean;
	integrityValid: boolean;
}
export interface ExecutionPlanAdmission {
	step: ExecutionPlanAgentStep;
	costUpperBoundUsd: number;
	nodeId: string;
}
export interface ExecutionSchedulerAdapter {
	preflight(step: ExecutionPlanAgentStep): ExecutionPlanAdmission;
	reserve(plan: ExecutionPlan, admissions: ReadonlyArray<ExecutionPlanAdmission>): { ownerId: string };
	run(
		step: ExecutionPlanAgentStep,
		handoffs: ReadonlyArray<ExecutionHandoff>,
		reservation: { ownerId: string; memberId: string },
	): Promise<{ assignmentId: string; result: Promise<ExecutionStepResult> }>;
	/**
	 * Execute a deterministic step. It takes no reservation because it holds no
	 * worker capacity lease. Required only for plans that contain code steps.
	 */
	runCode?(
		step: ExecutionPlanCodeStep,
		handoffs: ReadonlyArray<ExecutionHandoff>,
		signal: AbortSignal,
	): Promise<ExecutionStepResult>;
	cancel(assignmentId: string): void;
	release(ownerId: string): void;
	releaseUnconsumed(ownerId: string): void;
}
export interface ExecutionPlanResult {
	planHash: string;
	results: ReadonlyMap<string, ExecutionStepResult>;
	skipped: ReadonlyArray<string>;
}

export async function executePlan(
	plan: ExecutionPlan,
	adapter: ExecutionSchedulerAdapter,
	signal?: AbortSignal,
): Promise<ExecutionPlanResult> {
	const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
	const agentSteps: ExecutionPlanAgentStep[] = [];
	for (const step of plan.steps) {
		if (step.kind === "code") {
			if (adapter.runCode === undefined) {
				throw new Error(`execution plan: step '${step.id}' is a code step and this scheduler cannot run one`);
			}
			continue;
		}
		if (step.approvedAuthority === null || step.approvedAuthority !== step.requestedAuthority) {
			throw new Error(`execution plan: step '${step.id}' lacks its requested authority grant`);
		}
		agentSteps.push(step);
	}
	// Resolve every hard admission fact before reservation or spawn. Code steps
	// are outside admission entirely: they reserve nothing and spawn no worker.
	const admissions = agentSteps.map((step) => adapter.preflight(step));
	const reservation = adapter.reserve(plan, admissions);
	const results = new Map<string, ExecutionStepResult>();
	const skipped = new Set<string>();
	const running = new Map<string, { assignmentId: string | null }>();
	let stopped = false;
	// Code steps carry no assignment id, so `cancel` cannot reach them. They are
	// aborted through this signal, which the runner turns into a process-group
	// kill on the whole command tree.
	const codeAbort = new AbortController();
	const cancelOwned = (): void => {
		stopped = true;
		for (const owned of running.values()) if (owned.assignmentId !== null) adapter.cancel(owned.assignmentId);
		codeAbort.abort();
		adapter.releaseUnconsumed(reservation.ownerId);
	};
	signal?.addEventListener("abort", cancelOwned, { once: true });

	/**
	 * A failed predecessor normally disqualifies its dependents. A failed code
	 * step under `onFailure: continue` is the deliberate exception: the red
	 * suite's verbatim output is the input to the step that repairs it, so the
	 * edge carries the failure instead of severing it.
	 */
	const dependencyBlocks = (dependency: string): boolean => {
		if (skipped.has(dependency)) return true;
		const result = results.get(dependency);
		if (result === undefined || !result.integrityValid) return true;
		if (result.succeeded) return false;
		return !(stepsById.get(dependency)?.kind === "code" && plan.onFailure === "continue");
	};

	try {
		for (const wave of plan.waves) {
			if (stopped || signal?.aborted) break;
			const admitted = wave.flatMap((id) => {
				const step = stepsById.get(id);
				if (!step) throw new Error(`execution plan: unknown scheduled step '${id}'`);
				if (step.dependencies.some(dependencyBlocks)) {
					skipped.add(step.id);
					return [];
				}
				return [{ step, handoffs: projectExecutionHandoffs(step.dependencies, results) }];
			});
			const launch = admitted.filter(
				(entry): entry is { step: ExecutionPlanAgentStep; handoffs: ExecutionHandoff[] } => entry.step.kind === "agent",
			);
			const codeWork = admitted.filter(
				(entry): entry is { step: ExecutionPlanCodeStep; handoffs: ExecutionHandoff[] } => entry.step.kind === "code",
			);
			const started = await Promise.all(
				launch.map(async ({ step, handoffs }) => ({
					step,
					handle: await adapter.run(step, handoffs, { ownerId: reservation.ownerId, memberId: step.id }),
				})),
			);
			for (const { step, handle } of started) running.set(step.id, { assignmentId: handle.assignmentId });
			const onSettled = (step: ExecutionPlanStep, result: ExecutionStepResult): void => {
				if ((!result.succeeded || !result.integrityValid) && plan.onFailure === "stop") {
					stopped = true;
					for (const [runningStepId, owned] of running) {
						if (runningStepId !== step.id && owned.assignmentId !== null) adapter.cancel(owned.assignmentId);
					}
					codeAbort.abort();
					adapter.releaseUnconsumed(reservation.ownerId);
				}
			};
			const settled = await Promise.all([
				...started.map(async ({ step, handle }) => {
					const result = await handle.result;
					onSettled(step, result);
					return { step: step as ExecutionPlanStep, result };
				}),
				...codeWork.map(async ({ step, handoffs }) => {
					const runCode = adapter.runCode;
					if (runCode === undefined) throw new Error(`execution plan: no runner for code step '${step.id}'`);
					const result = await runCode(step, handoffs, codeAbort.signal);
					onSettled(step, result);
					return { step: step as ExecutionPlanStep, result };
				}),
			]);
			for (const { step, result } of settled) {
				running.set(step.id, { assignmentId: result.assignmentId });
				results.set(step.id, result);
				running.delete(step.id);
			}
			if (settled.some(({ result }) => !result.succeeded || !result.integrityValid) && plan.onFailure === "stop") {
				stopped = true;
				adapter.releaseUnconsumed(reservation.ownerId);
			}
		}
		return { planHash: plan.hash, results, skipped: [...skipped] };
	} catch (error) {
		cancelOwned();
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancelOwned);
		adapter.release(reservation.ownerId);
	}
}
