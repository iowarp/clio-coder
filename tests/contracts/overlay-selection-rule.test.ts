import { ok } from "node:assert/strict";
import { test } from "node:test";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import {
	type Component,
	type OverlayOptions,
	stripTerminalSequences,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import { openDecisionsOverlay } from "../../src/interactive/overlays/decisions.js";
import { TreeOverlayView } from "../../src/interactive/overlays/tree-selector.js";
import { formatCompositeTasksOverlayBodyLines } from "../../src/interactive/tasks-overlay.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const WIDTHS = [60, 80, 120, 200] as const;

/**
 * The selection rule: the focused row carries the cursor in accent and its
 * label in accent bold, and no other row carries either. Decisions, tasks and
 * the tree marked the row but left the label plain, so the eye had to find
 * the glyph; the help, model and view lists already highlighted the label.
 */
function assertSelectionRule(lines: ReadonlyArray<string>, width: number, focusedLabel: string, otherLabel: string) {
	const styled = (label: string) => clioTheme().style("accent", label, { bold: true });
	for (const line of lines) ok(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
	const plain = lines.map(stripTerminalSequences);
	const focusedIndex = plain.findIndex((row) => row.includes(focusedLabel));
	const otherIndex = plain.findIndex((row) => row.includes(otherLabel));
	ok(focusedIndex >= 0 && otherIndex >= 0, `${width}: both rows render`);
	ok(plain[focusedIndex]?.includes(GLYPH.cursor), `${width}: focused row carries the cursor`);
	ok(!plain[otherIndex]?.includes(GLYPH.cursor), `${width}: only the focused row carries the cursor`);
	ok(lines[focusedIndex]?.includes(styled(focusedLabel)), `${width}: focused label is accent bold`);
	ok(!lines[otherIndex]?.includes(styled(otherLabel)), `${width}: unfocused label stays plain`);
}

test("decisions follow the selection rule", () => {
	let component: Component | undefined;
	const tui = {
		terminal: { rows: 30, columns: 120 },
		requestRender: () => {},
		showOverlay: (child: Component, _options: OverlayOptions) => {
			component = child;
			return { hide: () => {} };
		},
	} as unknown as TUI;
	const entry: DecisionLedgerEntry = {
		kind: "decisionLedger",
		id: "e1",
		turnId: "t1",
		parentTurnId: null,
		timestamp: "2026-09-25T00:00:00Z",
		interviewId: "i1",
		interviewStatus: "complete",
		startedAt: "2026-09-25T00:00:00Z",
		endedAt: "2026-09-25T00:01:00Z",
		roundCount: 1,
		decisions: [
			{ key: "runtime", value: "node", label: "Runtime choice", status: "active", decidedAt: "2026-09-25T00:00:00Z" },
			{ key: "db", value: "sqlite", label: "Database pick", status: "active", decidedAt: "2026-09-25T00:00:00Z" },
		],
	} as DecisionLedgerEntry;
	openDecisionsOverlay(tui, () => [entry], { onSupersede: () => {}, onCorrection: () => {}, onClose: () => {} });
	ok(component);
	for (const width of WIDTHS) assertSelectionRule(component.render(width), width, "Runtime choice", "Database pick");
});

test("the task board follows the selection rule", () => {
	const board: TaskBoardSnapshot = {
		boardId: "b1",
		title: "Board",
		activeRunIds: [],
		tasks: [
			{ id: "t1", title: "First task title", status: "active" },
			{ id: "t2", title: "Second task title", status: "pending" },
		],
	} as TaskBoardSnapshot;
	for (const width of WIDTHS) {
		const lines = formatCompositeTasksOverlayBodyLines(
			{ board, history: [], artifacts: [], userTasks: [], selectedIndex: 0 },
			width,
		);
		assertSelectionRule(lines, width, "First task title", "Second task title");
	}
});

test("the session tree follows the selection rule", () => {
	const snapshot: TreeSnapshot = {
		sessionId: "session",
		meta: { id: "session", cwd: "/w", createdAt: "2026-09-01T00:00:00Z", endedAt: null, model: null, target: null },
		leafId: "newest",
		rootIds: ["oldest"],
		nodesById: {
			oldest: {
				id: "oldest",
				parentId: null,
				at: "2026-09-01T00:00:00Z",
				kind: "user",
				children: ["newest"],
				preview: "alpha preview",
			},
			newest: {
				id: "newest",
				parentId: "oldest",
				at: "2026-09-03T00:00:00Z",
				kind: "assistant",
				children: [],
				preview: "omega preview",
			},
		},
	} as TreeSnapshot;
	const view = new TreeOverlayView(
		{ cwd: "/w", session: { tree: () => snapshot, editLabel: () => {} }, onSwitchTurn: () => {}, onClose: () => {} },
		snapshot,
	);
	for (const width of WIDTHS) {
		const lines = view.render(width);
		const plain = lines.map(stripTerminalSequences);
		const focused = plain.find((row) => row.includes(GLYPH.cursor)) ?? "";
		const [focusedLabel, otherLabel] = focused.includes("alpha")
			? ["alpha preview", "omega preview"]
			: ["omega preview", "alpha preview"];
		assertSelectionRule(lines, width, focusedLabel, otherLabel);
	}
});
