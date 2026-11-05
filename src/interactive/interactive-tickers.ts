import type { TaskBoardStore } from "../domains/session/task-board.js";
import { taskBoardCounts } from "../domains/session/task-board.js";
import type { TUI } from "../engine/tui.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { ContextActivitySnapshot } from "./context-activity.js";
import type { DispatchBoardRow } from "./dispatch-board.js";

export interface InteractiveTickerHandle {
	unref?(): void;
}

export interface InteractiveDispatchStore {
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	/** Active workers and running plans, when the store tracks plans. */
	liveRows?(): ReadonlyArray<DispatchBoardRow>;
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
	isFooterExpanded: () => boolean;
	/** Bound to TaskBoardStore.cachedSnapshot; repaint must never fold the session ledger. */
	getTaskBoard?: TaskBoardStore["cachedSnapshot"];
	scheduleInterval?: (callback: () => void, intervalMs: number) => InteractiveTickerHandle;
	clearScheduledInterval?: (handle: InteractiveTickerHandle) => void;
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
	let dispatchBoardTicker: InteractiveTickerHandle | null = null;
	let contextIslandTicker: InteractiveTickerHandle | null = null;
	let contextIslandVisible = false;

	let taskRowShown = false;

	/**
	 * The board's summary is a dock row above the composer (fleet-dock.ts), never
	 * an overlay, because a top-right island painted over transcript words. This
	 * reports whether that row needs a repaint: while it shows, or the frame it
	 * stops showing.
	 */
	const renderTaskIsland = (): boolean => {
		const rows = deps.dispatchBoardStore.activeRows().filter((row) => !isHelperRun(row));
		const board = rows.length === 0 ? (deps.getTaskBoard?.() ?? null) : null;
		const shown = board !== null && !deps.isFooterExpanded() && taskBoardCounts(board).open > 0;
		const changed = shown !== taskRowShown;
		taskRowShown = shown;
		return changed || shown;
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
			const fleetActive = (deps.dispatchBoardStore.liveRows?.() ?? deps.dispatchBoardStore.activeRows()).length > 0;
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
		},
	};
	startContextIslandTicker();
	return controller;
}
