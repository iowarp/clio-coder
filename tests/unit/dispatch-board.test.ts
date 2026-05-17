import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	createDispatchBoardStore,
	formatDispatchBoardLines,
	formatTaskIslandLines,
} from "../../src/interactive/dispatch-board.js";

const BASE_RUN = {
	runId: "run-1",
	agentId: "coder",
	endpointId: "local",
	wireModelId: "qwen",
	runtimeId: "openai",
	runtimeKind: "http" as const,
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

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

describe("dispatch task island", () => {
	it("renders compact dispatch rows without exceeding its own frame width", () => {
		const lines = formatTaskIslandLines([
			{
				...BASE_RUN,
				runId: "run-1",
				status: "running",
				elapsedMs: 1250,
				tokenCount: 1234,
				costUsd: 0,
			},
			{
				...BASE_RUN,
				runId: "run-2",
				agentId: "reviewer-with-a-long-name",
				wireModelId: "a-very-long-model-name",
				status: "failed",
				elapsedMs: 25,
				tokenCount: 0,
				costUsd: 0,
			},
		]);
		const width = visibleWidth(lines[0] ?? "");
		ok(width > 0);
		for (const line of lines) {
			strictEqual(visibleWidth(line), width, JSON.stringify(lines));
		}
		const text = lines.join("\n").replace(ANSI, "");
		ok(text.includes("> coder"), text);
		ok(text.includes("✗ review"), text);
	});

	it("summarizes hidden task island rows", () => {
		const rows = Array.from({ length: 6 }, (_, index) => ({
			...BASE_RUN,
			runId: `run-${index}`,
			status: "completed" as const,
			elapsedMs: index,
			tokenCount: index,
			costUsd: 0,
		}));
		const text = formatTaskIslandLines(rows, 4).join("\n");
		ok(text.includes("+ 2 more"), text);
	});
});
