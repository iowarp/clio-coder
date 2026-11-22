import type { PlaybookCommandRegistry } from "../agents/playbook-commands.js";
import { resolvePlaybookCommandArgs } from "../agents/playbook-commands.js";
/**
 * Playbook to execution plan.
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

import type { Playbook, PlaybookStep, PlaybookStepScope } from "../agents/playbook.js";
import {
	playbookCodeSteps,
	playbookLoopCheckStepId,
	playbookLoopRepairStepId,
	playbookRunsInTaskWorktree,
	playbookStepWriteBoundary,
	validatePlaybookCommands,
} from "../agents/playbook.js";
import type { ResultContract } from "../agents/result-contract.js";
import type { AgentAutomationAuthority } from "../agents/spec.js";
import type { ExecutionPlan, ExecutionPlanLoop, ExecutionPlanScope, ExecutionPlanStepInput } from "./execution-plan.js";
import { compileExecutionPlan } from "./execution-plan.js";
import type { ExecutionRole } from "./execution-role.js";
import { renderFleetCheckTask, renderFleetNodeTask } from "./fleet-node-prompt.js";

/** Where an agent node sits, so the caller can resolve its role and authority. */
export interface FleetPlanAgentContext {
	stepId: string;
	agentId: string;
	scope: "readonly" | "workspace";
	/** Zero for declared work; a loop repair is attempt n and therefore recovery. */
	attempt: number;
	/** Set when this node is a loop's verification, which is a gate position. */
	gateRole?: "reviewer";
	target?: string;
	profile?: string;
	planRole?: true;
	gateAuthorRole?: true;
}

export interface FleetPlanAgentResolution {
	requestedAuthority: AgentAutomationAuthority;
	/** Null makes the plan an approval request that cannot execute. */
	approvedAuthority: AgentAutomationAuthority | null;
	expectedResultContract: ResultContract["kind"];
	resultContract?: ResultContract;
	executionRole: ExecutionRole;
}

export interface CompileFleetPlanInput {
	commands?: PlaybookCommandRegistry | null;
	vars?: Readonly<Record<string, string>>;
	playbook: Playbook;
	/**
	 * Rendered prompt body. It describes the work, so every agent node that
	 * builds, plans or authors carries it, followed by that node's own answer
	 * directive: the nodes hold different result contracts and the body can
	 * only ever name one of them. A loop's agent check gets its own
	 * verification task instead (`renderFleetCheckTask`).
	 */
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

function declaredLoops(steps: ReadonlyArray<PlaybookStep>): Map<string, ExecutionPlanLoop> {
	const loops = new Map<string, ExecutionPlanLoop>();
	for (const step of steps) {
		if (step.kind !== "loop") continue;
		const checkStepIds: string[] = [];
		const repairStepIds: string[] = [];
		for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
			checkStepIds.push(playbookLoopCheckStepId(step.id, attempt));
			if (attempt < step.maxAttempts) repairStepIds.push(playbookLoopRepairStepId(step.id, attempt));
		}
		loops.set(step.id, {
			id: step.id,
			checkKind: step.check.kind === "gate" ? "code" : step.check.kind,
			maxAttempts: step.maxAttempts,
			checkStepIds,
			repairStepIds,
		});
	}
	return loops;
}

/**
 * The exact registered argument vector each loop's code check runs, alongside
 * the changed-test checks resolved from the implementer's mutation paths.
 */
function loopCheckCommandNote(
	playbook: Playbook,
	commands: PlaybookCommandRegistry | null | undefined,
	vars: Readonly<Record<string, string>>,
): string {
	if (!commands) return "";
	const lines: string[] = [];
	for (const step of playbook.steps) {
		if (step.kind !== "loop" || step.check.kind !== "code") continue;
		const command = commands.commands.get(step.check.command);
		if (command === undefined) continue;
		const argv = [...command.argv, ...resolvePlaybookCommandArgs(step.check.args ?? [], vars)];
		lines.push(
			`Check step \`${step.id}\` runs the registered \`${command.id}\` command as ${JSON.stringify(argv)} in \`${command.cwd}\`.`,
		);
	}
	return lines.join("\n");
}

