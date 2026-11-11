import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { dashboardPageViewport, machineBlock, renderCompactDashboard } from "../../src/interactive/footer/pages.js";
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
	match(plain(), /≈12\s*tok\/s/);
	state.throughput.estimated = false;
	match(plain(), /12\s*tok\/s/);
	doesNotMatch(plain(), /≈12/);
	for (const rate of [0, NaN, Infinity]) {
		state.throughput.tokensPerSecond = rate;
		doesNotMatch(plain(), /tok\/s/);
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

test("the machine block splits its meters only when wide and names its sampling", () => {
	const resource = {
		cpuPercent: 12,
		hostTotalBytes: 16 * 1024 ** 3,
		hostFreeBytes: 8 * 1024 ** 3,
		processRssBytes: 200 * 1024 ** 2,
		sampledAt: 1000,
		scope: "local OS",
		network: null,
		disk: null,
		gpu: null,
	};
	for (const width of [60, 80, 83, 84, 120, 200]) {
		const lines = machineBlock(resource, 3000, width).map(stripTerminalSequences);
		for (const row of lines) ok(stripTerminalSequences(row).length <= width);
		const cpu = lines.find((line) => line.includes("CPU")) ?? "";
		ok(width < 84 ? !cpu.includes("RAM") : cpu.includes("RAM"), "machine meters split only when wide");
		for (const label of ["Machine ─", "Clio RSS", "Sampling", "Scope"]) match(lines.join("\n"), new RegExp(label));
	}
});

test("small dashboard viewports scroll the one page without exceeding their row budget", () => {
	const state = footerState();
	for (const width of [24, 40, 60, 120]) {
		for (const height of [12, 18, 24, 30, 40]) {
			const first = dashboardPageViewport(state, width, height, "Alt+U");
			const rows = [...first.rows];
			for (let offset = 1; offset <= first.maxOffset; offset++) {
				const next = dashboardPageViewport(state, width, height, "Alt+U", offset);
				strictEqual(next.rows.length, first.rows.length);
				rows.push(...next.rows);
			}
			ok(first.rows.length <= 8);
			for (const row of rows) ok(visibleWidth(row) <= width);
			const last = dashboardPageViewport(state, width, height, "Alt+U", Number.MAX_SAFE_INTEGER);
			strictEqual(last.offset, last.maxOffset);
			strictEqual(dashboardPageViewport(state, width, height, "Alt+U", -100).offset, 0);
		}
	}
});
