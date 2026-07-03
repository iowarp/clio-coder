import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	createDispatchBoardStore,
	type DispatchBoardRow,
	dispatchStatusPresentation,
	formatTaskIslandLines,
	renderDispatchCard,
	TASK_ISLAND_WIDTH,
} from "../../src/interactive/dispatch-board.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);

function makeRow(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "alpha",
		runtimeKind: "http",
		runtimeId: "rt-1",
		targetId: "local",
		wireModelId: "qwen3-coder",
		status: "running",
		elapsedMs: 1200,
		tokenCount: 512,
		costUsd: 0.0123,
		inputTokens: 300,
		outputTokens: 212,
		ttftMs: 180,
		...overrides,
	};
}

// Strip every well-formed SGR sequence (ESC [ ... m). If a bare ESC byte
// survives, a string was sliced through the middle of an escape sequence and
// the rendered output is corrupt.
function hasTruncatedAnsi(text: string): boolean {
	const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
	return text.replace(sgr, "").includes(ESC);
}

const stripSgr = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("dispatch board island frames", () => {
	it("opens the task island with the canonical ┌─ Tasks ─ fill ┐ recipe", () => {
		const top = stripSgr(formatTaskIslandLines([makeRow()])[0] ?? "");
		strictEqual(/^┌─ Tasks ─+┐$/.test(top), true, `task island top border "${top}"`);
	});

	it("separates island rows with a full-width inner divider", () => {
		const lines = formatTaskIslandLines([makeRow({ runId: "a" }), makeRow({ runId: "b", agentId: "beta" })]).map(
			stripSgr,
		);
		const divider = lines.find((line) => line.includes(GLYPH.innerDivider));
		ok(divider, "expected a ╌ inner divider between rows");
		ok(divider.includes(GLYPH.innerDivider.repeat(TASK_ISLAND_WIDTH)), `divider should span the island: "${divider}"`);
	});

	it("frames a dispatch card as ┌─ label ─ … ─ elapsed ─┐ with the elapsed meta before the corner", () => {
		const top = stripSgr(renderDispatchCard(makeRow({ agentId: "researcher", elapsedMs: 42_000 }), 80)[0] ?? "");
		match(top, /^┌─ researcher ─+ 42s ─┐$/, `dispatch card top border "${top}"`);
	});
});

describe("dispatch board task island", () => {
	it("renders every framed line at exactly TASK_ISLAND_WIDTH + 4 columns (empty state)", () => {
		const expected = TASK_ISLAND_WIDTH + 4;
		for (const line of formatTaskIslandLines([])) {
			strictEqual(visibleWidth(line), expected, `empty-state line "${line}" should span ${expected} columns`);
		}
	});

	it("keeps the frame aligned with one, several, and overflowing rows", () => {
		const expected = TASK_ISLAND_WIDTH + 4;
		const rowSets: DispatchBoardRow[][] = [
			[makeRow()],
			[makeRow({ runId: "a" }), makeRow({ runId: "b", status: "completed", agentId: "beta" })],
			Array.from({ length: 7 }, (_, i) => makeRow({ runId: `r${i}`, agentId: `agent-${i}` })),
		];
		for (const rows of rowSets) {
			for (const line of formatTaskIslandLines(rows)) {
				strictEqual(visibleWidth(line), expected, `line "${line}" should span ${expected} columns`);
			}
		}
	});

	it("never truncates a styled line through the middle of an ANSI escape", () => {
		// A long agent label is what used to trip the ANSI-unaware cell slicer.
		const rows = [makeRow({ agentId: "very-long-agent-identifier-that-overflows-the-island" })];
		for (const line of formatTaskIslandLines(rows)) {
			ok(!hasTruncatedAnsi(line), `line carries a truncated escape sequence: ${JSON.stringify(line)}`);
		}
	});
});

