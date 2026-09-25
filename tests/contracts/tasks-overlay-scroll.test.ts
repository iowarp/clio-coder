import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { after, test } from "node:test";
import type { SessionArtifact } from "../../src/domains/session/session-artifacts.js";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import type { UserTask } from "../../src/domains/user-tasks/store.js";
import { type Component, stripTerminalSequences, type TUI, visibleWidth } from "../../src/engine/tui.js";
import { DOCK_BODY_ROWS_MAX, type DockFrame, dockTop } from "../../src/interactive/dock.js";
import { formatCompositeTasksOverlayBodyLines, openTasksOverlay } from "../../src/interactive/tasks-overlay.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

// BT-015: at 144x35 the docked board ended at "… 3 more rows" under Artifacts.
// Operator tasks never appeared, ↓ stopped among the agent tasks, and PgDn
// and Tab did nothing, while the footer offered keys that act on operator tasks.
const CONTENT = 140;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const TAB = "\t";

const claim = (id: string): string =>
	`${id} landed with its tests; ${"the completion claim names what changed, what ran and what the operator should reread before trusting it. ".repeat(3)}`;

const BOARD: TaskBoardSnapshot = {
	boardId: "b1",
	title: "Divide rounding",
	activeRunIds: [],
	tasks: [
		{ id: "t1", title: "Reproduce the rounding bug", status: "completed", evidence: claim("t1") },
		{ id: "t2", title: "Fix divide()", status: "completed", evidence: claim("t2") },
		{ id: "t3", title: "Add regression tests", status: "completed", evidence: claim("t3") },
		{ id: "t4", title: "Review divide() rounding behaviour", status: "active", origin: "user", userTaskId: "u1" },
	],
};

const ARTIFACTS: SessionArtifact[] = ["lib/math.js", "test/math.test.js", "docs/rounding.md"].map((path, index) => ({
	path,
	tool: "write",
	turnId: `turn-${index}`,
	timestamp: "2026-09-25T12:00:00Z",
	overwrites: 0,
}));

const USER_TASKS: UserTask[] = [
	{ id: "u1", title: "Review divide() rounding behaviour", status: "picked", createdAt: "", updatedAt: "" },
	{ id: "u2", title: "Document the rounding mode", status: "open", createdAt: "", updatedAt: "" },
];

interface Harness {
	frame: DockFrame & Component;
	render(): string[];
	press(key: string, times?: number): string[];
	done: string[];
}

function mount(board: TaskBoardSnapshot = BOARD, userTasks: UserTask[] = USER_TASKS): Harness {
	const tui = {
		terminal: { rows: 35, setTitle: () => {} },
		requestRender: () => {},
		showOverlay: () => ({ hide: () => {} }),
	} as unknown as TUI;
	const done: string[] = [];
	const handle = openTasksOverlay(tui, () => board, {
		getSessionSnapshot: () => ({ history: [], artifacts: ARTIFACTS }),
		getUserTasks: () => userTasks,
		onDoneUserTask: (id) => done.push(id),
		workspace: "/work",
	});
	// The board's one-second repaint ticker would keep the test process alive.
	after(() => handle.hide());
	const mounted = dockTop(tui)?.frame as unknown as DockFrame & Component;
	const render = (): string[] => {
		const rows = mounted.renderDockBody(CONTENT, DOCK_BODY_ROWS_MAX);
		strictEqual(rows.length, DOCK_BODY_ROWS_MAX, "the dock body fills its fixed budget");
		for (const row of rows) ok(visibleWidth(row) <= CONTENT, stripTerminalSequences(row));
		return rows.map((row) => stripTerminalSequences(row).trimEnd());
	};
	return {
		frame: mounted,
		render,
		press(key: string, times = 1): string[] {
			for (let step = 0; step < times; step++) mounted.handleInput?.(key);
			return render();
		},
		done,
	};
}

const selectedRow = (rows: ReadonlyArray<string>): string | undefined =>
	rows.find((row) => row.startsWith(`${GLYPH.cursor} `));

