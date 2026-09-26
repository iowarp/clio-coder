import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Component, OverlayOptions } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createFleetDock } from "../../src/interactive/fleet-dock.js";
import { createInteractiveTickers } from "../../src/interactive/interactive-tickers.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { footerState } from "../harness/footer-fixture.js";

test("live Fleet runs reserve normal-flow rows and leave transcript words intact (BT-007)", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	let live = true;
	const getRows = () => (live ? [{ ...fixture, agentAudience: "base" as const }] : []);
	const fleet = createFleetDock({ getRows });
	const text = (line: string): Component => ({ render: () => [line], invalidate() {} });
	for (const width of [40, 60, 80, 120, 144, 200]) {
		const transcript = "A transcript sentence whose words must stay intact".slice(0, width);
		const root = buildLayout({
			banner: text("header"),
			chat: text(transcript),
			fleet,
			editor: text("composer"),
			footer: text("footer"),
		});
		const rows = root.render(width).map(stripTerminalSequences);
		strictEqual(rows[2], transcript);
		const start = rows.findIndex((row) => row.includes("Fleet runs"));
		ok(start > rows.indexOf(transcript));
		ok(start < rows.indexOf("composer"));
		for (const row of rows) ok(visibleWidth(row) <= width, row);
		live = false;
		deepStrictEqual(fleet.render(width), []);
		strictEqual(root.render(width).map(stripTerminalSequences).includes(transcript), true);
		live = true;
	}
	match(fleet.render(80).map(stripTerminalSequences).join("\n"), /Fleet runs/);
});

test("a live run is never drawn by a transcript-covering ticker overlay (BT-007)", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const overlays: Component[] = [];
	const ticker = createInteractiveTickers({
		tui: {
			terminal: { columns: 144, rows: 35 },
			requestRender() {},
			showOverlay(component: Component, _options?: OverlayOptions) {
				overlays.push(component);
				return { setHidden() {}, hide() {} } as never;
			},
		},
		dispatchBoardStore: { activeRows: () => [{ ...fixture, agentAudience: "base" }], reconcile() {} },
		contextActivityStore: { active: () => false, current: () => null },
		getOverlayState: () => "closed",
		isFooterExpanded: () => false,
		scheduleInterval: () => ({}),
		clearScheduledInterval() {},
	});
	try {
		ticker.renderTaskIsland();
		for (const overlay of overlays)
			ok(!overlay.render(144).some((line) => stripTerminalSequences(line).includes("Fleet runs")));
	} finally {
		ticker.dispose();
	}
});
