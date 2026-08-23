import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { ClioKeybinding } from "../../src/domains/config/keybindings.js";
import type { ApplicationInputResult } from "../../src/interactive/application-controller.js";
import {
	createInteractiveInputRuntime,
	type InteractiveInputKeyActionDeps,
} from "../../src/interactive/interactive-input-runtime.js";

it("constructs the input runtime without a terminal and wires controller-owned actions", async () => {
	const events: string[] = [];
	let inputListener: ((data: string) => ApplicationInputResult) | undefined;
	const controller = createInteractiveInputRuntime({
		keybindings: {
			matches: (data, id) => data === "tool" && id === "clio.tool.expand",
			leaderTargets: () => [],
		},
		dispatchAction: (id: ClioKeybinding, deps: InteractiveInputKeyActionDeps) => {
			if (id === "clio.tool.expand") deps.toggleToolExpansion();
			return true;
		},
		actions: {
			canExit: () => true,
			availableThinkingLevels: () => ["off"],
			onCycleThinking: () => events.push("thinking:cycle"),
			cycleScopedModelForward: () => events.push("model:forward"),
			cycleScopedModelBackward: () => events.push("model:backward"),
			backgroundActiveDispatch: () => events.push("dispatch:background"),
		},
		overlay: {
			getState: () => "closed",
			closeOverlay: () => events.push("overlay:close"),
			confirmPermission: () => events.push("permission:confirm"),
			stopTurnFromPermission: () => events.push("permission:stop-turn"),
			cancelAskUser: () => events.push("ask:cancel"),
			toggleFooterDashboardState: () => events.push("footer:toggle"),
			toggleDispatchBoardOverlay: () => events.push("board:toggle"),
			openModelOverlayState: () => events.push("model:open"),
			openTreeOverlayState: () => events.push("tree:open"),
			openTasksOverlayState: () => events.push("tasks:open"),
			openDecisionsOverlayState: () => events.push("decisions:open"),
		},
		refreshFooter: () => events.push("footer:refresh"),
		dispatchBoard: { selectPrevious: () => {}, selectNext: () => {}, toggleDetail: () => {} },
		steerSelectedDispatch: () => {},
		cancelSelectedDispatch: () => {},
		cancelActiveEditorBash: () => false,
		isStreaming: () => false,
		cancelActiveRun: () => {},
		editor: { getText: () => "", setText: () => {} },
		editorSubmit: {
			openExternalEditorForInput: () => {},
			queueFollowUpFromEditor: () => {},
			interruptFromEditor: () => {},
			restoreQueuedFollowUpsToEditor: () => {},
		},
		requestRender: () => events.push("render"),
		notifications: { list: () => [], dismiss: () => {}, dismissAll: () => {} },
		chatPanel: {
			toggleLastToolExpanded: () => {
				events.push("tool:last");
				return true;
			},
			toggleAllToolsExpanded: () => false,
			toggleLiveToolOutput: () => {},
			toggleLastThinking: () => false,
			toggleAllThinking: () => false,
		},
		shutdown: {
			stopTickers: () => {},
			disposeInteractiveTickers: () => {},
			disposeBeforeStatus: () => {},
			disposeProjectionPrimary: () => {},
			disposeStatus: () => {},
			disposeProjectionRemaining: () => {},
			disposeOverlay: () => {},
			stopAgentProgress: () => {},
			disposeChat: () => {},
			disposeSubscriptions: () => {},
		},
		stopUi: () => {},
		cancelParkedCalls: () => {},
		onShutdown: async () => {},
		registerInputListener: (listener) => {
			inputListener = listener;
		},
		clock: { now: () => 1_000 },
		signals: { takeInterruptOwnership: () => () => {}, on: () => {}, off: () => {} },
		intervals: { setInterval: () => ({}), clearInterval: () => {} },
	});

	strictEqual(typeof inputListener, "function");
	deepStrictEqual(inputListener?.("tool"), { consume: true });
	deepStrictEqual(events, ["tool:last", "render"]);
	await controller.shutdown();
});
