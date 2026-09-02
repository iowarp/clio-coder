/**
 * The observability projection's notice ring used to classify eight kinds of
 * bus event into an ObservabilityNotice. Seven of them (runtime, middleware,
 * safety, loop, tool-budget, context, budget) had no reader anywhere in the
 * repository and duplicated richer, independent classification the
 * interactive layer already runs for the same bus channels (bus-notices.ts
 * and interactive-event-projection.ts) to build the toast surface a session
 * actually shows. Only the eighth, evidence-build-failure, has a real reader
 * (the Dispatch Board's evidence-failure-reason lookup). This pins that the
 * seven dead kinds produce nothing, and that evidence still works.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
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

describe("observability projection notices", () => {
	it("produces nothing for the seven bus channels that used to classify a now-removed notice kind", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());

		bus.emit(BusChannels.RuntimeNotice, {
			kind: "swap",
			level: "warning",
			targetId: "t1",
			runtimeId: "r1",
			model: "m1",
			message: "swapped",
		});
		bus.emit(BusChannels.SafetyBlocked, {
			tool: "bash",
			actionClass: "execute",
			policySource: "safety.yaml",
			reasonCode: "denied",
		});
		bus.emit(BusChannels.MiddlewareHookFailed, {
			kind: "hook_failed",
			registrationId: "reg-1",
			hook: "before_tool",
			at: Date.now(),
		});
		bus.emit(BusChannels.LoopBlocked, {
			tool: "read",
			repeatCount: 3,
			blocksThisTurn: 1,
			budget: 5,
			interrupted: false,
			disposition: "block",
			at: Date.now(),
		});
		bus.emit(BusChannels.ToolBudgetExceeded, {
			tool: "read",
			callsThisTurn: 10,
			softBudget: 8,
			hardCeiling: 12,
			interrupted: false,
			at: Date.now(),
		});
		bus.emit(BusChannels.ContextPruned, {
			stage: "working_set",
			tokensBefore: 1000,
			tokensAfter: 500,
			trigger: "test",
			snapshotIdBefore: null,
			snapshotIdAfter: "snap-1",
			at: Date.now(),
		});
		bus.emit(BusChannels.BudgetAlert, { level: "over", currentUsd: 12, ceilingUsd: 10 });

		deepStrictEqual(projection.snapshot().notices, []);
	});

	it("still surfaces an evidence-build-failure notice, the one kind that survives", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());

		projection.evidenceBuildFailed("run-1", "disk full");
		const notices = projection.snapshot().notices;
		strictEqual(notices.length, 1);
		strictEqual(notices[0]?.kind, "evidence");
		strictEqual(notices[0]?.level, "warning");
		strictEqual(notices[0]?.message, "disk full");
		strictEqual(notices[0]?.ref?.runId, "run-1");
	});

	it("falls back to a generated message when the failure carries none", () => {
		const bus = createSafeEventBus();
		const projection = createObservabilityProjection(bus, stubReadModel());

		projection.evidenceBuildFailed("run-2", "");
		const notices = projection.snapshot().notices;
		strictEqual(notices[0]?.message, "evidence build failed for run-2");
	});
});
