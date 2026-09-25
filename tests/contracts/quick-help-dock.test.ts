import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Component, TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { createQuickHelp } from "../../src/interactive/quick-help.js";

test("empty-composer key help paints only in the dock at every supported width", () => {
	let proxy: Component | undefined;
	const tui = {
		terminal: { rows: 24 },
		requestRender() {},
		showOverlay(component: Component) {
			proxy = component;
			return { hide() {} };
		},
	} as unknown as TUI;
	const help = createQuickHelp(tui, {
		getKeys: () => ["alt+m"],
		getDescription: () => "Select the current model",
	});
	help.open();
	ok(help.isOpen());
	for (const width of [40, 60, 80, 120, 200]) {
		strictEqual(proxy?.render(width).length, 0);
		const frame = dockTop(tui)?.frame;
		ok(frame);
		for (const line of frame.renderDockBody(width - 4, 16)) ok(visibleWidth(line) <= width - 4);
	}
	help.close();
	strictEqual(help.isOpen(), false);
	strictEqual(dockTop(tui), null);
});
