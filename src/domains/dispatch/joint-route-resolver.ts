/**
 * Pure joint target, model, runtime, and node resolver.
 *
 * The caller supplies immutable settings dimensions and fact projections. This
 * module enumerates their complete cross-product, applies hard filters, derives
 * estimates, and delegates deterministic Pareto ranking to route-decision.
 * It performs no I/O and never changes the route the caller already resolved.
 */

import type { AgentLatencyClass } from "../agents/spec.js";
import {
	decideRoute,
	type RouteCandidate,
	type RouteDecisionInput,
	type RouteDecisionV1,
	routeCandidateKey,
} from "./route-decision.js";
import {
	estimateRoute,
	type RouteObservation,
	type RoutingPosture,
	routePriorForLatencyClass,
} from "./route-policy.js";
import { type RoutingIntent, routingIntentRejection } from "./routing-intent.js";

export const JOINT_ROUTE_UNIVERSE_LIMIT = 64;
export const JOINT_ROUTE_FALLBACK_LIMIT = 3;

export const JOINT_ROUTE_HARD_FILTERS = [
	"manual-pins",
	"approved-envelope",
	"authority",
	"required-tools",
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
	latencyClass: AgentLatencyClass;
	capabilities: ReadonlyArray<string>;
}

export interface JointRouteResolverInput {
	agentId: string;
	executionRole: RouteCandidate["executionRole"];
	executedRoute: RouteCandidate;
	targets: ReadonlyArray<JointTargetDimension>;
	nodes: ReadonlyArray<JointNodeDimension>;
	project: (target: JointTargetDimension, node: JointNodeDimension) => JointTupleProjection;
	intent: RoutingIntent;
	posture?: RoutingPosture;
	universeLimit?: number;
	decisionDurationMs?: number;
}

export interface JointRouteResolution {
	decision: RouteDecisionV1;
	/** Complete evaluated universe. No fallback bound is applied to this list. */
	candidateCount: number;
}

export interface EnumeratedJointRoute {
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
	input: JointRouteResolverInput,
	target: JointTargetDimension,
	node: JointNodeDimension,
	candidate: RouteCandidate,
): void {
	if (candidate.agentId !== input.agentId || candidate.executionRole !== input.executionRole) {
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
	const universeSize = input.targets.length * input.nodes.length;
	if (universeSize > limit) {
		throw new Error(
			`dispatch routing configuration error: joint route universe overflow (${universeSize}/${limit}); narrow configured targets, models, runtimes, or nodes`,
		);
	}
	if (universeSize === 0) throw new Error("dispatch routing configuration error: joint route universe is empty");
	const routes: EnumeratedJointRoute[] = [];
	const seen = new Set<string>();
	for (const target of input.targets) {
		for (const node of input.nodes) {
			const projection = input.project(target, node);
			assertProjectionIdentity(input, target, node, projection.candidate);
			const key = routeCandidateKey(projection.candidate);
			if (seen.has(key)) continue;
			seen.add(key);
			routes.push({ projection, rejection: firstHardRejection(projection.hardFilters) });
		}
	}
	return routes;
}

/** Enumerate, filter, estimate, and rank the complete bounded universe. */
export function resolveJointRoute(input: JointRouteResolverInput): JointRouteResolution {
	const universe = enumerateJointRouteUniverse(input);
	const candidates: RouteDecisionInput["candidates"][number][] = universe.map(({ projection, rejection }) => {
		const estimate = estimateRoute(projection.observations, routePriorForLatencyClass(projection.latencyClass));
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
			rejection: rejection ?? (intentRejection === null ? null : `routing-intent: ${intentRejection}`),
		};
	});

	const decision = decideRoute({
		mode: "shadow",
		posture: input.posture ?? input.intent.posture,
		executedRoute: input.executedRoute,
		candidates,
		hardConstraints: [...JOINT_ROUTE_HARD_FILTERS],
		maxFallbacks: JOINT_ROUTE_FALLBACK_LIMIT,
		decisionDurationMs: input.decisionDurationMs ?? 0,
	});
	return { decision, candidateCount: candidates.length };
}
