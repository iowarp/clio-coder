import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { TaskBoardSnapshot } from "../domains/session/task-board.js";
import { taskBoardCounts } from "../domains/session/task-board.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { formatTaskIslandLines } from "./dispatch-board.js";
import { taskBoardValue } from "./footer/widgets.js";
import type { QuotaProviders } from "./quota-view.js";
import { clioTheme, GLYPH } from "./theme/index.js";

export interface FleetDockDeps {
	getRows: () => ReadonlyArray<DispatchBoardRow>;
	getQuotaSnapshots?: () => QuotaProviders;
	/** Bound to TaskBoardStore.cachedSnapshot; a repaint must never fold the session ledger. */
	getTaskBoard?: () => TaskBoardSnapshot | null;
	/** The expanded footer carries the board's own rows, so the dock row steps aside. */
	isFooterExpanded?: () => boolean;
}

/**
 * The task board's dock row: its title, progress, and the task that needs the
 * operator next. It replaced a top-right overlay that painted over transcript
 * words, so it takes a row of its own above the composer instead.
 */
function taskBoardDockRow(board: TaskBoardSnapshot, width: number): string | null {
	const counts = taskBoardCounts(board);
	if (counts.open === 0 || width < 1) return null;
	const theme = clioTheme();
	const blocked = board.tasks.find((task) => task.status === "blocked");
	const next =
		board.tasks.find((task) => task.status === "active") ?? board.tasks.find((task) => task.status === "pending");
	const separator = theme.fg("annotation", " · ");
	const focus = blocked
		? `${theme.fg("warning", GLYPH.phaseBlocked)} ${theme.fg("annotation", blocked.id)} ${theme.fg("body", sanitizeCallTargetText(blocked.title))}`
		: next
			? `${theme.fg(next.status === "active" ? "activity" : "annotation", next.status === "active" ? GLYPH.running : GLYPH.queued)} ${theme.fg("annotation", next.id)} ${theme.fg("body", sanitizeCallTargetText(next.title))}`
			: null;
	const lead = [
		theme.style("sectionHeading", "Tasks", { bold: true }),
		theme.fg("body", sanitizeCallTargetText(board.title)),
		taskBoardValue(theme, board),
	].join(separator);
	const hint = theme.fg("commandHint", "/tasks");
	const room = Math.max(1, width - 2);
	const withHint = [lead, ...(focus ? [focus] : []), hint].join(separator);
	const row = visibleWidth(withHint) <= room ? withHint : [lead, ...(focus ? [focus] : [])].join(separator);
	return `  ${truncateToWidth(row, room, GLYPH.ellipsis, false)}`;
}

/** BT-007: normal-flow rows reserve space rather than covering transcript words. */
export function createFleetDock(deps: FleetDockDeps): Component {
	return {
		render(width) {
			const rows = deps.getRows().filter((row) => !isHelperRun(row));
			if (rows.length === 0) {
				if (deps.isFooterExpanded?.() === true) return [];
				const board = deps.getTaskBoard?.() ?? null;
				const row = board ? taskBoardDockRow(board, width) : null;
				return row === null ? [] : [row];
			}
			// One card keeps the composer reachable; the summary names the remaining
			// cards, all of which are inspectable in Fleet Runs.
			return formatTaskIslandLines(rows, 1, deps.getQuotaSnapshots?.() ?? [], Math.max(1, width - 4));
		},
		invalidate() {},
	};
}
