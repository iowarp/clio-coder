/**
 * The observability projection's run summary used to accept a NaN or
 * Infinity costUsd/tokenCount off a DispatchCompleted/DispatchFailed payload
 * with a bare `typeof === "number"` check, unlike the interactive dispatch
 * board's identical field, which already rejected non-finite values through
 * parseFiniteNumber. This exercises the fix end to end (through the bus, not
 * just the extracted helper) and confirms the shared status/provenance
 * resolvers are wired in.
 */
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type DispatchFailedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import { dispatchHasEvidenceLedger } from "../../src/domains/observability/extension.js";
import type { MetricsView } from "../../src/domains/observability/metrics.js";
import { createObservabilityProjection, type ProjectionReadModel } from "../../src/domains/observability/projection.js";

function stubReadModel(): ProjectionReadModel {
	const metrics: MetricsView = {
		dispatchesCompleted: 0,
		dispatchesFailed: 0,
		safetyClassifications: 0,
		totalTokens: 0,
		histograms: {},
	};
	return {
		metrics: () => metrics,
		sessionCost: () => 0,
		sessionCostSummary: () => emptyCostAggregate(),
		sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
		latestThroughput: () => null,
		readAccountability: () => ({ totalRuns: 0, firstPassRuns: 0, firstPassRate: 0, failureCauses: [] }),
	};
}

function baseFailedPayload(overrides: Partial<DispatchFailedPayload> = {}): DispatchFailedPayload {
	return {
		runId: "run-1",
		agentId: "coder",
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: "rt-1",
		runtimeKind: "subprocess",
		outcome: "failed",
		outcomeDetail: null,
		reason: "failed",
		...overrides,
	};
}

describe("observability run summary: dispatch-failed terminal fields", () => {
	it("does not auto-build evidence for a pre-admission failure that created no ledger", () => {
		strictEqual(dispatchHasEvidenceLedger(baseFailedPayload()), false);
		strictEqual(
			dispatchHasEvidenceLedger(
				baseFailedPayload({ lineage: { parentRunId: null, rootRunId: "run-1", attempt: 0, depth: 0 } }),
			),
			true,
		);
	});

	it("resolves reason to status through the shared resolver (stalled -> dead)", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ reason: "stalled" }));
		strictEqual(projection.snapshot().runs[0]?.status, "dead");
	});

	it("resolves reason to status through the shared resolver (canceled -> aborted)", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ reason: "canceled" }));
		strictEqual(projection.snapshot().runs[0]?.status, "aborted");
	});

	it("keeps the prior costUsd rather than storing NaN off a malformed payload", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ costUsd: Number.NaN }));
		strictEqual(projection.snapshot().runs[0]?.costUsd, 0);
	});

	it("keeps the prior tokenCount rather than storing Infinity off a malformed payload", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ tokenCount: Number.POSITIVE_INFINITY }));
		strictEqual(projection.snapshot().runs[0]?.tokens.total, 0);
	});

	it("accepts a genuine finite costUsd normally", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ costUsd: 0.42 }));
		strictEqual(projection.snapshot().runs[0]?.costUsd, 0.42);
	});

	it("falls back to unknown rather than storing a provenance value outside the closed set", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ costProvenance: "bogus" as never }));
		strictEqual(projection.snapshot().runs[0]?.costProvenance, "unknown");
	});

	it("accepts a genuine provenance value", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());
		bus.emit(BusChannels.DispatchFailed, baseFailedPayload({ costProvenance: "estimated" }));
		strictEqual(projection.snapshot().runs[0]?.costProvenance, "estimated");
	});
});
