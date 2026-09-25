import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import { footerState } from "../harness/footer-fixture.js";

test("fleet hint offers detail only for a row with rendered detail", () => {
	const base = footerState().dispatchRows[0];
	ok(base);
	const rows = [
		{ ...base, runId: "council-member", council: { group: "review", label: "Alpha", round: 1 } },
		{ ...base, runId: "ordinary", status: "completed" as const },
	];
	const board = createDispatchBoardView(
		() => rows,
		() => undefined,
	);
	for (const width of [60, 80, 120, 200]) {
		let hint: ((width: number) => string | undefined) | undefined;
		const deps = {
			transitions: { state: "closed" },
			dispatchBoard: board,
			terminal: { columns: width },
			requestRender() {},
			startDispatchBoardTicker() {},
			showOverlayFrame: (_tui: unknown, _child: unknown, options: { footerHint: typeof hint }) => {
				hint = options.footerHint;
				return {};
			},
		} as unknown as OverlayGeneralOpenersDeps;
		board.resetSelection();
		createOverlayGeneralOpeners(deps).toggleDispatchBoard();
		const councilHint = hint?.(width) ?? "";
		doesNotMatch(councilHint, /Enter.*detail/u);
		ok(visibleWidth(councilHint) <= width);
		board.selectNext();
		const ordinaryHint = hint?.(width) ?? "";
		match(ordinaryHint, /Enter.*detail/u);
		ok(visibleWidth(ordinaryHint) <= width);
		for (const line of [councilHint, ordinaryHint])
			for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
	}
});
