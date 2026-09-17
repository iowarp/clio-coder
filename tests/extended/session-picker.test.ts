import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import {
	type Component,
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	type Terminal,
	TuiAltScreen,
	visibleWidth,
} from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { openSessionOverlay, SESSION_ESCAPE_GRACE_MS } from "../../src/interactive/overlays/session-selector.js";

const noop = () => {};
function session(id: string, fields: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id,
		cwd: "/workspace/science",
		cwdHash: "fixture",
		createdAt: new Date(Date.now() - 3_600_000).toISOString(),
		endedAt: null,
		model: "model-long-context",
		target: "gateway",
		clioCoderVersion: "0.4.9",
		piMonoVersion: "0.85.1",
		platform: "linux",
		nodeVersion: process.version,
		messageCount: 3,
		...fields,
	};
}

function picker(t: TestContext, sessions: SessionMeta[], overrides: Record<string, string | string[]> = {}) {
	const previous = getKeybindings();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.keybindings = overrides;
	createKeybindingManager(settings, {});
	const terminal: Terminal = {
		columns: 120,
		rows: 40,
		kittyProtocolActive: false,
		start: noop,
		stop: noop,
		drainInput: async () => {},
		write: noop,
		moveBy: noop,
		hideCursor: noop,
		showCursor: noop,
		clearLine: noop,
		clearFromCursor: noop,
		clearScreen: noop,
		setTitle: noop,
		setProgress: noop,
	};
	const tui = new TuiAltScreen(terminal);
	const editor = new ClioEditor(tui, { getModelLabel: () => "fixture", getThinkingLabel: () => "off" });
	editor.setText("unsent editor draft");
	tui.addChild(editor);
	tui.setFocus(editor);
	const resumed: string[] = [];
	let closed = 0;
	const handle = openSessionOverlay(tui, {
		session: { history: () => sessions } as unknown as SessionContract,
		onResume: (id) => {
			resumed.push(id);
		},
		onClose: () => {
			closed++;
			handle.hide();
		},
	});
	const box = tui.getFocusedComponent() as Component & { undoInput(): boolean };
	assert.ok(box);
	t.after(() => {
		handle.hide();
		tui.stop();
		setKeybindings(previous);
	});
	const input = (data: string) => box.handleInput?.(data);
	const lines = (width = 92) => box.render(width).map((line) => stripTerminalSequences(line));
	const selected = (width = 92) => lines(width).find((line) => line.includes("❯")) ?? "";
	return { box, editor, input, lines, selected, resumed, closed: () => closed };
}

const topics: readonly string[] = ["Repair particle output", "Audit solver precision", "Measure checkpoint cost"];
for (const width of [40, 43, 44, 60, 92, 120]) {
	it(`shows recognizable task identity at ${width} columns`, (t) => {
		const f = picker(
			t,
			topics.map((topic, index) => session(`session-${index}`, { firstMessagePreview: topic })),
		);
		const lines = f.lines(width);
		for (const topic of topics)
			assert.ok(
				lines.some((line) => line.includes(topic)),
				`${topic} missing at ${width}`,
			);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		assert.match(f.selected(width), /Repair particle output/);
		if (width >= 92) {
			assert.ok(lines.some((line) => /3 msgs/.test(line)));
			assert.ok(lines.some((line) => /gateway/.test(line)));
		}
	});
}

it("keeps useful name and session ID fallbacks when previews are blank or absent", (t) => {
	const f = picker(t, [
		session("id-named", { firstMessagePreview: " \n ", name: "Named benchmark" }),
		session("id-empty-alpha", { firstMessagePreview: "", name: "" }),
		session("id-empty-beta", { cwd: "" }),
	]);
	const text = f.lines(40).join("\n");
	assert.match(text, /Named benchmark/);
	assert.match(text, /id-empty-alpha/);
	assert.match(text, /id-empty-beta/);
});

