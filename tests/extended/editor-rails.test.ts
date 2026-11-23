import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { type DispatchBoardRow, dispatchWaitRuns } from "../../src/interactive/dispatch-board.js";
import { dockMount, dockUnmount } from "../../src/interactive/dock.js";
import { parseEditorBashCommand } from "../../src/interactive/editor-bash.js";
import { renderEditorRail } from "../../src/interactive/editor-rails.js";
import { contextRailGroup, contextRailUnit, thinkingRailUnit } from "../../src/interactive/footer/context-rail.js";
import { type LiveWorkFacts, overlayRunState } from "../../src/interactive/footer/live-work.js";
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
	// Two shadow scouts the turn dispatched are the workers it waits on; the rail read `a worker` over them (FX-7b).
	const scout = (
		runId: string,
		status: DispatchBoardRow["status"],
		requestOrigin: NonNullable<DispatchBoardRow["requestOrigin"]>,
	): DispatchBoardRow => ({
		runId,
		agentId: "scout",
		agentAudience: "shadow",
		requestOrigin,
		runtimeKind: "http",
		runtimeId: "native",
		targetId: "copilot",
		wireModelId: "gpt-6-luna",
		status,
		elapsedMs: 2_500,
		usage: { kind: "pending" },
		lastContextTokens: null,
		ttft: null,
	});
	const awaited = dispatchWaitRuns([
		scout("a", "running", "agent"),
		scout("b", "enqueued", "agent"),
		scout("c", "completed", "agent"),
		scout("d", "running", "internal"),
	]).length;
	strictEqual(awaited, 2);
	for (const [width, expected] of [
		[80, "is waiting for 2 workers · 2s · Esc stops"],
		[48, "waiting for 2 workers · 2s · Esc stops"],
		[33, "waiting · 2s · Esc stops"],
	] as const) {
		const room = statusRailLabelRoom(width) - 2;
		strictEqual(workerWaitRailLabel(awaited, 2_400, room, { name: "GPT-6-luna", shown: false }), expected);
	}
	for (const width of [120, 80, 48]) {
		const label = compactionRailLabel({ phase: "summarize", startedAtMs: 0 }, statusRailLabelRoom(width) - 2, 5_200);
		strictEqual(label, "is summarizing history · 5s · Esc stops");
	}
});
test("overlay rule: a picker over the turn's dispatch wait names its shadow workers and the wait's clock (W1-10, FX-11)", () => {
	const now = Date.now();
	const scout = (runId: string, status: DispatchBoardRow["status"]): DispatchBoardRow => ({
		runId,
		agentId: "scout",
		agentAudience: "shadow",
		requestOrigin: "agent",
		runtimeKind: "http",
		runtimeId: "native",
		targetId: "copilot",
		wireModelId: "gpt-6-luna",
		status,
		elapsedMs: 3_000,
		usage: { kind: "pending" },
		lastContextTokens: null,
		ttft: null,
	});
	// What getBesideCard reads: the runs the dispatch waits on, which the operator-fleet summary alone left empty.
	const facts: LiveWorkFacts = {
		actor: "GPT-6-luna",
		status: {
			phase: "dispatching",
			since: now - 30_000,
			phaseSince: now - 14_000,
			lastMeaningfulAt: now,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		},
		workers: dispatchWaitRuns([scout("a", "running"), scout("b", "enqueued")]),
		workerActivity: () => "waiting on the model",
		background: [],
		now,
	};
	for (const width of [80, 48, 33]) {
		const tui = new TuiMainScreen({ columns: width, rows: 24, write() {} } as unknown as Terminal);
		const editor = new ClioEditor(tui, {
			getModelLabel: () => "model",
			getThinkingLabel: () => "low",
			isStreaming: () => true,
			getBesideCard: (room) => overlayRunState(facts, room),
		});
		const entry = dockMount(
			tui,
			{
				renderDockBody: (cells: number, rows: number) => Array.from({ length: Math.min(rows, 3) }, () => " ".repeat(cells)),
				dockTitle: () => "Models",
				dockHint: () => "[type] filter · [Enter] use · [Esc] close",
				dockTone: () => undefined,
				invalidate() {},
			},
			false,
		);
		const top = stripTerminalSequences(editor.render(width)[0] ?? "");
		match(top, /^━ Models ━+ [\u2800-\u28ff] 2 workers · 14s ━$/u, `${width}: ${top}`);
		strictEqual(visibleWidth(top), width);
		dockUnmount(tui, entry);
	}
});
test("rail content: a multi-line `!` draft is a prompt, so its bottom rail has no shell unit (W1-10, FX-11)", () => {
	// The composer's own reading: Enter runs a `!` draft as shell only while it is one line (editor-bash.ts).
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "model",
		getThinkingLabel: () => "low",
		getDraftOperator: (text) => (parseEditorBashCommand(text) ? "shell" : null),
	});
	const bottom = (draft: string): string => {
		editor.setText(draft);
		const rows = editor.render(80);
		ok(rows.every((row) => visibleWidth(row) <= 80));
		return stripTerminalSequences(rows.at(-1) ?? "");
	};
	match(bottom("!echo 1"), /^━ \$ shared shell · Enter runs/u);
	match(bottom("!!echo 1"), /^━ \$ private shell · Enter runs/u);
	const more = Array.from({ length: 30 }, (_, index) => `line ${index + 2}`).join("\n");
	for (const lead of ["!echo 1", "!!echo 1"]) {
		doesNotMatch(bottom(`${lead}\nline 2`), /\$/u);
		const tall = bottom(`${lead}\n${more}`);
		match(tall, /^━ 31 lines ━/u);
		doesNotMatch(tall, /\$|shell/u);
	}
});
