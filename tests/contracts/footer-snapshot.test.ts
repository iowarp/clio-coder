import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { DASHBOARD_PAGES, renderCompactDashboard, renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { footerState } from "../harness/footer-fixture.js";

test("footer hydration reads time and notices once per snapshot", () => {
	let clocks = 0;
	let notices = 0;
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		now: () => {
			clocks++;
			return 12000;
		},
		getNotifications: () => {
			notices++;
			return [];
		},
	});
	try {
		clocks = 0;
		notices = 0;
		panel.refresh();
		strictEqual(clocks, 1);
		strictEqual(notices, 1);
	} finally {
		panel.dispose();
	}
});

test("footer pages use snapshot time and preserve their row contracts at release widths", () => {
	const state = footerState();
	state.resources = {
		sampledAt: 9000,
		scope: "local OS",
		hostTotalBytes: 1024 ** 3,
		hostFreeBytes: 512 * 1024 ** 2,
		processRssBytes: 1000,
		cpuPercent: 40,
		network: null,
		disk: null,
		gpu: null,
	};
	for (const width of [60, 80, 120, 200]) {
		const compact = renderCompactDashboard(state, width);
		strictEqual(compact.length, 2);
		for (const page of DASHBOARD_PAGES) {
			const rows = renderDashboardPage(state, page, width, 240, "Alt+U");
			strictEqual(rows.length, 12);
			match(stripTerminalSequences(rows[0] ?? ""), new RegExp(page));
			if (page === "Status") match(rows.map(stripTerminalSequences).join("\n"), /3s ago/);
			for (const row of [...rows, ...compact]) {
				ok(visibleWidth(row) <= width);
				const plain = row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
				ok([...plain].every((char) => char.charCodeAt(0) >= 32 && (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159)));
			}
		}
	}
});

test("compact footer names an unknown serving window without a percentage", () => {
	const state = footerState();
	state.context.ledger = null;
	state.context.used = 100;
	state.context.contextWindow = null;
	const rows = renderCompactDashboard(state, 100).map(stripTerminalSequences).join("\n");
	match(rows, /100\/unknown/u);
	strictEqual(/\?%/u.test(rows), false);
});

test("footer totals distinguish unknown usage from never-sent calls, including when no tokens were spent", () => {
	let total = 0;
	let missing = 0;
	let neverSent = 1;
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalRows: () => 120,
		getSessionTokens: () => ({
			input: total,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 0,
			totalTokens: total,
			missingTokenCalls: missing,
			neverSentCalls: neverSent,
		}),
	});
	try {
		panel.setExpanded(true);
		for (const mixed of [false, true]) {
			total = mixed ? 150 : 0;
			missing = mixed ? 2 : 0;
			neverSent = mixed ? 3 : 1;
			for (const width of [40, 80, 120]) {
				const rows = panel.view.render(width);
				const text = rows.map(stripTerminalSequences).join(" ").replace(/\s+/gu, " ");
				match(text, mixed ? /Σ150 \+\? \(2 calls with unknown usage\) · 3 calls never sent/u : /Σ0 · 1 call never sent/u);
				if (!mixed) doesNotMatch(text, /unknown usage|\+\?/u);
				for (const row of rows) ok(visibleWidth(row) <= width);
			}
		}
	} finally {
		panel.dispose();
	}
});
