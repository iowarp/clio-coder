import { match, ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderCompactDashboard, renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { dispatchSegment } from "../../src/interactive/footer-panel.js";
import { footerState } from "../harness/footer-fixture.js";

test("retrying and cancelling workers count as active on every footer surface", () => {
	const state = footerState();
	const base = state.dispatchRows[0];
	ok(base);
	state.dispatchRows = [
		{ ...base, runId: "retry", status: "retrying" },
		{ ...base, runId: "cancel", status: "cancelling" },
	];
	state.agent.dispatchRows = state.dispatchRows;
	match(dispatchSegment(state.dispatchRows) ?? "", /2 active/u);
	for (const width of [60, 80, 120, 200]) {
		const compact = renderCompactDashboard(state, width);
		const expanded = renderDashboardPage(state, "Status", width, 240, "Alt+U");
		match(compact.map(stripTerminalSequences).join("\n"), /2 active/u);
		match(expanded.map(stripTerminalSequences).join("\n"), /2 active/u);
		for (const line of [...compact, ...expanded]) {
			ok(visibleWidth(line) <= width);
			for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
		}
	}
});
