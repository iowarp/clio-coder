import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import type { Component, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";

function countIntervals<T>(run: (counts: { scheduled: number; cleared: number }) => T): T {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const counts = { scheduled: 0, cleared: 0 };
	globalThis.setInterval = ((_callback: () => void, _delay: number) => {
		counts.scheduled += 1;
		return { unref() {} } as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((_timer: ReturnType<typeof setInterval>) => {
		counts.cleared += 1;
	}) as typeof clearInterval;
	try {
		return run(counts);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
}

test("the dashboard never samples the machine, open or closed", () => {
	countIntervals((counts) => {
		for (const width of [60, 80, 120, 200]) {
			const footer = buildFooterDashboard({
				providers: { list: () => [] } as never,
				getTerminalColumns: () => width,
				getTerminalRows: () => 40,
				resolveCurrentBranch: async () => null,
			});
			try {
				const compact = footer.view.render(width);
				footer.toggleExpanded();
				const glance = footer.view.render(width);
				footer.refresh();
				footer.toggleExpanded();
				strictEqual(counts.scheduled, 0);
				for (const line of [...compact, ...glance]) {
					ok(visibleWidth(line) <= width);
					for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
				}
			} finally {
				footer.dispose();
			}
		}
	});
});

test("/usage samples the machine only while its Health tab is shown", () => {
	countIntervals((counts) => {
		const tui = {
			terminal: { setTitle: () => {}, rows: 40 },
			requestRender: () => {},
			showOverlay: (_proxy: Component, _options: OverlayOptions) => ({ hide: () => {} }),
		} as unknown as TUI;
		const telemetry = { subscribe: () => () => {} } as unknown as TelemetryContract;
		const activity = openUsageOverlay(tui, telemetry);
		const frame = () => dockTop(tui)?.frame as unknown as Component;
		frame().render(100);
		strictEqual(counts.scheduled, 0, "the Activity tab does not sample");
		activity.hide();
		const handle = openUsageOverlay(tui, telemetry, { tab: "health" });
		const health = stripTerminalSequences(frame().render(100).join("\n"));
		strictEqual(counts.scheduled, 1, "the Health tab starts one sampler");
		match(health, /Machine/);
		frame().render(100);
		strictEqual(counts.scheduled, 1, "a repaint reuses the sampler");
		handle.hide();
		strictEqual(counts.cleared, 1, "closing /usage stops it");
	});
});
