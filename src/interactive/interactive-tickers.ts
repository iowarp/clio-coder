import { type TaskBoardSnapshot, taskBoardCounts } from "../domains/session/task-board.js";
import { Text, type TUI, visibleWidth } from "../engine/tui.js";
import {
	CONTEXT_ISLAND_WIDTH,
	type ContextActivitySnapshot,
	formatContextActivityIslandLines,
} from "./context-activity.js";
import { type DispatchBoardRow, formatTaskIslandLines, TASK_ISLAND_WIDTH } from "./dispatch-board.js";
import { clioTheme, frame, GLYPH } from "./theme/index.js";

export interface InteractiveTickerHandle {
	unref?(): void;
}

export interface InteractiveDispatchStore {
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	reconcile(): void;
}

export interface InteractiveContextActivityStore {
	active(): boolean;
	current(): ContextActivitySnapshot | null;
}

export interface InteractiveTickersDeps {
	tui: Pick<TUI, "requestRender" | "showOverlay">;
	dispatchBoardStore: InteractiveDispatchStore;
	contextActivityStore: InteractiveContextActivityStore;
	getOverlayState: () => string;
	isFooterExpanded: () => boolean;
	/** Cached current-board projection only; this repaint path must never fold the session ledger. */
	getTaskBoard?: () => TaskBoardSnapshot | null;
	scheduleInterval?: (callback: () => void, intervalMs: number) => InteractiveTickerHandle;
	clearScheduledInterval?: (handle: InteractiveTickerHandle) => void;
}

export function formatTaskBoardIslandLines(board: TaskBoardSnapshot): string[] {
	const theme = clioTheme();
	const counts = taskBoardCounts(board);
	const active = board.tasks.find((task) => task.status === "active");
	const next = active ?? board.tasks.find((task) => task.status === "pending");
	const chips = [
		`${counts.completed}/${counts.total} done`,
		...(counts.active > 0 ? [`${counts.active} active`] : []),
		...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
	].join(" · ");
	const body = [theme.fg("accent", board.title), theme.fg("dim", chips)];
	if (next) {
		const glyph = active ? theme.fg("accent", GLYPH.running) : theme.fg("dim", GLYPH.queued);
		body.push(`${glyph} ${theme.fg("dim", next.id)} ${theme.fg("muted", next.title)}`);
	}
	return frame(theme, "Tasks", body, TASK_ISLAND_WIDTH + 4);
}

export interface InteractiveTickers {
	renderTaskIsland(): void;
	renderContextIsland(): void;
	startDispatchBoardTicker(): void;
	stopDispatchBoardTicker(): void;
	startContextIslandTicker(): void;
	stopContextIslandTicker(): void;
	dispose(): void;
}