describe("dispatch board card", () => {
	it("renders every card line at the requested width", () => {
		for (const width of [60, 76, 100]) {
			for (const line of renderDispatchCard(makeRow(), width)) {
				strictEqual(visibleWidth(line), width, `width ${width}: line "${line}" should span ${width} columns`);
			}
		}
	});

	it("renders telemetry token counts through the compact footer formatter", () => {
		const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
		const stripped = renderDispatchCard(makeRow({ inputTokens: 12_000, outputTokens: 3_000, tokenCount: 15_000 }), 76)
			.join("\n")
			.replace(sgr, "");
		ok(stripped.includes(`${GLYPH.up} 12k`), `input should read compact, got: ${stripped}`);
		ok(stripped.includes(`${GLYPH.down} 3k`), `output should read compact, got: ${stripped}`);
		ok(stripped.includes("Total: 15k"), `total should read compact, got: ${stripped}`);
	});

	it("renders a compact terminal detail line for failed, dead, and aborted cards", () => {
		for (const status of ["failed", "dead", "aborted"] as const) {
			const lines = renderDispatchCard(makeRow({ status, outcomeDetail: "fatal\nworker crash" }), 76);
			ok(lines.join("\n").includes("Detail:"));
			ok(lines.join("\n").includes("fatal worker crash"));
			for (const line of lines) {
				strictEqual(visibleWidth(line), 76, `line "${line}" should span 76 columns`);
			}
		}
	});
});

describe("dispatch status presentation", () => {
	it("joins running and queued fleet work under the action token", () => {
		// Running fleet work is Clio acting, so it shares the action orange with
		// queued work rather than the old teal-running/orange-queued split.
		strictEqual(dispatchStatusPresentation("running").token, "action");
		strictEqual(dispatchStatusPresentation("enqueued").token, "action");
	});

	it("keeps every terminal and attention outcome in its own status token", () => {
		strictEqual(dispatchStatusPresentation("completed").token, "success");
		strictEqual(dispatchStatusPresentation("failed").token, "error");
		strictEqual(dispatchStatusPresentation("dead").token, "error");
		strictEqual(dispatchStatusPresentation("aborted").token, "dim");
		strictEqual(dispatchStatusPresentation("stale").token, "warning");
	});

	it("carries the section 5 glyph vocabulary for each status", () => {
		strictEqual(dispatchStatusPresentation("running").glyph, GLYPH.running);
		strictEqual(dispatchStatusPresentation("enqueued").glyph, GLYPH.queued);
		strictEqual(dispatchStatusPresentation("completed").glyph, GLYPH.ok);
		strictEqual(dispatchStatusPresentation("failed").glyph, GLYPH.error);
		strictEqual(dispatchStatusPresentation("aborted").glyph, GLYPH.cancelled);
		strictEqual(dispatchStatusPresentation("stale").glyph, GLYPH.warnInline);
	});
});

describe("dispatch board terminal taxonomy", () => {
	it("maps terminal run outcomes to board statuses with timeout detail", () => {
		const cases: Array<{ reason: string; status: DispatchBoardRow["status"]; detail?: string }> = [
			{ reason: "canceled", status: "aborted" },
			{ reason: "interrupted", status: "aborted" },
			{ reason: "stalled", status: "dead" },
			{ reason: "dead", status: "dead" },
			{ reason: "timed_out", status: "failed", detail: "turn timeout exceeded" },
			{ reason: "failed", status: "failed" },
		];

		for (const { reason, status, detail } of cases) {
			const bus = createSafeEventBus();
			const store = createDispatchBoardStore(bus);
			try {
				// Partial payloads on purpose: the board must tolerate runtime
				// events thinner than the compile-time contract, so the typed
				// emit check is bypassed with `as never`.
				bus.emit(BusChannels.DispatchStarted, {
					runId: `run-${reason}`,
					agentId: "coder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
				} as never);
				bus.emit(BusChannels.DispatchFailed, {
					runId: `run-${reason}`,
					agentId: "coder",
					targetId: "default",
					wireModelId: "model",
					runtimeId: "runtime",
					runtimeKind: "http",
					reason,
				} as never);

				const row = store.rows()[0];
				strictEqual(row?.status, status, `${reason} should render as ${status}`);
				if (detail !== undefined) strictEqual(row?.outcomeDetail, detail);
			} finally {
				store.unsubscribe();
			}
		}
	});

	it("does not downgrade a heartbeat-dead row when the terminal event is generic failed", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			bus.emit(BusChannels.DispatchStarted, {
				runId: "run-dead",
				agentId: "coder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
			} as never);
			bus.emit(BusChannels.DispatchProgress, {
				runId: "run-dead",
				agentId: "coder",
				event: { type: "heartbeat_status", status: "dead" },
			});
			strictEqual(store.rows()[0]?.status, "dead");

			bus.emit(BusChannels.DispatchFailed, {
				runId: "run-dead",
				agentId: "coder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				reason: "failed",
				outcomeDetail: "exit code 1",
			} as never);
			const row = store.rows()[0];
			strictEqual(row?.status, "dead");
			strictEqual(row?.outcomeDetail, "exit code 1");
		} finally {
			store.unsubscribe();
		}
	});
});
