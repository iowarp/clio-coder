import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ROUTE_POSTURES } from "../../src/domains/dispatch/route-policy.js";
import {
	DECISION_LATENCY_BUDGET_MS,
	describeReadinessGap,
	evaluateRouteReadiness,
	MINIMUM_ACTIVE_QUALITY_LABELS,
	type RouteReadinessInput,
} from "../../src/domains/dispatch/route-readiness.js";

function estimate(overrides: Partial<RouteReadinessInput["estimate"]> = {}) {
	return {
		qualityLabeledCount: MINIMUM_ACTIVE_QUALITY_LABELS,
		unmeasuredCount: 0,
		qualityCoverage: 1,
		qualityMean: 1,
		qualityLowerBound: 0.95,
		firstPassSuccessProbability: 1,
		expectedCostUsd: 0.01,
		costUpperBoundUsd: 0.02,
		expectedEndToEndMs: 1_000,
		p95EndToEndMs: 2_000,
		reliability: 1,
		cacheHitProbability: 0,
		queueWaitMs: 0,
		sampleCount: MINIMUM_ACTIVE_QUALITY_LABELS,
		confidence: 0.9,
		...overrides,
	};
}

function input(overrides: Partial<RouteReadinessInput> = {}): RouteReadinessInput {
	return {
		estimate: estimate(),
		posture: "balanced",
		hardConstraintValidity: 1,
		integrityFailures: 0,
		costUpperBoundUsd: 0.02,
		factsFresh: true,
		decisionP95Ms: 2,
		requestedMinimumQuality: null,
		...overrides,
	};
}

describe("contracts/route readiness", () => {
	it("a fully measured route is active-eligible", () => {
		const report = evaluateRouteReadiness(input());
		strictEqual(report.ready, true);
		deepStrictEqual(report.gaps, []);
		strictEqual(report.labelsNeeded, 0);
	});

	it("active readiness names every unmet prerequisite", () => {
		const report = evaluateRouteReadiness(
			input({
				estimate: estimate({ qualityLabeledCount: 2, qualityLowerBound: 0, reliability: 0 }),
				hardConstraintValidity: 0.9,
				integrityFailures: 1,
				costUpperBoundUsd: null,
				factsFresh: false,
				decisionP95Ms: DECISION_LATENCY_BUDGET_MS + 1,
				requestedMinimumQuality: 0.8,
			}),
		);
		strictEqual(report.ready, false);
		// Every gap is reported at once, not just the first one found, so an
		// operator sees the whole distance to activation rather than one item.
		deepStrictEqual(report.gaps, [
			"hard-constraint-validity-below-one",
			"integrity-failures-in-window",
			"insufficient-quality-labels",
			"quality-lower-bound-below-posture-floor",
			"quality-lower-bound-below-requested-minimum",
			"reliability-below-posture-floor",
			"cost-upper-bound-unknown",
			"route-facts-stale",
			"decision-latency-above-budget",
		]);
		strictEqual(report.labelsNeeded, MINIMUM_ACTIVE_QUALITY_LABELS - 2);
		for (const gap of report.gaps) {
			strictEqual(describeReadinessGap(gap).length > 0, true);
		}
	});

	it("unmeasured quality refuses active routing", () => {
		// Unmeasured runs do not enter the denominator, so a route with plenty of
		// activity and no labels is exactly as ineligible as a cold one.
		const report = evaluateRouteReadiness(
			input({ estimate: estimate({ qualityLabeledCount: 0, unmeasuredCount: 40, qualityLowerBound: 0 }) }),
		);
		strictEqual(report.ready, false);
		strictEqual(report.gaps.includes("insufficient-quality-labels"), true);
		strictEqual(report.labelsNeeded, MINIMUM_ACTIVE_QUALITY_LABELS);
	});

	it("quality lower bound and reliability floors both apply", () => {
		const floors = ROUTE_POSTURES.quality.floors;
		const lowQuality = evaluateRouteReadiness(
			input({ posture: "quality", estimate: estimate({ qualityLowerBound: floors.qualityLowerBound - 0.01 }) }),
		);
		deepStrictEqual(lowQuality.gaps, ["quality-lower-bound-below-posture-floor"]);

		const lowReliability = evaluateRouteReadiness(
			input({ posture: "quality", estimate: estimate({ reliability: floors.reliability - 0.01 }) }),
		);
		deepStrictEqual(lowReliability.gaps, ["reliability-below-posture-floor"]);
	});

	it("a request minimumQuality can only narrow eligibility", () => {
		// The posture floor is met, so only the request's own stricter bound bites.
		const strict = evaluateRouteReadiness(input({ requestedMinimumQuality: 0.99 }));
		deepStrictEqual(strict.gaps, ["quality-lower-bound-below-requested-minimum"]);
		// A request cannot loosen a posture floor by naming a lower bound.
		const loose = evaluateRouteReadiness(
			input({ posture: "quality", estimate: estimate({ qualityLowerBound: 0.1 }), requestedMinimumQuality: 0 }),
		);
		strictEqual(loose.gaps.includes("quality-lower-bound-below-posture-floor"), true);
	});

	it("an unknown cost upper bound blocks activation", () => {
		deepStrictEqual(evaluateRouteReadiness(input({ costUpperBoundUsd: null })).gaps, ["cost-upper-bound-unknown"]);
		deepStrictEqual(evaluateRouteReadiness(input({ costUpperBoundUsd: Number.POSITIVE_INFINITY })).gaps, [
			"cost-upper-bound-unknown",
		]);
	});

	it("readiness is deterministic for equal inputs", () => {
		deepStrictEqual(evaluateRouteReadiness(input()), evaluateRouteReadiness(input()));
	});
});
