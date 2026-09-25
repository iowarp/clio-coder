import { notStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import type { Notification } from "../../src/interactive/footer/notifications.js";

test("unchanged footer refresh preserves rendered rows while changed state and width invalidate them", () => {
	let now = 10_000;
	const notices: Notification[] = [];
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		now: () => now,
		getNotifications: () => notices,
		getAgentStatus: () => ({
			phase: "writing",
			since: 8000,
			lastMeaningfulAt: now,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		}),
	});
	try {
		const first = panel.view.render(120);
		panel.refresh();
		strictEqual(panel.view.render(120), first);
		now += 1000;
		panel.refresh();
		notStrictEqual(panel.view.render(120), first);
		const narrow = panel.view.render(60);
		strictEqual(narrow.length, 1);
		strictEqual(panel.view.render(60), narrow);
		notStrictEqual(panel.view.render(120), narrow);
		strictEqual(panel.view.render(120).length, 2);
		notices.push({ id: "warning", level: "warning", text: "Needs attention", key: null, addedAt: now, expiresAt: null });
		panel.refresh();
		strictEqual(panel.view.render(60).length, 2);
		notices.pop();
		panel.refresh();
		strictEqual(panel.view.render(60).length, 1);
	} finally {
		panel.dispose();
	}
});
