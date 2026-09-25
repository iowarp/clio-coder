import { match, ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { footerState } from "../harness/footer-fixture.js";

test("Context and Status stack below 84 cells and share the same split boundary", () => {
	for (const width of [60, 80, 83, 84, 120, 200]) {
		const state = footerState();
		const status = renderDashboardPage(state, "Status", width, 240, "Alt+U").map(stripTerminalSequences);
		const cost = status.findIndex((line) => line.includes("COST & CONNECTIONS"));
		const machine = status.findIndex((line) => line.includes("LOCAL MACHINE"));
		ok(cost >= 0 && machine >= 0);
		ok(width < 84 ? cost < machine : cost === machine);
		const context = renderDashboardPage(state, "Context", width, 240, "Alt+U").map(stripTerminalSequences);
		const heading = context.findIndex((line) => line.includes("CONTEXT COMPOSITION"));
		if (width < 84) match(context[heading + 1] ?? "", /^[▰▱▒ ]+$/u);
		else match(context[heading + 1] ?? "", /[A-Za-z]/);
		for (const line of [...status, ...context]) ok(visibleWidth(line) <= width);
	}
});
