/**
 * The telemetry projection's run summary used to accept a NaN or
 * Infinity costUsd/tokenCount off a DispatchCompleted/DispatchFailed payload
 * with a bare `typeof === "number"` check, unlike the interactive dispatch
 * board's identical field, which already rejected non-finite values through
 * parseFiniteNumber. This exercises the fix end to end (through the bus, not
 * just the extracted helper) and confirms the shared status/provenance
 * resolvers are wired in.
 */
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchFailedPayload } from "../../src/core/telemetry/live-events.js";
import { dispatchHasRunLedger } from "../../src/domains/telemetry/extension.js";
import { createTelemetryProjection, type ProjectionReadModel } from "../../src/domains/telemetry/projection.js";

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

	it("keeps the prior costUsd rather than storing NaN off a malformed payload", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ costUsd: Number.NaN }));
		strictEqual(projection.snapshot().runs[0]?.costUsd, 0);
	});

	it("keeps the prior tokenCount rather than storing Infinity off a malformed payload", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ tokenCount: Number.POSITIVE_INFINITY }));
		strictEqual(projection.snapshot().runs[0]?.tokens.total, 0);
	});

	it("accepts a genuine finite costUsd normally", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ costUsd: 0.42 }));
		strictEqual(projection.snapshot().runs[0]?.costUsd, 0.42);
	});

	it("falls back to unknown rather than storing a provenance value outside the closed set", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ costProvenance: "bogus" as never }));
		strictEqual(projection.snapshot().runs[0]?.costProvenance, "unknown");
	});

	it("accepts a genuine provenance value", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());
		bus.emit("run.failed", baseFailedPayload({ costProvenance: "estimated" }));
		strictEqual(projection.snapshot().runs[0]?.costProvenance, "estimated");
	});
});
