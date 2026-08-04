/**
 * Pure route-estimation and posture policy. Hard constraints are applied by the
 * resolver before this module runs; none of the values below can trade a hard
 * admission property for a better score.
 */

import type { AgentLatencyClass } from "../agents/spec.js";
import type { RouteHistoryRecord } from "./route-history.js";
import type { RouteQualityLabel } from "./route-quality.js";

export const ROUTE_POLICY_VERSION = "route-policy/4";
export const MINIMUM_QUALITY_LABELED_OUTCOMES = 6;

export type RoutingPosture = "manual" | "quality" | "balanced" | "latency" | "economy";

export const ROUTING_POSTURES: ReadonlyArray<RoutingPosture> = ["manual", "quality", "balanced", "latency", "economy"];

export function isRoutingPosture(value: unknown): value is RoutingPosture {
	return typeof value === "string" && (ROUTING_POSTURES as ReadonlyArray<string>).includes(value);
}

export interface RouteEstimate {
	/** Quality denominators contain pass/fail labels only; unmeasured work is excluded. */
	qualityLabeledCount: number;
	unmeasuredCount: number;
	qualityCoverage: number;
	qualityMean: number;
	/** 95% Wilson lower bound, the only quality value used for posture floors. */
	qualityLowerBound: number;
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

export interface RoutePosturePolicy {
	floors: { qualityLowerBound: number; reliability: number };
	weights: { quality: number; cost: number; latency: number };
	deadlineFirst: boolean;
}

export const ROUTE_POSTURES: Readonly<Record<RoutingPosture, RoutePosturePolicy>> = {
	manual: {
		floors: { qualityLowerBound: 0, reliability: 0 },
		weights: { quality: 1, cost: 0, latency: 0 },
		deadlineFirst: false,
	},
	quality: {
		floors: { qualityLowerBound: 0.8, reliability: 0.8 },
		weights: { quality: 1, cost: 0.1, latency: 0.1 },
		deadlineFirst: false,
	},
	balanced: {
		floors: { qualityLowerBound: 0.6, reliability: 0.6 },
		weights: { quality: 0.6, cost: 0.2, latency: 0.2 },
		deadlineFirst: false,
	},
	latency: {
		floors: { qualityLowerBound: 0.5, reliability: 0.6 },
		weights: { quality: 0.3, cost: 0.1, latency: 0.6 },
		deadlineFirst: true,
	},
	economy: {
		floors: { qualityLowerBound: 0.6, reliability: 0.6 },
		weights: { quality: 0.3, cost: 0.6, latency: 0.1 },
		deadlineFirst: false,
	},
};

export interface RoutePrior {
	qualityMean: number;
	firstPassSuccessProbability: number;
	costUpperBoundUsd: number;
	expectedEndToEndMs: number;
	reliability: number;
	queueWaitMs: number;
}

export const DEFAULT_ROUTE_PRIOR: RoutePrior = {
	qualityMean: 0.5,
	firstPassSuccessProbability: 0.5,
	costUpperBoundUsd: 1,
	expectedEndToEndMs: 120_000,
	reliability: 0.5,
	queueWaitMs: 0,
};

/** Cold-start latency only. Completed route timing supersedes these priors. */
export const LATENCY_CLASS_ROUTE_PRIORS: Readonly<Record<AgentLatencyClass, RoutePrior>> = {
	fast: { ...DEFAULT_ROUTE_PRIOR, expectedEndToEndMs: 30_000 },
	balanced: { ...DEFAULT_ROUTE_PRIOR, expectedEndToEndMs: 120_000 },
	deep: { ...DEFAULT_ROUTE_PRIOR, expectedEndToEndMs: 300_000 },
};

export function routePriorForLatencyClass(latencyClass: AgentLatencyClass): RoutePrior {
	return { ...LATENCY_CLASS_ROUTE_PRIORS[latencyClass] };
}

/** The estimator projection of one durable route-history record. */
export interface RouteObservation {
	qualityLabel: RouteQualityLabel;
	reliability: "success" | "failure" | "neutral";
	firstPass: boolean;
	completedCostUsd: number | null;
	completedEndToEndMs: number | null;
	cacheRead: boolean;
	queueWaitMs: number | null;
}

export function routeObservationFromHistory(record: RouteHistoryRecord): RouteObservation {
	return {
		qualityLabel: record.qualityLabel,
		reliability: record.reliability,
		firstPass: record.firstPass,
		completedCostUsd: record.completedCostUsd,
		completedEndToEndMs: record.completedPhaseTiming?.totalEndToEndMs ?? null,
		cacheRead: record.cacheRead,
		queueWaitMs: record.completedPhaseTiming?.queueWaitMs ?? null,
	};
}

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

function rate(values: ReadonlyArray<boolean>, fallback = 0): number {
	if (values.length === 0) return fallback;
	return values.filter(Boolean).length / values.length;
}

/** Conservative 95% Wilson lower confidence bound for a Bernoulli success rate. */
export function wilsonLowerBound(successes: number, observations: number, z = 1.96): number {
	if (observations <= 0) return 0;
	const proportion = successes / observations;
	const z2 = z * z;
	const center = proportion + z2 / (2 * observations);
	const margin = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * observations)) / observations);
	return Math.max(0, Math.min(1, (center - margin) / (1 + z2 / observations)));
}

