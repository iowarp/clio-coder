import { match, ok } from "node:assert/strict";
import { it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { footerState } from "../harness/footer-fixture.js";

it("live dashboard heading retains the distinguishing model suffix", () => {
	const state = footerState();
	state.session.target = `blade · dynamo/${"long-model-".repeat(10)}FINAL_MODEL`;
	for (const width of [80, 120, 200]) {
		const rows = renderDashboardPage(state, "Status", width, 40, "Alt+U");
		match(stripTerminalSequences(rows[0] ?? ""), /FINAL_MODEL/);
		ok(rows.every((row) => visibleWidth(row) <= width));
	}
});
