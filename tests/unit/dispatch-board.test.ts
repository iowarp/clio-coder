import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createDispatchBoardStore, formatDispatchBoardLines } from "../../src/interactive/dispatch-board.js";

const BASE_RUN = {
	runId: "run-1",
	agentId: "coder",
	endpointId: "local",
	wireModelId: "qwen",
	runtimeId: "openai",
	runtimeKind: "http" as const,
};

describe("dispatch-board heartbeat status", () => {
	it("renders stale and dead heartbeat transitions", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchEnqueued, BASE_RUN);
			bus.emit(BusChannels.DispatchStarted, BASE_RUN);
			strictEqual(store.rows()[0]?.status, "running");

			bus.emit(BusChannels.DispatchProgress, {
				...BASE_RUN,
				event: { type: "heartbeat_status", status: "stale" },
			});
			strictEqual(store.rows()[0]?.status, "stale");

			bus.emit(BusChannels.DispatchProgress, {
				...BASE_RUN,
				event: { type: "heartbeat_status", status: "alive" },
			});
			strictEqual(store.rows()[0]?.status, "running");

			bus.emit(BusChannels.DispatchProgress, {
				...BASE_RUN,
				event: { type: "heartbeat_status", status: "dead" },
			});
			const row = store.rows()[0];
			strictEqual(row?.status, "dead");
			ok(
				formatDispatchBoardLines(row ? [row] : [])
					.join("\n")
					.includes("dead"),
			);
		} finally {
			store.unsubscribe();
		}
	});

	it("maps dead dispatch failures to the dead row status", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, BASE_RUN);
			bus.emit(BusChannels.DispatchFailed, {
				...BASE_RUN,
				reason: "dead",
				durationMs: 25,
				tokenCount: 0,
				costUsd: 0,
			});
			strictEqual(store.rows()[0]?.status, "dead");
		} finally {
			store.unsubscribe();
		}
	});
});
