import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { createInteractiveTickers } from "../../src/interactive/interactive-tickers.js";
import { footerState } from "../harness/footer-fixture.js";

function scheduler() {
	const live = new Map<object, () => void>();
	return {
		live,
		scheduleInterval: (callback: () => void) => {
			const handle = {};
			live.set(handle, callback);
			return handle;
		},
		clearScheduledInterval: (handle: object) => {
			live.delete(handle);
		},
		/** One second passes: every armed interval fires once. */
		tick() {
			for (const callback of [...live.values()]) callback();
		},
	};
}

test("the fleet ticker sleeps while nothing is live and a run event wakes it", () => {
	const clock = scheduler();
	const row = footerState().dispatchRows[0];
	ok(row);
	let rows: DispatchBoardRow[] = [];
	// A retry restored or scheduled by dispatch reaches the board only through reconcile.
	let retryPending = false;
	let reconciles = 0;
	let renders = 0;
	const tickers = createInteractiveTickers({
		tui: { terminal: { columns: 100, rows: 30 }, requestRender: () => (renders += 1), showOverlay: () => ({}) as never },
		dispatchBoardStore: {
			activeRows: () => rows,
			reconcile() {
				reconciles += 1;
				if (retryPending) rows = [{ ...row, status: "retrying" }];
			},
		},
		contextActivityStore: { active: () => false, current: () => null },
		getOverlayState: () => "closed",
		isFooterExpanded: () => false,
		scheduleInterval: clock.scheduleInterval,
		clearScheduledInterval: clock.clearScheduledInterval,
	});
	try {
		// The first tick reconciles once, so a retry restored at boot still shows; idle, the ticker then stops.
		clock.tick();
		strictEqual(reconciles, 1);
		strictEqual(clock.live.size, 0, "an idle session keeps no 1 s ticker");
		for (let second = 0; second < 5; second++) clock.tick();
		deepStrictEqual([reconciles, renders], [1, 0], "nothing reconciles or repaints while idle");

		// A run event repaints the task island, which wakes the ticker; it runs while the run is live.
		rows = [{ ...row, status: "running" }];
		tickers.renderTaskIsland();
		strictEqual(clock.live.size, 1);
		clock.tick();
		clock.tick();
		deepStrictEqual([reconciles, renders], [3, 2]);

		// The run fails and dispatch schedules its retry: the failure's repaint wakes the ticker, and the
		// reconcile that follows finds the retry, so the row keeps the ticker running.
		rows = [];
		retryPending = true;
		tickers.renderTaskIsland();
		clock.tick();
		strictEqual(reconciles, 4);
		strictEqual(rows[0]?.status, "retrying");
		strictEqual(clock.live.size, 1, "a retrying row is live");

		retryPending = false;
		rows = [];
		clock.tick();
		strictEqual(clock.live.size, 0, "the ticker stops once nothing is live");
		tickers.renderContextIsland();
		strictEqual(clock.live.size, 1, "context activity wakes it too");
	} finally {
		tickers.dispose();
	}
	strictEqual(clock.live.size, 0);
});

test("the Fleet Runs repaint ticker ends when the board closes", () => {
	const clock = scheduler();
	let overlay = "dispatch-board";
	let renders = 0;
	const tickers = createInteractiveTickers({
		tui: { terminal: { columns: 100, rows: 30 }, requestRender: () => (renders += 1), showOverlay: () => ({}) as never },
		dispatchBoardStore: { activeRows: () => [], reconcile() {} },
		contextActivityStore: { active: () => false, current: () => null },
		getOverlayState: () => overlay,
		isFooterExpanded: () => false,
		scheduleInterval: clock.scheduleInterval,
		clearScheduledInterval: clock.clearScheduledInterval,
	});
	try {
		clock.tick();
		tickers.startDispatchBoardTicker();
		strictEqual(clock.live.size, 1);
		clock.tick();
		strictEqual(renders, 1, "the open board repaints its elapsed times");
		overlay = "closed";
		clock.tick();
		strictEqual(clock.live.size, 0, "a closed board leaves no ticker behind");
		strictEqual(renders, 1);
	} finally {
		tickers.dispose();
	}
});
