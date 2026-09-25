import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderCompactDashboard, renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { footerState } from "../harness/footer-fixture.js";

test("the narrow footer gives the model a readable row with context anchored at the right edge", () => {
	const state = footerState();
	state.agent.statusText = "Ready";
	state.dispatchRows = [];
	state.session.targetId = "blade";
	state.session.modelId = "dynamo/qwopus3.8-27b-flash@q4_k_m";
	state.context = { ...state.context, ledger: null, used: null };
	for (const width of [40, 59, 60, 61, 80, 120]) {
		const rows = renderCompactDashboard(state, width).map(stripTerminalSequences);
		strictEqual(rows.length, width <= 60 ? 1 : 2);
		for (const row of rows) ok(visibleWidth(row) <= width);
		if (width <= 60) {
			match(rows[0] ?? "", /^Ready · blade/);
			match(rows[0] ?? "", /ctx \?%$/);
			strictEqual(visibleWidth(rows[0] ?? ""), width);
			doesNotMatch(rows.join("\n"), /clio-coder|newline|Dashboard|▰|▱/);
		} else match(rows[1] ?? "", /clio-coder/);
	}
	match(
		stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""),
		/blade · (?:dynamo\/)?qwopus3\.8-27b-flash@q4_k_m/,
	);
});

test("narrow context reports unknown, estimated and saved occupancy without inventing measurements", () => {
	const state = footerState();
	state.context.budget = { revision: "1", historical: false, inputSource: "estimated" };
	state.context.used = 50_000;
	state.context.contextWindow = 100_000;
	for (const width of [40, 60]) {
		const row = stripTerminalSequences(renderCompactDashboard(state, width)[0] ?? "");
		match(row, /ctx ~50\.0%$/);
		ok(visibleWidth(row) <= width);
	}
	state.context.budget = { revision: "2", historical: true, inputSource: "historical" };
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /ctx saved 50\.0%$/);
	state.context.used = null;
	state.context.budget = { revision: "3", historical: false, inputSource: "unknown" };
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /ctx \?%$/);
	state.context.used = 0;
	state.context.budget = { revision: "4", historical: false, inputSource: "estimated" };
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /ctx ~0\.0%$/);
});

test("a narrow attention row preserves the activity, armed skill and context above it", () => {
	const state = footerState();
	state.agent.statusText = "Ready";
	state.session.activeSkills = ["tdd"];
	state.notices = [
		{ id: "error", level: "error", text: "Provider unavailable", key: null, addedAt: 1, expiresAt: null },
		{ id: "info", level: "info", text: "Saved", key: null, addedAt: 2, expiresAt: null },
	];
	for (const width of [40, 60]) {
		const rows = renderCompactDashboard(state, width).map(stripTerminalSequences);
		strictEqual(rows.length, 2);
		match(rows[0] ?? "", /Ready · 1 active · (?:skill|§) tdd/);
		match(rows[0] ?? "", /ctx \d+\.\d%$/);
		match(rows[1] ?? "", /✗ Provider unavailable/);
		doesNotMatch(rows.join("\n"), /Saved/);
		for (const row of rows) ok(visibleWidth(row) <= width);
		state.session.shutdownArmed = true;
		match(stripTerminalSequences(renderCompactDashboard(state, width)[1] ?? ""), /Ctrl\+C again to quit/);
		state.session.shutdownArmed = false;
	}
	state.notices = [];
	strictEqual(renderCompactDashboard(state, 60).length, 1);
	state.session.leaderArmed = true;
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[1] ?? ""), /Ctrl\+G.*choose key/);
});

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
