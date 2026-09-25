import assert from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import { createObservabilityProjection } from "../../src/domains/observability/projection.js";
import { createDispatchBoardStore } from "../../src/interactive/dispatch-board.js";

// BT-007: at 55s the Fleet runs island said `↑ 5.9k · ↓ 450` while the inline
// worker card said `24.3k tokens`. The card folds cache reads into input, as
// every settled receipt does; the live dispatch snapshot left them out.
test("the island's live input counts cache reads, so ↑ plus ↓ is the card's processed total", () => {
	const usage = { input: 5_900, output: 450, cacheRead: 17_950, cacheWrite: 0 };
	const bus = createSafeEventBus();
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
	const projection = createObservabilityProjection(bus, {
		dispatchSnapshot: () =>
			({
				running,
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}) as unknown as DispatchSnapshot,
		sessionCostSummary: emptyCostAggregate,
		sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
		latestThroughput: () => null,
	});
	const store = createDispatchBoardStore(projection);
	try {
		bus.emit(BusChannels.DispatchStarted, {
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
		bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "coder",
			event: { type: "message_end", message: { role: "assistant", usage } },
		});
		store.reconcile();
		const row = store.rows()[0];
		assert.ok(row, "the run is on the board");
		const processed = row.progress?.processedTokens;
		assert.equal(processed, 24_300, "the card's processed count");
		assert.equal(row.inputTokens, usage.input + usage.cacheRead);
		assert.equal(row.inputTokens + row.outputTokens + usage.cacheWrite, processed);
		assert.equal(row.tokenCount, processed);
	} finally {
		store.unsubscribe();
	}
});
