import { deepStrictEqual, doesNotMatch, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { centeredWindow, fitRow, fitRows } from "../../src/interactive/overlay-frame.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

const WIDTHS = [60, 80, 120, 200] as const;

/**
 * Six overlays carried a private fit helper, two a `fixedLines`, and settings
 * and the leader menu each a centered scroll window. One copy of each now
 * lives beside the frame, and the overlays are checked for regrowth.
 */
test("fitRow leaves a fitting row alone and cuts a long one on the ellipsis", () => {
	for (const width of WIDTHS) {
		const short = "x".repeat(width - 1);
		strictEqual(fitRow(short, width), short);
		const long = fitRow("y".repeat(width + 20), width);
		strictEqual(visibleWidth(long), width);
		ok(stripTerminalSequences(long).endsWith(GLYPH.ellipsis));
	}
});

test("fitRows returns exactly the height asked for at every width", () => {
	for (const width of WIDTHS) {
		const rows = fitRows(["a", "b".repeat(width + 5)], width, 4);
		strictEqual(rows.length, 4);
		for (const row of rows) strictEqual(visibleWidth(row), width);
		const cut = fitRows(["a", "b", "c"], width, 2);
		strictEqual(cut.length, 2);
	}
});

test("centeredWindow keeps the selection centered and pins at both ends", () => {
	deepStrictEqual(centeredWindow(3, 1, 10), [0, 3]);
	deepStrictEqual(centeredWindow(20, 0, 5), [0, 5]);
	deepStrictEqual(centeredWindow(20, 10, 5), [8, 13]);
	deepStrictEqual(centeredWindow(20, 19, 5), [15, 20]);
	deepStrictEqual(centeredWindow(20, 5, 0), [0, 20]);
});

test("overlay modules no longer carry their own copies", () => {
	const root = fileURLToPath(new URL("../../src/interactive/", import.meta.url));
	for (const file of [
		"overlays/auth-dialog.ts",
		"overlays/decisions.ts",
		"overlays/keybinding-detail.ts",
		"overlays/ask-user.ts",
		"overlays/settings.ts",
		"view/view-overlay.ts",
		"tasks-overlay.ts",
		"leader-menu.ts",
	]) {
		doesNotMatch(
			readFileSync(`${root}${file}`, "utf8"),
			/function (fitLine|fitCell|fitContentLine|fixedLines|scrollWindow)\(/u,
			file,
		);
	}
});