export function createInteractiveTickers(deps: InteractiveTickersDeps): InteractiveTickers {
	const scheduleInterval = deps.scheduleInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
	const clearScheduledInterval =
		deps.clearScheduledInterval ??
		((handle: InteractiveTickerHandle) => clearInterval(handle as ReturnType<typeof setInterval>));
	const taskIsland = new Text("", 0, 0);
	const contextIsland = new Text("", 0, 0);
	const taskIslandWidth = formatTaskIslandLines([]).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const taskIslandHandle = deps.tui.showOverlay(taskIsland, {
		anchor: "top-right",
		width: taskIslandWidth,
		margin: { top: 1, right: 1 },
		nonCapturing: true,
		visible: (width, height) => width >= 80 && height >= 18,
	});
	taskIslandHandle.setHidden(true);
	const contextIslandHandle = deps.tui.showOverlay(contextIsland, {
		anchor: "top-right",
		width: CONTEXT_ISLAND_WIDTH,
		margin: { top: 1, right: 1 },
		nonCapturing: true,
		visible: (width, height) => width >= 92 && height >= 20,
	});
	contextIslandHandle.setHidden(true);

	let dispatchBoardTicker: InteractiveTickerHandle | null = null;
	let contextIslandTicker: InteractiveTickerHandle | null = null;
	let contextIslandVisible = false;

	let taskIslandHidden = true;

	const renderTaskIsland = (): boolean => {
		const rows = deps.dispatchBoardStore.activeRows();
		const board = rows.length === 0 ? (deps.getTaskBoard?.() ?? null) : null;
		const boardHasOpenTasks = board !== null && taskBoardCounts(board).open > 0;
		const contextActive = deps.contextActivityStore.active();
		const hidden =
			deps.getOverlayState() !== "closed" ||
			deps.isFooterExpanded() ||
			contextActive ||
			(rows.length === 0 && !boardHasOpenTasks);
		const visibilityChanged = taskIslandHidden !== hidden;
		taskIslandHandle.setHidden(hidden);
		// A hidden island with nothing to show still ran the frame builder and two
		// truncateToWidth calls four times a second, forever, to produce lines no
		// one could see. Formatting the empty case is pure waste; staying hidden
		// leaves the last text in place, which is unreachable while hidden.
		if (hidden && taskIslandHidden && rows.length === 0 && !boardHasOpenTasks) return visibilityChanged;
		taskIslandHidden = hidden;
		if (rows.length > 0) taskIsland.setText(formatTaskIslandLines(rows).join("\n"));
		else if (board) taskIsland.setText(formatTaskBoardIslandLines(board).join("\n"));
		taskIsland.invalidate();
		return visibilityChanged || !hidden;
	};

	const renderContextIsland = (): void => {
		const activity = deps.contextActivityStore.current();
		contextIslandVisible = Boolean(activity) && deps.getOverlayState() === "closed" && !deps.isFooterExpanded();
		contextIslandHandle.setHidden(!contextIslandVisible);
		if (activity) contextIsland.setText(formatContextActivityIslandLines(activity).join("\n"));
		contextIsland.invalidate();
	};

	const stopDispatchBoardTicker = (): void => {
		if (!dispatchBoardTicker) return;
		clearScheduledInterval(dispatchBoardTicker);
		dispatchBoardTicker = null;
	};

	const startDispatchBoardTicker = (): void => {
		stopDispatchBoardTicker();
		// The board component renders statelessly, so keeping spinners and
		// elapsed times moving only needs a repaint request.
		dispatchBoardTicker = scheduleInterval(() => {
			if (deps.getOverlayState() !== "dispatch-board") return;
			deps.tui.requestRender();
		}, 250);
		// Process liveness belongs to the application controller's keepAlive
		// interval alone. A repaint ticker that also holds the loop keeps the
		// process alive for as long as the board is open.
		dispatchBoardTicker.unref?.();
	};

	const stopContextIslandTicker = (): void => {
		if (!contextIslandTicker) return;
		clearScheduledInterval(contextIslandTicker);
		contextIslandTicker = null;
	};

	const startContextIslandTicker = (): void => {
		stopContextIslandTicker();
		contextIslandTicker = scheduleInterval(() => {
			deps.dispatchBoardStore.reconcile();
			const taskNeedsRender = renderTaskIsland();
			const fleetActive = deps.dispatchBoardStore.activeRows().length > 0;
			if (!deps.contextActivityStore.active() && !contextIslandVisible && !fleetActive && !taskNeedsRender) return;
			renderContextIsland();
			deps.tui.requestRender();
		}, 250);
		contextIslandTicker.unref?.();
	};

	const controller: InteractiveTickers = {
		renderTaskIsland,
		renderContextIsland,
		startDispatchBoardTicker,
		stopDispatchBoardTicker,
		startContextIslandTicker,
		stopContextIslandTicker,
		dispose: () => {
			stopDispatchBoardTicker();
			stopContextIslandTicker();
			contextIslandHandle.hide();
			taskIslandHandle.hide();
		},
	};
	startContextIslandTicker();
	return controller;
}
