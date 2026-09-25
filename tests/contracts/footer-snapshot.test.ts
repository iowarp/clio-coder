import { match, ok, strictEqual } from "node:assert/strict";
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
			strictEqual(rows.length, 60);
			match(stripTerminalSequences(rows[0] ?? ""), new RegExp(page.toUpperCase()));
			if (page === "Status") match(rows.map(stripTerminalSequences).join("\n"), /3s ago/);
			for (const row of [...rows, ...compact]) {
				ok(visibleWidth(row) <= width);
				const plain = row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
				ok([...plain].every((char) => char.charCodeAt(0) >= 32 && (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159)));
			}
		}
	}
});
