/**
 * Pure joint target, model, runtime, and node resolver.
 *
 * The caller supplies immutable settings dimensions and fact projections. This
 * module enumerates their complete cross-product, applies hard filters, derives
 * estimates, and delegates deterministic Pareto ranking to route-decision.
 * It performs no I/O and never changes the route the caller already resolved.
 */

import type { AgentLatencyClass } from "../agents/spec.js";
import { type AgentCandidateEvaluation, agentRoleReadinessReport } from "./agent-candidates.js";
import type { RouteCorrelationFacts } from "./execution-role.js";
import {
	decideRoute,
	type RouteCandidate,
	type RouteDecisionAgentSelectionInput,
	type RouteDecisionInput,
	type RouteDecisionV1,
	routeCandidateKey,
} from "./route-decision.js";
import {
	estimateRoute,
	type RouteObservation,
	type RoutePrior,
	type RoutingPosture,
	routePriorForLatencyClass,
} from "./route-policy.js";
import { evaluateRouteReadiness, type RouteReadinessReport } from "./route-readiness.js";
import { type RoutingIntent, routingIntentRejection } from "./routing-intent.js";

export const JOINT_ROUTE_UNIVERSE_LIMIT = 64;
export const JOINT_ROUTE_FALLBACK_LIMIT = 3;

export const JOINT_ROUTE_HARD_FILTERS = [
	"manual-pins",
	"approved-envelope",
	"audience",
	"authority",
	"required-tools",
	"required-skills",
	"result-contract",
	"response-schema-support",
	"locality",
	"authentication",
	"network-policy",
	"endpoint-reachability",
	"model-context",
	"resource-fit",
	"capacity-lease-availability",
	"budget",
	"deadline",
	"cooldown",
] as const;

export type JointRouteHardFilter = (typeof JOINT_ROUTE_HARD_FILTERS)[number];
export type JointRouteHardFilterVerdicts = Readonly<Record<JointRouteHardFilter, string | null>>;

export interface JointTargetDimension {
	targetId: string;
	modelId: string;
	runtimeId: string;
	thinkingLevel?: string;
	endpointIdentityHash: string;
}

export interface JointNodeDimension {
	nodeId: string;
}

export interface JointAgentDimension {
	agentId: string;
	specFingerprint: string;
	executionRole: RouteCandidate["executionRole"];
	latencyClass: AgentLatencyClass;
	coldPrior: RoutePrior;
}

/** A single truthful role-quality label retires task-feature priors for this tuple. */
export function routePriorForAgentEvidence(
	agent: JointAgentDimension,
	observations: ReadonlyArray<RouteObservation>,
): RoutePrior {
	return observations.some((observation) => observation.qualityLabel !== "unmeasured")
		? routePriorForLatencyClass(agent.latencyClass)
		: agent.coldPrior;
}

export function configuredJointTargets(
	configured: ReadonlyArray<{
		id: string;
		runtime: string;
		url?: string;
		defaultModel?: string;
		wireModels?: ReadonlyArray<string>;
	}>,
	fallback: JointTargetDimension,
	endpointIdentity: (url: string | undefined) => string,
): JointTargetDimension[] {
	const targets = configured.flatMap((target) =>
		[...new Set([target.defaultModel, ...(target.wireModels ?? [])])].flatMap((modelId) =>
			modelId === undefined
				? []
				: [{ targetId: target.id, modelId, runtimeId: target.runtime, endpointIdentityHash: endpointIdentity(target.url) }],
		),
	);
	return targets.length > 0 ? targets : [{ ...fallback }];
}

export function configuredJointNodes(
	configuredNodeIds: ReadonlyArray<string>,
	executedNodeId: string,
	fixed: boolean,
): JointNodeDimension[] {
	const ids = fixed ? [executedNodeId] : [...configuredNodeIds, executedNodeId, "local"];
	return [...new Set(ids)].map((nodeId) => ({ nodeId }));
}

export interface JointTupleProjection {
	candidate: RouteCandidate;
	hardFilters: JointRouteHardFilterVerdicts;
	observations: ReadonlyArray<RouteObservation>;
	capabilities: ReadonlyArray<string>;
	readiness: {
		hardConstraintValidity: number;
		integrityFailures: number;
		costUpperBoundUsd: number | null;
		factsFresh: boolean;
		decisionP95Ms: number;
	};
}

export interface JointRouteResolverInput {
	mode: "shadow" | "active";
	agents: ReadonlyArray<JointAgentDimension>;
	agentSelection: Omit<RouteDecisionAgentSelectionInput, "readiness"> & {
		evaluations: ReadonlyArray<AgentCandidateEvaluation>;
	};
	executedRoute: RouteCandidate;
	targets: ReadonlyArray<JointTargetDimension>;
	nodes: ReadonlyArray<JointNodeDimension>;
	project: (agent: JointAgentDimension, target: JointTargetDimension, node: JointNodeDimension) => JointTupleProjection;
	intent: RoutingIntent;
	independenceSubject: RouteCorrelationFacts | null;
	posture?: RoutingPosture;
	universeLimit?: number;
	decisionDurationMs?: number;
}

export interface JointRouteResolution {
	decision: RouteDecisionV1;
	/** Complete evaluated universe. No fallback bound is applied to this list. */
	candidateCount: number;
	readiness: ReadonlyArray<{ candidate: RouteCandidate; report: RouteReadinessReport }>;
	agentReadiness: ReturnType<typeof agentRoleReadinessReport>;
}

