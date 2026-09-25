import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";

test("footer hydration does not read session metadata that no page renders", () => {
	let sessionReads = 0;
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		getSessionInfo: () => {
			sessionReads += 1;
			return { id: "session", name: "demo", turns: 42 };
		},
		getTerminalColumns: () => 80,
		getTerminalRows: () => 40,
		resolveCurrentBranch: async () => null,
	});
	try {
		for (const width of [40, 60, 80, 120, 200]) {
			const compact = footer.view.render(width);
			strictEqual(compact.length, width <= 60 ? 1 : 2);
			footer.setExpanded(true);
			const expanded = footer.view.render(width);
			ok(expanded.length > compact.length);
			for (const line of [...compact, ...expanded]) {
				ok(visibleWidth(line) <= width);
				for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
			}
			footer.setExpanded(false);
		}
		strictEqual(sessionReads, 0);
	} finally {
		footer.dispose();
	}
});
