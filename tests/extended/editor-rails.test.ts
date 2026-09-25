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
				{ phase, yolo: true, animate: true, now: 1700 },
			);
			strictEqual(visibleWidth(row), width);
			if (width >= 40) match(stripTerminalSequences(row), /CONFIRM.*Enter allow/);
		}
	}
});
test("motion changes only styling, and reduced motion keeps working rails stable", () => {
	const render = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, {}, { phase: "working", yolo: true, animate, now });
	notStrictEqual(render(400, true), render(1500, true));
	strictEqual(stripTerminalSequences(render(400, true)), stripTerminalSequences(render(1500, true)));
	strictEqual(render(400, false), render(1500, false));
	ok(render(400, true).includes(theme.style("editorDanger", "━━━", { bold: true })));
});
test("thinking effort moves to the rail and follows transcript density", () => {
	let level = "off";
	let style: "compact" | "standard" | "detailed" = "standard";
	let autonomy = "default";
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "model",
		getThinkingLabel: () => level,
		getOutputStyle: () => style,
		getAutonomy: () => autonomy,
	});
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /think ▱▱▱▱▱/u);
	level = "high";
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /think ▰▰▰▱▱/u);
	style = "compact";
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /T ▰▰▰▱▱/u);
	style = "detailed";
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /think ▰▰▰▱▱ high/u);
	autonomy = "yolo";
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /^YOLO .*think ▰▰▰▱▱ high/u);
	level = "forced";
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /think forced/u);
	doesNotMatch(stripTerminalSequences(editor.render(80)[0] ?? ""), /▰/u);
});
test("permission rail carries a moving orange spectrum", () => {
	const paint = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, { left: "CONFIRM" }, { phase: "attention", yolo: false, animate, now });
	notStrictEqual(paint(400, true), paint(1500, true));
	strictEqual(stripTerminalSequences(paint(400, true)), stripTerminalSequences(paint(1500, true)));
	strictEqual(paint(400, false), paint(1500, false));
	ok(paint(1500, true).includes(theme.style("warning", "━", { bold: true }).split("━")[0] ?? ""));
});
test("composer reads live autonomy and holds the rail steady around an existing draft", () => {
	let autonomy = "yolo";
	let now = 400;
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "model",
		getThinkingLabel: () => "off",
		isStreaming: () => true,
		getAutonomy: () => autonomy,
		getAnimationTime: () => now,
	});
	match(stripTerminalSequences(editor.render(80)[0] ?? ""), /YOLO/);
	editor.setText("Do not change this draft");
	const before = editor.render(80)[0];
	now = 2200;
	strictEqual(editor.render(80)[0], before);
	strictEqual(editor.getText(), "Do not change this draft");
	autonomy = "default";
	doesNotMatch(stripTerminalSequences(editor.render(80)[0] ?? ""), /YOLO/);
});
test("the working pulse steps with the shared animation clock, not with every frame", (t) => {
	const env = { TERM: process.env.TERM, reduce: process.env.CLIO_CODER_REDUCE_MOTION };
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_REDUCE_MOTION;
	t.after(() => {
		process.env.TERM = env.TERM;
		if (env.reduce !== undefined) process.env.CLIO_CODER_REDUCE_MOTION = env.reduce;
	});
	let now = 1_200;
	t.mock.method(performance, "now", () => now);
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "model",
		getThinkingLabel: () => "off",
		isStreaming: () => true,
	});
	const first = editor.render(80)[0];
	// A streamed token's frame inside the same 120 ms step repaints no rail.
	now = 1_310;
	strictEqual(editor.render(80)[0], first);
	now = 1_450;
	notStrictEqual(editor.render(80)[0], first);
});
