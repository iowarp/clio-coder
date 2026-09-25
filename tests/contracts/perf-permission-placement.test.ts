import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { buildLayout, registerRegularRoot } from "../../src/interactive/layout.js";
import { permissionOverlayPlacement } from "../../src/interactive/permission-overlay.js";

for (const width of [60, 80, 120, 200]) {
	for (const transcriptRows of [0, 55]) {
		test(`permission placement reuses a ${width}-column base frame with ${transcriptRows} transcript rows`, () => {
			const banner = { render: () => ["session"], invalidate: () => {} };
			const chat = {
				render: () => Array.from({ length: transcriptRows }, (_, index) => `turn ${index}`),
				invalidate: () => {},
			};
			const editor = {
				render: (columns: number) => Array.from({ length: columns < 80 ? 3 : 2 }, () => "composer"),
				invalidate: () => {},
			};
			const footer = { render: (_columns: number) => ["status"], invalidate: () => {} };
			const root = buildLayout({ banner, chat, editor, footer });
			let baseRenders = 0;
			const tui = {
				mode: "regular" as const,
				render: (columns: number) => {
					baseRenders++;
					return root.render(columns);
				},
			};
			registerRegularRoot(tui, root);
			const placement = permissionOverlayPlacement(tui, editor, footer);
			const terminalRows = 24;
			for (let frame = 1; frame <= 4; frame++) {
				const rows = tui.render(width);
				for (const line of rows) {
					ok(visibleWidth(line) <= width);
					for (const escapeTail of line.split(String.fromCharCode(27)).slice(1)) {
						ok(/^\[[0-9;]*m/u.test(escapeTail), "only SGR escapes are allowed");
					}
				}
				const dockHeight = editor.render(width).length + footer.render(width).length;
				const composerTop = Math.max(0, rows.length - dockHeight);
				const viewportStart = Math.max(0, rows.length - terminalRows);
				const viewportRow = composerTop - viewportStart;
				const expectedBottom =
					viewportRow >= 0 && viewportRow < terminalRows ? Math.max(0, terminalRows - viewportRow) : dockHeight;
				strictEqual(placement.visible?.(width, terminalRows), true);
				const margin = placement.margin;
				ok(typeof margin === "object" && margin !== null);
				strictEqual(margin.bottom, expectedBottom);
				strictEqual(baseRenders, frame, "one base render per parked frame");
			}
		});
	}
}