/** A playbook body that quotes the operator's request through `{{task}}`. */
const TASK_PLACEHOLDER_RE = /\{\{\s*task\s*\}\}/u;

/**
 * A node's scope inside the run. `worktree` is where the run writes, carried once on the plan as `isolation`; inside
 * that worktree a `worktree` step edits exactly as a `workspace` step edits the checkout.
 */
function nodeScope(scope: PlaybookStepScope): ExecutionPlanScope {
	return scope === "readonly" ? "readonly" : "workspace";
}

/**
 * The agent steps that changed the workspace before a node, in plan order: the
 * transitive workspace-scope agent ancestors of its dependencies. A check names
 * them as the authors of the change it reviews.
 */
function workspaceAuthors(
	steps: ReadonlyArray<ExecutionPlanStepInput>,
	dependencies: ReadonlyArray<string>,
): Array<{ stepId: string; agentId: string; repair: boolean }> {
	const byId = new Map(steps.map((step) => [step.id, step]));
	const seen = new Set<string>();
	const pending = [...dependencies];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		if (seen.has(id)) continue;
		seen.add(id);
		pending.push(...(byId.get(id)?.dependencies ?? []));
	}
	return steps.flatMap((step) =>
		seen.has(step.id) && step.kind !== "code" && step.scope === "workspace"
			? [{ stepId: step.id, agentId: step.agentId, repair: step.loop?.role === "repair" }]
			: [],
	);
}

