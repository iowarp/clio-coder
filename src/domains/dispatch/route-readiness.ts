/**
 * Whether a route has earned the right to be selected actively.
 *
 * Shadow mode may rank a cold candidate: nothing executes on its opinion. Active
 * mode does execute on it, so every prerequisite in the plan of record must hold
 * for the exact route and execution role before the resolver may pick it. This
 * module reports each unmet item by name rather than returning a bare boolean,
 * because "not ready" is an operator-facing diagnosis, not a rejection.
 *
 * Pure by construction: the caller owns history reads, fact freshness probes,
 * and the clock. Equal inputs produce an equal report, so a readiness refusal is
 * reproducible from a sealed decision.
 */

import { ROUTE_POSTURES, type RouteEstimate, type RoutingPosture } from "./route-policy.js";

/**
 * The minimum labeled count in the plan of record. Six passes are exactly what
 * clears a 0.6 quality floor under a 95% Wilson lower bound; a higher posture
 * floor naturally demands more evidence than this, which the floor check below
 * enforces on its own.
 */
export const MINIMUM_ACTIVE_QUALITY_LABELS = 6;

export type ReadinessGap =
	| "hard-constraint-validity-below-one"
	| "integrity-failures-in-window"
	| "insufficient-quality-labels"
	| "quality-lower-bound-below-posture-floor"
	| "quality-lower-bound-below-requested-minimum"
	| "reliability-below-posture-floor"
	| "cost-upper-bound-unknown"
	| "route-facts-stale"
	| "decision-latency-above-budget";

/** The p95 shadow-decision budget at the configured universe bound. */
export const DECISION_LATENCY_BUDGET_MS = 10;

export interface RouteReadinessInput {
	estimate: RouteEstimate;
	posture: RoutingPosture;
	/**
	 * Share of retained decisions in which this route's hard constraints were
	 * evaluated consistently. Anything below 1.0 means the filter itself is not
	 * yet trustworthy, so no amount of quality evidence compensates.
	 */
	hardConstraintValidity: number;
	/** Receipt or source integrity failures for this route in the retained window. */
	integrityFailures: number;
	/** Conservative cost ceiling, or null when the route has never completed work. */
	costUpperBoundUsd: number | null;
	/** Node, endpoint, resource, capacity, and settings facts are all current. */
	factsFresh: boolean;
	/** Measured p95 resolver duration at the configured universe bound. */
	decisionP95Ms: number;
	/** The request's own `minimumQuality` bound, when it named one. */
	requestedMinimumQuality: number | null;
}

export interface RouteReadinessReport {
	ready: boolean;
	/** Every unmet prerequisite, in a stable order. Empty exactly when ready. */
	gaps: ReadinessGap[];
	/** How many more labeled outcomes this route needs. Zero once the floor is met. */
	labelsNeeded: number;
}

export function evaluateRouteReadiness(input: RouteReadinessInput): RouteReadinessReport {
	const gaps: ReadinessGap[] = [];
	const floors = ROUTE_POSTURES[input.posture].floors;
	const estimate = input.estimate;

	if (input.hardConstraintValidity < 1) gaps.push("hard-constraint-validity-below-one");
	if (input.integrityFailures > 0) gaps.push("integrity-failures-in-window");
	if (estimate.qualityLabeledCount < MINIMUM_ACTIVE_QUALITY_LABELS) gaps.push("insufficient-quality-labels");
	if (estimate.qualityLowerBound < floors.qualityLowerBound) gaps.push("quality-lower-bound-below-posture-floor");
	if (input.requestedMinimumQuality !== null && estimate.qualityLowerBound < input.requestedMinimumQuality) {
		gaps.push("quality-lower-bound-below-requested-minimum");
	}
	if (estimate.reliability < floors.reliability) gaps.push("reliability-below-posture-floor");
	if (input.costUpperBoundUsd === null || !Number.isFinite(input.costUpperBoundUsd)) {
		gaps.push("cost-upper-bound-unknown");
	}
	if (!input.factsFresh) gaps.push("route-facts-stale");
	if (input.decisionP95Ms > DECISION_LATENCY_BUDGET_MS) gaps.push("decision-latency-above-budget");

	return {
		ready: gaps.length === 0,
		gaps,
		labelsNeeded: Math.max(0, MINIMUM_ACTIVE_QUALITY_LABELS - estimate.qualityLabeledCount),
	};
}

/**
 * Human-readable one-liners for a refusal message. The wording names the
 * missing evidence, so an operator who sees an active refusal can tell whether
 * to wait for measurements or to fix a stale fact.
 */
export function describeReadinessGap(gap: ReadinessGap): string {
	switch (gap) {
		case "hard-constraint-validity-below-one":
			return "hard-constraint evaluation was not consistently valid over the retained window";
		case "integrity-failures-in-window":
			return "the retained window contains receipt or source integrity failures";
		case "insufficient-quality-labels":
			return `fewer than ${MINIMUM_ACTIVE_QUALITY_LABELS} quality-labeled outcomes for this route and role`;
		case "quality-lower-bound-below-posture-floor":
			return "the conservative quality lower bound is below the posture floor";
		case "quality-lower-bound-below-requested-minimum":
			return "the conservative quality lower bound is below the request's minimumQuality";
		case "reliability-below-posture-floor":
			return "route-attributable reliability is below the posture floor";
		case "cost-upper-bound-unknown":
			return "the route has no conservative cost upper bound";
		case "route-facts-stale":
			return "node, endpoint, resource, capacity, or settings facts are stale";
		case "decision-latency-above-budget":
			return `shadow decision p95 exceeds ${DECISION_LATENCY_BUDGET_MS} ms at the configured universe bound`;
	}
}
