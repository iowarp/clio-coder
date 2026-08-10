import { Text, type TUI, visibleWidth } from "../engine/tui.js";
import {
	CONTEXT_ISLAND_WIDTH,
	type ContextActivitySnapshot,
	formatContextActivityIslandLines,
} from "./context-activity.js";
import { type DispatchBoardRow, formatTaskIslandLines } from "./dispatch-board.js";

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

	const renderTaskIsland = (): void => {
		const rows = deps.dispatchBoardStore.activeRows();
		const contextActive = deps.contextActivityStore.active();
		taskIslandHandle.setHidden(
			deps.getOverlayState() !== "closed" || deps.isFooterExpanded() || contextActive || rows.length === 0,
		);
		taskIsland.setText(formatTaskIslandLines(rows).join("\n"));
		taskIsland.invalidate();
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
			renderTaskIsland();
			const fleetActive = deps.dispatchBoardStore.activeRows().length > 0;
			if (!deps.contextActivityStore.active() && !contextIslandVisible && !fleetActive) return;
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