export function compileFleetExecutionPlan(input: CompileFleetPlanInput): ExecutionPlan {
	const { playbook, resolveAgent } = input;
	if (input.commands !== undefined) validatePlaybookCommands(playbook, input.commands, input.vars ?? {});
	else if (playbookCodeSteps(playbook).some((step) => (step.args?.length ?? 0) > 0))
		throw new Error("fleet code args: admission requires the operator command registry");
	const checkNote = loopCheckCommandNote(playbook, input.commands, input.vars ?? {});
	const task = checkNote.length > 0 ? `${input.task}\n\n${checkNote}` : input.task;
	// What a loop's agent check is asked to verify: the operator's request when
	// the body quotes it, otherwise the rendered body, which is then the only
	// statement of the change.
	const requestVar = input.vars?.task;
	const request = requestVar !== undefined && TASK_PLACEHOLDER_RE.test(playbook.body) ? requestVar : input.task;
	const loops = declaredLoops(playbook.steps);
	const steps: ExecutionPlanStepInput[] = [];

	/**
	 * The declared boundary of one position, carried onto every node the
	 * position unrolls to. Each of a loop's attempts inherits the same
	 * declaration: the bound changes how many times work may be retried, never
	 * what it may touch.
	 */
	const boundary = (scope: PlaybookStepScope, writes: ReadonlyArray<string> | undefined): { writes?: string[] } => {
		const resolved = playbookStepWriteBoundary(playbook.version, scope, writes);
		return resolved === undefined ? {} : { writes: [...resolved] };
	};

	const agentNode = (
		context: FleetPlanAgentContext,
		dependencies: ReadonlyArray<string>,
		writes: ReadonlyArray<string> | undefined,
		loop?: { loopId: string; role: "check" | "repair"; attempt: number },
		extra?: {
			gate?: { path: string; commandId: string };
			plan?: { roster: ReadonlyArray<string>; maxTasks: number; proposals: boolean };
		},
	): ExecutionPlanStepInput => {
		const resolved = resolveAgent(context);
		// A loop's check verifies the change; the playbook body tells a builder
		// how to make it, so the check gets its own task and never that body.
		const body =
			loop?.role === "check"
				? renderFleetCheckTask({ request, authors: workspaceAuthors(steps, dependencies), note: checkNote })
				: task;
		return {
			kind: "agent",
			id: context.stepId,
			agentId: context.agentId,
			scope: context.scope,
			dependencies: [...dependencies],
			task: renderFleetNodeTask(body, resolved.expectedResultContract, context.stepId, resolved.resultContract),
			expectedResultContract: resolved.expectedResultContract,
			requestedAuthority: resolved.requestedAuthority,
			approvedAuthority: resolved.approvedAuthority,
			executionRole: resolved.executionRole,
			...boundary(context.scope, writes),
			...(loop !== undefined ? { loop } : {}),
			...(context.target !== undefined ? { target: context.target } : {}),
			...(context.profile !== undefined ? { profile: context.profile } : {}),
			...extra,
		};
	};
	const routeOf = (value: { target?: string; profile?: string }): { target?: string; profile?: string } => ({
		...(value.target !== undefined ? { target: value.target } : {}),
		...(value.profile !== undefined ? { profile: value.profile } : {}),
	});

	for (const step of playbook.steps) {
		const dependencies = expandDependencies(step.dependencies, loops);
		if (step.kind === "agent") {
			steps.push(
				agentNode(
					{ stepId: step.id, agentId: step.agent, scope: nodeScope(step.scope), attempt: 0, ...routeOf(step) },
					dependencies,
					step.writes,
				),
			);
			continue;
		}
		if (step.kind === "gate") {
			steps.push(
				agentNode(
					{ stepId: step.id, agentId: step.agent, scope: "workspace", attempt: 0, gateAuthorRole: true, ...routeOf(step) },
					dependencies,
					[step.path],
					undefined,
					{ gate: { path: step.path, commandId: step.run } },
				),
			);
			continue;
		}
		if (step.kind === "plan") {
			steps.push(
				agentNode(
					{
						stepId: step.id,
						agentId: step.agent,
						scope: nodeScope(step.scope),
						attempt: 0,
						planRole: true,
						...routeOf(step),
					},
					dependencies,
					step.writes,
					undefined,
					{ plan: { roster: [...step.roster], maxTasks: step.maxTasks, proposals: step.proposals } },
				),
			);
			continue;
		}
		if (step.kind === "code") {
			steps.push({
				kind: "code",
				id: step.id,
				commandId: step.command,
				...(step.args ? { args: resolvePlaybookCommandArgs(step.args, input.vars) } : {}),
				scope: nodeScope(step.scope),
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
					...(step.check.args ? { args: resolvePlaybookCommandArgs(step.check.args, input.vars) } : {}),
					scope: nodeScope(step.check.scope),
					dependencies: checkDependencies,
					...boundary(step.check.scope, step.check.writes),
					loop: membership,
					// The green a later step may rely on; the scheduler re-runs it
					// when a workspace step lands after it.
					verification: true,
				});
			} else if (step.check.kind === "gate") {
				const gateId = step.check.gate;
				const gate = playbook.steps.find((candidate) => candidate.id === gateId);
				if (gate?.kind !== "gate") throw new Error(`fleet plan: gate '${gateId}' failed to resolve`);
				steps.push({
					kind: "code",
					id: checkId,
					commandId: gate.run,
					scope: "readonly",
					dependencies: checkDependencies,
					writes: [],
					loop: membership,
					verification: true,
					gate: { gateId: gate.id, path: gate.path },
				});
			} else {
				steps.push(
					agentNode(
						{
							stepId: checkId,
							agentId: step.check.agent,
							scope: nodeScope(step.check.scope),
							attempt: 0,
							gateRole: "reviewer",
							...routeOf(step.check),
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
					{
						stepId: repairId,
						agentId: step.repair.agent,
						scope: nodeScope(step.repair.scope),
						attempt,
						...routeOf(step.repair),
					},
					[checkId, ...checkDependencies],
					step.repair.writes,
					{ loopId: loop.id, role: "repair", attempt },
				),
			);
		}
	}

	return compileExecutionPlan({
		topology: "fleet",
		rootTask: input.task,
		maxWorkers: playbook.maxWorkers,
		...(playbook.writers === 1 ? { writers: 1 as const } : {}),
		...(playbookRunsInTaskWorktree(playbook) ? { isolation: "worktree" as const } : {}),
		onFailure: playbook.onFailure,
		steps,
		loops: [...loops.values()],
	});
}
