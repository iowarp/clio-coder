import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";

test("machine sampling is scheduled only while the Status page is visible", () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let scheduled = 0;
	let cleared = 0;
	globalThis.setInterval = ((_callback: () => void, _delay: number) => {
		scheduled += 1;
		return { unref() {} } as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((_timer: ReturnType<typeof setInterval>) => {
		cleared += 1;
	}) as typeof clearInterval;
	try {
		for (const width of [60, 80, 120, 200]) {
			const before = scheduled;
			const footer = buildFooterDashboard({
				providers: { list: () => [] } as never,
				getTerminalColumns: () => width,
				getTerminalRows: () => 40,
				resolveCurrentBranch: async () => null,
			});
			try {
				strictEqual(scheduled, before, "compact footer does not start machine sampling");
				const compact = footer.view.render(width);
				footer.setExpanded(true);
				strictEqual(scheduled, before, "Activity does not sample the machine");
				const activity = footer.view.render(width);
				footer.toggleExpanded();
				strictEqual(scheduled, before, "Context does not sample the machine");
				const context = footer.view.render(width);
				footer.toggleExpanded();
				strictEqual(scheduled, before + 1, "Status starts one sampler interval");
				const status = footer.view.render(width);
				footer.refresh();
				strictEqual(scheduled, before + 1, "Status refresh reuses the interval");
				footer.toggleExpanded();
				strictEqual(cleared, before + 1, "leaving Status clears its interval");
				for (const line of [...compact, ...activity, ...context, ...status]) {
					ok(visibleWidth(line) <= width);
					for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
				}
			} finally {
				footer.dispose();
			}
		}
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});
