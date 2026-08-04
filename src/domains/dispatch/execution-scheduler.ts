import { type ExecutionHandoff, projectExecutionHandoffs } from "./execution-handoff.js";
import type { ExecutionPlan, ExecutionPlanStep } from "./execution-plan.js";

export interface ExecutionStepResult extends ExecutionHandoff {
	succeeded: boolean;
	integrityValid: boolean;
}
export interface ExecutionPlanAdmission {
	step: ExecutionPlanStep;
	costUpperBoundUsd: number;
	nodeId: string;
}
export interface ExecutionSchedulerAdapter {
	preflight(step: ExecutionPlanStep): ExecutionPlanAdmission;
	reserve(plan: ExecutionPlan, admissions: ReadonlyArray<ExecutionPlanAdmission>): { ownerId: string };
	run(
		step: ExecutionPlanStep,
		handoffs: ReadonlyArray<ExecutionHandoff>,
		reservation: { ownerId: string; memberId: string },
	): Promise<{ assignmentId: string; result: Promise<ExecutionStepResult> }>;
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
	for (const step of plan.steps) {
		if (step.approvedAuthority === null || step.approvedAuthority !== step.requestedAuthority) {
			throw new Error(`execution plan: step '${step.id}' lacks its requested authority grant`);
		}
	}
	// Resolve every hard admission fact before reservation or spawn.
	const admissions = plan.steps.map((step) => adapter.preflight(step));
	const reservation = adapter.reserve(plan, admissions);
	const results = new Map<string, ExecutionStepResult>();
	const skipped = new Set<string>();
	const running = new Map<string, { assignmentId: string | null }>();
	let stopped = false;
	const cancelOwned = (): void => {
		stopped = true;
		for (const owned of running.values()) if (owned.assignmentId !== null) adapter.cancel(owned.assignmentId);
		adapter.releaseUnconsumed(reservation.ownerId);
	};
	signal?.addEventListener("abort", cancelOwned, { once: true });
	try {
		for (const wave of plan.waves) {
			if (stopped || signal?.aborted) break;
			const launch = wave.flatMap((id) => {
				const step = plan.steps.find((candidate) => candidate.id === id);
				if (!step) throw new Error(`execution plan: unknown scheduled step '${id}'`);
				const failedDependency = step.dependencies.some((dependency) => {
					const result = results.get(dependency);
					return skipped.has(dependency) || !result?.succeeded || !result.integrityValid;
				});
				if (failedDependency) {
					skipped.add(step.id);
					return [];
				}
				const handoffs = projectExecutionHandoffs(step.dependencies, results);
				const start = adapter.run(step, handoffs, { ownerId: reservation.ownerId, memberId: step.id });
				return [{ step, start }];
			});
			const started = await Promise.all(launch.map(async ({ step, start }) => ({ step, handle: await start })));
			for (const { step, handle } of started) running.set(step.id, { assignmentId: handle.assignmentId });
			const settled = await Promise.all(
				started.map(async ({ step, handle }) => {
					const result = await handle.result;
					if ((!result.succeeded || !result.integrityValid) && plan.onFailure === "stop") {
						stopped = true;
						for (const [runningStepId, owned] of running) {
							if (runningStepId !== step.id && owned.assignmentId !== null) adapter.cancel(owned.assignmentId);
						}
						adapter.releaseUnconsumed(reservation.ownerId);
					}
					return { step, result };
				}),
			);
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
