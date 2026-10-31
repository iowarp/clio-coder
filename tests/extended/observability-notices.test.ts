/**
 * The telemetry projection's notice ring used to classify eight kinds of
 * bus event into a TelemetryNotice. Seven of them (runtime, middleware,
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
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DeclaredRuntimeNotice } from "../../src/core/telemetry/live-events.js";
import { createTelemetryProjection, type ProjectionReadModel } from "../../src/domains/telemetry/projection.js";

function stubReadModel(): ProjectionReadModel {
	return {};
}

describe("telemetry projection notices", () => {
	it("produces nothing for the seven bus channels that used to classify a now-removed notice kind", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());

		bus.emit("runtime.notice_raised", {
			kind: "swap",
			level: "warning",
			targetId: "t1",
			runtimeId: "r1",
			model: "m1",
			message: "swapped",
		} as DeclaredRuntimeNotice);
		bus.emit("safety.blocked", {
			tool: "bash",
			actionClass: "execute",
			policySource: "safety.yaml",
			reasonCode: "denied",
		});
		bus.emit("middleware.hook_failed", {
			kind: "hook_failed",
			registrationId: "reg-1",
			hook: "before_tool",
			at: Date.now(),
		});
		bus.emit("safety.loop_blocked", {
			tool: "read",
			repeatCount: 3,
			blocksThisTurn: 1,
			budget: 5,
			interrupted: false,
			disposition: "block",
			at: Date.now(),
		});
		bus.emit("safety.tool_budget_exceeded", {
			tool: "read",
			callsThisTurn: 10,
			softBudget: 8,
			hardCeiling: 12,
			interrupted: false,
			at: Date.now(),
		});
		bus.emit("context.pruned", {
			stage: "working_set",
			tokensBefore: 1000,
			tokensAfter: 500,
			trigger: "auto",
			snapshotIdBefore: null,
			snapshotIdAfter: "snap-1",
			at: Date.now(),
		});
		bus.emit("budget.alerted", { level: "over", currentUsd: 12, ceilingUsd: 10 });

		deepStrictEqual(projection.snapshot().notices, []);
	});

	it("still surfaces an evidence-build-failure notice, the one kind that survives", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());

		projection.evidenceBuildFailed("run-1", "disk full");
		const notices = projection.snapshot().notices;
		strictEqual(notices.length, 1);
		strictEqual(notices[0]?.kind, "evidence");
		strictEqual(notices[0]?.level, "error");
		strictEqual(notices[0]?.message, "disk full");
		strictEqual(notices[0]?.ref?.runId, "run-1");
	});

	it("falls back to a generated message when the failure carries none", () => {
		const bus = createTelemetryHub();
		const projection = createTelemetryProjection(bus, stubReadModel());

		projection.evidenceBuildFailed("run-2", "");
		const notices = projection.snapshot().notices;
		strictEqual(notices[0]?.message, "evidence build failed for run-2");
	});
});