/**
 * Quality uses only explicitly labeled pass/fail outcomes. Reliability excludes
 * cancellation, policy denial, and permission denial through `neutral`.
 * Completed cost/timing exclude all fast failed work.
 */
export function estimateRoute(
	samples: ReadonlyArray<RouteObservation>,
	prior: RoutePrior = DEFAULT_ROUTE_PRIOR,
): RouteEstimate {
	const labeled = samples.filter((sample) => sample.qualityLabel !== "unmeasured");
	const qualityPasses = labeled.filter((sample) => sample.qualityLabel === "pass").length;
	const attributable = samples.filter((sample) => sample.reliability !== "neutral");
	const completed = samples.filter((sample) => sample.completedCostUsd !== null && sample.completedEndToEndMs !== null);
	const costs = completed.flatMap((sample) => (sample.completedCostUsd === null ? [] : [sample.completedCostUsd]));
	const latencies = completed.flatMap((sample) =>
		sample.completedEndToEndMs === null ? [] : [sample.completedEndToEndMs],
	);
	const queueWaits = completed.flatMap((sample) => (sample.queueWaitMs === null ? [] : [sample.queueWaitMs]));
	const completedCount = completed.length;
	const reliabilityCount = attributable.length;
	const qualityMean = labeled.length === 0 ? prior.qualityMean : qualityPasses / labeled.length;
	const completedCosts = mean(costs, prior.costUpperBoundUsd);
	const completedLatency = mean(latencies, prior.expectedEndToEndMs);
	return {
		qualityLabeledCount: labeled.length,
		unmeasuredCount: samples.length - labeled.length,
		qualityCoverage: samples.length === 0 ? 0 : labeled.length / samples.length,
		qualityMean,
		qualityLowerBound: wilsonLowerBound(qualityPasses, labeled.length),
		firstPassSuccessProbability: shrink(
			rate(
				attributable.map((sample) => sample.firstPass),
				prior.firstPassSuccessProbability,
			),
			prior.firstPassSuccessProbability,
			reliabilityCount,
		),
		expectedCostUsd: shrink(completedCosts, prior.costUpperBoundUsd, completedCount),
		costUpperBoundUsd: Math.max(prior.costUpperBoundUsd, quantile(costs, 0.95, prior.costUpperBoundUsd)),
		expectedEndToEndMs: shrink(completedLatency, prior.expectedEndToEndMs, completedCount),
		p95EndToEndMs: Math.max(completedLatency, quantile(latencies, 0.95, prior.expectedEndToEndMs)),
		reliability: shrink(
			rate(
				attributable.map((sample) => sample.reliability === "success"),
				prior.reliability,
			),
			prior.reliability,
			reliabilityCount,
		),
		cacheHitProbability: completedCount === 0 ? 0 : rate(completed.map((sample) => sample.cacheRead)),
		queueWaitMs: shrink(mean(queueWaits, prior.queueWaitMs), prior.queueWaitMs, completedCount),
		sampleCount: samples.length,
		confidence: labeled.length / (labeled.length + ROUTE_ESTIMATE_SHRINKAGE),
	};
}

/** Active eligibility requires a lower bound and six exact-route quality labels. */
export function clearsPostureFloors(estimate: RouteEstimate, posture: RoutingPosture): boolean {
	if (posture === "manual") return true;
	const policy = ROUTE_POSTURES[posture];
	return (
		estimate.qualityLabeledCount >= MINIMUM_QUALITY_LABELED_OUTCOMES &&
		estimate.qualityLowerBound >= policy.floors.qualityLowerBound &&
		estimate.reliability >= policy.floors.reliability
	);
}

function normalize(value: number, min: number, max: number): number {
	if (!(max > min)) return 0;
	return (value - min) / (max - min);
}

