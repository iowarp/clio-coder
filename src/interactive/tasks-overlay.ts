import { isAbsolute, relative, resolve } from "node:path";
import type { SessionArtifact } from "../domains/session/session-artifacts.js";
import type { SessionTaskHistoryBoard, TaskBoardSnapshot, TaskBoardTask } from "../domains/session/task-board.js";
import {
	observedTaskChecks,
	taskBoardCounts,
	taskCompletionStanding,
	unverifiedTaskChecks,
} from "../domains/session/task-board.js";
import type { UserTask } from "../domains/user-tasks/store.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { stampLocal } from "./format-time.js";
import type { RowBudgetedBody } from "./overlay-frame.js";
import { buildHint, fitRow, selectionLabel, selectionMark, showClioOverlayFrame } from "./overlay-frame.js";
import type { ClioToken } from "./theme/index.js";
import { clioTheme, fitUnits, GLYPH } from "./theme/index.js";

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
	pending: { glyph: GLYPH.queued, token: "annotation", label: "pending" },
	active: { glyph: GLYPH.running, token: "activity", label: "active" },
	completed: { glyph: GLYPH.ok, token: "success", label: "done" },
	blocked: { glyph: GLYPH.phaseBlocked, token: "warning", label: "blocked" },
	cancelled: { glyph: GLYPH.cancelled, token: "annotation", label: "dropped" },
};

function dim(text: string): string {
	return clioTheme().fg("annotation", text);
}

function muted(text: string): string {
	return clioTheme().fg("menuOption", text);
}

/** Only an operator's task says whose it is; on the agent's own board every other row would repeat `agent`. */
function taskOriginLabel(task: TaskBoardTask): string | null {
	return task.origin === "user" ? `operator ${task.userTaskId ?? "unlinked"}` : null;
}

/**
 * Current work first, then what stands in its way and what is next, then what
 * settled, with a claim the record does not back above one it does. Ids keep the
 * plan's order, so a row can still be placed in it.
 */
function taskReadingRank(task: TaskBoardTask): number {
	if (task.status === "active") return 0;
	if (task.status === "blocked") return 1;
	if (task.status === "pending") return 2;
	if (task.status === "cancelled") return 6;
	const standing = taskCompletionStanding(task);
	return standing === "unverified" ? 3 : standing === "claim only" ? 4 : 5;
}

function tasksInReadingOrder(tasks: ReadonlyArray<TaskBoardTask>): TaskBoardTask[] {
	return tasks
		.map((task, index) => ({ task, index }))
		.sort((left, right) => taskReadingRank(left.task) - taskReadingRank(right.task) || left.index - right.index)
		.map(({ task }) => task);
}

/** A done task's standing in the words a person reads: whether a check Clio saw backs it, not the record's term. */
const STANDING_WORDS: Readonly<Record<ReturnType<typeof taskCompletionStanding> & string, string>> = {
	checked: "checked",
	"claim only": "not checked",
	unverified: "unverified",
};

