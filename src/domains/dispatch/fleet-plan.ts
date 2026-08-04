/**
 * Fleet contract to execution plan.
 *
 * Bounded loops are unrolled here, at compile time, into statically declared
 * conditional nodes: `maxAttempts` verifications and one fewer repair, chained
 * so attempt `n + 1` only exists behind repair `n`. Nothing about the graph is
 * decided while it runs, so the plan keeps the properties every other part of
 * dispatch depends on: one deterministic hashed DAG, waves computed once,
 * whole-plan admission and reservation before the first spawn, and a separate
 * receipt for every attempt. The scheduler's only runtime decision is whether
 * a declared node is still needed, which is a question about results rather
 * than about structure.
 *
 * A dynamic loop executor would have to admit work mid-run, which is exactly
 * the property fleet admission exists to deny.
 */

import {
	type FleetContract,
	type FleetContractStep,
	type FleetStepScope,
	fleetLoopCheckStepId,
	fleetLoopRepairStepId,
	fleetStepWriteBoundary,
} from "../agents/fleet-contract.js";
import type { ResultContract } from "../agents/result-contract.js";
import type { AgentAutomationAuthority } from "../agents/spec.js";
import {
	compileExecutionPlan,
	type ExecutionPlan,
	type ExecutionPlanLoop,
	type ExecutionPlanStepInput,
} from "./execution-plan.js";
import type { ExecutionRole } from "./execution-role.js";

/** Where an agent node sits, so the caller can resolve its role and authority. */
export interface FleetPlanAgentContext {
	stepId: string;
	agentId: string;
	scope: "readonly" | "workspace";
	/** Zero for declared work; a loop repair is attempt n and therefore recovery. */
	attempt: number;
	/** Set when this node is a loop's verification, which is a gate position. */
	gateRole?: "reviewer";
}

export interface FleetPlanAgentResolution {
	requestedAuthority: AgentAutomationAuthority;
	/** Null makes the plan an approval request that cannot execute. */
	approvedAuthority: AgentAutomationAuthority | null;
	expectedResultContract: ResultContract["kind"];
	executionRole: ExecutionRole;
}

export interface CompileFleetPlanInput {
	contract: FleetContract;
	/** Rendered prompt body; every agent node carries it as its task. */
	task: string;
	resolveAgent(context: FleetPlanAgentContext): FleetPlanAgentResolution;
}

/** Expand a declared dependency: a loop stands for all of its verifications. */
function expandDependencies(
	dependencies: ReadonlyArray<string>,
	loopMembers: ReadonlyMap<string, ExecutionPlanLoop>,
): string[] {
	return dependencies.flatMap((id) => {
		const loop = loopMembers.get(id);
		return loop === undefined ? [id] : [...loop.checkStepIds];
	});
}

/**
 * Expand a commit's message sources into concrete node ids, most recent first.
 * A loop stands for its repair attempts in reverse order, because the newest
 * repair is the one whose words describe the tree being committed.
 */
function expandCommitSources(
	sources: ReadonlyArray<string>,
	loopMembers: ReadonlyMap<string, ExecutionPlanLoop>,
): string[] {
	return sources.flatMap((id) => {
		const loop = loopMembers.get(id);
		return loop === undefined ? [id] : [...loop.repairStepIds].reverse();
	});
}

function declaredLoops(steps: ReadonlyArray<FleetContractStep>): Map<string, ExecutionPlanLoop> {
	const loops = new Map<string, ExecutionPlanLoop>();
	for (const step of steps) {
		if (step.kind !== "loop") continue;
		const checkStepIds: string[] = [];
		const repairStepIds: string[] = [];
		for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
			checkStepIds.push(fleetLoopCheckStepId(step.id, attempt));
			if (attempt < step.maxAttempts) repairStepIds.push(fleetLoopRepairStepId(step.id, attempt));
		}
		loops.set(step.id, {
			id: step.id,
			checkKind: step.check.kind,
			maxAttempts: step.maxAttempts,
			checkStepIds,
			repairStepIds,
		});
	}
	return loops;
}

