import { renderCostAmount } from "../telemetry/cost.js";
/**
 * What `/fleet run <playbook>` will do, projected before anything dispatches.
 *
 * The projection is the compiled plan and nothing else. It calls the same
 * loader, the same graph and command validation, the same plan compiler, and
 * the same write-boundary preflight the headless `fleet` subcommands call, so
 * the overlay cannot show an operator a run that differs from the one the
 * scheduler would execute. No fleet logic is reimplemented here; this module
 * only arranges the compiled facts into rows a surface can render. The
 * terminal's approval overlay and the ACP fleet methods both read it, so the
 * plan a person approves is compiled one way wherever they approve it.
 *
 * A preflight failure is data, not an exception. Every diagnostic is collected
 * and returned so the overlay can render the whole list with no accept action,
 * rather than surfacing the first failure and hiding the rest.
 */

import { createHash } from "node:crypto";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import {
	loadPlaybook,
	loadPlaybookCommands,
	PLAYBOOK_COMMANDS_REMEDY,
	type Playbook,
	type PlaybookCommandRegistry,
	PlaybookCommandRegistryMissingError,
	playbookStepBoundaries,
	renderPlaybookPrompt,
	validatePlaybookCommands,
	validatePlaybookGraph,
} from "../agents/index.js";
import { type AgentSpec, agentSpecFingerprint } from "../agents/spec.js";
import { foregroundStreamUsage } from "../providers/index.js";
import { type BudgetSpendPricing, budgetRemainingText, budgetSpendText } from "../scheduling/budget.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import { bindExecutionPlanEndpoints, type ExecutionPlan, type ExecutionPlanStep } from "./execution-plan.js";
import { type AgentRoleFactsResolver, requestExecutionRole, withAttemptRole } from "./execution-role.js";
import type { ExecutionStepResult } from "./execution-scheduler.js";
import { hasConcurrentAgentSteps } from "./execution-scheduler.js";
import { compileFleetExecutionPlan } from "./fleet-plan.js";
import { planFleetResume } from "./fleet-run.js";
import { type FleetRunRecord, readFleetRun } from "./state.js";
import { preflightWriteBoundaries } from "./write-boundary-enforcer.js";

/** Where a step would run, as the dispatch domain resolves it today. */
export interface FleetRunPreviewRoute {
	targetId: string;
	wireModelId: string;
	nodeId: string;
	endpoint?: { key: string; label: string; limit: number; foregroundHeld?: number };
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
	/** A resumed run replays this step's prior sealed result instead of dispatching it. */
	replayed?: true;
}

export interface FleetRunPreviewWave {
	index: number;
	steps: ReadonlyArray<FleetRunPreviewStep>;
}

export interface FleetRunPreviewBudget {
	/** Session ceiling this run is admitted under. */
	ceilingUsd: number;
	currentUsd: number;
	/** The playbook's own declared ceiling, or null when it declares none. */
	playbookUsd: number | null;
	/** How `currentUsd` was priced; absent when the scheduling read could not say, and then it reads as known (#434 §6.3). */
	pricing?: BudgetSpendPricing;
}

export interface FleetRunPreview {
	name: string;
	/** Variables rendered into the plan and sealed into its durable run record. */
	vars: Readonly<Record<string, string>>;
	/** Approval identity includes resolved recipes, routes, commands and budget; plan.hash seals the DAG. */
	planHash: string;
	waves: ReadonlyArray<FleetRunPreviewWave>;
	budget: FleetRunPreviewBudget;
	/** The compiled plan itself, so an accepted preview dispatches what was shown. */
	plan: ExecutionPlan;
	playbook: Playbook;
	commands: PlaybookCommandRegistry | null;
	/** Rendered prompt body every agent node carries as its task. */
	task: string;
	/** Present when the run resumes a prior one: the validated record and the prefix it replays. */
	resume?: {
		fromRunId: string;
		record: FleetRunRecord;
		replayed: ReadonlyMap<string, ExecutionStepResult>;
	};
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
	budget?: { ceilingUsd: number; currentUsd: number; verdict: "under" | "at" | "over"; pricing?: BudgetSpendPricing };
	/** Effective route for an agent step. Absent or null renders the step without one. */
	resolveRoute?: (step: {
		stepId: string;
		agentId: string;
		/** The compiled step task; a route preview validates the request it would send, and an empty task is refused. */
		task: string;
		scope: "readonly" | "workspace";
		target?: string;
		profile?: string;
		ledger?: DispatchRequest["ledger"];
	}) => FleetRunPreviewRoute | null;
	/** Playbook and registry loaders, overridable so tests project a fixture. */
	load?: (workspaceRoot: string, name: string) => { playbook: Playbook; commands: PlaybookCommandRegistry | null };
	/** A prior root to resume. Every surface validates it here, the way `fleet run --resume` does. */
	resume?: string;
	/** Durable fleet ledger lookup, overridable so tests resume a fixture record. */
	readRun?: (runId: string) => FleetRunRecord | null;
}

