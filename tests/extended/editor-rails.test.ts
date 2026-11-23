import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { renderEditorRail } from "../../src/interactive/editor-rails.js";
import { contextRailGroup, contextRailUnit, thinkingRailUnit } from "../../src/interactive/footer/context-rail.js";
import { compactionRailLabel, workerWaitRailLabel } from "../../src/interactive/footer/widgets.js";
import { createClioTheme, statusRailLabelRoom } from "../../src/interactive/theme/index.js";

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
	// Only the live-work spinner moves; everything else on the rail holds still around the draft.
	const steady = (row: string | undefined): string => (row ?? "").replace(/[\u2800-\u28ff]/gu, "");
	const before = editor.render(80)[0];
	now = 2200;
	strictEqual(steady(editor.render(80)[0]), steady(before));
	strictEqual(editor.getText(), "Do not change this draft");
	autonomy = "default";
	doesNotMatch(stripTerminalSequences(editor.render(80)[0] ?? ""), /YOLO/);
});
test("a working rail steps with the shared animation clock, and the approval cue holds still", (t) => {
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
	strictEqual(working.render(80)[0], firstWorking);
	now = 1_700;
	notStrictEqual(working.render(80)[0], firstWorking);
	strictEqual(approval.render(80)[0], firstApproval);
});
test("rail content: the context and thinking group keeps ctx last and drops units in the 4.1 order (W1-2)", () => {
	const thinking = { label: "low", hasLevels: true, supportedLevels: ["off", "low", "medium", "high"] };
	const live = (used: number, inputSource: "anchored-plus-estimated-tail" | "historical" | "estimated") => ({
		budget: { revision: "r1", historical: inputSource === "historical", inputSource },
		used,
		contextWindow: 272_000,
		toolSchemaTokens: 4_000,
		breakdown: { systemPromptTokens: 3_000, toolSchemaTokens: 4_000, messageTokens: used - 7_000, pendingUserTokens: 0 },
	});
	const room = (width: number) => Math.max(1, width - Math.min(16, Math.floor(width / 3)) - 3);
	const group = (context: Parameters<typeof contextRailGroup>[1]["context"], width: number) => {
		const row = contextRailGroup(theme, { context, thinking }, room(width), width);
		ok(visibleWidth(row) <= room(width), `${width}: ${row}`);
		return stripTerminalSequences(row);
	};
	strictEqual(group(live(16_800, "anchored-plus-estimated-tail"), 80), "ctx ▰▱▱▱▱▱ 6% · low ● ○ ○ ○");
	strictEqual(group(live(16_800, "anchored-plus-estimated-tail"), 120), "ctx ▰▱▱▱▱▱▱▱▱▱ 16.8k/272k 6% · low ● ○ ○ ○");
	strictEqual(group(live(10_900, "anchored-plus-estimated-tail"), 33), "ctx 4% · think low");
	strictEqual(group(live(223_000, "anchored-plus-estimated-tail"), 80), "ctx ▰▰▰▰▰▱ 82% high · low ● ○ ○ ○");
	strictEqual(group(live(261_200, "anchored-plus-estimated-tail"), 80), "ctx ▰▰▰▰▰▰ 96% full · low ● ○ ○ ○");
	strictEqual(group(live(223_000, "historical"), 80), "ctx ▰▰▰▰▰▱ saved 82% high · low ● ○ ○ ○");
	strictEqual(group(live(16_800, "historical"), 120), "ctx ▰▱▱▱▱▱▱▱▱▱ saved 16.8k/272k 6% · low ● ○ ○ ○");
	strictEqual(group(live(16_800, "estimated"), 120), "ctx ▰▱▱▱▱▱▱▱▱▱ ≈16.8k/272k 6% · low ● ○ ○ ○");
	const fresh = {
		budget: { revision: "r1", historical: false, inputSource: "unknown" as const },
		used: null,
		contextWindow: 272_000,
		toolSchemaTokens: null,
	};
	strictEqual(group(fresh, 80), "ctx 272k · low ● ○ ○ ○");
	// Narrowing drops the marks (the word stays), then the bar, then the word; `ctx N%` stands last.
	const context = live(16_800, "anchored-plus-estimated-tail");
	const fitted = (cells: number) => stripTerminalSequences(contextRailGroup(theme, { context, thinking }, cells, 80));
	strictEqual(fitted(20), "ctx ▰▱▱▱▱▱ 6% · low");
	strictEqual(fitted(18), "ctx 6% · think low");
	strictEqual(fitted(8), "ctx 6%");
	strictEqual(stripTerminalSequences(contextRailUnit(context, theme, { bar: 0, pair: true })), "ctx 16.8k/272k 6%");
	strictEqual(stripTerminalSequences(thinkingRailUnit(theme, thinking, "labelled") ?? ""), "think low");
});
test("rail content: worker waits name a count and a clock, and Esc stops outlasts both (W1-2)", () => {
	for (const [width, expected] of [
		[120, "is waiting for 2 workers · 18s · Esc stops"],
		[80, "is waiting for 2 workers · 18s · Esc stops"],
		[48, "waiting for 2 workers · 18s · Esc stops"],
		[33, "waiting · 18s · Esc stops"],
	] as const) {
		const room = statusRailLabelRoom(width) - 2;
		const label = workerWaitRailLabel(2, 18_400, room, { name: "GPT-6-luna", shown: false });
		strictEqual(label, expected);
		ok(visibleWidth(label) <= room);
	}
	strictEqual(workerWaitRailLabel(2, 1_500, 60), "is waiting for 2 workers · Esc stops");
	for (const width of [120, 80, 48]) {
		const label = compactionRailLabel({ phase: "summarize", startedAtMs: 0 }, statusRailLabelRoom(width) - 2, 5_200);
		strictEqual(label, "is summarizing history · 5s · Esc stops");
	}
});
