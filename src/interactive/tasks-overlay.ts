import { type TaskBoardSnapshot, type TaskBoardTask, taskBoardCounts } from "../domains/session/task-board.js";
import { type Component, matchesKey, type OverlayHandle, type TUI, truncateToWidth } from "../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { type ClioToken, clioTheme, GLYPH, rule } from "./theme/index.js";

/**
 * The `/tasks` overlay: a read-only view of the session task board the agent
 * maintains through the tasks tool. Rows carry the recorded receipts — the
 * evidence note on a completed task, the reason on a blocked or dropped one —
 * so the operator can audit the board without scrolling the transcript.
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

function fitContentLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "", true);
}

function taskRow(task: TaskBoardTask, width: number): string {
	const theme = clioTheme();
	const presentation = STATUS_PRESENTATION[task.status];
	const glyph = theme.fg(presentation.token, presentation.glyph);
	const title = task.status === "completed" || task.status === "cancelled" ? dim(task.title) : muted(task.title);
	return fitContentLine(`${glyph} ${dim(task.id.padEnd(4))} ${title}`, width);
}

function taskReceiptRow(task: TaskBoardTask, width: number): string | null {
	const theme = clioTheme();
	if (task.status === "completed" && task.evidence) {
		return fitContentLine(`       ${dim("evidence")} ${muted(task.evidence)}`, width);
	}
	if (task.status === "blocked" && task.reason) {
		return fitContentLine(`       ${dim("blocked")} ${theme.fg("warning", task.reason)}`, width);
	}
	if (task.status === "cancelled" && task.reason) {
		return fitContentLine(`       ${dim("dropped")} ${muted(task.reason)}`, width);
	}
	return null;
}

export function formatTasksOverlayBodyLines(
	board: TaskBoardSnapshot | null,
	contentWidth = DEFAULT_CONTENT_WIDTH,
): string[] {
	const theme = clioTheme();
	const width = Math.max(1, Math.floor(contentWidth));
	if (!board || board.tasks.length === 0) {
		return [
			muted("No task board declared in this session."),
			"",
			dim('The agent declares one with the tasks tool (action="plan") before multi-step work.'),
		];
	}
	const counts = taskBoardCounts(board);
	const chips = [
		theme.fg(counts.open > 0 ? "muted" : "success", `${counts.completed}/${counts.total} done`),
		counts.active > 0 ? theme.fg("accent", `${counts.active} active`) : null,
		counts.blocked > 0 ? theme.fg("warning", `${counts.blocked} blocked`) : null,
		counts.cancelled > 0 ? dim(`${counts.cancelled} dropped`) : null,
	].filter((chip): chip is string => chip !== null);
	const lines: string[] = [
		fitContentLine(theme.fg("accent", board.title), width),
		fitContentLine(chips.join(dim(" · ")), width),
		rule(theme, width),
	];
	for (const task of board.tasks) {
		lines.push(taskRow(task, width));
		const receipt = taskReceiptRow(task, width);
		if (receipt) lines.push(receipt);
	}
	if (board.activeRunIds.length > 0) {
		lines.push("");
		const runs = board.activeRunIds.map((runId) => runId.slice(0, 10)).join(", ");
		lines.push(fitContentLine(`${dim("dispatched runs in flight")} ${muted(runs)}`, width));
	}
	return lines;
}

interface OpenTasksOverlayOptions {
	onClose?: () => void;
}

class TasksOverlayBody implements Component {
	constructor(
		private readonly getBoard: () => TaskBoardSnapshot | null,
		private readonly options: OpenTasksOverlayOptions,
	) {}

	render(width: number): string[] {
		return formatTasksOverlayBodyLines(this.getBoard(), Math.max(1, Math.floor(width)));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "esc")) this.options.onClose?.();
	}

	invalidate(): void {}
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
		title: () => "Tasks",
		footerHint: () => buildHint("browse", []),
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
