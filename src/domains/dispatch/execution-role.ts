/**
 * Semantic execution roles and the gate-route policy that depends on them.
 *
 * A route identity is not just a tuple of agent, target, model, runtime, and
 * node. The same Coder on the same target is a different statistical population
 * depending on what it was asked to do: producing work, reviewing someone
 * else's work, judging between candidates, or recovering from a failed attempt.
 * Mixing those samples makes every estimator lie, so the role is a required,
 * typed part of the request, the envelope, the receipt, the route candidate, and
 * the route-history key rather than something inferred at scoring time.
 *
 * This module is pure. It owns the role vocabulary, the request-time role
 * resolution (one rule, `resolveRunRole`, plus recovery for a later attempt),
 * the gate decider defaults, and the correlation/independence policy. No I/O,
 * no clock, no engine state.
 */

import { EXECUTION_ROLE_VOCABULARY } from "../../core/telemetry/run-vocabulary.js";
import { dispatchJobRecipe } from "../agents/dispatch-jobs.js";
import { isHoareResultContract, type ResultContract, withResultSummaryAllowance } from "../agents/result-contract.js";
import type { AgentCapabilityClass } from "../agents/spec.js";
import type { DispatchRequest } from "./contract.js";
import { type RunRole, requestedWriteNone, resolveRunRole } from "./obligation.js";

/**
 * The one execution-role union.
 *
 * The names are the fleet role vocabulary (DESIGN 4.2, M12). `builder` produces
 * the work under review. `reviewer` and `judge` are gate deciders. `explorer`
 * is a run that writes nothing outside a gate and `seat` a council member.
 * `checker` is a verification-class recipe outside a gate. `recovery` is any attempt after
 * the first: a retry is not an independent observation of the route, so it
 * never trains ordinary builder quality. Runs journaled before M12 recorded
 * `researcher` and `verifier`; those records read as recorded and nothing
 * writes or matches those names.
 */
export type ExecutionRole = (typeof EXECUTION_ROLE_VOCABULARY)[number];

export const EXECUTION_ROLES: ReadonlyArray<ExecutionRole> = EXECUTION_ROLE_VOCABULARY;

