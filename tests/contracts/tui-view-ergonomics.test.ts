import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { getKeybindings, Input, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import {
	type ArtifactProviderDeps,
	type ViewArtifact,
	type ViewArtifactLoadResult,
	WorkspaceArtifactProvider,
} from "../../src/interactive/view/artifacts.js";
import { ViewOverlayView } from "../../src/interactive/view/view-overlay.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const plain = (view: ViewOverlayView, width = 92) => view.render(width).map(stripTerminalSequences).join("\n");
const artifact = (id: string, category: ViewArtifact["category"] = "workspace"): ViewArtifact => ({
	id,
	category,
	title: id,
	timestamp: 0,
	load: async () => ({ format: "text", lines: [`Body of ${id}`] }),
});

async function open(items: ViewArtifact[], initialFilter = "") {
	let closed = false;
	const view = new ViewOverlayView({
		providers: [{ category: "workspace", list: async () => items }],
		initialFilter,
		getBodyHeight: () => 16,
		onClose: () => {
			closed = true;
		},
	});
	view.refresh();
	await settle();
	return { view, closed: () => closed };
}

test("initial text filters global evidence, appends at the end, and clears at any cursor position", async () => {
	const items = [artifact("DEMO-REPORT.md"), artifact("distant evidence mentions old reports", "receipt")];
	const { view } = await open(items, "DEMO-REPORT");
	match(plain(view), /List · 1\/2/u);
	doesNotMatch(plain(view), /Receipts/u);
	view.handleInput(".md");
	match(plain(view), /filter: DEMO-REPORT.md/u);
	view.handleInput("\x01");
	view.handleInput("\x15");
	match(plain(view), /List · 2\/2/u);
	view.undoInput();
	match(plain(view), /filter: DEMO-REPORT.md/u);
	view.handleInput("\x15");
	view.handleInput("unfindable");
	match(plain(view), /List · 0\/2/u);
	match(plain(view), /Ctrl\+U clears the filter/u);
	view.handleInput("\r");
	strictEqual(view.keyboardScope, "edit");
	view.handleInput("\x15");
	view.handleInput("receipt:");
	match(plain(view), /List · 1\/2/u);
	match(plain(view), /Receipts/u);
});

test("filter persists across preview, back, refresh, and terminal widths", async () => {
	const { view, closed } = await open([artifact("report"), artifact("other")], "report");
	for (const width of [40, 56, 57, 92, 160]) {
		match(plain(view, width), /filter: report/u);
		view.handleInput("\r");
		view.render(width);
		await settle();
		match(plain(view, width), /Body of report/u);
		ok(view.render(width).every((line) => visibleWidth(line) === width));
		view.handleInput("\x1b");
		strictEqual(closed(), false);
		view.refresh();
		await settle();
		match(plain(view, width), /filter: report/u);
	}
	view.handleInput("\x1b");
	strictEqual(closed(), true);
});

test("view gives narrow lists the full width and lets a focused preview move between entries", async () => {
	const first = { ...artifact("first", "transcript"), title: "Read the retry module before changing its tests" };
	const second = { ...artifact("second", "transcript"), title: "Run the retry tests after the edit" };
	const { view } = await open([first, second], "transcript:");
	const narrow = plain(view, 60);
	doesNotMatch(narrow, / │ /u);
	match(narrow, /Read the retry module before changing its tests/u);
	view.handleInput("\r");
	view.render(60);
	await settle();
	match(plain(view, 60), /Preview · 1\/2[\s\S]*Read the retry module/u);
	match(plain(view, 40), /Preview · 1\/2 · i info/u);
	doesNotMatch(plain(view, 40), /i inf…/u);
	view.handleInput("n");
	match(plain(view, 60), /Preview · 2\/2[\s\S]*Run the retry tests/u);
	view.handleInput("p");
	match(plain(view, 60), /Preview · 1\/2[\s\S]*Read the retry module/u);
	view.handleInput("\x1b");
	match(plain(view, 200), /Read the retry module before changing its tests/u);
});

test("an unusually long title leaves room for the preview body", async () => {
	const long = { ...artifact("long", "transcript"), title: "inspect the result ".repeat(100) };
	const { view } = await open([long]);
	view.handleInput("\r");
	view.render(40);
	await settle();
	const rows = plain(view, 40).split("\n");
	const metadata = rows.findIndex((row) => row.startsWith("transcript ·"));
	ok(metadata > 0 && metadata <= 4, rows.join("\n"));
	match(rows[metadata + 1] ?? "", /Body of long/u);
});

test("width-specific preview layout starts after paint and skips stale widths", async () => {
	const rendered: number[] = [];
	const rich = artifact("rich", "transcript");
	rich.load = async () => ({
		format: "text",
		lines: ["full body"],
		render: (width: number) => {
			rendered.push(width);
			return [`laid out at ${width} cells`];
		},
	});
	const { view } = await open([rich]);
	view.render(100);
	strictEqual(rendered.length, 0);
	await settle();
	strictEqual(rendered.length, 1);
	view.render(120);
	strictEqual(rendered.length, 1, "resizing never runs the block renderer inside paint");
	match(plain(view, 120), /laying out preview/u);
	await settle();
	strictEqual(rendered.length, 2);
	match(plain(view, 120), /laid out at \d+ cells/u);
	view.render(130);
	view.render(140);
	strictEqual(rendered.length, 2);
	await settle();
	strictEqual(rendered.length, 3, "only the latest requested width renders");
});

test("literal terms match full paths and provenance without matching scattered letters", async () => {
	const report = artifact("測定👩‍🔬.md");
	report.path = `/tmp/${"long-parent/".repeat(12)}測定👩‍🔬.md`;
	report.sessionId = "session-current";
	report.runId = "run-current";
	const { view } = await open([report, artifact("s_e_s_s_i_o_n-c_u_r_r_e_n_t")], "session-current");
	match(plain(view), /List · 1\/2/u);
	for (const width of [40, 92, 160]) {
		view.handleInput("\r");
		view.render(width);
		await settle();
		view.handleInput("i");
		const rows: string[] = [];
		for (let i = 0; i < 30; i += 1) {
			rows.push(...view.render(width));
			view.handleInput("j");
		}
		ok(rows.every((line) => visibleWidth(line) === width));
		const text = rows.map(stripTerminalSequences).join("\n");
		match(text, /測定👩‍🔬.md/u);
		match(text, /Session: session-current/u);
		match(text, /Run: run-current/u);
		view.handleInput("i");
		match(plain(view, width), /Body of 測定👩‍🔬.md/u);
		view.handleInput("\x1b");
	}
});

test("late content cannot reappear after the filter removes its selection", async () => {
	let finish: ((result: ViewArtifactLoadResult) => void) | undefined;
	const slow = artifact("slow");
	slow.load = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const { view } = await open([slow]);
	view.render(92);
	await settle();
	view.handleInput("absent");
	finish?.({ format: "text", lines: ["STALE CONTENT"] });
	await settle();
	doesNotMatch(plain(view), /STALE CONTENT/u);
	match(plain(view), /No artifact selected/u);
});

test("refresh retains selected identity after list ordering changes and category keys remain available", async () => {
	const items = [
		{ ...artifact("first"), timestamp: 2 },
		{ ...artifact("chosen"), timestamp: 1 },
		artifact("receipt", "receipt"),
	];
	const { view } = await open(items, "workspace:");
	view.handleInput("\x1b[B");
	view.render(92);
	await settle();
	match(plain(view), /Body of chosen/u);
	items.unshift({ ...artifact("newer"), timestamp: 3 });
	view.refresh();
	await settle();
	view.render(92);
	await settle();
	match(plain(view), /Body of chosen/u);
	view.handleInput("\x15");
	view.handleInput("\x1b[C");
	view.render(92);
	await settle();
	match(plain(view), /Body of receipt/u);
	view.handleInput("\x1b[C");
	view.render(92);
	await settle();
	match(plain(view), /Body of newer/u);
});

test("workspace titles expose basenames and preserve scoped path and turn provenance", async () => {
	const workspace = "/tmp/view-identity-fixture";
	const path = `${workspace}/long-parent/測定👩‍🔬-REPORT.md`;
	const provider = new WorkspaceArtifactProvider({
		stateDir: workspace,
		sessionMeta: {
			id: "current-session",
			cwd: workspace,
			cwdHash: "fixture-workspace-hash",
			createdAt: "2026-09-16T00:00:00Z",
			endedAt: null,
			model: null,
			target: null,
			clioCoderVersion: "0.4.9",
			piMonoVersion: "fixture",
			platform: "linux",
			nodeVersion: process.version,
			sessionFormatVersion: 4,
		},
		readSessionEntries: () => [
			{
				kind: "message",
				role: "tool_result",
				turnId: "turn-current",
				parentTurnId: null,
				timestamp: "2026-09-16T00:00:00Z",
				payload: { toolName: "artifact", result: { details: { paths: [path, "/outside/hidden.md"], kind: "report" } } },
			},
		],
	} satisfies ArtifactProviderDeps);
	const items = await provider.list();
	strictEqual(items.length, 1);
	const item = items[0];
	ok(item);
	ok(item.title.startsWith("測定👩‍🔬-REPORT.md · long-parent/"));
	strictEqual(item.path, path);
	strictEqual(item.sessionId, "current-session");
	match(item.description ?? "", /Turn: turn-current/u);
	const { view } = await open(items, "REPORT");
	for (const width of [40, 92, 160]) {
		match(plain(view, width), /測定👩‍🔬-REPORT.md/u);
		ok(view.render(width).every((line) => visibleWidth(line) === width));
	}
});

test("loads start off the render stack and an older refresh cannot replace newer resources", async () => {
	const pending: Array<(items: ViewArtifact[]) => void> = [];
	let loads = 0;
	const current = artifact("current");
	current.load = async () => {
		loads += 1;
		return { format: "text", lines: ["CURRENT BODY"] };
	};
	const view = new ViewOverlayView({
		providers: [{ category: "workspace", list: () => new Promise((resolve) => pending.push(resolve)) }],
		getBodyHeight: () => 10,
		onClose: () => {},
	});
	view.refresh();
	view.refresh();
	pending[1]?.([current]);
	await settle();
	view.render(92);
	strictEqual(loads, 0);
	await settle();
	strictEqual(loads, 1);
	pending[0]?.([artifact("obsolete")]);
	await settle();
	match(plain(view), /CURRENT BODY/u);
	doesNotMatch(plain(view), /obsolete/u);
	view.render(92);
	await settle();
	strictEqual(loads, 1);
});

test("Ctrl+U clears at any cursor with line-end remapped and undo restores the whole query", async () => {
	const previousKeys = getKeybindings();
	try {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.interface.keybindings = { "tui.editor.cursorLineEnd": ["end"] };
		createKeybindingManager(settings, {});
		for (const [movement, restored] of [
			["\x01", "!DEMO-REPORT"],
			["\x1bb", "DEMO-!REPORT"],
			["", "DEMO-REPORT!"],
		] as const) {
			const { view } = await open([artifact("DEMO-REPORT"), artifact("other")], "DEMO-REPORT");
			if (movement) view.handleInput(movement);
			view.handleInput("\x15");
			match(plain(view), /filter: \(empty\)/u);
			match(plain(view), /List · 2\/2/u);
			view.handleInput("\x15");
			view.undoInput();
			match(plain(view), /filter: DEMO-REPORT/u);
			match(plain(view), /List · 1\/2/u);
			view.handleInput("\x15");
			view.handleInput("other");
			match(plain(view), /filter: other/u);
			view.undoInput();
			match(plain(view), /filter: \(empty\)/u);
			view.undoInput();
			match(plain(view), /filter: DEMO-REPORT/u);
			view.handleInput("!");
			ok(plain(view).includes(`filter: ${restored}`));
		}
	} finally {
		setKeybindings(previousKeys);
	}
});

test("semantic clear preserves a whole Unicode value in the kill ring and empty clear leaves undo intact", () => {
	const input = new Input();
	const query = "測定👩‍🔬 DEMO-REPORT";
	input.handleInput(`\x1b[200~${query}\x1b[201~`);
	input.handleInput("\x1bb");
	input.applyEdit("clear");
	strictEqual(input.getValue(), "");
	input.applyEdit("clear");
	input.handleInput("\x19");
	strictEqual(input.getValue(), query);
	input.applyEdit("undo");
	strictEqual(input.getValue(), "");
	input.applyEdit("undo");
	strictEqual(input.getValue(), query);
	input.handleInput("!");
	strictEqual(input.getValue(), "測定👩‍🔬 DEMO-!REPORT");
});