export interface RouteScoreScale {
	minCostUsd: number;
	maxCostUsd: number;
	minLatencyMs: number;
	maxLatencyMs: number;
	minQueueWaitMs: number;
	maxQueueWaitMs: number;
}

export function routeScoreScale(estimates: ReadonlyArray<RouteEstimate>): RouteScoreScale {
	const costs = estimates.map((estimate) => estimate.expectedCostUsd);
	const latencies = estimates.map((estimate) => estimate.p95EndToEndMs);
	const queueWaits = estimates.map((estimate) => estimate.queueWaitMs);
	return {
		minCostUsd: costs.length > 0 ? Math.min(...costs) : 0,
		maxCostUsd: costs.length > 0 ? Math.max(...costs) : 0,
		minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
		maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
		minQueueWaitMs: queueWaits.length > 0 ? Math.min(...queueWaits) : 0,
		maxQueueWaitMs: queueWaits.length > 0 ? Math.max(...queueWaits) : 0,
	};
}

const SCORE_PRECISION = 1e-9;

function round(value: number): number {
	return Math.round(value / SCORE_PRECISION) * SCORE_PRECISION;
}

export function scoreRoute(estimate: RouteEstimate, posture: RoutingPosture, scale: RouteScoreScale): number {
	const policy = ROUTE_POSTURES[posture];
	const costPenalty = normalize(estimate.expectedCostUsd, scale.minCostUsd, scale.maxCostUsd);
	const latencyPenalty = normalize(
		policy.deadlineFirst ? estimate.p95EndToEndMs : estimate.expectedEndToEndMs,
		scale.minLatencyMs,
		scale.maxLatencyMs,
	);
	const queuePenalty = normalize(estimate.queueWaitMs, scale.minQueueWaitMs, scale.maxQueueWaitMs);
	// A bounded task prior orders only wholly cold routes. The first labeled
	// role-specific outcome replaces it; active floors always use the Wilson
	// lower bound and minimum label count regardless.
	const qualitySignal = estimate.qualityLabeledCount === 0 ? estimate.qualityMean : estimate.qualityLowerBound;
	const health = qualitySignal * 0.7 + estimate.reliability * 0.3;
	const affinityBonus = estimate.cacheHitProbability * 0.01;
	return round(
		policy.weights.quality * health -
			policy.weights.cost * costPenalty -
			policy.weights.latency * (latencyPenalty * 0.9 + queuePenalty * 0.1) +
			affinityBonus,
	);
}

export function dominatesRoute(left: RouteEstimate, right: RouteEstimate): boolean {
	const noWorse =
		left.qualityLowerBound >= right.qualityLowerBound &&
		left.reliability >= right.reliability &&
		left.expectedCostUsd <= right.expectedCostUsd &&
		left.p95EndToEndMs <= right.p95EndToEndMs &&
		left.queueWaitMs <= right.queueWaitMs &&
		left.cacheHitProbability >= right.cacheHitProbability;
	return (
		noWorse &&
		(left.qualityLowerBound > right.qualityLowerBound ||
			left.reliability > right.reliability ||
			left.expectedCostUsd < right.expectedCostUsd ||
			left.p95EndToEndMs < right.p95EndToEndMs ||
			left.queueWaitMs < right.queueWaitMs ||
			left.cacheHitProbability > right.cacheHitProbability)
	);
}

export interface RankedRoute {
	key: string;
	order: number;
	estimate: RouteEstimate;
	score: number;
}

export function compareRankedRoutes(left: RankedRoute, right: RankedRoute): number {
	if (left.score !== right.score) return right.score - left.score;
	if (left.estimate.expectedCostUsd !== right.estimate.expectedCostUsd) {
		return left.estimate.expectedCostUsd - right.estimate.expectedCostUsd;
	}
	if (left.estimate.reliability !== right.estimate.reliability) {
		return right.estimate.reliability - left.estimate.reliability;
	}
	if (left.estimate.p95EndToEndMs !== right.estimate.p95EndToEndMs) {
		return left.estimate.p95EndToEndMs - right.estimate.p95EndToEndMs;
	}
	if (left.estimate.queueWaitMs !== right.estimate.queueWaitMs) {
		return left.estimate.queueWaitMs - right.estimate.queueWaitMs;
	}
	if (left.estimate.cacheHitProbability !== right.estimate.cacheHitProbability) {
		return right.estimate.cacheHitProbability - left.estimate.cacheHitProbability;
	}
	if (left.order !== right.order) return left.order - right.order;
	return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}