test("the docked board never cuts a section it cannot reach (BT-015)", () => {
	const board = mount();
	const first = board.render();
	doesNotMatch(first.join("\n"), /more rows/u, "the frame never has to cut the board");
	match(first.join("\n"), /\d+–\d+ of \d+ rows/u, "an overflowing board says where the window is");
	match(first[0] ?? "", /Divide rounding/u, "the board opens at its top");

	// Paging down reaches the end, and every row of the whole board was on screen once.
	const seen = new Set(first);
	let screen = first;
	for (let page = 0; page < 10; page++) {
		screen = board.press(PAGE_DOWN);
		for (const row of screen) seen.add(row);
	}
	match(screen.join("\n"), /Operator tasks/u, "PgDn reaches the operator tasks");
	match(screen.join("\n"), /u2 {3}Document the rounding mode/u);
	const whole = formatCompositeTasksOverlayBodyLines(
		{ board: BOARD, history: [], artifacts: ARTIFACTS, userTasks: USER_TASKS, workspace: "/work" },
		CONTENT,
	).map((row) => stripTerminalSequences(row).trimEnd());
	// Selection changes only the mark in front of a row, so rows compare without it.
	const unmarked = (row: string): string => row.replace(new RegExp(`^${GLYPH.cursor} `, "u"), "  ");
	const reached = new Set([...seen].map(unmarked));
	for (const row of whole) ok(reached.has(unmarked(row)), `unreachable board row: ${row}`);
	match(board.press(PAGE_UP, 10)[0] ?? "", /Divide rounding/u, "PgUp returns to the top");
});

test("the selection walks into operator tasks and the window follows it (BT-015)", () => {
	const board = mount();
	let screen = board.render();
	match(selectedRow(screen) ?? "", /t1 {3}Reproduce/u);
	const visited: string[] = [];
	for (let step = 0; step < 9; step++) {
		screen = board.press(DOWN);
		const selected = selectedRow(screen);
		ok(selected !== undefined, `the selected row stays on screen after ↓ ${step + 1}`);
		visited.push(selected);
	}
	match(visited.at(-1) ?? "", /u2 {3}Document the rounding mode/u, "↓ reaches the last operator task");
	match(screen.join("\n"), /Operator tasks/u, "the section heading shows with its rows");
	board.press("d");
	deepStrictEqual(board.done, ["u2"], "[d] done acts on the operator task the operator selected");

	for (let step = 0; step < 9; step++) {
		screen = board.press(UP);
		ok(selectedRow(screen) !== undefined, `the selected row stays on screen after ↑ ${step + 1}`);
	}
	match(selectedRow(screen) ?? "", /t1 {3}Reproduce/u);
	match(screen[0] ?? "", /Divide rounding/u, "returning to the first task shows the board title");
});

test("Tab moves the selection to the next section and the window follows (BT-015)", () => {
	const board = mount();
	let screen = board.press(TAB);
	match(selectedRow(screen) ?? "", /lib\/math\.js/u, "Tab jumps from the agent board to the artifacts");
	screen = board.press(TAB);
	match(selectedRow(screen) ?? "", /u1 {3}Review/u, "Tab again reaches the operator tasks");
	match(screen.join("\n"), /Operator tasks/u);
	screen = board.press(TAB);
	match(selectedRow(screen) ?? "", /t1 {3}Reproduce/u, "Tab wraps to the first section");
	screen = board.press("\x1b[Z");
	match(selectedRow(screen) ?? "", /u1 {3}Review/u, "Shift+Tab goes back a section");
});

test("a board that fits renders whole, with no position row and no page hint (BT-015)", () => {
	const small: TaskBoardSnapshot = { ...BOARD, tasks: BOARD.tasks.slice(3) };
	const board = mount(small, USER_TASKS.slice(1));
	const screen = board.render();
	doesNotMatch(screen.join("\n"), /of \d+ rows/u);
	match(screen.join("\n"), /Operator tasks/u);
	doesNotMatch(board.frame.dockHint(200) ?? "", /PgUp/u);
	const large = mount();
	large.render();
	match(large.frame.dockHint(200) ?? "", /\[PgUp\/PgDn\] page/u);
});
