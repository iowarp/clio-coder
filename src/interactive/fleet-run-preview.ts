/**
 * What `/fleet run <name>` will do, projected before anything dispatches.
 *
 * The projection is the compiled plan and nothing else. It calls the same
 * loader, the same graph and command validation, the same plan compiler, and
 * the same write-boundary preflight the headless `fleet` subcommands call, so
 * the overlay cannot show an operator a run that differs from the one the
 * scheduler would execute. No fleet logic is reimplemented here; this module
 * only arranges the compiled facts into rows a terminal can render.
 *
 * A preflight failure is data, not an exception. Every diagnostic is collected
 * and returned so the overlay can render the whole list with no accept action,
 * rather than surfacing the first failure and hiding the rest.
 */

import {
	FLEET_COMMANDS_REMEDY,
	type FleetCommandRegistry,
	FleetCommandRegistryMissingError,
	type FleetContract,
	fleetStepBoundaries,
	loadFleetCommands,
	loadFleetContract,
	renderFleetPrompt,
	validateFleetCommands,
	validateFleetGraph,
} from "../domains/agents/index.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { ExecutionPlan, ExecutionPlanStep } from "../domains/dispatch/execution-plan.js";
import {
	type AgentRoleFactsResolver,
	requestExecutionRole,
	withAttemptRole,
} from "../domains/dispatch/execution-role.js";
import { compileFleetExecutionPlan } from "../domains/dispatch/fleet-plan.js";
import { preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";

/** Where a step would run, as the dispatch domain resolves it today. */
export interface FleetRunPreviewRoute {
	targetId: string;
	wireModelId: string;
	nodeId: string;
}

export interface FleetRunPreviewStep {
	stepId: string;
	kind: ExecutionPlanStep["kind"];
	scope: "readonly" | "workspace";
	/** Agent steps only. */
	agentId?: string;
	/** Resolved route for an agent step; absent when the domain could not resolve one. */
	route?: FleetRunPreviewRoute;
	/** Code steps only: the registered command id and the argv it will run. */
	commandId?: string;
	argv?: ReadonlyArray<string>;
	/** Declared write boundary. Empty is the claim "changes nothing"; undefined is no claim. */
	writes: ReadonlyArray<string> | undefined;
	/** Loop membership for a node a bounded loop unrolled to. */
	loop?: { loopId: string; role: "check" | "repair"; attempt: number };
	target?: string;
	profile?: string;
	gate?: { path: string; commandId: string } | { gateId: string; path: string };
	plan?: { roster: ReadonlyArray<string>; maxTasks: number; proposals: boolean };
}

export interface FleetRunPreviewWave {
	index: number;
	steps: ReadonlyArray<FleetRunPreviewStep>;
}

export interface FleetRunPreviewBudget {
	/** Session ceiling this run is admitted under. */
	ceilingUsd: number;
	currentUsd: number;
	/** The contract's own declared ceiling, or null when it declares none. */
	contractUsd: number | null;
}

export interface FleetRunPreview {
	name: string;
	/** Variables rendered into the plan and sealed into its durable run record. */
	vars: Readonly<Record<string, string>>;
	planHash: string;
	waves: ReadonlyArray<FleetRunPreviewWave>;
	budget: FleetRunPreviewBudget;
	/** The compiled plan itself, so an accepted preview dispatches what was shown. */
	plan: ExecutionPlan;
	contract: FleetContract;
	commands: FleetCommandRegistry | null;
	/** Rendered prompt body every agent node carries as its task. */
	task: string;
}

export type FleetRunPreviewResult =
	| { ok: true; preview: FleetRunPreview }
	| { ok: false; name: string; diagnostics: ReadonlyArray<string> };

/** Everything the projection needs from the running process. */
export interface FleetRunPreviewInput {
	workspaceRoot: string;
	name: string;
	vars: Readonly<Record<string, string>>;
	/** Recipe lookup; a step naming an unknown agent is a diagnostic. */
	getAgentSpec: (agentId: string) => AgentSpec | null;
	/** Role facts for the execution role each node runs under. */
	roleFacts: AgentRoleFactsResolver;
	/** Session budget state; absent leaves the ceiling unknown and checks nothing. */
	budget?: { ceilingUsd: number; currentUsd: number; verdict: "under" | "at" | "over" };
	/** Effective route for an agent step. Absent or null renders the step without one. */
	resolveRoute?: (step: {
		stepId: string;
		agentId: string;
		scope: "readonly" | "workspace";
		target?: string;
		profile?: string;
	}) => FleetRunPreviewRoute | null;
	/** Contract and registry loaders, overridable so tests project a fixture. */
	load?: (workspaceRoot: string, name: string) => { contract: FleetContract; commands: FleetCommandRegistry | null };
}

function defaultLoad(
	workspaceRoot: string,
	name: string,
): { contract: FleetContract; commands: FleetCommandRegistry | null } {
	const contract = loadFleetContract(workspaceRoot, name);
	// loadFleetContract already refused any unregistered command id; this read
	// is the binding the runner executes.
	return { contract, commands: loadFleetCommands(workspaceRoot) };
}

function describeError(error: unknown): string {
	if (error instanceof FleetCommandRegistryMissingError) return `${error.message}\n${FLEET_COMMANDS_REMEDY}`;
	return error instanceof Error ? error.message : String(error);
}

/** The contract position a compiled node came from; a loop half keeps its position id. */
function positionId(step: ExecutionPlanStep): string {
	return step.loop === undefined ? step.id : `${step.loop.loopId}.${step.loop.role}`;
}

/**
 * Compile the plan and project it into waves. Returns diagnostics instead of
 * throwing: an operator meets a broken contract in the overlay, with every
 * reason it cannot run, and no accept key.
 */
export function compileFleetRunPreview(input: FleetRunPreviewInput): FleetRunPreviewResult {
	const diagnostics: string[] = [];
	const fail = (): FleetRunPreviewResult => ({ ok: false, name: input.name, diagnostics });

	let contract: FleetContract;
	let commands: FleetCommandRegistry | null;
	try {
		({ contract, commands } = (input.load ?? defaultLoad)(input.workspaceRoot, input.name));
	} catch (error) {
		diagnostics.push(describeError(error));
		return fail();
	}

	let task: string;
	try {
		validateFleetGraph(contract);
		validateFleetCommands(contract, commands);
		task = renderFleetPrompt(contract.body, input.vars);
	} catch (error) {
		diagnostics.push(describeError(error));
		return fail();
	}

	let plan: ExecutionPlan;
	try {
		plan = compileFleetExecutionPlan({
			contract,
			task,
			resolveAgent(context) {
				const spec = input.getAgentSpec(context.agentId);
				if (spec === null) {
					throw new Error(`unknown agent '${context.agentId}' (step '${context.stepId}' must name a recipe from /agents)`);
				}
				if (spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
					throw new Error(`fleet step '${context.stepId}' has no automatable agent authority`);
				}
				const requestRole = requestExecutionRole({
					agentId: context.agentId,
					resolveFacts: input.roleFacts,
					...(context.gateRole !== undefined ? { gateRole: context.gateRole } : {}),
				});
				return {
					requestedAuthority: spec.capabilityClass,
					approvedAuthority: spec.capabilityClass,
					// A gate decider answers the coordinator's question, so its
					// postcondition is the gate result contract, not its recipe's.
					expectedResultContract:
						context.planRole === true
							? "delegation-plan"
							: context.gateAuthorRole === true
								? "artifact-report"
								: context.gateRole === "reviewer"
									? "verifier-report"
									: spec.resultContract.kind,
					executionRole: withAttemptRole(requestRole, context.attempt),
				};
			},
		});
	} catch (error) {
		diagnostics.push(describeError(error));
		return fail();
	}

	// A declared boundary is verified against the checkout, so the checkout has
	// to be one this can read. Refused here, before any dispatch, rather than
	// discovered as an unenforceable claim halfway through the run.
	try {
		preflightWriteBoundaries(plan, input.workspaceRoot);
	} catch (error) {
		diagnostics.push(describeError(error));
	}

	const budget: FleetRunPreviewBudget = {
		ceilingUsd: input.budget?.ceilingUsd ?? 0,
		currentUsd: input.budget?.currentUsd ?? 0,
		contractUsd: contract.budgetUsd,
	};
	if (input.budget) {
		if (input.budget.verdict === "over" || input.budget.verdict === "at") {
			diagnostics.push(`budget ceiling crossed: $${budget.currentUsd.toFixed(4)} / $${budget.ceilingUsd.toFixed(4)}`);
		} else if (contract.budgetUsd !== null) {
			const remaining = budget.ceilingUsd - budget.currentUsd;
			if (contract.budgetUsd > remaining) {
				diagnostics.push(
					`fleet budget $${contract.budgetUsd.toFixed(2)} exceeds remaining session budget $${remaining.toFixed(2)}`,
				);
			}
		}
	}

	const boundaries = new Map(fleetStepBoundaries(contract).map((entry) => [entry.id, entry.writes]));
	const byId = new Map(plan.steps.map((step) => [step.id, step]));
	const waves: FleetRunPreviewWave[] = plan.waves.map((wave, index) => ({
		index,
		steps: wave.flatMap((stepId): FleetRunPreviewStep[] => {
			const step = byId.get(stepId);
			if (step === undefined) return [];
			const declared = boundaries.has(positionId(step)) ? boundaries.get(positionId(step)) : step.writes;
			const base = {
				stepId: step.id,
				scope: step.scope,
				writes: declared,
				...(step.loop !== undefined ? { loop: { ...step.loop } } : {}),
				...(step.gate !== undefined ? { gate: { ...step.gate } } : {}),
			};
			if (step.kind === "code") {
				const command = commands?.commands.get(step.commandId);
				return [
					{
						...base,
						kind: "code" as const,
						commandId: step.commandId,
						...(command !== undefined ? { argv: [...command.argv] } : {}),
					},
				];
			}
			let route: FleetRunPreviewRoute | null = null;
			try {
				route =
					input.resolveRoute?.({
						stepId: step.id,
						agentId: step.agentId,
						scope: step.scope,
						...(step.target !== undefined ? { target: step.target } : {}),
						...(step.profile !== undefined ? { profile: step.profile } : {}),
					}) ?? null;
			} catch (error) {
				diagnostics.push(`step '${step.id}' route preflight failed: ${describeError(error)}`);
			}
			return [
				{
					...base,
					kind: "agent" as const,
					agentId: step.agentId,
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { profile: step.profile } : {}),
					...(step.plan !== undefined ? { plan: { ...step.plan, roster: [...step.plan.roster] } } : {}),
					...(route !== null ? { route } : {}),
				},
			];
		}),
	}));
	if (diagnostics.length > 0) return fail();

	return {
		ok: true,
		preview: {
			name: contract.name,
			vars: { ...input.vars },
			planHash: plan.hash,
			waves,
			budget,
			plan,
			contract,
			commands,
			task,
		},
	};
}