export function compileFleetExecutionPlan(input: CompileFleetPlanInput): ExecutionPlan {
	const { contract, task, resolveAgent } = input;
	const loops = declaredLoops(contract.steps);
	const steps: ExecutionPlanStepInput[] = [];

	/**
	 * The declared boundary of one position, carried onto every node the
	 * position unrolls to. Each of a loop's attempts inherits the same
	 * declaration: the bound changes how many times work may be retried, never
	 * what it may touch.
	 */
	const boundary = (scope: FleetStepScope, writes: ReadonlyArray<string> | undefined): { writes?: string[] } => {
		const resolved = fleetStepWriteBoundary(contract.version, scope, writes);
		return resolved === undefined ? {} : { writes: [...resolved] };
	};

	const agentNode = (
		context: FleetPlanAgentContext,
		dependencies: ReadonlyArray<string>,
		writes: ReadonlyArray<string> | undefined,
		loop?: { loopId: string; role: "check" | "repair"; attempt: number },
	): ExecutionPlanStepInput => {
		const resolved = resolveAgent(context);
		return {
			kind: "agent",
			id: context.stepId,
			agentId: context.agentId,
			scope: context.scope,
			dependencies: [...dependencies],
			task,
			expectedResultContract: resolved.expectedResultContract,
			requestedAuthority: resolved.requestedAuthority,
			approvedAuthority: resolved.approvedAuthority,
			executionRole: resolved.executionRole,
			...boundary(context.scope, writes),
			...(loop !== undefined ? { loop } : {}),
		};
	};

	for (const step of contract.steps) {
		const dependencies = expandDependencies(step.dependencies, loops);
		if (step.kind === "agent") {
			steps.push(
				agentNode({ stepId: step.id, agentId: step.agent, scope: step.scope, attempt: 0 }, dependencies, step.writes),
			);
			continue;
		}
		if (step.kind === "code") {
			steps.push({
				kind: "code",
				id: step.id,
				commandId: step.command,
				scope: step.scope,
				dependencies,
				...boundary(step.scope, step.writes),
				...(step.commitFrom !== undefined ? { commitFrom: expandCommitSources(step.commitFrom, loops) } : {}),
			});
			continue;
		}
		const loop = loops.get(step.id);
		if (loop === undefined) throw new Error(`fleet plan: loop '${step.id}' failed to compile`);
		for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
			const checkId = loop.checkStepIds[attempt - 1] ?? "";
			const previousRepair = attempt === 1 ? null : (loop.repairStepIds[attempt - 2] ?? "");
			const checkDependencies = previousRepair === null ? dependencies : [previousRepair];
			const membership = { loopId: loop.id, role: "check" as const, attempt };
			if (step.check.kind === "code") {
				steps.push({
					kind: "code",
					id: checkId,
					commandId: step.check.command,
					scope: step.check.scope,
					dependencies: checkDependencies,
					...boundary(step.check.scope, step.check.writes),
					loop: membership,
					// The green a later step may rely on; the scheduler re-runs it
					// when a workspace step lands after it.
					verification: true,
				});
			} else {
				steps.push(
					agentNode(
						{
							stepId: checkId,
							agentId: step.check.agent,
							scope: step.check.scope,
							attempt: 0,
							gateRole: "reviewer",
						},
						checkDependencies,
						step.check.writes,
						membership,
					),
				);
			}
			if (attempt >= step.maxAttempts) continue;
			const repairId = loop.repairStepIds[attempt - 1] ?? "";
			steps.push(
				agentNode(
					{ stepId: repairId, agentId: step.repair.agent, scope: step.repair.scope, attempt },
					[checkId],
					step.repair.writes,
					{ loopId: loop.id, role: "repair", attempt },
				),
			);
		}
	}

	return compileExecutionPlan({
		topology: "fleet",
		rootTask: task,
		maxWorkers: contract.maxWorkers,
		onFailure: contract.onFailure,
		steps,
		loops: [...loops.values()],
	});
}
