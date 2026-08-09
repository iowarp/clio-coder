import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleController,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { OpenContextResetOverlayDeps } from "../../src/interactive/overlays/context-reset.js";

type GeneralOpenerSeams = {
	openCostOverlay?: typeof import("../../src/interactive/cost-overlay.js").openCostOverlay;
	openContextOverlay?: typeof import("../../src/interactive/context-overlay.js").openContextOverlay;
	openContextResetOverlay?: typeof import("../../src/interactive/overlays/context-reset.js").openContextResetOverlay;
	openTasksOverlay?: typeof import("../../src/interactive/tasks-overlay.js").openTasksOverlay;
	openMemoryOverlay?: typeof import("../../src/interactive/memory-overlay.js").openMemoryOverlay;
	openFleetOverlay?: typeof import("../../src/interactive/fleet-overlay.js").openFleetOverlay;
	openViewOverlay?: typeof import("../../src/interactive/view/view-overlay.js").openViewOverlay;
};

function makeRuntime(args: {
	events: string[];
	app?: Partial<OverlayLifecycleApplicationDeps>;
	runtime?: Partial<OverlayLifecycleRuntimeDeps & GeneralOpenerSeams>;
}): OverlayLifecycleRuntimeDeps & GeneralOpenerSeams {
	const { events } = args;
	const app = {
		providers: {},
		bus: { on: () => () => {}, emit: () => {} },
		chat: { contextLedger: () => ({}) },
		dispatch: {},
		observability: {},
		stateDir: "/tmp/clio-overlay-general-state",
		dataDir: "/tmp/clio-overlay-general-data",
		readSessionEntries: () => [],
		...args.app,
	} as unknown as OverlayLifecycleApplicationDeps;
	return {
		app,
		tui: { requestRender: () => events.push("render") } as unknown as TUI,
		footer: {
			refresh: () => events.push("footer"),
			toggleExpanded: () => events.push("footer-toggle"),
		},
		interactiveTickers: {
			stopDispatchBoardTicker: () => events.push("stop-board"),
			startDispatchBoardTicker: () => events.push("start-board"),
			renderContextIsland: () => events.push("context-island"),
			renderTaskIsland: () => events.push("task-island"),
		},
		busNoticeSink: { appendReplayBlock: () => {}, requestRender: () => {} },
		chatRenderer: { applyEvent: () => {} },
		notify: () => {},
		terminal: { columns: 70 },
		dispatchBoard: {
			resetSelection: () => events.push("reset-selection"),
			selectedRow: () => null,
		},
		getObservabilitySnapshot: () => ({}),
		chatPanel: {},
		io: { stdout: () => {}, stderr: (text: string) => events.push(`stderr:${text}`) },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({ notice: () => {} }),
		...args.runtime,
	} as unknown as OverlayLifecycleRuntimeDeps & GeneralOpenerSeams;
}

describe("contracts/interactive general overlay openers", () => {
	it("publishes each general overlay state before invoking its factory", () => {
		const events: string[] = [];
		const observed: string[] = [];
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		let lifecycle: OverlayLifecycleController;
		const observe = (name: string): OverlayHandle => {
			observed.push(`${name}:${lifecycle.getState()}`);
			return handle;
		};
		const runtime = makeRuntime({
			events,
			app: {
				getSessionId: () => "session-1",
				getTaskBoard: () => null,
				getTaskMemoryStatus: () => ({}) as never,
			},
			runtime: {
				openCostOverlay: () => observe("cost"),
				openContextOverlay: () => observe("context"),
				openTasksOverlay: () => observe("tasks"),
				openMemoryOverlay: () => observe("memory"),
				openFleetOverlay: () => observe("fleet"),
				openViewOverlay: (_tui, options) => {
					strictEqual(options.initialFilter, "errors");
					return observe("view");
				},
			},
		});
		lifecycle = createOverlayLifecycle(runtime);

		for (const open of [
			() => lifecycle.openCostOverlayState(),
			() => lifecycle.openContextViewOverlayState(),
			() => lifecycle.openTasksOverlayState(),
			() => lifecycle.openMemoryOverlayState(),
			() => lifecycle.openFleetOverlayState(),
			() => lifecycle.openViewOverlayState("errors"),
		]) {
			open();
			lifecycle.closeOverlay();
		}

		deepStrictEqual(observed, [
			"cost:cost",
			"context:context-view",
			"tasks:tasks",
			"memory:memory",
			"fleet:fleet",
			"view:view",
		]);
		lifecycle.dispose();
	});

	it("closes context reset before invoking its asynchronous mutation and refreshes after settlement", async () => {
		const events: string[] = [];
		let resetDeps: OpenContextResetOverlayDeps | undefined;
		let resolveClear: (() => void) | undefined;
		const clearSettled = new Promise<void>((resolve) => {
			resolveClear = resolve;
		});
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		const runtime = makeRuntime({
			events,
			app: {
				onContextClear: (options) => {
					events.push(`clear:${JSON.stringify(options)}`);
					return clearSettled;
				},
			},
			runtime: {
				openContextResetOverlay: (_tui, deps) => {
					resetDeps = deps;
					events.push("factory");
					return handle;
				},
			},
		});
		const lifecycle = createOverlayLifecycle(runtime);
		lifecycle.openContextResetOverlayState();
		events.length = 0;

		resetDeps?.onReset("preserve-clio-md");
		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["stop-board", "hide", "context-island", "task-island", "render"]);

		await Promise.resolve();
		deepStrictEqual(events, [
			"stop-board",
			"hide",
			"context-island",
			"task-island",
			"render",
			'clear:{"confirmed":true}',
		]);
		resolveClear?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		deepStrictEqual(events.slice(-2), ["footer", "render"]);
		lifecycle.dispose();
	});

	it("toggles the footer without taking overlay state", () => {
		const events: string[] = [];
		const lifecycle = createOverlayLifecycle(makeRuntime({ events }));

		lifecycle.toggleFooterDashboardState();

		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["footer-toggle", "task-island", "render"]);
		lifecycle.dispose();
	});

	it("opens and toggles the dispatch board with the clamped width and ticker lifecycle", () => {
		const events: string[] = [];
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		let lifecycle: OverlayLifecycleController;
		let frameOptions: OverlayOptions | undefined;
		const runtime = makeRuntime({
			events,
			runtime: {
				showOverlayFrame: (_tui, _component, options) => {
					events.push(`frame:${lifecycle.getState()}`);
					frameOptions = options;
					return handle;
				},
			},
		});
		lifecycle = createOverlayLifecycle(runtime);

		lifecycle.toggleDispatchBoardOverlay();
		strictEqual(lifecycle.getState(), "dispatch-board");
		strictEqual(frameOptions?.width, 66);
		deepStrictEqual(events, ["reset-selection", "frame:dispatch-board", "start-board", "render"]);

		events.length = 0;
		lifecycle.toggleDispatchBoardOverlay();
		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["stop-board", "hide", "context-island", "task-island", "render"]);
		lifecycle.dispose();
	});
});
