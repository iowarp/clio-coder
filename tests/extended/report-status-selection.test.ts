import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateOutbox } from "../../src/domains/report/outbox.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { type DockFrame, dockTop } from "../../src/interactive/dock.js";
import { createOverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import { createReportHost } from "../../src/interactive/report-flow.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

const DOWN = "\u001b[B";
const IDS = ["rpt_01KAAAAAAAAAAAAAAAAAAAAAA1", "rpt_01KAAAAAAAAAAAAAAAAAAAAAA2", "rpt_01KAAAAAAAAAAAAAAAAAAAAAA3"];

test("turning off one report's reply check in /report status leaves the cursor on that report", (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-report-status-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	for (const [index, id] of IDS.entries())
		updateOutbox(stateDir, id, {
			kind: "bug",
			title: `report ${index + 1}`,
			state: "sent",
			number: index + 1,
			url: `https://github.com/iowarp/clio-coder/issues/${index + 1}`,
			replyCheck: "2026-11-01T00:00:00.000Z",
		});
	const tui = {
		terminal: { columns: 100, rows: 35, setTitle: () => {} },
		requestRender: () => {},
		showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }),
	} as unknown as TUI;
	const transitions = createOverlayTransitions({
		stopDispatchBoardTicker: () => {},
		renderContextIsland: () => {},
		renderTaskIsland: () => {},
		requestRender: () => {},
		cancelPendingAskUser: () => false,
		finishAuth: () => {},
		onPermissionOverlayClosed: () => {},
	});
	const notices: string[] = [];
	const host = createReportHost({
		tui,
		transitions,
		stateDir,
		notify: (_level, text) => notices.push(text),
		findGh: () => null,
	});
	t.after(() => transitions.close());

	const frame = (): DockFrame & Component => dockTop(tui)?.frame as unknown as DockFrame & Component;
	const selected = (): string | undefined =>
		frame()
			.renderDockBody(96, 20)
			.map((row) => stripTerminalSequences(row).trim())
			.find((row) => row.startsWith(`${GLYPH.cursor} `));

	host.status();
	frame().handleInput?.(DOWN);
	strictEqual(selected()?.includes("report 2"), true, selected());
	frame().handleInput?.("r");
	strictEqual(notices.at(-1), `report: no more reply checks for ${IDS[1]}`);
	strictEqual(selected()?.includes("report 2"), true, selected());
});
