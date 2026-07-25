/**
 * Route policy: the operating points on the cost-quality-latency frontier and
 * the arithmetic that ranks candidates on them.
 *
 * Named postures are the interface. Raw weights are the mechanism and are
 * deliberately not the primary knob: an operator picks "economy", not a vector,
 * because a posture is explainable and testable while a weight vector is
 * neither. Advanced configuration can still override a posture's floors, but a
 * posture always has a name.
 *
 * Governance is not a weight. Hard constraints eliminate candidates before any
 * of this runs; nothing here can trade a constraint against cost or latency.
 *
 * Pure by construction: no I/O, no clock, no engine state. Every function is a
 * deterministic mapping from its arguments, which is what makes an offline
 * replay of a stored decision reproduce the stored decision.
 */

export const ROUTE_POLICY_VERSION = "route-policy/1";

export type RoutingPosture = "manual" | "quality" | "balanced" | "latency" | "economy";

export const ROUTING_POSTURES: ReadonlyArray<RoutingPosture> = ["manual", "quality", "balanced", "latency", "economy"];

export function isRoutingPosture(value: unknown): value is RoutingPosture {
	return typeof value === "string" && (ROUTING_POSTURES as ReadonlyArray<string>).includes(value);
}

/**
 * The objective vector for one candidate, with its own uncertainty. Quality is
 * verified success, never "the process exited zero": an unverified answer that
 * returned quickly is not a better operating point than a verified one.
 */
export interface RouteEstimate {
	verifiedSuccessProbability: number;
	firstPassSuccessProbability: number;
	expectedCostUsd: number;
	costUpperBoundUsd: number;
	expectedEndToEndMs: number;
	p95EndToEndMs: number;
	reliability: number;
	cacheHitProbability: number;
	queueWaitMs: number;
	sampleCount: number;
	confidence: number;
}

/**
 * A posture is two things: floors that a candidate must clear to be selectable
 * at all, and weights that order whatever clears them. `deadlineFirst` is the
 * one structural difference: the latency posture ranks p95 ahead of quality
 * inside the floor, because a deadline missed is a task failed.
 */
export interface RoutePosturePolicy {
	floors: { verifiedSuccessProbability: number; reliability: number };
	weights: { quality: number; cost: number; latency: number };
	deadlineFirst: boolean;
}

/**
 * manual is not a scoring posture. It names the operator's exact requested
 * route and fails closed, so its floors are zero and its weights select the
 * resolved route by construction rather than by comparison.
 */
export const ROUTE_POSTURES: Readonly<Record<RoutingPosture, RoutePosturePolicy>> = {
	manual: {
		floors: { verifiedSuccessProbability: 0, reliability: 0 },
		weights: { quality: 1, cost: 0, latency: 0 },
		deadlineFirst: false,
	},
	quality: {
		floors: { verifiedSuccessProbability: 0.8, reliability: 0.8 },
		weights: { quality: 1, cost: 0.1, latency: 0.1 },
		deadlineFirst: false,
	},
	balanced: {
		floors: { verifiedSuccessProbability: 0.6, reliability: 0.6 },
		weights: { quality: 0.6, cost: 0.2, latency: 0.2 },
		deadlineFirst: false,
	},
	latency: {
		floors: { verifiedSuccessProbability: 0.5, reliability: 0.6 },
		weights: { quality: 0.3, cost: 0.1, latency: 0.6 },
		deadlineFirst: true,
	},
	economy: {
		floors: { verifiedSuccessProbability: 0.6, reliability: 0.6 },
		weights: { quality: 0.3, cost: 0.6, latency: 0.1 },
		deadlineFirst: false,
	},
};

/**
 * The conservative operator prior for a route with no history. Unknown price is
 * never free and unknown quality is never certain: a cold route is assumed
 * mediocre and expensive so that a warm, measured route wins on evidence rather
 * than on the optimism of a missing sample.
 */
export interface RoutePrior {
	verifiedSuccessProbability: number;
	firstPassSuccessProbability: number;
	costUpperBoundUsd: number;
	expectedEndToEndMs: number;
	reliability: number;
	queueWaitMs: number;
}

export const DEFAULT_ROUTE_PRIOR: RoutePrior = {
	verifiedSuccessProbability: 0.5,
	firstPassSuccessProbability: 0.5,
	costUpperBoundUsd: 1,
	expectedEndToEndMs: 120_000,
	reliability: 0.5,
	queueWaitMs: 0,
};

