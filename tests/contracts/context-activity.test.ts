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

	it("renders a running compaction as live work instead of a completed context-init pipeline", () => {
		const rendered = stripAnsi(
			formatContextActivityIslandLines(
				makeActivity({
					kind: "compaction",
					phase: "compact",
					status: "started",
					message: "compacting context (summary)",
					current: null,
					total: null,
				}),
				CONTEXT_ISLAND_WIDTH,
				2000,
				1,
			).join("\n"),
		);
		ok(rendered.includes("Context Compact"), rendered);
		ok(rendered.includes("compact"), rendered);
		ok(rendered.includes("  0%"), rendered);
		strictEqual(rendered.includes("done"), false, rendered);
		strictEqual(rendered.includes("100%"), false, rendered);
		strictEqual(rendered.includes("scan › index › draft"), false, rendered);
	});

	// context-wiki is declared in ContextActivityKind and emitted by the context
	// domain, but the island's KINDS set omitted it, so isContextActivityPayload
	// rejected every wiki event and the island stayed blank for a whole wiki run.
	it("renders wiki activity instead of discarding it", () => {
		const bus = createSafeEventBus();
		const store = createContextActivityStore(bus);
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-wiki",
			phase: "generate",
			status: "running",
			message: "writing page 4 of 32",
			at: 1000,
			current: 4,
			total: 32,
		});
		const current = store.current(1001);
		ok(current, "a wiki activity payload must reach the island store");
		strictEqual(current.kind, "context-wiki");
		store.unsubscribe();

		const rendered = stripAnsi(formatContextActivityIslandLines(current, CONTEXT_ISLAND_WIDTH, 2000, 1).join("\n"));
		ok(rendered.includes("Context Wiki"), rendered);
		// A wiki run never reaches the CLIO-CODER.md phase, so the trail must not offer it.
		strictEqual(rendered.includes("CLIO-CODER.md"), false, rendered);
		ok(rendered.includes("pages"), rendered);
	});

	it("labels the codewiki index phase distinctly from the Markdown wiki", () => {
		const rendered = stripAnsi(
			formatContextActivityIslandLines(makeActivity({ phase: "codewiki" }), CONTEXT_ISLAND_WIDTH, 2000, 1).join("\n"),
		);
		ok(rendered.includes("index"), rendered);
	});

	it("labels the generation phase neutrally for Scout and heuristic drafts", () => {
		const rendered = stripAnsi(
			formatContextActivityIslandLines(
				makeActivity({ phase: "generate", message: "drafting CLIO-CODER.md with heuristic" }),
				CONTEXT_ISLAND_WIDTH,
				2000,
				1,
			).join("\n"),
		);
		ok(rendered.includes("draft"), rendered);
		strictEqual(rendered.includes("scout"), false);
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
