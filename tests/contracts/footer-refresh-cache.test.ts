import { notStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";

test("unchanged footer refresh preserves rendered rows while changed state and width invalidate them", () => {
	let now = 10_000;
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		now: () => now,
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
		strictEqual(panel.view.render(60), narrow);
		notStrictEqual(panel.view.render(120), narrow);
	} finally {
		panel.dispose();
	}
});
