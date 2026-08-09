import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleController,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";

describe("contracts/interactive overlay transitions", () => {
	it("publishes the next state before constructing its handle and closes in the established order", () => {
		const events: string[] = [];
		let lifecycle: OverlayLifecycleController;
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
		const app = {
			providers: {},
			bus: { on: () => () => {}, emit: () => {} },
		} as unknown as OverlayLifecycleApplicationDeps;
		const runtime = {
			app,
			tui: { requestRender: () => events.push("render") } as unknown as TUI,
			footer: { refresh: () => events.push("footer") },
			interactiveTickers: {
				stopDispatchBoardTicker: () => events.push("stop-board"),
				renderContextIsland: () => events.push("context-island"),
				renderTaskIsland: () => events.push("task-island"),
			},
			busNoticeSink: { appendReplayBlock: () => {}, requestRender: () => {} },
			chatRenderer: { applyEvent: () => {} },
			notify: () => {},
			terminal: { columns: 100 },
			dispatchBoard: {},
			getObservabilitySnapshot: () => ({}),
			chatPanel: {},
			io: { stdout: () => {}, stderr: () => {} },
			readStructuredEntries: () => [],
			announceTaskMemorySeedOffer: () => {},
			keybindings: {},
			editor: { getText: () => "", setText: () => {} },
			getSlashContext: () => ({}),
			openProvidersOverlay: (_tui: TUI, _providers: ProvidersContract) => {
				events.push(`factory:${lifecycle.getState()}`);
				return handle;
			},
		} as unknown as OverlayLifecycleRuntimeDeps;
		lifecycle = createOverlayLifecycle(runtime);

		lifecycle.openProvidersOverlayState();
		strictEqual(lifecycle.getState(), "providers");
		deepStrictEqual(events, ["factory:providers", "render"]);

		events.length = 0;
		lifecycle.closeOverlay();
		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, ["stop-board", "hide", "context-island", "task-island", "render"]);
		lifecycle.dispose();
	});
});
