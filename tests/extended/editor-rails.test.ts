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
test("working rails are static, and only the permission rail carries motion", () => {
	const render = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, {}, { phase: "working", yolo: true, animate, now });
	strictEqual(render(400, true), render(1500, true));
	strictEqual(render(400, false), render(1500, false));
	const attention = (now: number) =>
		renderEditorRail(theme, 80, {}, { phase: "attention", yolo: false, animate: true, now });
	notStrictEqual(attention(400), attention(1500));
	strictEqual(stripTerminalSequences(attention(400)), stripTerminalSequences(attention(1500)));
});
test("thinking effort moves to the bottom rail and follows transcript density", () => {
	let level = "off";
	const style: "compact" | "standard" | "detailed" = "standard";
	let autonomy = "default";
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "model",
		getThinkingLabel: () => level,
		getOutputStyle: () => style,
		getAutonomy: () => autonomy,
	});
	const rails = () => stripTerminalSequences(editor.render(80).join("\n"));
	match(rails(), /think off/u);
	level = "high";
	match(rails(), /think high/u);
	autonomy = "yolo";
	match(rails(), /YOLO/u);
	level = "forced";
	match(rails(), /think forced/u);
	doesNotMatch(rails(), /▰/u);
});
test("permission rail carries a moving attention spectrum", () => {
	const paint = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, { left: "CONFIRM" }, { phase: "attention", yolo: false, animate, now });
	notStrictEqual(paint(400, true), paint(1500, true));
	strictEqual(stripTerminalSequences(paint(400, true)), stripTerminalSequences(paint(1500, true)));
	strictEqual(paint(400, false), paint(1500, false));
	ok(paint(1500, true).includes(theme.style("attentionRail", "━", { bold: true }).split("━")[0] ?? ""));
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
test("the approval cue steps with the shared animation clock, and a working rail holds still", (t) => {
	const env = { TERM: process.env.TERM, reduce: process.env.CLIO_CODER_REDUCE_MOTION };
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_REDUCE_MOTION;
	t.after(() => {
		process.env.TERM = env.TERM;
		if (env.reduce !== undefined) process.env.CLIO_CODER_REDUCE_MOTION = env.reduce;
	});
	let now = 1_200;
	const make = (awaitingApproval: boolean) =>
		new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
			getModelLabel: () => "model",
			getThinkingLabel: () => "off",
			isStreaming: () => true,
			isAwaitingApproval: () => awaitingApproval,
			getAnimationTime: () => now,
		});
	const working = make(false);
	const approval = make(true);
	const firstWorking = working.render(80)[0];
	const firstApproval = approval.render(80)[0];
	// Inside one 480 ms step a repaint changes nothing.
	now = 1_300;
	strictEqual(approval.render(80)[0], firstApproval);
	now = 1_700;
	notStrictEqual(approval.render(80)[0], firstApproval);
	strictEqual(working.render(80)[0], firstWorking);
});