it("sanitizes external task, name, route and label text before styling", (t) => {
	const poison = "\x1b]0;injected-title\x07\x1b[31m";
	const f = picker(t, [
		session("safe-task", {
			firstMessagePreview: `${poison}Task\n科学 👩‍🔬\tcheck\x7f`,
			target: `${poison}gateway`,
			model: `${poison}model`,
			labels: [`${poison}label`],
		}),
		session("safe-name", { name: `${poison}Named\rtest` }),
		session("safe-cwd", { cwd: `/workspace/${poison}folder` }),
	]);
	for (const width of [40, 44, 60, 92, 120]) {
		const raw = f.box.render(width).join("\n");
		assert.ok(!raw.includes("\x1b]0;"));
		assert.ok(!raw.includes("\x1b[31m"));
		assert.ok(!raw.includes("injected-title"));
		assert.ok(!raw.includes("\x07") && !raw.includes("\x7f") && !raw.includes("\r") && !raw.includes("\t"));
		const lines = f.lines(width);
		assert.ok(lines.some((line) => line.includes("Task 科学 👩‍🔬")));
		assert.ok(lines.some((line) => line.includes("Named test")));
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
});

it("retains the selected session ID when filtering still includes it and on undo", (t) => {
	const f = picker(t, [
		session("first", { firstMessagePreview: "Alpha task" }),
		session("second", { firstMessagePreview: "Beta task" }),
	]);
	f.input("\x1b[B");
	f.input("task");
	assert.match(f.selected(), /Beta task/);
	assert.equal(f.box.undoInput(), true);
	assert.match(f.selected(), /Beta task/);
	f.input("\r");
	assert.deepEqual(f.resumed, ["second"]);
	assert.equal(f.editor.getText(), "unsent editor draft");
});

it("empty results cannot resume and undo restores the prior selected ID", (t) => {
	const f = picker(t, [
		session("first", { firstMessagePreview: "Alpha task" }),
		session("second", { firstMessagePreview: "Beta task" }),
	]);
	f.input("\x1b[B");
	f.input("zzzznomatch");
	assert.match(f.lines().join("\n"), /no matching sessions/);
	f.input("\r");
	assert.deepEqual(f.resumed, []);
	assert.equal(f.closed(), 0);
	f.box.undoInput();
	assert.match(f.selected(), /Beta task/);
	f.input("\r");
	assert.deepEqual(f.resumed, ["second"]);
});

it("selects the visible matching row when the previous ID is filtered out", (t) => {
	const f = picker(t, [
		session("first", { firstMessagePreview: "Alpha task" }),
		session("second", { firstMessagePreview: "Beta task" }),
	]);
	f.input("Beta");
	assert.match(f.selected(), /Beta task/);
	f.input("\r");
	assert.deepEqual(f.resumed, ["second"]);
});

it("page navigation resumes the visibly selected ID and clamps at both ends", (t) => {
	const sessions = Array.from({ length: 28 }, (_, index) =>
		session(`id-${index}`, { firstMessagePreview: `Task ${index} unique topic` }),
	);
	const f = picker(t, sessions);
	f.input("\x1b[6~");
	assert.match(f.selected(), /Task 12 unique topic/);
	f.input("\x1b[6~");
	f.input("\x1b[6~");
	assert.match(f.selected(), /Task 27 unique topic/);
	f.input("\x1b[5~");
	assert.match(f.selected(), /Task 15 unique topic/);
	f.input("\x1b[5~");
	f.input("\x1b[5~");
	assert.match(f.selected(), /Task 0 unique topic/);
	f.input("\x1b[6~");
	f.input("\r");
	assert.deepEqual(f.resumed, ["id-12"]);
});

it("keeps configured navigation and confirm keys with duplicate display names", (t) => {
	const f = picker(t, [session("id-first", { name: "Same name" }), session("id-second", { name: "Same name" })], {
		"tui.select.down": "ctrl+n",
		"tui.select.confirm": "ctrl+y",
	});
	f.input("\x0e");
	f.input("\x19");
	assert.deepEqual(f.resumed, ["id-second"]);
	assert.equal(f.editor.getText(), "unsent editor draft");
});

it("keeps fragmented arrows distinct from Escape and preserves the editor draft", async (t) => {
	const f = picker(t, [session("first"), session("second")]);
	f.input("\x1b");
	f.input("[");
	f.input("B");
	assert.equal(f.closed(), 0);
	f.input("\r");
	assert.deepEqual(f.resumed, ["second"]);
	assert.equal(f.editor.getText(), "unsent editor draft");
	const cancelled = picker(t, [session("first")]);
	cancelled.input("search text");
	cancelled.input("\x1b");
	await delay(SESSION_ESCAPE_GRACE_MS + 30);
	assert.equal(cancelled.closed(), 1);
	assert.deepEqual(cancelled.resumed, []);
	assert.equal(cancelled.editor.getText(), "unsent editor draft");
});

it("Input's Enter path resumes the selected ID when list confirm is rebound", (t) => {
	const f = picker(t, [session("first"), session("second")], { "tui.select.confirm": "ctrl+y" });
	f.input("\x1b[B");
	f.input("\r");
	assert.deepEqual(f.resumed, ["second"]);
});

it("line-feed confirmation resumes the selected ID", (t) => {
	const f = picker(t, [session("first"), session("second")]);
	f.input("\x1b[B");
	f.input("\n");
	assert.deepEqual(f.resumed, ["second"]);
});

it("keeps long Unicode identity within the frame at every supported width", (t) => {
	const f = picker(t, [
		session("unicode", { firstMessagePreview: `科学 👩‍🔬 e\u0301 ${"測定👩‍🔬e\u0301 ".repeat(40)}` }),
	]);
	for (const width of [40, 44, 60, 92, 120]) {
		const lines = f.lines(width);
		assert.match(f.selected(width), /科学 👩‍🔬 é/);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width);
			assert.ok(!line.includes("\ufffd"));
		}
	}
});

it("empty history stays inert under arrows, paging and confirmation", (t) => {
	const f = picker(t, []);
	for (const key of ["\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[5~", "\r", "\n"]) f.input(key);
	assert.match(f.lines(40).join("\n"), /no matching sessions/);
	assert.deepEqual(f.resumed, []);
	assert.equal(f.closed(), 0);
	assert.equal(f.editor.getText(), "unsent editor draft");
});

it("retains searchable labels, model and workspace context", (t) => {
	const f = picker(t, [
		session("id-other", { firstMessagePreview: "Other task" }),
		session("id-wanted", {
			firstMessagePreview: "Wanted task",
			labels: ["calibration"],
			model: "science-model",
			cwd: "/workspace/experiment",
		}),
	]);
	f.input("calibration science-model experiment");
	assert.match(f.selected(), /Wanted task/);
	f.input("\r");
	assert.deepEqual(f.resumed, ["id-wanted"]);
});
