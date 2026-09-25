import { isAbsolute, relative, resolve } from "node:path";
import type { SessionArtifact } from "../domains/session/session-artifacts.js";
import {
	type SessionTaskHistoryBoard,
	type TaskBoardSnapshot,
	type TaskBoardTask,
	taskBoardCounts,
	unverifiedTaskChecks,
} from "../domains/session/task-board.js";
import type { UserTask } from "../domains/user-tasks/store.js";
import {
	type Component,
	Input,
	matchesKey,
	type OverlayHandle,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import type { RowBudgetedBody } from "./overlay-frame.js";
import { buildHint, fitRow, selectionLabel, selectionMark, showClioOverlayFrame } from "./overlay-frame.js";
import { type ClioToken, clioTheme, fitUnits, GLYPH, rule } from "./theme/index.js";

/**
 * The `/tasks` overlay: one reopenable board for current agent work, prior
 * terminal work, workspace artifacts, and project-scoped operator tasks.
 * Expensive session/disk folds are captured once on open and only refreshed
 * explicitly; the one-second repaint reads only the cheap current-board getter.
 */

const DEFAULT_CONTENT_WIDTH = 84;
const REFRESH_MS = 1000;

export const TASKS_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

const STATUS_PRESENTATION: Record<TaskBoardTask["status"], { glyph: string; token: ClioToken; label: string }> = {
	pending: { glyph: GLYPH.queued, token: "dim", label: "pending" },
	active: { glyph: GLYPH.running, token: "accent", label: "active" },
	completed: { glyph: GLYPH.ok, token: "success", label: "done" },
	blocked: { glyph: GLYPH.phaseBlocked, token: "warning", label: "blocked" },
	cancelled: { glyph: GLYPH.cancelled, token: "dim", label: "dropped" },
};

function dim(text: string): string {
	return clioTheme().fg("dim", text);
}

function muted(text: string): string {
	return clioTheme().fg("muted", text);
}

function firstUsefulToken(values: ReadonlyArray<string>): string | null {
	for (const value of values) {
		const token = value.trim();
		if (token.length > 0) return token;
	}
	return null;
}

function taskLedgerProofRef(board: TaskBoardSnapshot): string {
	const runToken = firstUsefulToken(board.activeRunIds);
	if (runToken) return `task-ledger:${runToken}`;
	const activeTask = board.tasks.find((task) => task.status === "active" && task.id.trim().length > 0);
	if (activeTask) return `task-ledger:${activeTask.id.trim()}`;
	const taskToken = firstUsefulToken(board.tasks.map((task) => task.id));
	return taskToken ? `task-ledger:${taskToken}` : "task-ledger";
}

function taskOriginLabel(task: TaskBoardTask): string {
	if (task.origin === "user") return `operator ${task.userTaskId ?? "unlinked"}`;
	return "agent";
}

// The one audit anchor for the board: `proof task-ledger:<token>`. The per-run
// `dispatch:`/`evidence:` derivations were pure string echoes of the run id, so
// the in-flight run ids render once, in their own header line, instead.
function formatTaskProofLine(board: TaskBoardSnapshot, width: number): string {
	return fitRow(`${dim("proof")} ${muted(taskLedgerProofRef(board))}`, width);
}

function taskRow(task: TaskBoardTask, width: number, selected?: boolean): string {
	const theme = clioTheme();
	const unverified = unverifiedTaskChecks(task);
	const presentation = unverified
		? { glyph: GLYPH.phaseBlocked, token: "warning" as const }
		: STATUS_PRESENTATION[task.status];
	const glyph = theme.fg(presentation.token, presentation.glyph);
	const title = selected
		? selectionLabel(true, task.title)
		: task.status === "completed" || task.status === "cancelled"
			? dim(task.title)
			: muted(task.title);
	const cursor = selected === undefined ? "" : `${selectionMark(selected)} `;
	return fitRow(
		`${cursor}${glyph} ${dim(task.id.padEnd(4))} ${title} ${dim(`· ${taskOriginLabel(task)}${unverified ? " · unverified" : ""}`)}`,
		width,
	);
}

function wrapTaskProse(prefix: string, prose: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const proseWidth = Math.max(1, width - prefixWidth);
	return wrapTextWithAnsi(prose, proseWidth).map((line, index) =>
		fitRow(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`, width),
	);
}

function taskReceiptRows(task: TaskBoardTask, width: number): string[] {
	const theme = clioTheme();
	if (task.status === "completed") {
		const rows: string[] = [];
		// The completion claim already carries any run id it mentions, so no derived
		// `evidence:<runId>` suffix is appended; it would repeat that id on one line.
		if (task.evidence) rows.push(...wrapTaskProse(`       ${dim("completion claim")} `, muted(task.evidence), width));
		const unverified = unverifiedTaskChecks(task);
		if (unverified) {
			const checks = [
				...unverified.failed.map((check) => `${check} failed`),
				...unverified.noRecordedPass.map((check) => `${check} has no recorded pass`),
			];
			rows.push(
				...wrapTaskProse(`       ${theme.fg("warning", "unverified")} `, theme.fg("warning", checks.join("; ")), width),
			);
		}
		return rows;
	}
	if (task.status === "blocked" && task.reason) {
		return wrapTaskProse(`       ${dim("blocked")} `, theme.fg("warning", task.reason), width);
	}
	if (task.status === "cancelled" && task.reason) {
		return wrapTaskProse(`       ${dim("dropped")} `, muted(task.reason), width);
	}
	return [];
}

/**
 * Where one selectable row sits in the body. `line` is the row itself;
 * `[start, end)` is what has to be on screen with it: its receipt rows, the
 * section heading when the row opens a section, and the rest of the body when
 * it is the last row, so an empty section below it is still reached.
 */
interface TasksRowSpan {
	line: number;
	start: number;
	end: number;
}

interface TasksOverlayLayout {
	lines: string[];
	/** One span per `selectableRows` entry, in the same order. */
	spans: TasksRowSpan[];
}

function formatTasksOverlayBodyLines(
	board: TaskBoardSnapshot | null,
	contentWidth = DEFAULT_CONTENT_WIDTH,
	selectedTaskId?: string | null,
): TasksOverlayLayout {
	const theme = clioTheme();
	const width = Math.max(1, Math.floor(contentWidth));
	if (!board || board.tasks.length === 0) {
		// The empty state is one statement and one remedy, and the remedy is the
		// only thing on the surface that says how a board comes to exist. It used
		// to be emitted at its natural length and hard-cut by the frame, so at 80
		// and 40 columns the sentence ended at "before multi-step" and the reader
		// was left with a fragment of the only instruction here.
		return {
			lines: [
				...wrapTextWithAnsi(muted("No task board declared in this session."), width),
				"",
				...wrapTextWithAnsi(
					dim('The agent declares one with the tasks tool (action="plan") before multi-step work.'),
					width,
				),
			],
			spans: [],
		};
	}
	const counts = taskBoardCounts(board);
	const unverifiedCount = board.tasks.filter((task) => unverifiedTaskChecks(task) !== null).length;
	const chips = [
		theme.fg(counts.open > 0 || unverifiedCount > 0 ? "muted" : "success", `${counts.completed}/${counts.total} done`),
		unverifiedCount > 0 ? theme.fg("warning", `${unverifiedCount} unverified`) : null,
		counts.active > 0 ? theme.fg("accent", `${counts.active} active`) : null,
		counts.blocked > 0 ? theme.fg("warning", `${counts.blocked} blocked`) : null,
		counts.cancelled > 0 ? dim(`${counts.cancelled} dropped`) : null,
	].filter((chip): chip is string => chip !== null);
	const lines: string[] = [
		fitRow(theme.fg("accent", board.title), width),
		fitRow(chips.join(dim(" · ")), width),
		rule(theme, width),
		formatTaskProofLine(board, width),
	];
	// The in-flight run ids render once, right under the proof anchor: full ids
	// in muted, fitted so overflow drops whole ids behind a dim ellipsis.
	const activeRuns = board.activeRunIds.map((runId) => runId.trim()).filter((runId) => runId.length > 0);
	if (activeRuns.length > 0) {
		lines.push(fitUnits(theme, `${dim("in flight")} `, activeRuns.map(muted), width));
	}
	const spans: TasksRowSpan[] = [];
	for (const task of board.tasks) {
		const line = lines.length;
		lines.push(taskRow(task, width, selectedTaskId === undefined ? undefined : selectedTaskId === task.id));
		lines.push(...taskReceiptRows(task, width));
		// The first task carries the board's title, counts and proof above it.
		spans.push({ line, start: spans.length === 0 ? 0 : line, end: lines.length });
	}
	return { lines, spans };
}

type TasksOverlaySelection =
	| { kind: "current"; boardId: string; task: TaskBoardTask }
	| { kind: "history"; board: SessionTaskHistoryBoard; task: TaskBoardTask }
	| { kind: "artifact"; artifact: SessionArtifact }
	| { kind: "user"; task: UserTask };

export interface CompositeTasksOverlayState {
	board: TaskBoardSnapshot | null;
	history: ReadonlyArray<SessionTaskHistoryBoard>;
	artifacts: ReadonlyArray<SessionArtifact>;
	userTasks: ReadonlyArray<UserTask>;
	selectedIndex?: number;
	workspace?: string;
}

function terminalHistoryRows(
	board: TaskBoardSnapshot | null,
	history: ReadonlyArray<SessionTaskHistoryBoard>,
): ReadonlyArray<{ board: SessionTaskHistoryBoard; task: TaskBoardTask }> {
	return history.flatMap((historyBoard) =>
		historyBoard.boardId === board?.boardId
			? []
			: historyBoard.tasks
					.filter((task) => task.status === "completed" || task.status === "blocked" || task.status === "cancelled")
					.map((task) => ({ board: historyBoard, task })),
	);
}

function selectableRows(state: CompositeTasksOverlayState): TasksOverlaySelection[] {
	return [
		...(state.board?.tasks.map((task) => ({ kind: "current" as const, boardId: state.board?.boardId ?? "", task })) ??
			[]),
		...terminalHistoryRows(state.board, state.history).map(({ board, task }) => ({
			kind: "history" as const,
			board,
			task,
		})),
		...state.artifacts.map((artifact) => ({ kind: "artifact" as const, artifact })),
		...state.userTasks.map((task) => ({ kind: "user" as const, task })),
	];
}

function sectionHeading(label: string, width: number): string {
	return fitRow(clioTheme().style("accent", label, { bold: true }), width);
}

function isSameSelection(left: TasksOverlaySelection | undefined, right: TasksOverlaySelection): boolean {
	if (!left || left.kind !== right.kind) return false;
	if (left.kind === "current" && right.kind === "current") {
		return left.boardId === right.boardId && left.task.id === right.task.id;
	}
	if (left.kind === "history" && right.kind === "history") {
		return left.board.boardId === right.board.boardId && left.task.id === right.task.id;
	}
	if (left.kind === "artifact" && right.kind === "artifact") return left.artifact.path === right.artifact.path;
	return left.kind === "user" && right.kind === "user" && left.task.id === right.task.id;
}

function displayArtifactPath(path: string, workspace: string): string {
	const root = resolve(workspace);
	const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
	const display = relative(root, target);
	return display.length > 0 ? display : ".";
}

const USER_TASK_PRESENTATION: Record<UserTask["status"], { glyph: string; token: ClioToken }> = {
	open: { glyph: GLYPH.queued, token: "muted" },
	handed: { glyph: GLYPH.running, token: "accent" },
	picked: { glyph: GLYPH.running, token: "accent" },
	done: { glyph: GLYPH.ok, token: "success" },
	dropped: { glyph: GLYPH.cancelled, token: "dim" },
};

/** Pure composite renderer; callers provide already-captured history/artifact/user snapshots. */
export function formatCompositeTasksOverlayBodyLines(
	state: CompositeTasksOverlayState,
	contentWidth = DEFAULT_CONTENT_WIDTH,
): string[] {
	return layoutCompositeTasksOverlay(state, contentWidth).lines;
}

function layoutCompositeTasksOverlay(state: CompositeTasksOverlayState, contentWidth: number): TasksOverlayLayout {
	const width = Math.max(1, Math.floor(contentWidth));
	const theme = clioTheme();
	const rows = selectableRows(state);
	const selectedIndex = Math.max(0, Math.min(state.selectedIndex ?? 0, Math.max(0, rows.length - 1)));
	const selected = rows[selectedIndex];
	const currentSelected = selected?.kind === "current" ? selected.task.id : null;
	// The frame title already says Tasks; a second heading under it was the one
	// title the overlay repeated.
	const current = formatTasksOverlayBodyLines(state.board, width, currentSelected);
	const lines = [...current.lines];
	const spans = [...current.spans];
	let heading = 0;
	const openSection = (label: string): void => {
		lines.push("");
		heading = lines.length;
		lines.push(sectionHeading(label, width));
	};
	const pushRow = (rowLines: ReadonlyArray<string>): void => {
		const line = lines.length;
		const opensSection = line === heading + 1;
		lines.push(...rowLines);
		spans.push({ line, start: opensSection ? heading : line, end: lines.length });
	};

	openSection("Task history");
	const historyRows = terminalHistoryRows(state.board, state.history);
	if (historyRows.length === 0) lines.push(fitRow(dim("No terminal tasks from prior boards."), width));
	for (const row of historyRows) {
		const rowSelection: TasksOverlaySelection = { kind: "history", board: row.board, task: row.task };
		const presentation = unverifiedTaskChecks(row.task)
			? { glyph: GLYPH.phaseBlocked, token: "warning" as const }
			: STATUS_PRESENTATION[row.task.status];
		pushRow([
			fitRow(
				`${selectionMark(isSameSelection(selected, rowSelection))} ${theme.fg(presentation.token, presentation.glyph)} ${dim(`${row.board.boardId}:${row.task.id}`)} ${muted(row.task.title)} ${dim(`· ${taskOriginLabel(row.task)} · ${row.board.title}`)}`,
				width,
			),
			...taskReceiptRows(row.task, width),
		]);
	}

	openSection("Artifacts");
	if (state.artifacts.length === 0) lines.push(fitRow(dim("No workspace outputs recorded."), width));
	const workspace = state.workspace ?? process.cwd();
	for (const artifact of state.artifacts) {
		const rowSelection: TasksOverlaySelection = { kind: "artifact", artifact };
		const kind = artifact.artifactKind ? `:${artifact.artifactKind}` : "";
		pushRow([
			fitRow(
				`${selectionMark(isSameSelection(selected, rowSelection))} ${theme.fg("muted", GLYPH.toolHeader)} ${muted(displayArtifactPath(artifact.path, workspace))} ${dim(`· ${artifact.tool}${kind} · ${artifact.timestamp}`)}`,
				width,
			),
		]);
	}

	openSection("Operator tasks");
	if (state.userTasks.length === 0) lines.push(fitRow(dim("No operator tasks in this project."), width));
	for (const task of state.userTasks) {
		const rowSelection: TasksOverlaySelection = { kind: "user", task };
		const presentation = USER_TASK_PRESENTATION[task.status];
		pushRow([
			fitRow(
				`${selectionMark(isSameSelection(selected, rowSelection))} ${theme.fg(presentation.token, presentation.glyph)} ${dim(task.id.padEnd(4))} ${muted(task.title)} ${dim(`· ${task.status}`)}`,
				width,
			),
			...(task.note ? wrapTaskProse(`       ${dim("note")} `, muted(task.note), width) : []),
		]);
	}
	const last = spans.at(-1);
	if (last) last.end = lines.length;
	return { lines, spans };
}

/**
 * The first line of a `height`-row window that shows `span`, moved from
 * `offset` as little as possible. A span taller than the window shows its head.
 */
function followTasksWindow(offset: number, span: TasksRowSpan, height: number, total: number): number {
	let next = offset;
	if (span.end - span.start > height || span.start < next) next = span.start;
	else if (span.end > next + height) next = span.end - height;
	return Math.max(0, Math.min(next, total - height));
}

/**
 * The row a page move leaves selected: the current one while its line is still
 * in the window, else the first (paging down) or last (paging up) row whose
 * line is. A page with no row on it keeps the selection where it was.
 */
function selectionAfterPage(
	spans: ReadonlyArray<TasksRowSpan>,
	selected: number,
	offset: number,
	height: number,
	direction: 1 | -1,
): number {
	const inWindow = (span: TasksRowSpan | undefined): boolean =>
		span !== undefined && span.line >= offset && span.line < offset + height;
	if (inWindow(spans[selected])) return selected;
	const visible = spans.flatMap((span, index) => (inWindow(span) ? [index] : []));
	return (direction > 0 ? visible[0] : visible.at(-1)) ?? selected;
}

/** The first row of the next or previous section that has rows, wrapping around. */
function sectionJumpIndex(rows: ReadonlyArray<TasksOverlaySelection>, selected: number, direction: 1 | -1): number {
	const kinds = [...new Set(rows.map((row) => row.kind))];
	const at = Math.max(0, kinds.indexOf(rows[selected]?.kind ?? "current"));
	const target = kinds[(at + direction + kinds.length) % kinds.length];
	const index = rows.findIndex((row) => row.kind === target);
	return index === -1 ? selected : index;
}

export interface OpenTasksOverlayOptions {
	onClose?: () => void;
	getSessionSnapshot?: () => {
		history: ReadonlyArray<SessionTaskHistoryBoard>;
		artifacts: ReadonlyArray<SessionArtifact>;
	};
	getHistory?: () => ReadonlyArray<SessionTaskHistoryBoard>;
	getArtifacts?: () => ReadonlyArray<SessionArtifact>;
	getUserTasks?: () => ReadonlyArray<UserTask>;
	onAddUserTask?: (title: string) => void;
	onHandUserTask?: (id: string) => void;
	onDoneUserTask?: (id: string) => void;
	onDropUserTask?: (id: string) => void;
	onOpenArtifact?: (path: string) => void;
	requestRender?: () => void;
	workspace?: string;
}

class TasksOverlayBody implements Component, RowBudgetedBody {
	private history: ReadonlyArray<SessionTaskHistoryBoard> = [];
	private artifacts: ReadonlyArray<SessionArtifact> = [];
	private userTasks: ReadonlyArray<UserTask> = [];
	private selectedIndex = 0;
	private addInput: Input | null = null;
	private status = "";
	/**
	 * The dock's fixed budget cut the board behind "… N more rows", so the
	 * operator tasks the footer keys act on were never reachable (BT-015). The
	 * board now windows itself: the window follows the selection, pages with
	 * PgUp/PgDn, and keeps the add field and the status pinned below it.
	 */
	private bodyRows = 0;
	private offset = 0;
	/** Rows in the window, or zero while the whole board fits. */
	private windowRows = 0;
	/** Set by a selection move; the next render, which knows the layout, scrolls to it. */
	private followSelection = false;
	private layout: TasksOverlayLayout | null = null;

	constructor(
		private readonly getBoard: () => TaskBoardSnapshot | null,
		private readonly options: OpenTasksOverlayOptions,
	) {
		this.refreshCaptured();
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const layout = layoutCompositeTasksOverlay(this.state(), safeWidth);
		this.layout = layout;
		const pinned: string[] = [];
		if (this.addInput) {
			pinned.push("", fitRow(clioTheme().fg("accent", "New operator task"), safeWidth));
			pinned.push(...this.addInput.render(safeWidth).map((line) => fitRow(line, safeWidth)));
		}
		if (this.status) pinned.push("", ...wrapTextWithAnsi(clioTheme().fg("warning", this.status), safeWidth));
		const total = layout.lines.length;
		const room = this.bodyRows - pinned.length - 1;
		const span = layout.spans[Math.min(this.selectedIndex, layout.spans.length - 1)];
		const follow = this.followSelection;
		this.followSelection = false;
		// With no known budget, or no room left for a window, the board renders
		// whole and the frame's cut still marks what is missing.
		if (this.bodyRows <= 0 || total + pinned.length <= this.bodyRows || room < 1) {
			this.windowRows = 0;
			this.offset = 0;
			return [...layout.lines, ...pinned];
		}
		this.windowRows = room;
		this.offset =
			follow && span
				? followTasksWindow(this.offset, span, room, total)
				: Math.max(0, Math.min(this.offset, total - room));
		const end = this.offset + room;
		const position = dim(`${this.offset + 1}–${end} of ${total} rows · PgUp/PgDn page`);
		return [...layout.lines.slice(this.offset, end), fitRow(position, safeWidth), ...pinned];
	}

	handleInput(data: string): void {
		if (this.addInput) {
			if (matchesKey(data, "esc")) {
				this.addInput = null;
				this.requestRender();
				return;
			}
			this.addInput.handleInput(data);
			return;
		}
		if (matchesKey(data, "esc")) {
			this.options.onClose?.();
			return;
		}
		if (matchesKey(data, "r")) {
			this.refreshCaptured();
			this.requestRender();
			return;
		}
		if (matchesKey(data, "a")) {
			this.beginAdd();
			return;
		}
		const state = this.state();
		const rows = selectableRows(state);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rows.length - 1)));
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.page(matchesKey(data, "pageDown") ? 1 : -1);
			return;
		}
		if (rows.length === 0) return;
		if (matchesKey(data, "up")) {
			this.select(this.selectedIndex - 1, rows.length);
			return;
		}
		if (matchesKey(data, "down")) {
			this.select(this.selectedIndex + 1, rows.length);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.select(sectionJumpIndex(rows, this.selectedIndex, matchesKey(data, "tab") ? 1 : -1), rows.length);
			return;
		}
		const selected = rows[this.selectedIndex];
		if (selected?.kind === "artifact" && this.options.onOpenArtifact && (matchesKey(data, "enter") || data === "\n")) {
			this.options.onClose?.();
			this.options.onOpenArtifact(selected.artifact.path);
			return;
		}
		if (selected?.kind !== "user") return;
		if (matchesKey(data, "h")) this.mutateUserTask("handed", selected.task.id, this.options.onHandUserTask);
		else if (matchesKey(data, "d")) this.mutateUserTask("done", selected.task.id, this.options.onDoneUserTask);
		else if (matchesKey(data, "x")) this.mutateUserTask("dropped", selected.task.id, this.options.onDropUserTask);
	}

	invalidate(): void {
		this.addInput?.invalidate();
	}

	footerHint(): string {
		return this.addInput
			? buildHint([{ key: "Enter", verb: "add" }], "back")
			: buildHint([
					{ key: "↑↓", verb: "select" },
					...(this.windowRows > 0 ? [{ key: "PgUp/PgDn", verb: "page" }] : []),
					{ key: "Tab", verb: "section" },
					{ key: "Enter", verb: "view" },
					{ key: "a", verb: "add" },
					{ key: "h", verb: "hand" },
					{ key: "d", verb: "done" },
					{ key: "x", verb: "drop" },
					{ key: "r", verb: "refresh" },
				]);
	}

	private state(): CompositeTasksOverlayState {
		return {
			board: this.readBoard(),
			history: this.history,
			artifacts: this.artifacts,
			userTasks: this.userTasks,
			selectedIndex: this.selectedIndex,
			...(this.options.workspace ? { workspace: this.options.workspace } : {}),
		};
	}

	/** Move the selection; the next render brings its row, with what belongs to it, into the window. */
	private select(index: number, rowCount: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, rowCount - 1));
		this.followSelection = true;
		this.requestRender();
	}

	private page(direction: 1 | -1): void {
		if (!this.layout || this.windowRows <= 0) return;
		const step = Math.max(1, this.windowRows - 1);
		this.offset = Math.max(0, Math.min(this.offset + direction * step, this.layout.lines.length - this.windowRows));
		this.selectedIndex = selectionAfterPage(
			this.layout.spans,
			this.selectedIndex,
			this.offset,
			this.windowRows,
			direction,
		);
		this.requestRender();
	}

	private readBoard(): TaskBoardSnapshot | null {
		try {
			return this.getBoard();
		} catch (error) {
			this.status = error instanceof Error ? error.message : String(error);
			return null;
		}
	}

	private refreshCaptured(): void {
		const errors: string[] = [];
		try {
			const snapshot = this.options.getSessionSnapshot?.();
			if (snapshot) {
				this.history = snapshot.history;
				this.artifacts = snapshot.artifacts;
			} else {
				this.history = this.options.getHistory?.() ?? [];
				this.artifacts = this.options.getArtifacts?.() ?? [];
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		try {
			this.userTasks = this.options.getUserTasks?.() ?? [];
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		this.status = errors.join("; ");
	}

	private refreshUserTasks(): void {
		if (this.options.getUserTasks) this.userTasks = this.options.getUserTasks();
	}

	private beginAdd(): void {
		if (!this.options.onAddUserTask) {
			this.status = "Operator task actions are unavailable.";
			this.requestRender();
			return;
		}
		const input = new Input();
		input.onSubmit = (value) => {
			const title = value.trim();
			if (title.length === 0) {
				this.status = "Enter a task title.";
				this.requestRender();
				return;
			}
			try {
				this.options.onAddUserTask?.(title);
				this.refreshUserTasks();
				this.addInput = null;
				this.status = "Operator task added.";
			} catch (error) {
				this.status = error instanceof Error ? error.message : String(error);
			}
			this.requestRender();
		};
		this.addInput = input;
		this.status = "";
		this.requestRender();
	}

	private mutateUserTask(
		status: "handed" | "done" | "dropped",
		id: string,
		mutation: ((id: string) => void) | undefined,
	): void {
		if (!mutation) {
			this.status = "Operator task actions are unavailable.";
			this.requestRender();
			return;
		}
		try {
			mutation(id);
			this.refreshUserTasks();
			this.status = `Operator task ${id} ${status}.`;
		} catch (error) {
			this.status = error instanceof Error ? error.message : String(error);
		}
		this.requestRender();
	}

	private requestRender(): void {
		this.options.requestRender?.();
	}
}

/** Mount the `/tasks` overlay backed by the live task-board snapshot. */
export function openTasksOverlay(
	tui: TUI,
	getBoard: () => TaskBoardSnapshot | null,
	options: OpenTasksOverlayOptions = {},
): OverlayHandle {
	const body = new TasksOverlayBody(getBoard, options);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: TASKS_OVERLAY_WIDTH,
		markerId: "tasks",
		title: () => "Tasks",
		footerHint: () => body.footerHint(),
	});
	// The board mutates mid-turn as the agent works; a coarse ticker keeps the
	// open overlay live without wiring a dedicated event channel.
	const timer = setInterval(() => tui.requestRender(), REFRESH_MS);
	timer.unref?.();
	return {
		...handle,
		hide(): void {
			clearInterval(timer);
			handle.hide();
		},
	};
}