/** One settled run of a route tuple, reduced to the objective vector's inputs. */
export interface RouteObservation {
	verified: boolean;
	firstPass: boolean;
	costUsd: number;
	endToEndMs: number;
	succeeded: boolean;
	cacheRead: boolean;
	queueWaitMs: number;
}

/** Samples needed before the measurement outweighs the prior. */
export const ROUTE_ESTIMATE_SHRINKAGE = 5;

function mean(values: ReadonlyArray<number>, fallback: number): number {
	if (values.length === 0) return fallback;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: ReadonlyArray<number>, fraction: number, fallback: number): number {
	if (values.length === 0) return fallback;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index] ?? fallback;
}

function shrink(measured: number, prior: number, sampleCount: number): number {
	const weight = sampleCount / (sampleCount + ROUTE_ESTIMATE_SHRINKAGE);
	return measured * weight + prior * (1 - weight);
}

function rate(values: ReadonlyArray<boolean>): number {
	if (values.length === 0) return 0;
	return values.filter(Boolean).length / values.length;
}

/**
 * Blend a route's measured history with the conservative prior. A cold route
 * gets the prior verbatim; a route with history moves toward its measurements
 * at a rate set by how much history it has. Cost keeps a separate upper bound
 * because budget reservation must hold the bound, not the mean.
 *
 * Cost and latency are measured over the runs that finished the work, never
 * over every run. A target that answers 503 in eight milliseconds is not a fast
 * cheap route; it is an unreliable one, and folding its failures into the
 * latency mean is exactly the kind of implementation artifact a router must not
 * be allowed to optimize. Failures stay in reliability, verified success, and
 * first-pass success, which is where they carry real signal.
 */
export function estimateRoute(
	samples: ReadonlyArray<RouteObservation>,
	prior: RoutePrior = DEFAULT_ROUTE_PRIOR,
): RouteEstimate {
	const sampleCount = samples.length;
	const completed = samples.filter((sample) => sample.succeeded);
	const completedCount = completed.length;
	const costs = completed.map((sample) => sample.costUsd);
	const latencies = completed.map((sample) => sample.endToEndMs);
	const measuredCost = mean(costs, prior.costUpperBoundUsd);
	const measuredLatency = mean(latencies, prior.expectedEndToEndMs);
	const expectedCostUsd = shrink(measuredCost, prior.costUpperBoundUsd, completedCount);
	const expectedEndToEndMs = shrink(measuredLatency, prior.expectedEndToEndMs, completedCount);
	return {
		verifiedSuccessProbability: shrink(
			rate(samples.map((sample) => sample.verified)),
			prior.verifiedSuccessProbability,
			sampleCount,
		),
		firstPassSuccessProbability: shrink(
			rate(samples.map((sample) => sample.firstPass)),
			prior.firstPassSuccessProbability,
			sampleCount,
		),
		expectedCostUsd,
		costUpperBoundUsd: Math.max(prior.costUpperBoundUsd, quantile(costs, 0.95, prior.costUpperBoundUsd)),
		expectedEndToEndMs,
		p95EndToEndMs: Math.max(expectedEndToEndMs, quantile(latencies, 0.95, prior.expectedEndToEndMs)),
		reliability: shrink(rate(samples.map((sample) => sample.succeeded)), prior.reliability, sampleCount),
		cacheHitProbability: completedCount === 0 ? 0 : rate(completed.map((sample) => sample.cacheRead)),
		queueWaitMs: shrink(
			mean(
				completed.map((sample) => sample.queueWaitMs),
				prior.queueWaitMs,
			),
			prior.queueWaitMs,
			completedCount,
		),
		sampleCount,
		confidence: sampleCount / (sampleCount + ROUTE_ESTIMATE_SHRINKAGE),
	};
}

/** True when a candidate clears the posture's quality and reliability floors. */
export function clearsPostureFloors(estimate: RouteEstimate, posture: RoutingPosture): boolean {
	const policy = ROUTE_POSTURES[posture];
	return (
		estimate.verifiedSuccessProbability >= policy.floors.verifiedSuccessProbability &&
		estimate.reliability >= policy.floors.reliability
	);
}

/** Min-max normalization to 0..1 where 0 is best; an all-equal set normalizes to 0. */
function normalize(value: number, min: number, max: number): number {
	if (!(max > min)) return 0;
	return (value - min) / (max - min);
}

