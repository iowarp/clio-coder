import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import type { TelemetryReadModel } from "../../src/domains/telemetry/contract.js";
import { createTelemetryProjection } from "../../src/domains/telemetry/projection.js";
import { createDispatchBoardStore, dispatchUsageText } from "../../src/interactive/dispatch-board.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

// BT-007: at 55s the Fleet runs island said `↑ 5.9k · ↓ 450` while the inline
// worker card said `24.3k tokens`. The card folds cache reads into input, as
// every settled receipt does. The island reads the run's prompt tokens from the
// telemetry read model, which folds them the same way (#434 §11.3).
test("the island's input counts cache reads, so ↑ plus ↓ is the card's processed total", () => {
	const usage = { input: 5_900, output: 450, cacheRead: 17_950, cacheWrite: 0 };
	const bus = createTelemetryHub();
	const running: DispatchSnapshot["running"] = [
		{
			runId: "run-1",
			agentId: "coder",
			runtimeKind: "http",
			outcomePhase: "running",
			heartbeat: "alive",
			lineage: { rootRunId: "run-1", parentRunId: null, attempt: 0, depth: 0 },
			startedAt: new Date().toISOString(),
			elapsedMs: 55_000,
			// The shape the dispatch meter publishes: `input` excludes cache reads.
			tokens: {
				input: usage.input,
				output: usage.output,
				total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
				cacheRead: usage.cacheRead,
			},
			costUsd: 0,
			costProvenance: "unknown",
			node: null,
		} as DispatchSnapshot["running"][number],
	];
	const projection = createTelemetryProjection(bus, {
		dispatchSnapshot: () =>
			({
				running,
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}) as unknown as DispatchSnapshot,
	});
	const view = telemetryViewOf("session-1", [], new Map([["run-1", telemetryCall("session-1", { usage })]]));
	const store = createDispatchBoardStore({
		snapshot: () => projection.snapshot(),
		subscribe: (listener) => projection.subscribe(listener),
		reconcileRuns: () => projection.reconcileRuns(),
		setFleetPhase: (runId, phase) => projection.setFleetPhase(runId, phase),
		read: { live: () => view } as unknown as TelemetryReadModel,
	});
	try {
		bus.emit("run.started", {
			runId: "run-1",
			agentId: "coder",
			targetId: "mini",
			wireModelId: "ornith",
			runtimeId: "llamacpp",
			runtimeKind: "http",
			requestOrigin: "user",
			pid: null,
			assignmentId: "run-1",
			attempt: 1,
		});
		bus.emit("run.progressed", {
			runId: "run-1",
			agentId: "coder",
			event: { type: "message_end", message: { role: "assistant", usage } },
		});
		store.reconcile();
		const row = store.rows()[0];
		assert.ok(row, "the run is on the board");
		const processed = row.progress?.processedTokens;
		assert.equal(processed, 24_300, "the card's processed count");
		assert.equal(row.usage.kind, "ready");
		if (row.usage.kind !== "ready") return;
		const count = (fact: (typeof row.usage.prompt)["fact"]) => ("kind" in fact ? Number.NaN : fact.measured);
		assert.equal(count(row.usage.prompt.fact), usage.input + usage.cacheRead + usage.cacheWrite);
		assert.equal(count(row.usage.prompt.fact) + count(row.usage.output.fact), processed);
		assert.equal(count(row.usage.total.fact), processed);
		const text = dispatchUsageText(row.usage);
		assert.deepEqual(
			[text.prompt, text.output, text.total],
			[row.usage.prompt.display, row.usage.output.display, row.usage.total.display],
		);
	} finally {
		store.unsubscribe();
	}
});
