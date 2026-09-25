import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { renderContextMeterBar } from "../../src/interactive/context-meter.js";
import { renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { footerState } from "../harness/footer-fixture.js";

test("context meters share a one-cell fallback if terminal glyphs are wide", () => {
	const glyphs = GLYPH as unknown as { contextFull: string; contextFree: string };
	const full = glyphs.contextFull;
	const free = glyphs.contextFree;
	glyphs.contextFull = "中";
	glyphs.contextFree = "界";
	try {
		const state = footerState();
		const ledger = state.context.ledger;
		ok(ledger);
		strictEqual(visibleWidth(renderContextMeterBar(ledger, 12)), 12);
		for (const width of [60, 80, 120, 200]) {
			const lines = renderDashboardPage(state, "Context", width, 240, "Alt+U");
			for (const line of lines) {
				ok(visibleWidth(line) <= width);
				for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
			}
		}
	} finally {
		glyphs.contextFull = full;
		glyphs.contextFree = free;
	}
});