function defaultLoad(
	workspaceRoot: string,
	name: string,
): { playbook: Playbook; commands: PlaybookCommandRegistry | null } {
	const playbook = loadPlaybook(workspaceRoot, name);
	// loadPlaybook already refused any unregistered command id; this read
	// is the binding the runner executes.
	return { playbook, commands: loadPlaybookCommands(workspaceRoot) };
}

function describeError(error: unknown): string {
	if (error instanceof PlaybookCommandRegistryMissingError) return `${error.message}\n${PLAYBOOK_COMMANDS_REMEDY}`;
	return error instanceof Error ? error.message : String(error);
}

/** The playbook position a compiled node came from; a loop half keeps its position id. */
function positionId(step: ExecutionPlanStep): string {
	return step.loop === undefined ? step.id : `${step.loop.loopId}.${step.loop.role}`;
}

/**
 * Compile the plan and project it into waves. Returns diagnostics instead of
 * throwing: an operator meets a broken playbook in the overlay, with every
 * reason it cannot run, and no accept key.
 */
export function compileFleetRunPreview(input: FleetRunPreviewInput): FleetRunPreviewResult {
	const diagnostics: string[] = [];
	const fail = (): FleetRunPreviewResult => ({ ok: false, name: input.name, diagnostics });

	let playbook: Playbook;
	let commands: PlaybookCommandRegistry | null;
	try {
		({ playbook, commands } = (input.load ?? defaultLoad)(input.workspaceRoot, input.name));
	} catch (error) {
		diagnostics.push(describeError(error));
		return fail();
	}

	let task: string;
	try {
		validatePlaybookGraph(playbook);
		validatePlaybookCommands(playbook, commands);
		task = renderPlaybookPrompt(playbook.body, input.vars);
	} catch (error) {
		diagnostics.push(describeError(error));
		return fail();
	}

	let plan: ExecutionPlan;
	const recipeFingerprints = new Map<string, string>();
	try {
		plan = compileFleetExecutionPlan({
			commands,
			vars: input.vars,
			playbook,
			task,
			resolveAgent(context) {
				const spec = input.getAgentSpec(context.agentId);
				if (spec === null) {
					throw new Error(`unknown agent '${context.agentId}' (step '${context.stepId}' must name a recipe from /agents)`);
				}
				if (spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
					throw new Error(`fleet step '${context.stepId}' has no automatable agent authority`);
				}
				recipeFingerprints.set(spec.id, agentSpecFingerprint(spec));
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
	const ledger = hasConcurrentAgentSteps(plan) ? { id: "fleet-preview", sequence: 0 } : undefined;
	const routes = new Map<string, FleetRunPreviewRoute>();
	if (input.resolveRoute !== undefined) {
		for (const step of plan.steps) {
			if (step.kind === "code") continue;
			try {
				const route = input.resolveRoute({
					stepId: step.id,
					agentId: step.agentId,
					task: step.task,
					scope: step.scope,
					...(ledger !== undefined ? { ledger } : {}),
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { profile: step.profile } : {}),
				});
				if (route !== null) routes.set(step.id, route);
			} catch (error) {
				diagnostics.push(`step '${step.id}' route preflight failed: ${describeError(error)}`);
			}
		}
		plan = bindExecutionPlanEndpoints(
			plan,
			Object.fromEntries(
				[...routes].map(([stepId, route]) => [
					stepId,
					route.endpoint === undefined
						? undefined
						: {
								key: route.endpoint.key,
								limit: route.endpoint.limit,
								...(route.endpoint.foregroundHeld !== undefined ? { foregroundHeld: route.endpoint.foregroundHeld } : {}),
							},
				]),
			),
		);
	}

	// Resume is validated against the plan just compiled, so an operator
	// approves the exact prefix that will be replayed, on every surface.
	let resume: FleetRunPreview["resume"];
	if (input.resume !== undefined) {
		const record = (input.readRun ?? readFleetRun)(input.resume);
		if (record === null) {
			diagnostics.push(`resume run '${input.resume}' was not found in the durable fleet ledger`);
		} else {
			const planned = planFleetResume(record, plan, playbook, input.vars, input.workspaceRoot);
			if (planned.ok) resume = { fromRunId: input.resume, record, replayed: planned.replayed };
			else if (planned.reason === "fleet-name") {
				diagnostics.push(
					`resume run '${input.resume}' belongs to fleet '${planned.priorFleet}', not '${planned.currentFleet}'`,
				);
			} else if (planned.reason === "workspace") {
				diagnostics.push(
					planned.priorCwd === null
						? `resume run '${input.resume}' predates recorded workspaces, so it cannot be resumed in ${planned.currentCwd}`
						: `resume run '${input.resume}' ran in ${planned.priorCwd}, not ${planned.currentCwd}`,
				);
			} else if (planned.reason === "running") {
				diagnostics.push(
					`resume run '${input.resume}' is still running in process ${planned.pid}; wait for it to settle or cancel it first`,
				);
			} else if (planned.reason === "vars") {
				diagnostics.push(`resume run '${input.resume}' used different --var values`);
			} else {
				const changed = planned.diff
					.slice(0, 8)
					.map((entry) => `step ${entry.index + 1}: ${entry.priorId} -> ${entry.currentId}`);
				diagnostics.push(
					`resume run '${input.resume}' was planned from a different plan (prior=${planned.priorHash.slice(0, 12)} current=${planned.currentHash.slice(0, 12)})${changed.length > 0 ? `; ${changed.join("; ")}` : ""}`,
				);
			}
		}
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
		playbookUsd: playbook.budgetUsd,
		...(input.budget?.pricing ? { pricing: input.budget.pricing } : {}),
	};
	if (input.budget) {
		if (input.budget.verdict === "over" || input.budget.verdict === "at") {
			diagnostics.push(
				`budget ceiling crossed: ${budgetSpendText(budget.currentUsd, budget.pricing)} / ${renderCostAmount(budget.ceilingUsd, "known")}`,
			);
		} else if (playbook.budgetUsd !== null && budget.ceilingUsd > 0) {
			const remaining = budget.ceilingUsd - budget.currentUsd;
			if (playbook.budgetUsd > remaining) {
				diagnostics.push(
					`fleet budget ${renderCostAmount(playbook.budgetUsd, "known")} exceeds remaining session budget ${budgetRemainingText(budget.ceilingUsd, budget.currentUsd, budget.pricing)}`,
				);
			}
		}
	}

	const boundaries = new Map(playbookStepBoundaries(playbook).map((entry) => [entry.id, entry.writes]));
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
				...(resume?.replayed.has(step.id) === true ? { replayed: true as const } : {}),
			};
			if (step.kind === "code") {
				const command = commands?.commands.get(step.commandId);
				return [
					{
						...base,
						kind: "code" as const,
						commandId: step.commandId,
						...(command !== undefined ? { argv: [...command.argv, ...(step.args ?? [])] } : {}),
					},
				];
			}
			const route = routes.get(step.id) ?? null;
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
	// The DAG names recipes and command IDs, but their current bindings and the
	// resolved model are separate facts. Approval must change when those change.
	const commandBindings = [...(commands?.commands.values() ?? [])]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map(({ id, argv, cwd, timeoutMs, env, argumentSlots }) => ({ id, argv, cwd, timeoutMs, env, argumentSlots }));
	const planHash = createHash("sha256")
		.update(
			JSON.stringify({
				version: 1,
				plan: plan.hash,
				recipes: [...recipeFingerprints].sort(([left], [right]) => left.localeCompare(right)),
				commands: commandBindings,
				waves,
				// How the spend was priced only words it, so the identity keeps the amounts it always sealed.
				budget: { ceilingUsd: budget.ceilingUsd, currentUsd: budget.currentUsd, playbookUsd: budget.playbookUsd },
				// Absent for a fresh run, so its approval identity is unchanged.
				...(resume !== undefined
					? {
							resume: {
								fromRunId: resume.fromRunId,
								replayed: [...resume.replayed].map(([stepId, result]) => [stepId, result.receiptDigest ?? null]),
							},
						}
					: {}),
			}),
		)
		.digest("hex");

	return {
		ok: true,
		preview: {
			name: playbook.name,
			vars: { ...input.vars },
			planHash,
			waves,
			budget,
			plan,
			playbook,
			commands,
			task,
			...(resume !== undefined ? { resume } : {}),
		},
	};
}

/**
 * The route each agent step would take, as the dispatch domain resolves it
 * now, with the foreground streams already holding its endpoint. Resolution
 * only: nothing is reserved or dispatched.
 */
export function fleetRouteResolver(
	preview: DispatchContract["preview"],
	roleFacts: AgentRoleFactsResolver,
	foregroundUsage: () => Readonly<Record<string, number>> = foregroundStreamUsage,
	turnConstraints?: TurnConstraints,
): NonNullable<FleetRunPreviewInput["resolveRoute"]> {
	return (step) => {
		const request: DispatchRequest = {
			agentId: step.agentId,
			executionRole: requestExecutionRole({ agentId: step.agentId, resolveFacts: roleFacts }),
			task: step.task,
			...(step.ledger !== undefined ? { ledger: step.ledger } : {}),
			...(turnConstraints !== undefined ? { turnConstraints } : {}),
			...(step.scope === "readonly" ? { readOnly: true as const } : {}),
			...(step.target !== undefined ? { target: step.target } : {}),
			...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
		};
		const resolution = preview?.(request);
		if (!resolution) return null;
		const foregroundHeld = resolution.endpoint === undefined ? 0 : (foregroundUsage()[resolution.endpoint.key] ?? 0);
		return {
			targetId: resolution.targetId,
			wireModelId: resolution.wireModelId,
			nodeId: resolution.node.id,
			...(resolution.endpoint !== undefined
				? { endpoint: { ...resolution.endpoint, ...(foregroundHeld > 0 ? { foregroundHeld } : {}) } }
				: {}),
		};
	};
}
