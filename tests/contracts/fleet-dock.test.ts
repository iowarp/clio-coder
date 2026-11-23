import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { setPresentationTier } from "../../src/core/presentation-tier.js";
import type { Component, OverlayOptions, Terminal } from "../../src/engine/tui.js";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "../../src/engine/tui.js";
import { createFleetDock } from "../../src/interactive/fleet-dock.js";
import { createInteractiveTickers } from "../../src/interactive/interactive-tickers.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { fitRails } from "../../src/interactive/rails-budget.js";
import { footerState } from "../harness/footer-fixture.js";

class CapturedFullscreen extends TuiAltScreen {
	frame: string[] = [];
	protected override applyLineResets(lines: string[]): string[] {
		this.frame = [...lines];
		return super.applyLineResets(lines);
	}
}

function fullscreenFrame(root: Component, width: number, rows = 35): string[] {
	const terminal = {
		columns: width,
		rows,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		async drainInput() {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	} as unknown as Terminal;
	const tui = new CapturedFullscreen(terminal);
	tui.setLayoutRoot(root);
	tui.start();
	try {
		tui.renderNow(true);
		return tui.frame;
	} finally {
		tui.stop();
	}
}

test("live Fleet runs reserve normal-flow rows and leave transcript words intact (BT-007)", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	let live = true;
	const getRows = () => (live ? [{ ...fixture, agentAudience: "base" as const }] : []);
	const fleet = createFleetDock({ getRows });
	const text = (line: string): Component => ({ render: () => [line], invalidate() {} });
	setPresentationTier("detailed");
	try {
		for (const mode of ["regular", "fullscreen"] as const) {
			for (const width of [40, 60, 80, 120, 144, 200]) {
				const transcript = "A transcript sentence whose words must stay intact".slice(0, width - 1).trimEnd();
				const root = buildLayout(
					{
						banner: text("header"),
						chat: text(transcript),
						fleet,
						editor: text("composer"),
						footer: text("footer"),
					},
					{ mode },
				);
				const rows = (mode === "fullscreen" ? fullscreenFrame(root, width) : root.render(width)).map((line) =>
					stripTerminalSequences(line).trimEnd(),
				);
				ok(rows.includes(transcript), `${mode} preserves the transcript sentence: ${JSON.stringify(rows)}`);
				const start = rows.findIndex((row) => row.startsWith("Fleet "));
				ok(start > rows.indexOf(transcript));
				ok(start < rows.indexOf("composer"));
				for (const row of rows) ok(visibleWidth(row) <= width, row);
				live = false;
				deepStrictEqual(fleet.render(width), []);
				strictEqual(
					(mode === "fullscreen" ? fullscreenFrame(root, width) : root.render(width))
						.map((line) => stripTerminalSequences(line).trimEnd())
						.includes(transcript),
					true,
				);
				live = true;
			}
		}
		match(fleet.render(80).map(stripTerminalSequences).join("\n"), /^Fleet /);
	} finally {
		setPresentationTier("standard");
	}
});

test("the rails keep the transcript's budget and fold the context rail under 30 rows (TUI-13)", () => {
	const block = (name: string, count: number): Component => ({
		render: () => Array.from({ length: count }, (_, index) => `${name} ${index + 1}`),
		invalidate() {},
	});
	for (const mode of ["regular", "fullscreen"] as const) {
		for (const terminalRows of [24, 40]) {
			const root = buildLayout(
				{
					banner: block("header", 1),
					chat: block("transcript", 1),
					pending: block("queued", 15),
					fleet: block("worker", 2),
					contextProgress: block("context", 3),
					editor: block("composer", 4),
					footer: block("footer", 2),
				},
				{ mode, getTerminalRows: () => terminalRows },
			);
			const frame = (mode === "fullscreen" ? fullscreenFrame(root, 80, terminalRows) : root.render(80)).map((line) =>
				stripTerminalSequences(line).trim(),
			);
			const label = `${mode} at ${terminalRows} rows: ${JSON.stringify(frame)}`;
			const rails = frame.filter((row) => /^(queued|worker|context) \d+$|more rows?$/u.test(row));
			const floor = terminalRows < 30 ? 6 : Math.ceil(terminalRows / 3);
			ok(rails.length + 4 + 2 <= terminalRows - floor, label);
			ok(frame.includes("composer 4") && frame.includes("footer 2"), label);
			strictEqual(frame.includes("worker 1"), terminalRows >= 30, label);
			strictEqual(frame.includes("context 1"), terminalRows >= 30, label);
			if (terminalRows < 30) ok(frame.includes("… 4 more rows"), label);
			else ok(frame.includes("queued 15"), label);
		}
	}
	// A rail of whole variants is granted the first that fits, never a cut one (6.4).
	const variants = [["dock 1", "dock 2", "dock 3"], ["dock summary"], []];
	deepStrictEqual(fitRails([{ lines: variants[0] ?? [], variants, priority: 2 }], 2, true, 80), [["dock summary"]]);
	deepStrictEqual(fitRails([{ lines: variants[0] ?? [], variants, priority: 2 }], 0, true, 80), [[]]);
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
			ok(!overlay.render(144).some((line) => stripTerminalSequences(line).includes("Fleet Runs")));
	} finally {
		ticker.dispose();
	}
});
