import type { UsageSnapshot } from "../domains/quota/types.js";
import type { TaskBoardSnapshot, TaskBoardStore } from "../domains/session/task-board.js";
import { taskBoardCounts } from "../domains/session/task-board.js";
import type { TUI } from "../engine/tui.js";
import { Text, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ContextActivitySnapshot } from "./context-activity.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { formatTaskIslandLines, TASK_ISLAND_WIDTH } from "./dispatch-board.js";
import { clioTheme, frame, GLYPH } from "./theme/index.js";
import { isHelperRun } from "./worker-stream.js";

const TASK_ISLAND_MIN_COLUMNS = 80;
const TASK_ISLAND_MIN_ROWS = 18;
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
	tui: Pick<TUI, "requestRender" | "showOverlay"> & { terminal: Pick<TUI["terminal"], "columns" | "rows"> };
	dispatchBoardStore: InteractiveDispatchStore;
	contextActivityStore: InteractiveContextActivityStore;
	getOverlayState: () => string;
	getQuotaSnapshots?: () => ReadonlyArray<UsageSnapshot>;
	isFooterExpanded: () => boolean;
	/** Bound to TaskBoardStore.cachedSnapshot; repaint must never fold the session ledger. */
	getTaskBoard?: TaskBoardStore["cachedSnapshot"];
	scheduleInterval?: (callback: () => void, intervalMs: number) => InteractiveTickerHandle;
	clearScheduledInterval?: (handle: InteractiveTickerHandle) => void;
}

function formatTaskBoardIslandLines(board: TaskBoardSnapshot): string[] {
	const theme = clioTheme();
	const counts = taskBoardCounts(board);
	const active = board.tasks.find((task) => task.status === "active");
	const next = active ?? board.tasks.find((task) => task.status === "pending");
	const chips = [
		`${counts.completed}/${counts.total} done`,
		...(counts.active > 0 ? [`${counts.active} active`] : []),
		...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
	].join(" · ");
	const body = [theme.fg("sectionHeading", board.title), theme.fg("annotation", chips)];
	if (next) {
		const glyph = active ? theme.fg("activity", GLYPH.running) : theme.fg("annotation", GLYPH.queued);
		body.push(`${glyph} ${theme.fg("annotation", next.id)} ${theme.fg("body", next.title)}`);
	}
	return frame(
		theme,
		"Tasks",
		[
			...body.flatMap((line) => wrapTextWithAnsi(line, TASK_ISLAND_WIDTH)).slice(0, 7),
			theme.fg("commandHint", "/tasks · full task board"),
		],
		TASK_ISLAND_WIDTH + 4,
	);
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
	const taskIslandWidth = formatTaskIslandLines([]).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const taskIslandHandle = deps.tui.showOverlay(taskIsland, {
		anchor: "top-right",
		width: taskIslandWidth,
		margin: { top: 1, right: 1 },
		nonCapturing: true,
		visible: (width, height) => width >= TASK_ISLAND_MIN_COLUMNS && height >= TASK_ISLAND_MIN_ROWS,
	});
	taskIslandHandle.setHidden(true);

	let dispatchBoardTicker: InteractiveTickerHandle | null = null;
	let contextIslandTicker: InteractiveTickerHandle | null = null;
	let contextIslandVisible = false;

	let taskIslandHidden = true;

	const renderTaskIsland = (): boolean => {
		const rows = deps.dispatchBoardStore.activeRows().filter((row) => !isHelperRun(row));
		const board = rows.length === 0 ? (deps.getTaskBoard?.() ?? null) : null;
		const boardHasOpenTasks = board !== null && taskBoardCounts(board).open > 0;
		const hidden =
			deps.getOverlayState() !== "closed" ||
			deps.isFooterExpanded() ||
			rows.length > 0 ||
			(rows.length === 0 && !boardHasOpenTasks);
		const visibilityChanged = taskIslandHidden !== hidden;
		taskIslandHandle.setHidden(hidden);
		// A hidden island with nothing to show still ran the frame builder and two
		// truncateToWidth calls four times a second, forever, to produce lines no
		// one could see. Formatting the empty case is pure waste; staying hidden
		// leaves the last text in place, which is unreachable while hidden.
		if (hidden && taskIslandHidden && rows.length === 0 && !boardHasOpenTasks) return visibilityChanged;
		taskIslandHidden = hidden;
		if (!hidden && board) taskIsland.setText(formatTaskBoardIslandLines(board).join("\n"));
		taskIsland.invalidate();
		return visibilityChanged || !hidden;
	};

	const renderContextIsland = (): void => {
		// Progress is a dock component. Repaint it without allocating a
		// transcript overlay or hiding the task board on a wide terminal.
		contextIslandVisible = deps.contextActivityStore.active();
	};

	const stopDispatchBoardTicker = (): void => {
		if (!dispatchBoardTicker) return;
		clearScheduledInterval(dispatchBoardTicker);
		dispatchBoardTicker = null;
	};

	const startDispatchBoardTicker = (): void => {
		stopDispatchBoardTicker();
		// The board renders statelessly; update its elapsed times once a second.
		dispatchBoardTicker = scheduleInterval(() => {
			if (deps.getOverlayState() !== "dispatch-board") return;
			deps.tui.requestRender();
		}, 1_000);
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
		}, 1_000);
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
			taskIslandHandle.hide();
		},
	};
	startContextIslandTicker();
	return controller;
}
