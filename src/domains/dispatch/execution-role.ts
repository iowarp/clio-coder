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
 * This module is pure. It owns the role vocabulary, the derivation rules, the
 * gate decider defaults, and the correlation/independence policy. No I/O, no
 * clock, no engine state.
 */

import type { ResultContract } from "../agents/result-contract.js";
import type { AgentCapabilityClass } from "../agents/spec.js";

/**
 * The one execution-role union.
 *
 * `builder` produces the work under review. `reviewer` and `judge` are gate
 * deciders. `researcher` is read-only reconnaissance. `verifier` is a direct
 * typed-validation run outside a gate. `recovery` is any attempt after the
 * first: a retry is not an independent observation of the route, so it never
 * trains ordinary builder quality.
 */
export type ExecutionRole = "builder" | "reviewer" | "judge" | "researcher" | "verifier" | "recovery";

export const EXECUTION_ROLES: ReadonlyArray<ExecutionRole> = [
	"builder",
	"reviewer",
	"judge",
	"researcher",
	"verifier",
	"recovery",
];

export function isExecutionRole(value: unknown): value is ExecutionRole {
	return typeof value === "string" && (EXECUTION_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * Position inside a review or compete topology. This is where a run sits in the
 * gate graph, which is a different question from what execution role its route
 * statistics belong to: every compete candidate occupies a distinct `candidate`
 * position but they are all ordinary `builder` routes.
 */
export type GateTopologyRole = "builder" | "reviewer" | "candidate" | "judge";

/**
 * Facts the role is derived from. `capabilityClass` and `resultContractKind`
 * both come from the strict Slice 2 recipe schema, so a role can never be read
 * off free-form prose or a display-only field.
 */
export interface ExecutionRoleInput {
	/** Zero-based lineage attempt; anything past the first is recovery work. */
	attempt: number;
	/** Review/compete topology position, which overrides the recipe default. */
	gateRole?: GateTopologyRole;
	capabilityClass: AgentCapabilityClass;
	/** Declared typed postcondition, or null for a recipe that declares none. */
	resultContractKind: ResultContract["kind"] | null;
}

/**
 * Derive the one role this run's statistics belong to.
 *
 * Order matters and encodes the policy:
 *
 *   1. A retry or failover attempt is recovery evidence regardless of what it
 *      was originally doing. Recovery runs start from a poisoned context, so
 *      folding them back into the builder population would understate a route
 *      that only ever fails on the first try.
 *   2. Topology overrides the recipe. A Coder placed in the reviewer slot is
 *      reviewer evidence, and a compete candidate is a builder no matter which
 *      candidate ordinal it holds.
 *   3. Outside a gate, the recipe's own typed contract decides. A declared
 *      `verifier-report` is the only contract that makes a direct run a
 *      verifier; a Debugger's `debugger-report` deliberately does not, because
 *      Slice 2 forbids it from masquerading as a gate verdict.
 *   4. A read-only recipe with no verifier contract is reconnaissance.
 */
export function deriveExecutionRole(input: ExecutionRoleInput): ExecutionRole {
	if (input.attempt > 0) return "recovery";
	if (input.gateRole === "reviewer") return "reviewer";
	if (input.gateRole === "judge") return "judge";
	if (input.gateRole === "builder" || input.gateRole === "candidate") return "builder";
	if (input.resultContractKind === "verifier-report") return "verifier";
	if (input.capabilityClass === "read-only") return "researcher";
	return "builder";
}

/** The strict recipe facts a request needs to derive its role, and nothing else. */
export type AgentRoleFacts = Pick<ExecutionRoleInput, "capabilityClass" | "resultContractKind">;

/** Resolves the strict recipe facts for an agent id, or null when it is unknown. */
export type AgentRoleFactsResolver = (agentId: string) => AgentRoleFacts | null;

/** Project an agent spec lookup into the two fields role derivation reads. */
export function agentRoleFactsResolver(
	getSpec: (agentId: string) => { capabilityClass: AgentCapabilityClass; resultContract: ResultContract } | null,
): AgentRoleFactsResolver {
	return (agentId) => {
		const spec = getSpec(agentId);
		return spec === null ? null : { capabilityClass: spec.capabilityClass, resultContractKind: spec.resultContract.kind };
	};
}

/**
 * Derive the role for one request at construction time.
 *
 * A gate position alone determines the role, so a topology never needs the
 * recipe. Outside a gate, an unresolvable agent falls back to `builder`: that is
 * the population with no special standing, so an unknown recipe can never claim
 * verifier or researcher evidence it has not proven. Admission still rejects the
 * unknown agent on its own terms.
 */
export function requestExecutionRole(input: {
	agentId: string;
	gateRole?: GateTopologyRole;
	resolveFacts?: AgentRoleFactsResolver;
}): ExecutionRole {
	const facts = input.resolveFacts?.(input.agentId) ?? null;
	return deriveExecutionRole({
		attempt: 0,
		...(input.gateRole !== undefined ? { gateRole: input.gateRole } : {}),
		capabilityClass: facts?.capabilityClass ?? "workspace-edit",
		resultContractKind: facts?.resultContractKind ?? null,
	});
}

/**
 * Apply the recovery rule to an already-derived request role.
 *
 * The request carries the role its first attempt would run under; only the
 * dispatch lifecycle knows which attempt actually launched. Keeping the rule
 * here means the lifecycle transports the role rather than re-deriving it, so
 * there is exactly one definition of what counts as recovery.
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
 * construction and Slice 1 already refuses to treat it as a quality label, so
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
 * Whether a run's own recipe result contract is its postcondition.
 *
 * A gate decider answers the coordinator's question, not its recipe's. A judge
 * returns a winner, which no recipe contract can express, and a reviewer answers
 * whatever contract the gate asks for regardless of which agent was pinned into
 * the slot. The gate validates that answer and fails closed on a malformed one,
 * so also enforcing an inapplicable recipe postcondition would fail the run
 * before its verdict could be read.
 */
export function appliesRecipeResultContract(gateRole: GateTopologyRole | undefined): boolean {
	return gateRole !== "reviewer" && gateRole !== "judge";
}

/** The route dimensions a gate correlation is measured across. */
export interface RouteCorrelationFacts {
	agentId: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	nodeId: string;
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

/**
 * Deterministic soft preference for an independent decider route.
 *
 * Independence is a tie-break, never a filter. The caller has already applied
 * every hard constraint and quality floor and passes only the survivors, so this
 * function cannot resurrect a rejected route: it returns one of its inputs or
 * nothing. When no eligible route is independent it returns the caller's first
 * preference unchanged, because a single-target fleet must still be able to run
 * its gate. The correlation is reported separately rather than hidden.
 */
export function preferIndependentRoute<T>(
	eligible: ReadonlyArray<T>,
	subject: RouteCorrelationFacts,
	factsOf: (candidate: T) => RouteCorrelationFacts,
): T | null {
	if (eligible.length === 0) return null;
	const independent = eligible.find((candidate) => gateRouteCorrelation(subject, factsOf(candidate)).independent);
	return independent ?? eligible[0] ?? null;
}