export function isExecutionRole(value: unknown): value is ExecutionRole {
	return typeof value === "string" && (EXECUTION_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * Position inside a review or compete topology. This is where a run sits in the
 * gate graph, which is a different question from what execution role its route
 * statistics belong to: every compete candidate occupies a distinct `candidate`
 * position but they are all ordinary `builder` routes.
 */
export type GateTopologyRole = "builder" | "reviewer" | "candidate" | "judge" | "member" | "synthesis";

/** The strict recipe facts a request's role is resolved from, and nothing else. */
export interface AgentRoleFacts {
	capabilityClass: AgentCapabilityClass | string;
	resultContract: ResultContract;
}

/** Resolves the strict recipe facts for an agent id, or null when it is unknown. */
export type AgentRoleFactsResolver = (agentId: string) => AgentRoleFacts | null;

/** Project an agent spec lookup into the two fields role resolution reads. */
export function agentRoleFactsResolver(
	getSpec: (agentId: string) => { capabilityClass: AgentCapabilityClass; resultContract: ResultContract } | null,
): AgentRoleFactsResolver {
	return (agentId) => {
		const spec = getSpec(agentId);
		return spec === null ? null : { capabilityClass: spec.capabilityClass, resultContract: spec.resultContract };
	};
}

/** The request fields a run's role is resolved from: its seat, its gate position, its write scope and its contract. */
export interface RunRoleRequest {
	agentId: string;
	gate?: { role?: GateTopologyRole } | undefined;
	readOnly?: boolean | undefined;
	resultContractOverride?: ResultContract | undefined;
}

/**
 * The role a request's first attempt runs under (DESIGN 4.2): `resolveRunRole` over the request's gate position, its
 * recipe's class and whether it may write, the same facts the run's envelope is built from, so the role a run is
 * journaled, routed and receipted under is always its `envelope.role`. Write scope is part of the request: a caller
 * constructs the request whole (readOnly, gate, contract override) before resolving its role. An unknown agent has no
 * class, so it can never claim checker evidence; admission rejects it on its own terms.
 */
export function requestRunRole(req: RunRoleRequest, resolveFacts?: AgentRoleFactsResolver): RunRole {
	const facts = resolveFacts?.(req.agentId) ?? null;
	const capabilityClass = facts?.capabilityClass ?? null;
	// Without a result summary allowance the contract resolution cannot throw.
	const contract = dispatchResultContract(
		{
			agentId: req.agentId,
			...(req.gate !== undefined ? { gate: req.gate } : {}),
			...(req.resultContractOverride !== undefined ? { resultContractOverride: req.resultContractOverride } : {}),
		},
		facts,
	);
	return resolveRunRole({
		gateRole: req.gate?.role,
		capabilityClass,
		readOnly: requestedWriteNone({
			readOnly: req.readOnly,
			capabilityClass,
			hoareContract: isHoareResultContract(contract),
		}),
	});
}

/** The request with the role `requestRunRole` resolves for it, for a construction site that builds the request whole. */
export function withRunRole(
	req: Omit<DispatchRequest, "executionRole"> & { executionRole?: ExecutionRole },
	resolveFacts?: AgentRoleFactsResolver,
): DispatchRequest {
	return { ...req, executionRole: requestRunRole(req, resolveFacts) };
}

/**
 * Apply the recovery rule to a request's role.
 *
 * The request carries the role its first attempt runs under; only the dispatch lifecycle knows which attempt actually
 * launched. A retry or failover attempt is recovery evidence whatever it was doing: it starts from a poisoned context,
 * so folding it into its first attempt's population would understate a route that only ever fails on the first try.
 */
export function withAttemptRole(requestRole: ExecutionRole, attempt: number): ExecutionRole {
	return attempt > 0 ? "recovery" : requestRole;
}

/**
 * The builtin quality agent every gate decider defaults to.
 *
 * Defaulting a reviewer or judge to the builder agent makes the gate a
 * self-review: the same recipe, the same prompt surface, and usually the same
 * model family grading its own output. That verdict is correlated by
 * construction and cannot count as an independent quality label, so
 * the default has to be an agent whose entire contract is independent typed
 * validation.
 */
export const DEFAULT_GATE_DECIDER_AGENT_ID = "verifier";

/** Resolve a gate decider without ever falling back to the subject builder. */
export function gateDeciderAgentId(requested: string | undefined): string {
	const trimmed = requested?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : DEFAULT_GATE_DECIDER_AGENT_ID;
}

/**
 * Resolve a review gate's decider: the job table's recipe for reviewing a
 * diff, and the gate default only when this install lacks it. Like every gate
 * decider it never falls back to the subject builder.
 */
export function reviewDeciderAgentId(requested: string | undefined, installed?: (id: string) => boolean): string {
	const trimmed = requested?.trim() ?? "";
	if (trimmed.length > 0) return trimmed;
	const reviewer = dispatchJobRecipe("review");
	return installed === undefined || installed(reviewer) ? reviewer : DEFAULT_GATE_DECIDER_AGENT_ID;
}

/**
 * The builtin a council judge defaults to. The self-review rule above applies,
 * but the verifier cannot sit here: it requires `verify`, which the judge's
 * `council-read-only` profile does not grant. Oracle is read-only and needs
 * only `read`, so it fits the profile and differs from the default seat.
 */
export const DEFAULT_COUNCIL_JUDGE_AGENT_ID = "oracle";
const COUNCIL_JUDGE_ALTERNATE_AGENT_ID = "researcher";

/** Resolve a council judge that is never the seated agent unless the caller names it. */
export function councilJudgeAgentId(requested: string | undefined, seated: string): string {
	const trimmed = requested?.trim() ?? "";
	if (trimmed.length > 0) return trimmed;
	return seated === DEFAULT_COUNCIL_JUDGE_AGENT_ID ? COUNCIL_JUDGE_ALTERNATE_AGENT_ID : DEFAULT_COUNCIL_JUDGE_AGENT_ID;
}

/**
 * The contract a gate decider answers under (fleet design 4.8, M9). A gate decider answers the coordinator's
 * question, not its recipe's, so its recipe's postcondition never applies; it gets the gate's own verdict contract
 * instead, which makes V2 conformance and claim grounding apply to it as to any other run. A reviewer answers
 * `review-verdict`; a compete judge `judge-verdict` with one winner among its subjects; a council synthesis
 * `judge-verdict` with no candidates, its `{verdict, text}`. Undefined for every other run, including a council
 * member, whose ballot arrives as the topology's override.
 */
function gateVerdictContract(gate: DispatchResultContractRequest["gate"]): ResultContract | undefined {
	// The packet's ids ride the contract so the shape, the bound schema and the repair round all name them (M10).
	const ids = gate?.packet?.ids;
	const packet = ids !== undefined && ids.length > 0 ? { packet: [...ids] } : {};
	if (gate?.role === "reviewer") return { kind: "review-verdict", ...packet };
	if (gate?.role === "judge")
		return { kind: "judge-verdict", candidates: Math.max(1, gate.subjects?.length ?? 1), ...packet };
	if (gate?.role === "synthesis") return { kind: "judge-verdict" };
	return undefined;
}

/**
 * The contract a fleet step whose output a gate checks hands back. A builder's is its builder report, with the typed
 * completion DESIGN 4.3 requires; any other role's output is prose, so it answers `text-report`.
 */
export function gateAuthorContractKind(role: ExecutionRole): "artifact-report" | "text-report" {
	return role === "builder" ? "artifact-report" : "text-report";
}

/** A caller's summary allowance for one dispatch, with where it was set. */
export interface DispatchResultSummaryAllowance {
	maxBytes: number;
	/**
	 * `task` is an explicit setting on this one assignment; `batch` is the
	 * shared default every member of a batch or pipeline inherits. Only the
	 * explicit form can be a caller error on a recipe with no summary field.
	 */
	scope: "task" | "batch";
}

/** The request fields the applied result contract is resolved from. */
export interface DispatchResultContractRequest {
	agentId: string;
	gate?:
		| {
				role?: GateTopologyRole;
				subjects?: ReadonlyArray<unknown>;
				packet?: { ids: ReadonlyArray<string> } | undefined;
		  }
		| undefined;
	resultContractOverride?: ResultContract;
	resultSummary?: DispatchResultSummaryAllowance;
}

/**
 * The one resolution of the contract a run is validated and sealed against.
 * Every reader (the worker spec, the capture bound, the seal) calls this so
 * the worker repairs against exactly the contract the receipt will name.
 *
 * Precedence: a gate role that answers its topology gets that topology's verdict
 * contract and never its recipe's; a council member gets only the topology's
 * override; otherwise the coordinator's override, else the seated recipe's. A
 * caller's summary allowance then applies to a mutation report only. A
 * topology-owned override (ballot, plan, gate author) and a batch-level default
 * inherited by a non-mutation step ignore it, because the allowance was never
 * about that step. An explicit per-task allowance on a recipe with no summary
 * field is a caller error and fails here, before any model boots.
 */
export function dispatchResultContract(
	req: DispatchResultContractRequest,
	recipe: { resultContract: ResultContract } | null | undefined,
): ResultContract | undefined {
	const gateContract = gateVerdictContract(req.gate);
	if (gateContract !== undefined) return gateContract;
	// A council member answers the council's question under a read-only
	// profile, whatever recipe it is seated as, so a recipe contract that needs
	// a write (an architect's plan file, a coder's mutation report) can never
	// hold there. Only the topology's own override (the vote ballot) applies.
	if (req.gate?.role === "member") return req.resultContractOverride;
	const base = req.resultContractOverride ?? recipe?.resultContract;
	const allowance = req.resultSummary;
	if (allowance === undefined) return base;
	if (base?.kind === "mutation-report") return withResultSummaryAllowance(base, allowance.maxBytes);
	if (req.resultContractOverride !== undefined || allowance.scope === "batch") return base;
	throw new Error(
		`dispatch: result_summary_max_bytes applies only to a mutation-report result contract; agent '${req.agentId}' declares ${base === undefined ? "no result contract" : base.kind}`,
	);
}

/** The route dimensions a gate correlation is measured across. */
export interface RouteCorrelationFacts {
	agentId: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	nodeId: string;
}

/** Project a trusted run envelope into the bounded gate-correlation identity. */
export function routeCorrelationFactsForRun(run: {
	agentId: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	node?: { id: string } | null;
}): RouteCorrelationFacts {
	return {
		agentId: run.agentId,
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		nodeId: run.node?.id ?? "local",
	};
}

export interface GateRouteCorrelation {
	agent: boolean;
	target: boolean;
	modelFamily: boolean;
	runtime: boolean;
	node: boolean;
	/**
	 * True when the decider is not a proxy for its subject. A shared target,
	 * runtime, or node is an operational fact about a small fleet; a shared agent
	 * or model family is a shared failure mode, and only those two can make a
	 * verdict self-confirming.
	 */
	independent: boolean;
	/** Correlated dimension names, sorted, for artifacts and explanations. */
	dimensions: string[];
}

/**
 * Provider model ids commonly append a dated snapshot. The stable family is the
 * part before that suffix; an unfamiliar id remains its own exact identity.
 */
export function modelFamily(model: string): string {
	return model
		.trim()
		.toLowerCase()
		.replace(/[-_:]?\d{4}[-_]?\d{2}[-_]?\d{2}$/u, "");
}

export function gateRouteCorrelation(
	subject: RouteCorrelationFacts,
	decider: RouteCorrelationFacts,
): GateRouteCorrelation {
	const agent = subject.agentId === decider.agentId;
	const target = subject.targetId === decider.targetId;
	const sameModelFamily = modelFamily(subject.wireModelId) === modelFamily(decider.wireModelId);
	const runtime = subject.runtimeId === decider.runtimeId;
	const node = subject.nodeId === decider.nodeId;
	const dimensions = [
		...(agent ? ["agent"] : []),
		...(target ? ["target"] : []),
		...(sameModelFamily ? ["model-family"] : []),
		...(runtime ? ["runtime"] : []),
		...(node ? ["node"] : []),
	].sort();
	return {
		agent,
		target,
		modelFamily: sameModelFamily,
		runtime,
		node,
		independent: !agent && !sameModelFamily,
		dimensions,
	};
}
