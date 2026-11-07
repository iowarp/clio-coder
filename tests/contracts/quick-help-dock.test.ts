import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
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

test("open key help follows a binding reload without resizing or reopening", () => {
	const previous = getKeybindings();
	const keys = createKeybindingManager(DEFAULT_SETTINGS, {});
	const tui = {
		terminal: { rows: 40 },
		requestRender() {},
		showOverlay() {
			return { hide() {} };
		},
	} as unknown as TUI;
	const help = createQuickHelp(tui, keys);
	try {
		help.open();
		const text = () => stripTerminalSequences(dockTop(tui)?.frame.renderDockBody(116, 35).join("\n") ?? "");
		match(text(), /Alt\+M/);
		keys.reload({ "clio-coder.model.select": "alt+p" });
		match(text(), /Alt\+P/);
		doesNotMatch(text(), /Alt\+M/);
	} finally {
		help.close();
		setKeybindings(previous);
	}
});
