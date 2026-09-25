import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../../src/interactive/council.js";
import { createDispatchBoardView, type DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { footerState } from "../harness/footer-fixture.js";

test("council focus traverses only the members rendered in the current projection", () => {
	const base = footerState().dispatchRows[0];
	ok(base);
	const member = (runId: string, label: string, round: number): DispatchBoardRow => ({
		...base,
		runId,
		council: { group: "review", label, round },
	});
	const rows = [
		member("alpha-1", "Alpha", 1),
		member("beta-1", "Beta", 1),
		member("alpha-2", "Alpha", 2),
		member("beta-2", "Beta", 2),
		member("synthesis", COUNCIL_SYNTHESIS_LABEL, 2),
		{ ...base, runId: "ordinary" },
	];
	const board = createDispatchBoardView(
		() => rows,
		() => undefined,
	);
	board.resetSelection();
	strictEqual(board.selectedRow()?.runId, "alpha-2");
	for (const width of [60, 80, 120, 200]) {
		const lines = board.render(width);
		match(lines.map(stripTerminalSequences).join("\n"), new RegExp(`${GLYPH.cursor} Alpha`));
		for (const line of lines) {
			ok(visibleWidth(line) <= width);
			for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
		}
	}
	for (const runId of ["beta-2", "synthesis", "ordinary", "alpha-2"]) {
		board.selectNext();
		strictEqual(board.selectedRow()?.runId, runId);
	}
	rows.push(member("alpha-3", "Alpha", 3));
	strictEqual(board.selectedRow()?.runId, "alpha-3", "a new round replaces the focused member without hiding focus");
});
