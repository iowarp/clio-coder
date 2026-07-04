import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	CONTEXT_ISLAND_WIDTH,
	type ContextActivitySnapshot,
	createContextActivityStore,
	formatContextActivityIslandLines,
} from "../../src/interactive/context-activity.js";

const ESC = "\u001B";
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

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

	it("titles context-refresh activity as Context Refresh", () => {
		const rendered = stripAnsi(
			formatContextActivityIslandLines(makeActivity({ kind: "context-refresh" }), CONTEXT_ISLAND_WIDTH, 2000, 1).join(
				"\n",
			),
		);
		ok(rendered.includes("Context Refresh"), rendered);
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

	it("accepts context-refresh payloads and rejects removed context-prime payloads", () => {
		const bus = createSafeEventBus();
		const store = createContextActivityStore(bus);
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-refresh",
			phase: "codewiki",
			status: "started",
			message: "rebuilding codewiki",
			at: 1000,
		});
		strictEqual(store.current(1001)?.kind, "context-refresh");
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-prime",
			phase: "codewiki",
			status: "started",
			message: "removed kind",
			at: 2000,
		} as never);
		strictEqual(store.current(2001)?.kind, "context-refresh");
		store.unsubscribe();
	});

	it("starts a new elapsed timer for non-scan activity starts after a retained terminal event", () => {
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
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-refresh",
			phase: "codewiki",
			status: "started",
			message: "rebuilding codewiki",
			at: 2500,
		});

		const current = store.current(2600);
		ok(current);
		strictEqual(current.kind, "context-refresh");
		strictEqual(current.startedAtMs, 2500);
		store.unsubscribe();
	});
});