/** The words after a task's title: its state, what the record says of a done one, and whose it is. */
function taskStateClause(task: TaskBoardTask): string {
	const standing = taskCompletionStanding(task);
	const contradicted = standing === "unverified" && observedTaskChecks(task).failed.length > 0;
	return [
		standing === "unverified" ? "claimed done" : STATUS_PRESENTATION[task.status].label,
		contradicted ? "check failed" : standing === null ? null : STANDING_WORDS[standing],
		taskOriginLabel(task),
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
}

/**
 * The status word renders beside the glyph so state never rests on shape or
 * color alone (NO_COLOR, screen readers). A done task only keeps the success
 * ink when a check backs it: a note alone is quiet, and an unverified one warns.
 */
function taskPresentation(task: TaskBoardTask): { glyph: string; token: ClioToken; label: string } {
	const base = STATUS_PRESENTATION[task.status];
	const standing = taskCompletionStanding(task);
	if (standing === "unverified") return { ...base, glyph: GLYPH.warn, token: "warning" };
	if (standing === "claim only") return { ...base, token: "annotation" };
	return base;
}

/** A row a tight width cuts in its title, so the state beside the title stays readable. */
const TASK_TITLE_FLOOR = 12;

function taskRow(task: TaskBoardTask, width: number, selected?: boolean): string {
	const theme = clioTheme();
	const presentation = taskPresentation(task);
	const glyph = theme.fg(presentation.token, presentation.glyph);
	const cursor = selected === undefined ? "" : `${selectionMark(selected)} `;
	const lead = `${cursor}${glyph} ${dim(task.id.padEnd(4))} `;
	const clause = ` · ${taskStateClause(task)}`;
	const room = Math.max(TASK_TITLE_FLOOR, width - visibleWidth(lead) - visibleWidth(clause));
	const shown = truncateToWidth(task.title, room, GLYPH.ellipsis, false);
	const title = selected
		? selectionLabel(true, shown)
		: task.status === "completed" || task.status === "cancelled"
			? dim(shown)
			: muted(shown);
	return fitRow(`${lead}${title}${dim(clause)}`, width);
}

function wrapTaskProse(prefix: string, prose: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const proseWidth = Math.max(1, width - prefixWidth);
	return wrapTextWithAnsi(prose, proseWidth).map((line, index) =>
		fitRow(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`, width),
	);
}

/** What a tool recorded, before what the agent said: an outcome and when Clio saw it. */
function observedCheckRows(task: TaskBoardTask, width: number): string[] {
	const theme = clioTheme();
	const { passed, failed } = observedTaskChecks(task);
	const facts = [
		...failed.map((check) => theme.fg("warning", `${check.name} failed at ${stampLocal(check.observedAt)}`)),
		...passed.map((check) => theme.fg("success", `${check.name} passed at ${stampLocal(check.observedAt)}`)),
	];
	return facts.flatMap((fact) => wrapTaskProse(`       ${dim("check")} `, fact, width));
}

function taskReceiptRows(task: TaskBoardTask, width: number): string[] {
	const theme = clioTheme();
	if (task.status === "completed") {
		const rows = observedCheckRows(task, width);
		const unverified = unverifiedTaskChecks(task);
		// A failed check already reads on its own observed row with its time.
		if (unverified && unverified.noRecordedPass.length > 0) {
			const owed = unverified.noRecordedPass.map((check) => `${check} has no recorded pass`).join("; ");
			rows.push(...wrapTaskProse(`       ${theme.fg("warning", "unverified")} `, theme.fg("warning", owed), width));
		}
		if (!unverified && rows.length === 0)
			rows.push(...wrapTaskProse(`       ${dim("check")} `, dim("none on record"), width));
		// The completion claim already carries any run id it mentions, so no derived
		// `evidence:<runId>` suffix is appended; it would repeat that id on one line.
		if (task.evidence) rows.push(...wrapTaskProse(`       ${dim("agent said")} `, muted(task.evidence), width));
		return rows;
	}
	if (task.status === "blocked" && task.reason) {
		return [
			...wrapTaskProse(`       ${dim("blocked")} `, theme.fg("warning", task.reason), width),
			...observedCheckRows(task, width),
		];
	}
	if (task.status === "cancelled" && task.reason) {
		return wrapTaskProse(`       ${dim("dropped")} `, muted(task.reason), width);
	}
	return [];
}

/** An operator's call on a linked task that the agent's row has not caught up with: done or dropped while the row is still open. */
function operatorOverride(task: TaskBoardTask, userTasks: ReadonlyArray<UserTask>): UserTask | null {
	if (task.status !== "active" && task.status !== "pending" && task.status !== "blocked") return null;
	const linked = userTasks.find((item) => item.id === task.userTaskId);
	return linked?.status === "done" || linked?.status === "dropped" ? linked : null;
}

function overrideRows(task: TaskBoardTask, userTasks: ReadonlyArray<UserTask>, width: number): string[] {
	const override = operatorOverride(task, userTasks);
	if (override === null) return [];
	const words = `you marked ${override.id} ${override.status === "done" ? "done" : "dropped"}; this row is the agent's and stays open until it acts`;
	return wrapTaskProse(`       ${clioTheme().fg("warning", "overridden")} `, clioTheme().fg("warning", words), width);
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
	userTasks: ReadonlyArray<UserTask> = [],
): TasksOverlayLayout {
	const theme = clioTheme();
	const width = Math.max(1, Math.floor(contentWidth));
	if (!board || board.tasks.length === 0) {
		// The empty state is one statement with its remedy on one row, so an empty board never sits above real content.
		return {
			lines: [collapsedSection("Agent board", "none yet, the model lists its steps here before multi-step work", width)],
			spans: [],
		};
	}
	const counts = taskBoardCounts(board);
	const standingCount = (standing: ReturnType<typeof taskCompletionStanding>): number =>
		board.tasks.filter((task) => taskCompletionStanding(task) === standing).length;
	const unverifiedCount = standingCount("unverified");
	const checkedCount = standingCount("checked");
	const claimCount = standingCount("claim only");
	const chips = [
		theme.fg(
			counts.open > 0 || unverifiedCount > 0 ? "menuDescription" : "success",
			`${counts.completed}/${counts.total} done`,
		),
		unverifiedCount > 0 ? theme.fg("warning", `${unverifiedCount} unverified`) : null,
		counts.active > 0 ? theme.fg("activity", `${counts.active} active`) : null,
		counts.blocked > 0 ? theme.fg("warning", `${counts.blocked} blocked`) : null,
		counts.cancelled > 0 ? dim(`${counts.cancelled} dropped`) : null,
		checkedCount > 0 ? theme.fg("success", `${checkedCount} checked`) : null,
		claimCount > 0 ? dim(`${claimCount} ${STANDING_WORDS["claim only"]}`) : null,
	].filter((chip): chip is string => chip !== null);
	// A tight width gives the counts their own rows, because a cut would hide the blocked one.
	const summary = `${theme.fg("sectionHeading", board.title)}${dim(" · ")}${chips.join(dim(" · "))}`;
	const lines: string[] = [
		sectionHeading("Agent board", width),
		...(visibleWidth(summary) + SECTION_GUTTER.length <= width
			? [fitRow(`${SECTION_GUTTER}${summary}`, width)]
			: wrapTextWithAnsi(
					`${theme.fg("sectionHeading", board.title)}\n${chips.join(dim(" · "))}`,
					width - SECTION_GUTTER.length,
				).map((line) => fitRow(`${SECTION_GUTTER}${line}`, width))),
	];
	// The in-flight run ids render once, right under the title: full ids
	// in muted, fitted so overflow drops whole ids behind a dim ellipsis.
	const activeRuns = board.activeRunIds.map((runId) => runId.trim()).filter((runId) => runId.length > 0);
	if (activeRuns.length > 0) {
		lines.push(fitUnits(theme, `${dim("in flight")} `, activeRuns.map(muted), width));
	}
	const spans: TasksRowSpan[] = [];
	for (const task of tasksInReadingOrder(board.tasks)) {
		const line = lines.length;
		lines.push(taskRow(task, width, selectedTaskId === undefined ? undefined : selectedTaskId === task.id));
		lines.push(...overrideRows(task, userTasks, width), ...taskReceiptRows(task, width));
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
		...tasksInReadingOrder(state.board?.tasks ?? []).map((task) => ({
			kind: "current" as const,
			boardId: state.board?.boardId ?? "",
			task,
		})),
		// Current work first, the agent's and then the operator's own, then what earlier boards and runs left.
		...state.userTasks.map((task) => ({ kind: "user" as const, task })),
		...terminalHistoryRows(state.board, state.history).map(({ board, task }) => ({
			kind: "history" as const,
			board,
			task,
		})),
		...state.artifacts.map((artifact) => ({ kind: "artifact" as const, artifact })),
	];
}

/**
 * A section is a bold heading, its rows under a two-cell gutter that matches
 * the selection mark, and a blank row before the next heading. An empty section
 * says so in its own row rather than vanishing, so the operator sees what the
 * surface covers before anything is in it.
 */
const SECTION_GUTTER = "  ";

function sectionHeading(label: string, width: number): string {
	return fitRow(clioTheme().style("menuDescription", label, { bold: true }), width);
}

/** A section with nothing in it: its name and what would fill it, on one row. */
function collapsedSection(label: string, note: string, width: number): string {
	return fitRow(`${clioTheme().style("menuDescription", label, { bold: true })}${dim(` · ${note}`)}`, width);
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
	open: { glyph: GLYPH.queued, token: "menuDescription" },
	handed: { glyph: GLYPH.running, token: "activity" },
	picked: { glyph: GLYPH.running, token: "activity" },
	done: { glyph: GLYPH.ok, token: "success" },
	dropped: { glyph: GLYPH.cancelled, token: "annotation" },
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
	const current = formatTasksOverlayBodyLines(state.board, width, currentSelected, state.userTasks);
	const boardEmpty = current.spans.length === 0;
	const lines = boardEmpty ? [] : [...current.lines];
	const spans = [...current.spans];
	// Sections with content read first, in their usual order; the empty ones gather on single rows beneath them.
	const empties = boardEmpty ? [...current.lines] : [];
	let heading = 0;
	const openSection = (label: string): void => {
		if (lines.length > 0) lines.push("");
		heading = lines.length;
		lines.push(sectionHeading(label, width));
	};
	const pushRow = (rowLines: ReadonlyArray<string>): void => {
		const line = lines.length;
		const opensSection = line === heading + 1;
		lines.push(...rowLines);
		spans.push({ line, start: opensSection ? heading : line, end: lines.length });
	};

	if (state.userTasks.length === 0)
		empties.push(collapsedSection("Operator tasks", "none in this project, [a] adds one", width));
	else openSection("Operator tasks");
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

	const historyRows = terminalHistoryRows(state.board, state.history);
	if (historyRows.length === 0) empties.push(collapsedSection("Task history", "nothing from earlier boards", width));
	else openSection("Task history");
	// Each earlier board's tasks sit under that board's title once, rather than repeating it on every row.
	let lastBoard: SessionTaskHistoryBoard | null = null;
	for (const row of historyRows) {
		const rowSelection: TasksOverlaySelection = { kind: "history", board: row.board, task: row.task };
		const presentation = taskPresentation(row.task);
		const boardTitle =
			row.board === lastBoard ? [] : [fitRow(`${SECTION_GUTTER}${theme.fg("menuDescription", row.board.title)}`, width)];
		lastBoard = row.board;
		pushRow([
			...boardTitle,
			fitRow(
				`${selectionMark(isSameSelection(selected, rowSelection))} ${theme.fg(presentation.token, presentation.glyph)} ${dim(row.task.id.padEnd(4))} ${muted(row.task.title)} ${dim(`· ${taskStateClause(row.task)}`)}`,
				width,
			),
			...taskReceiptRows(row.task, width),
		]);
	}

	if (state.artifacts.length === 0) empties.push(collapsedSection("Artifacts", "no workspace outputs recorded", width));
	else openSection("Artifacts");
	const workspace = state.workspace ?? process.cwd();
	for (const artifact of state.artifacts) {
		const rowSelection: TasksOverlaySelection = { kind: "artifact", artifact };
		const kind = artifact.artifactKind ? `:${artifact.artifactKind}` : "";
		pushRow([
			fitRow(
				`${selectionMark(isSameSelection(selected, rowSelection))} ${theme.fg("menuDescription", GLYPH.toolHeader)} ${muted(displayArtifactPath(artifact.path, workspace))} ${dim(`· ${artifact.tool}${kind} · ${stampLocal(artifact.timestamp)}`)}`,
				width,
			),
		]);
	}

	if (empties.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...empties);
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

/** An operator task title typed and stepped out of with Esc, offered again by the next `a`. */
let keptTaskTitle = "";

/** A row the window ends inside of, closed with the ellipsis so the cut never reads as the end of a sentence. */
function cutRow(line: string, width: number): string {
	const kept = truncateToWidth(line, Math.max(1, width - 2), "", false).trimEnd();
	return `${kept} ${dim(GLYPH.ellipsis)}`;
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
			pinned.push("", fitRow(clioTheme().fg("sectionHeading", "New operator task"), safeWidth));
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
		// The position counts tasks, which a reader can check against the board, not the wrapped lines they fill.
		const shown = layout.spans.flatMap((taskSpan, index) =>
			taskSpan.line < end && taskSpan.end > this.offset ? [index + 1] : [],
		);
		const first = shown[0];
		const last = shown.at(-1);
		const range = first === undefined || last === undefined ? null : first === last ? `${first}` : `${first}–${last}`;
		const position = dim(
			range === null
				? `lines ${this.offset + 1}–${end} of ${total} · PgUp/PgDn page`
				: `tasks ${range} of ${layout.spans.length} · PgUp/PgDn page`,
		);
		const window = layout.lines.slice(this.offset, end);
		// A task the window ends inside reads as cut, not as finished mid-sentence.
		const cut = layout.spans.some((taskSpan) => taskSpan.line < end && taskSpan.end > end);
		const lastShown = window.at(-1);
		const next = layout.lines[end];
		if (cut && lastShown !== undefined && next !== undefined && next.trim().length > 0) {
			window[window.length - 1] = cutRow(lastShown, safeWidth);
		}
		return [...window, fitRow(position, safeWidth), ...pinned];
	}

	handleInput(data: string): void {
		if (this.addInput) {
			// Esc leaves the field and keeps what was typed; `a` brings it back, even after the board closes.
			if (matchesKey(data, "esc")) {
				keptTaskTitle = this.addInput.getValue().trim().length > 0 ? this.addInput.getValue() : "";
				this.addInput = null;
				this.status = keptTaskTitle ? "Draft kept · a reopens it" : "";
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
		if (this.addInput) return buildHint([{ key: "Enter", verb: "add" }], "back, keeps draft");
		// Only the keys the selected row answers: Enter opens an artifact, and h, d and x act on operator tasks.
		const selected = selectableRows(this.state())[this.selectedIndex];
		return buildHint([
			{ key: "↑↓", verb: "select" },
			...(this.windowRows > 0 ? [{ key: "PgUp/PgDn", verb: "page" }] : []),
			{ key: "Tab", verb: "section" },
			...(selected?.kind === "artifact" && this.options.onOpenArtifact ? [{ key: "Enter", verb: "view" }] : []),
			{ key: "a", verb: keptTaskTitle ? "resume draft" : "add" },
			...(selected?.kind === "user" && selected.task.status === "open" ? [{ key: "h", verb: "hand" }] : []),
			...(selected?.kind === "user" && selected.task.status !== "done" && selected.task.status !== "dropped"
				? [
						{ key: "d", verb: "done" },
						{ key: "x", verb: "drop" },
					]
				: []),
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
		input.setValue(keptTaskTitle);
		input.handleInput("\x1b[F");
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
				keptTaskTitle = "";
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
			const linked = status === "handed" ? undefined : this.readBoard()?.tasks.find((task) => task.userTaskId === id);
			const stillOpen = linked !== undefined && operatorOverride(linked, this.userTasks) !== null;
			this.status = `Operator task ${id} ${status}.${stillOpen ? ` ${linked.id} stays open on the agent's board, so steer the turn if it should stop.` : ""}`;
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
