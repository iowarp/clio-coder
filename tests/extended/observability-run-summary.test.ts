/**
 * The telemetry projection's run summary takes a terminal payload's spend only in the run-usage shape: a malformed
 * spend off a DispatchCompleted/DispatchFailed payload never replaces the run's facts (#434). This exercises it end to
 * end through the bus and confirms the shared status resolver is wired in.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchFailedPayload } from "../../src/core/telemetry/live-events.js";
import { dispatchHasRunLedger } from "../../src/domains/telemetry/extension.js";
import { createTelemetryProjection, type ProjectionReadModel } from "../../src/domains/telemetry/projection.js";
import { measuredSpend } from "../harness/receipt.js";

function stubReadModel(): ProjectionReadModel {
	return {};
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

describe("telemetry run summary: dispatch-failed terminal fields", () => {
	it("does not auto-build evidence for a pre-admission failure that created no ledger", () => {
		strictEqual(dispatchHasRunLedger(baseFailedPayload()), false);
		strictEqual(
			dispatchHasRunLedger(
				baseFailedPayload({ lineage: { parentRunId: null, rootRunId: "run-1", attempt: 0, depth: 0 } }),
			),
			true,
		);
	});

	it("resolves reason to status through the shared resolver (stalled -> dead)", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ reason: "stalled" }));
		strictEqual(projection.snapshot().runs[0]?.status, "dead");
	});

	it("resolves reason to status through the shared resolver (canceled -> aborted)", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ reason: "canceled" }));
		strictEqual(projection.snapshot().runs[0]?.status, "aborted");
	});

	it("keeps the run's spend unknown rather than storing a malformed terminal spend", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ spend: { totalTokens: Number.NaN } as never }));
		strictEqual(projection.snapshot().runs[0]?.spend.totalTokens.kind, "unknown");
	});

	it("accepts a terminal spend in the run-usage shape", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		const spend = measuredSpend({ input: 4, output: 2 }, 0.42, "catalog");
		bus.emit("run.failed", baseFailedPayload({ spend }));
		deepStrictEqual(projection.snapshot().runs[0]?.spend, spend);
	});
});
