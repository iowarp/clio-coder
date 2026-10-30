import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { LegacyRouteHistoryRecord } from "../../src/domains/dispatch/route-history.js";
import type { RouteObservation } from "../../src/domains/dispatch/route-policy.js";
import {
	DEFAULT_ROUTE_PRIOR,
	estimateRoute,
	routeObservationFromHistory,
} from "../../src/domains/dispatch/route-policy.js";

const completed: RouteObservation = {
	qualityLabel: "pass",
	reliability: "success",
	firstPass: true,
	completedCostUsd: 0.2,
	completedEndToEndMs: 12_000,
	cacheRead: true,
	queueWaitMs: 600,
};

describe("contracts/route telemetry", () => {
	it("unpriced completions retain latency, queue wait, and cache affinity", () => {
		const priced = estimateRoute([completed]);
		const unpriced = estimateRoute([{ ...completed, completedCostUsd: null }]);
		strictEqual(unpriced.expectedEndToEndMs, priced.expectedEndToEndMs);
		strictEqual(unpriced.p95EndToEndMs, 12_000);
		strictEqual(unpriced.queueWaitMs, priced.queueWaitMs);
		strictEqual(unpriced.cacheHitProbability, 1);
		ok(unpriced.expectedEndToEndMs < DEFAULT_ROUTE_PRIOR.expectedEndToEndMs);
		ok(unpriced.queueWaitMs > 0);
		strictEqual(unpriced.expectedCostUsd, DEFAULT_ROUTE_PRIOR.costUpperBoundUsd);
	});

	it("unpriced samples do not strengthen the priced cost estimate", () => {
		const priced = estimateRoute([completed]);
		const mixed = estimateRoute([completed, { ...completed, completedCostUsd: null }]);
		strictEqual(mixed.expectedCostUsd, priced.expectedCostUsd);
		strictEqual(mixed.costUpperBoundUsd, priced.costUpperBoundUsd);
		ok(mixed.expectedEndToEndMs < priced.expectedEndToEndMs);
	});

	it("cache affinity excludes null but retains measured misses and excludes incomplete work", () => {
		const samples = [completed, { ...completed, cacheRead: false }];
		strictEqual(estimateRoute(samples).cacheHitProbability, 0.5);
		strictEqual(estimateRoute([...samples, { ...completed, cacheRead: null }]).cacheHitProbability, 0.5);
		deepStrictEqual(
			estimateRoute([{ ...completed, completedCostUsd: null, completedEndToEndMs: null }]),
			estimateRoute([{ ...completed, completedCostUsd: null, completedEndToEndMs: null, cacheRead: null }]),
		);
	});

	it("v3 cache false is ambiguous and contributes no miss to replayed affinity", () => {
		const record: LegacyRouteHistoryRecord = {
			version: 3,
			receiptDigest: "receipt",
			assignmentId: "assignment",
			route: {
				agentId: "coder",
				specFingerprint: "spec",
				executionRole: "builder",
				targetId: "unpriced",
				modelId: "model",
				runtimeId: "litellm",
				nodeId: "local",
				toolSignature: "tools",
				promptCompositionHash: "prompt",
				endpointIdentityHash: "endpoint",
				settingsFingerprint: "settings",
			},
			executionRole: "builder",
			qualityLabel: "pass",
			reliability: "success",
			firstPass: true,
			completedCostUsd: null,
			completedPhaseTiming: null,
			cacheRead: false,
			sourceDigests: [],
			settledAt: "2026-10-30T12:00:00.000Z",
		};
		strictEqual(routeObservationFromHistory(record).cacheRead, null);
		strictEqual(routeObservationFromHistory({ ...record, cacheRead: true }).cacheRead, true);
	});
});
