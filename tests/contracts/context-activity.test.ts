import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	CONTEXT_ISLAND_WIDTH,
	createContextActivityStore,
	formatContextActivityIslandLines,
	type ContextActivitySnapshot,
} from "../../src/interactive/context-activity.js";

function makeActivity(overrides: Partial<ContextActivitySnapshot> = {}): ContextActivitySnapshot {
	return {
		kind: "context-init",
		phase: "codewiki",
		status: "running",
		message: "indexed 480 modules and refreshed project state",
		startedAtMs: 1000,
		updatedAtMs: 1500,
		completedAtMs: null,
		current: 240,
		total: 480,
		detail: "src/domains/context/bootstrap.ts",
		...overrides,
	};
}

describe("context activity island", () => {
	it("renders every line at the requested width", () => {
		for (const width of [CONTEXT_ISLAND_WIDTH, 64, 80]) {
			for (const line of formatContextActivityIslandLines(makeActivity(), width, 2000, 1)) {
				strictEqual(visibleWidth(line), width, `width ${width}: line "${line}" should span ${width}`);
			}
		}
	});

	it("tracks context progress events and retains terminal state briefly", () => {
		const bus = createSafeEventBus();
		const store = createContextActivityStore(bus);
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-init",
			phase: "scan",
			status: "started",
			message: "scanning",
			at: 1000,
		});
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-init",
			phase: "done",
			status: "completed",
			message: "done",
			at: 2000,
		});

		const current = store.current(3000);
		ok(current);
		strictEqual(current.phase, "done");
		strictEqual(current.status, "completed");
		strictEqual(store.current(7001), null);
		store.unsubscribe();
	});
});
