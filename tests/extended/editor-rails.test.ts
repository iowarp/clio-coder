import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { renderEditorRail } from "../../src/interactive/editor-rails.js";
import { createClioTheme } from "../../src/interactive/theme/index.js";

const theme = createClioTheme({ color: true, truecolor: true });
test("rails preserve width and decision labels across animated and static phases", () => {
	for (const width of [0, 1, 12, 40, 80, 160]) {
		for (const phase of ["idle", "working", "attention"] as const) {
			const row = renderEditorRail(
				theme,
				width,
				{ left: "CONFIRM", right: "Enter allow" },
				{ phase, fullAuto: true, animate: true, now: 1700 },
			);
			strictEqual(visibleWidth(row), width);
			if (width >= 40) match(stripTerminalSequences(row), /CONFIRM.*Enter allow/);
		}
	}
});
test("motion changes only styling, and reduced motion keeps working rails stable", () => {
	const render = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, {}, { phase: "working", fullAuto: true, animate, now });
	notStrictEqual(render(400, true), render(1500, true));
	strictEqual(stripTerminalSequences(render(400, true)), stripTerminalSequences(render(1500, true)));
	strictEqual(render(400, false), render(1500, false));
	ok(render(400, true).includes(theme.style("editorDanger", "━━━", { bold: true })));
});
test("composer reads live autonomy and holds the rail steady around an existing draft", () => {
	let autonomy = "full-auto";
	let now = 400;
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "model",
		getThinkingLabel: () => "off",
		isStreaming: () => true,
		getAutonomy: () => autonomy,
		getAnimationTime: () => now,
	});
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /FULL-AUTO/);
	editor.setText("Do not change this draft");
	const before = editor.render(80)[0];
	now = 2200;
	strictEqual(editor.render(80)[0], before);
	strictEqual(editor.getText(), "Do not change this draft");
	autonomy = "auto-edit";
	doesNotMatch(stripTerminalSequences(editor.render(80)[0] ?? ""), /FULL-AUTO/);
});
