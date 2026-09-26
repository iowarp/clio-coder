import { deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { ContextActivitySnapshot } from "../../src/interactive/context-activity.js";
import { formatContextActivityIslandLines } from "../../src/interactive/context-activity.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";
import { footerState } from "../harness/footer-fixture.js";

const activity: ContextActivitySnapshot = {
	kind: "context-init",
	phase: "scan",
	status: "running",
	message: "Scanning project",
	startedAtMs: -5000,
	updatedAtMs: 0,
	completedAtMs: null,
	current: 1,
	total: 2,
	detail: null,
};

test("board and context spinners share the 120 ms animation step", () => {
	const row = footerState().dispatchRows[0];
	ok(row);
	const board = createDispatchBoardView(
		() => [row],
		() => undefined,
	);
	const originalNow = Date.now;
	try {
		for (const width of [60, 80, 120, 200]) {
			Date.now = () => 199;
			const beforeBoard = board.render(width);
			const beforeContext = formatContextActivityIslandLines(activity, width, 199);
			Date.now = () => 200;
			const afterBoard = board.render(width);
			const afterContext = formatContextActivityIslandLines(activity, width, 200);
			deepStrictEqual(afterBoard, beforeBoard);
			deepStrictEqual(afterContext, beforeContext);
			for (const line of [...afterBoard, ...afterContext]) {
				ok(visibleWidth(line) <= width);
				for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
				ok(stripTerminalSequences(line).length > 0);
			}
		}
	} finally {
		Date.now = originalNow;
	}
});
