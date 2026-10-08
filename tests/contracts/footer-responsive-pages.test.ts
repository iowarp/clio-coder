import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { dashboardPageViewport, renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { footerState } from "../harness/footer-fixture.js";

test("the narrow footer gives workspace and branch a readable row with context at the right edge", () => {
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
		match(rows[0] ?? "", /v050/);
		match(rows[0] ?? "", /262\.1K ctx$/);
		strictEqual(visibleWidth(rows[0] ?? ""), width);
		doesNotMatch(rows[0] ?? "", /Ready|blade|▰|▱/);
	}
});

test("narrow context reports unknown, estimated and saved occupancy without inventing measurements", () => {
	const state = footerState();
	state.context.budget = { revision: "1", historical: false, inputSource: "estimated" };
	state.context.used = 50_000;
	state.context.contextWindow = 100_000;
	for (const width of [40, 60]) {
		const row = stripTerminalSequences(renderCompactDashboard(state, width)[0] ?? "");
		match(row, /50K\/100K \(50\.0%\)$/);
		ok(visibleWidth(row) <= width);
	}
	state.context.budget = { revision: "2", historical: true, inputSource: "historical" };
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /50K\/100K \(50\.0%\)$/);
	state.context.used = null;
	state.context.budget = { revision: "3", historical: false, inputSource: "unknown" };
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /100K ctx$/);
	state.context.used = 0;
	state.context.budget = { revision: "4", historical: false, inputSource: "estimated" };
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /0\/100K \(0\.0%\)$/);
});

test("compact throughput keeps the estimate marker and omits unavailable rates", () => {
	const state = footerState();
	state.context.used = null;
	state.throughput = { tokensPerSecond: 12.3, outputTokens: 123, durationMs: 10000, estimated: true };
	const plain = () => renderCompactDashboard(state, 120).map(stripTerminalSequences).join("\n");
	match(plain(), /≈12\s*tps/);
	state.throughput.estimated = false;
	match(plain(), /12\s*tps/);
	doesNotMatch(plain(), /≈12/);
	for (const rate of [0, NaN, Infinity]) {
		state.throughput.tokensPerSecond = rate;
		doesNotMatch(plain(), /tps/);
	}
});

test("a narrow attention row preserves workspace and context with armed skill facts beside it", () => {
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
		match(rows[0] ?? "", /v050/);
		match(rows[0] ?? "", /68\.5K\/262\.1K/);
		if (width === 60) match(rows[1] ?? "", /skill tdd/);
		match(rows[1] ?? "", /✗ Provider unavailab(?:le|…)/);
		doesNotMatch(rows.join("\n"), /Saved/);
		for (const row of rows) ok(visibleWidth(row) <= width);
		state.session.shutdownArmed = true;
		match(stripTerminalSequences(renderCompactDashboard(state, width)[1] ?? ""), /Ctrl\+C again to quit/);
		state.session.shutdownArmed = false;
	}
	state.notices = [];
	strictEqual(renderCompactDashboard(state, 60).length, 2);
	state.session.leaderArmed = true;
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[1] ?? ""), /choose key/i);
});

function allContent(page: "Context" | "Status", width: number): string[] {
	const state = footerState();
	const lines: string[] = [];
	let offset = 0;
	for (;;) {
		const viewport = dashboardPageViewport(state, page, width, 240, "Alt+U", offset);
		for (const row of viewport.rows) ok(visibleWidth(row) <= width);
		lines.push(...viewport.rows.slice(2, -2).map(stripTerminalSequences));
		if (viewport.offset === viewport.maxOffset) return lines;
		offset += 8;
	}
}

test("Context and Status retain stacked and split sections through compact scrolling viewports", () => {
	for (const width of [60, 80, 83, 84, 87, 88, 120, 200]) {
		const status = allContent("Status", width);
		match(status.join("\n"), /Tools \(visit\)/);
		const cost = status.findIndex((line) => line.includes("COST & CONNECTIONS"));
		const machine = status.findIndex((line) => line.includes("LOCAL MACHINE"));
		ok(cost >= 0 && machine >= 0);
		ok(width < 88 ? cost < machine : cost === machine);
		const context = allContent("Context", width);
		const heading = context.findIndex((line) => line.includes("CONTEXT COMPOSITION"));
		ok(heading >= 0);
		if (width < 88) match(context[heading + 1] ?? "", /^[▰▱▒ ]+$/u);
		else match(context[heading + 1] ?? "", /[A-Za-z]/);
	}
});

test("small Status viewports expose every health fact by scrolling without exceeding their row budget", () => {
	const state = footerState();
	state.agent.localCapacity = { limit: 2, bound: "memory" };
	for (const width of [24, 40, 60, 120]) {
		for (const height of [12, 18, 30]) {
			const first = dashboardPageViewport(state, "Status", width, height, "Alt+U");
			const rows = [...first.rows];
			for (let offset = 1; offset <= first.maxOffset; offset++) {
				const next = dashboardPageViewport(state, "Status", width, height, "Alt+U", offset);
				strictEqual(next.rows.length, first.rows.length);
				rows.push(...next.rows);
			}
			ok(first.rows.length <= Math.min(12, height - 6));
			for (const row of rows) ok(visibleWidth(row) <= width);
			const text = rows.map(stripTerminalSequences).join("\n");
			for (const label of ["CPU", "RAM", "Worker cap", "Sampling", "Scope"]) match(text, new RegExp(label));
			const last = dashboardPageViewport(state, "Status", width, height, "Alt+U", Number.MAX_SAFE_INTEGER);
			strictEqual(last.offset, last.maxOffset);
			strictEqual(dashboardPageViewport(state, "Status", width, height, "Alt+U", -100).offset, 0);
		}
	}
});