export interface RouteScoreScale {
	minCostUsd: number;
	maxCostUsd: number;
	minLatencyMs: number;
	maxLatencyMs: number;
}

/**
 * The comparison scale for one decision. Cost and latency are only meaningful
 * relative to the alternatives actually on the table, so the scale is derived
 * from the admissible set rather than from an absolute constant that would
 * change meaning between a local fleet and a cloud one.
 */
export function routeScoreScale(estimates: ReadonlyArray<RouteEstimate>): RouteScoreScale {
	const costs = estimates.map((estimate) => estimate.expectedCostUsd);
	const latencies = estimates.map((estimate) => estimate.p95EndToEndMs);
	return {
		minCostUsd: costs.length > 0 ? Math.min(...costs) : 0,
		maxCostUsd: costs.length > 0 ? Math.max(...costs) : 0,
		minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
		maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
	};
}

/** Rounding that keeps float noise out of the deterministic tie-break. */
const SCORE_PRECISION = 1e-9;

function round(value: number): number {
	return Math.round(value / SCORE_PRECISION) * SCORE_PRECISION;
}

/**
 * Posture score, higher is better. Quality is the verified-success estimate;
 * cost and latency are penalties normalized across the admissible set. The
 * latency posture puts p95 ahead of the mean because a deadline is about the
 * tail, not the average.
 */
export function scoreRoute(estimate: RouteEstimate, posture: RoutingPosture, scale: RouteScoreScale): number {
	const policy = ROUTE_POSTURES[posture];
	const costPenalty = normalize(estimate.expectedCostUsd, scale.minCostUsd, scale.maxCostUsd);
	const latencyPenalty = normalize(
		policy.deadlineFirst ? estimate.p95EndToEndMs : estimate.expectedEndToEndMs,
		scale.minLatencyMs,
		scale.maxLatencyMs,
	);
	return round(
		policy.weights.quality * estimate.verifiedSuccessProbability -
			policy.weights.cost * costPenalty -
			policy.weights.latency * latencyPenalty,
	);
}

/**
 * Pareto dominance on the three objectives: `left` dominates `right` when it is
 * no worse on quality, cost, and latency, and strictly better on at least one.
 * A dominated candidate is never the right operating point at any posture, so
 * removing it costs nothing and shrinks what an operator has to read.
 */
export function dominatesRoute(left: RouteEstimate, right: RouteEstimate): boolean {
	const noWorse =
		left.verifiedSuccessProbability >= right.verifiedSuccessProbability &&
		left.expectedCostUsd <= right.expectedCostUsd &&
		left.p95EndToEndMs <= right.p95EndToEndMs;
	if (!noWorse) return false;
	return (
		left.verifiedSuccessProbability > right.verifiedSuccessProbability ||
		left.expectedCostUsd < right.expectedCostUsd ||
		left.p95EndToEndMs < right.p95EndToEndMs
	);
}

export interface RankedRoute {
	/** Stable identity used as the final tie-break, so equal inputs rank equally. */
	key: string;
	/** Position in the caller's approval order; the resolved route is always zero. */
	order: number;
	estimate: RouteEstimate;
	score: number;
}

/**
 * Total order over candidates: score descending, then cheapest, then fastest
 * tail, then approval order, then the candidate key.
 *
 * Approval order before the key is what keeps a tie from churning the route. On
 * a cold fleet every candidate carries the identical prior, so every objective
 * ties; ordering by key there would recommend whichever target happened to sort
 * first and report it as divergence from the route that ran. Approval order puts
 * the resolved route first, so a tie recommends staying put. The key remains the
 * last tie-break, so the comparator is still total and equal inputs still
 * produce equal rankings.
 */
export function compareRankedRoutes(left: RankedRoute, right: RankedRoute): number {
	if (left.score !== right.score) return right.score - left.score;
	if (left.estimate.expectedCostUsd !== right.estimate.expectedCostUsd) {
		return left.estimate.expectedCostUsd - right.estimate.expectedCostUsd;
	}
	if (left.estimate.p95EndToEndMs !== right.estimate.p95EndToEndMs) {
		return left.estimate.p95EndToEndMs - right.estimate.p95EndToEndMs;
	}
	if (left.order !== right.order) return left.order - right.order;
	return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}