export interface EnumeratedJointRoute {
	agent: JointAgentDimension;
	projection: JointTupleProjection;
	rejection: string | null;
}

export function emptyJointHardFilterVerdicts(): Record<JointRouteHardFilter, string | null> {
	return Object.fromEntries(JOINT_ROUTE_HARD_FILTERS.map((name) => [name, null])) as Record<
		JointRouteHardFilter,
		string | null
	>;
}

function firstHardRejection(verdicts: JointRouteHardFilterVerdicts): string | null {
	for (const name of JOINT_ROUTE_HARD_FILTERS) {
		const reason = verdicts[name];
		if (reason !== null) return `${name}: ${reason}`;
	}
	return null;
}

function assertProjectionIdentity(
	agent: JointAgentDimension,
	target: JointTargetDimension,
	node: JointNodeDimension,
	candidate: RouteCandidate,
): void {
	if (
		candidate.agentId !== agent.agentId ||
		candidate.specFingerprint !== agent.specFingerprint ||
		candidate.executionRole !== agent.executionRole
	) {
		throw new Error(
			"dispatch routing configuration error: joint universe attempted to enumerate an alternate agent or role",
		);
	}
	if (
		candidate.targetId !== target.targetId ||
		candidate.nodeId !== node.nodeId ||
		candidate.endpointIdentityHash !== target.endpointIdentityHash
	) {
		throw new Error(
			`dispatch routing configuration error: projected candidate identity drifted from its joint dimensions (${candidate.targetId}/${candidate.nodeId}/${candidate.endpointIdentityHash} != ${target.targetId}/${node.nodeId}/${target.endpointIdentityHash})`,
		);
	}
}

/** Enumerate every tuple and retain every hard-filter verdict before ranking. */
export function enumerateJointRouteUniverse(input: JointRouteResolverInput): ReadonlyArray<EnumeratedJointRoute> {
	const limit = Math.max(1, Math.floor(input.universeLimit ?? JOINT_ROUTE_UNIVERSE_LIMIT));
	const universeSize = input.agents.length * input.targets.length * input.nodes.length;
	if (universeSize > limit) {
		throw new Error(
			`dispatch routing configuration error: joint route universe overflow (${universeSize}/${limit}); narrow configured targets, models, runtimes, or nodes`,
		);
	}
	if (universeSize === 0) throw new Error("dispatch routing configuration error: joint route universe is empty");
	const routes: EnumeratedJointRoute[] = [];
	const seen = new Set<string>();
	for (const agent of input.agents) {
		for (const target of input.targets) {
			for (const node of input.nodes) {
				const projection = input.project(agent, target, node);
				assertProjectionIdentity(agent, target, node, projection.candidate);
				const key = routeCandidateKey(projection.candidate);
				if (seen.has(key)) continue;
				seen.add(key);
				routes.push({ agent, projection, rejection: firstHardRejection(projection.hardFilters) });
			}
		}
	}
	return routes;
}

/** Enumerate, filter, estimate, and rank the complete bounded universe. */
export function resolveJointRoute(input: JointRouteResolverInput): JointRouteResolution {
	const universe = enumerateJointRouteUniverse(input);
	const candidates: RouteDecisionInput["candidates"][number][] = universe.map(({ agent, projection, rejection }) => {
		const estimate = estimateRoute(projection.observations, routePriorForAgentEvidence(agent, projection.observations));
		const intentRejection = routingIntentRejection({
			intent: input.intent,
			candidate: projection.candidate,
			qualityLowerBound: estimate.qualityLowerBound,
			costUpperBoundUsd: estimate.costUpperBoundUsd,
			endToEndUpperBoundMs: estimate.p95EndToEndMs,
			capabilities: projection.capabilities,
		});
		return {
			candidate: projection.candidate,
			estimate,
			activeReadiness: evaluateRouteReadiness({
				estimate,
				posture: input.posture ?? input.intent.posture,
				hardConstraintValidity: projection.readiness.hardConstraintValidity,
				integrityFailures: projection.readiness.integrityFailures,
				costUpperBoundUsd: projection.readiness.costUpperBoundUsd,
				factsFresh: projection.readiness.factsFresh,
				decisionP95Ms: projection.readiness.decisionP95Ms,
				requestedMinimumQuality: input.intent.minimumQuality,
			}),
			rejection: rejection ?? (intentRejection === null ? null : `routing-intent: ${intentRejection}`),
		};
	});

	const readiness = candidates.map((entry) => ({
		candidate: { ...entry.candidate },
		report: { ...entry.activeReadiness, gaps: [...entry.activeReadiness.gaps] },
	}));
	const agentReadiness = agentRoleReadinessReport(readiness);
	const decision = decideRoute({
		mode: input.mode,
		posture: input.posture ?? input.intent.posture,
		executedRoute: input.executedRoute,
		candidates,
		independenceSubject: input.independenceSubject,
		hardConstraints: [...JOINT_ROUTE_HARD_FILTERS],
		maxFallbacks: JOINT_ROUTE_FALLBACK_LIMIT,
		decisionDurationMs: input.decisionDurationMs ?? 0,
		agentSelection: { ...input.agentSelection, readiness: agentReadiness },
	});
	return {
		decision,
		candidateCount: candidates.length,
		readiness,
		agentReadiness,
	};
}
