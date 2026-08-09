import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import type { ContextActivitySnapshot } from "../../src/interactive/context-activity.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	createInteractiveTickers,
	type InteractiveTickerHandle,
	type InteractiveTickersDeps,
} from "../../src/interactive/interactive-tickers.js";

const ROW: DispatchBoardRow = {
	runId: "run-1",
	agentId: "coder",
	runtimeKind: "http",
	runtimeId: "runtime",
	targetId: "target",
	wireModelId: "model",
	status: "running",
	elapsedMs: 100,
	tokenCount: 0,
	costUsd: 0,
	inputTokens: 0,
	outputTokens: 0,
	ttftMs: null,
};

const ACTIVITY: ContextActivitySnapshot = {
	kind: "context-init",
	phase: "scan",
	status: "running",
	message: "scanning",
	startedAtMs: 0,
	updatedAtMs: 0,
	completedAtMs: null,
	current: null,
	total: null,
	detail: null,
};

interface ScheduledTicker extends InteractiveTickerHandle {
	id: number;
	callback: () => void;
	intervalMs: number;
}

function createHarness(): {
	deps: InteractiveTickersDeps;
	log: string[];
	tickers: ScheduledTicker[];
	taskHidden: boolean[];
	contextHidden: boolean[];
	overlayOptions: OverlayOptions[];
	setRows(rows: DispatchBoardRow[]): void;
	setActivity(activity: ContextActivitySnapshot | null): void;
	setOverlay(state: string): void;
	setFooterExpanded(expanded: boolean): void;
} {
	const log: string[] = [];
	const tickers: ScheduledTicker[] = [];
	const taskHidden: boolean[] = [];
	const contextHidden: boolean[] = [];
	const overlayOptions: OverlayOptions[] = [];
	let rows: DispatchBoardRow[] = [];
	let activity: ContextActivitySnapshot | null = null;
	let overlayState = "closed";
	let footerExpanded = false;
	let nextTickerId = 1;

	const makeHandle = (name: "task" | "context", hidden: boolean[]): OverlayHandle =>
		({
			hide: () => log.push(`hide:${name}`),
			setHidden: (value) => {
				hidden.push(value);
				log.push(`hidden:${name}:${value}`);
			},
			isHidden: () => hidden.at(-1) ?? false,
			focus: () => {},
			unfocus: () => {},
			isFocused: () => false,
		}) as OverlayHandle;
	const handles = [makeHandle("task", taskHidden), makeHandle("context", contextHidden)];
	const tui = {
		showOverlay: (_component: unknown, options?: OverlayOptions) => {
			overlayOptions.push(options ?? {});
			const handle = handles.shift();
			if (!handle) throw new Error("unexpected island overlay");
			return handle;
		},
		requestRender: () => log.push("render"),
	} as unknown as Pick<TUI, "requestRender" | "showOverlay">;

	return {
		deps: {
			tui,
			dispatchBoardStore: {
				activeRows: () => {
					log.push("rows");
					return rows;
				},
				reconcile: () => log.push("reconcile"),
			},
			contextActivityStore: {
				active: () => {
					log.push("active");
					return activity !== null;
				},
				current: () => {
					log.push("current");
					return activity;
				},
			},
			getOverlayState: () => overlayState,
			isFooterExpanded: () => footerExpanded,
			scheduleInterval: (callback, intervalMs) => {
				const ticker: ScheduledTicker = {
					id: nextTickerId,
					callback,
					intervalMs,
					unref: () => log.push(`unref:${ticker.id}`),
				};
				nextTickerId += 1;
				tickers.push(ticker);
				log.push(`schedule:${ticker.id}:${intervalMs}`);
				return ticker;
			},
			clearScheduledInterval: (handle) => {
				const ticker = handle as ScheduledTicker;
				log.push(`clear:${ticker.id}`);
			},
		},
		log,
		tickers,
		taskHidden,
		contextHidden,
		overlayOptions,
		setRows: (next) => {
			rows = next;
		},
		setActivity: (next) => {
			activity = next;
		},
		setOverlay: (next) => {
			overlayState = next;
		},
		setFooterExpanded: (next) => {
			footerExpanded = next;
		},
	};
}

describe("interactive ticker ownership", () => {
	it("starts the context ticker, unrefs it, and preserves reconciliation/render order", () => {
		const harness = createHarness();
		harness.setRows([ROW]);
		harness.setActivity(ACTIVITY);
		createInteractiveTickers(harness.deps);

		strictEqual(harness.tickers.length, 1);
		strictEqual(harness.tickers[0]?.intervalMs, 250);
		deepStrictEqual(harness.log.slice(-2), ["schedule:1:250", "unref:1"]);
		harness.log.length = 0;
		harness.tickers[0]?.callback();
		deepStrictEqual(harness.log, [
			"reconcile",
			"rows",
			"active",
			"hidden:task:true",
			"rows",
			"active",
			"current",
			"hidden:context:false",
			"render",
		]);
	});

	it("keeps starts restart-safe, stops idempotent, and only unrefs the context ticker", () => {
		const harness = createHarness();
		const tickers = createInteractiveTickers(harness.deps);
		tickers.startDispatchBoardTicker();
		tickers.startDispatchBoardTicker();
		tickers.stopDispatchBoardTicker();
		tickers.stopDispatchBoardTicker();
		tickers.startContextIslandTicker();

		deepStrictEqual(
			harness.log.filter((entry) => /^(schedule|clear|unref)/.test(entry)),
			[
				"schedule:1:250",
				"unref:1",
				"schedule:2:250",
				"clear:2",
				"schedule:3:250",
				"clear:3",
				"clear:1",
				"schedule:4:250",
				"unref:4",
			],
		);
		harness.log.length = 0;
		harness.tickers[1]?.callback();
		strictEqual(harness.log.includes("render"), false);
		harness.setOverlay("dispatch-board");
		harness.tickers[1]?.callback();
		strictEqual(harness.log.includes("render"), true);
	});

	it("applies island visibility boundaries and disposes handles in shutdown order", () => {
		const harness = createHarness();
		const tickers = createInteractiveTickers(harness.deps);
		const taskVisible = harness.overlayOptions[0]?.visible;
		const contextVisible = harness.overlayOptions[1]?.visible;
		strictEqual(taskVisible?.(80, 18), true);
		strictEqual(taskVisible?.(79, 18), false);
		strictEqual(contextVisible?.(92, 20), true);
		strictEqual(contextVisible?.(92, 19), false);

		harness.setRows([ROW]);
		tickers.renderTaskIsland();
		strictEqual(harness.taskHidden.at(-1), false);
		harness.setFooterExpanded(true);
		tickers.renderTaskIsland();
		strictEqual(harness.taskHidden.at(-1), true);
		harness.setFooterExpanded(false);
		harness.setActivity(ACTIVITY);
		tickers.renderContextIsland();
		strictEqual(harness.contextHidden.at(-1), false);
		harness.setOverlay("model");
		tickers.renderContextIsland();
		strictEqual(harness.contextHidden.at(-1), true);

		tickers.startDispatchBoardTicker();
		harness.log.length = 0;
		tickers.dispose();
		deepStrictEqual(harness.log, ["clear:2", "clear:1", "hide:context", "hide:task"]);
	});
});
