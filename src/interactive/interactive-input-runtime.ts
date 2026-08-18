import { getTerminationCoordinator } from "../core/termination.js";
import type { ClioKeybinding } from "../domains/config/keybindings.js";
import { isKeyRelease } from "../engine/tui.js";
import {
	type ApplicationClock,
	type ApplicationController,
	type ApplicationInputResult,
	type ApplicationIntervalCoordinator,
	type ApplicationIntervalHandle,
	type ApplicationSignalCoordinator,
	createApplicationController,
} from "./application-controller.js";
import { createLeaderKeyController, type LeaderTarget } from "./leader-key.js";
import { type OverlayState, routeOverlayKey } from "./overlay-lifecycle.js";

export interface InteractiveInputKeyActionDeps {
	matches: (data: string, id: ClioKeybinding) => boolean;
	canExit: () => boolean;
	cycleThinking: () => void;
	requestShutdown: () => void;
	toggleStatus: () => void;
	toggleDispatchBoard: () => void;
	backgroundDispatch: () => void;
	openModelSelector: () => void;
	openTree: () => void;
	cycleScopedModelForward: () => void;
	cycleScopedModelBackward: () => void;
	dismissNotifications: () => void;
	toggleToolExpansion: () => void;
	toggleAllToolExpansion: () => void;
	toggleLiveToolOutput: () => void;
	toggleThinkingExpansion: () => void;
	toggleAllThinkingExpansion: () => void;
	openExternalEditor: () => void;
	queueFollowUp: () => void;
	interruptWithMessage: () => void;
	restoreQueuedFollowUps: () => void;
}

export interface InteractiveInputRuntimeDeps {
	keybindings: {
		matches(data: string, id: ClioKeybinding): boolean;
		leaderTargets(): ReadonlyArray<LeaderTarget>;
	};
	dispatchAction: (id: ClioKeybinding, deps: InteractiveInputKeyActionDeps) => boolean;
	actions: {
		canExit(): boolean;
		availableThinkingLevels(): ReadonlyArray<string>;
		onCycleThinking(): void;
		cycleScopedModelForward(): void;
		cycleScopedModelBackward(): void;
		/** Convert the newest attached dispatch into a detached batch and notice the outcome. */
		backgroundActiveDispatch(): void;
	};
	overlay: {
		getState(): OverlayState;
		closeOverlay(): void;
		confirmPermission(): void;
		stopTurnFromPermission(): void;
		cancelAskUser(): void;
		toggleFooterDashboardState(): void;
		toggleDispatchBoardOverlay(): void;
		openModelOverlayState(): void;
		openTreeOverlayState(): void;
	};
	refreshFooter: () => void;
	/** Armed/disarmed transitions of the Ctrl+G leader, for the footer indicator. */
	onLeaderStateChange?: (pending: boolean) => void;
	/** Armed/disarmed transitions of the Ctrl+C double tap, for the same indicator row. */
	onShutdownArmedChange?: (armed: boolean) => void;
	dispatchBoard: {
		selectPrevious(): void;
		selectNext(): void;
	};
	steerSelectedDispatch: () => void;
	cancelSelectedDispatch: () => void;
	cancelActiveEditorBash: () => boolean;
	isStreaming: () => boolean;
	cancelActiveRun: () => void;
	editor: { getText(): string; setText(text: string): void };
	editorSubmit: {
		openExternalEditorForInput(): void;
		queueFollowUpFromEditor(): void;
		interruptFromEditor(): void;
		restoreQueuedFollowUpsToEditor(): void;
	};
	requestRender: () => void;
	notifications: {
		list(): ReadonlyArray<{ id: string }>;
		dismiss(id: string): void;
		dismissAll(): void;
	};
	chatPanel: {
		toggleLastToolExpanded(): boolean;
		toggleAllToolsExpanded(): boolean;
		toggleLiveToolOutput(): void;
		toggleLastThinking(): boolean;
		toggleAllThinking(): boolean;
	};
	shutdown: {
		stopTickers(): void;
		disposeInteractiveTickers(): void;
		disposeBeforeStatus(): void;
		disposeProjectionPrimary(): void;
		disposeStatus(): void;
		disposeProjectionRemaining(): void;
		disposeOverlay(): void;
		stopAgentProgress(): void;
		disposeChat(): void;
		disposeSubscriptions(): void;
	};
	stopUi: () => void;
	cancelParkedCalls: (reason: string) => void;
	onShutdown: () => Promise<void>;
	reportShutdownFailure?: (step: string, error: unknown) => void;
	/** Defaults to the process termination coordinator's drain phase. */
	registerTerminalTeardown?: (teardown: () => void) => void;
	registerInputListener: (listener: (data: string) => ApplicationInputResult) => void;
	intervalsToClear?: ReadonlyArray<ApplicationIntervalHandle>;
	clock?: ApplicationClock;
	signals?: ApplicationSignalCoordinator;
	intervals?: ApplicationIntervalCoordinator;
}

/** Compose the main-editor input boundary without booting a terminal or provider. */
export function createInteractiveInputRuntime(deps: InteractiveInputRuntimeDeps): ApplicationController {
	let controller: ApplicationController;
	const keyActionDeps = (): InteractiveInputKeyActionDeps => ({
		matches: (input, id) => deps.keybindings.matches(input, id),
		canExit: deps.actions.canExit,
		cycleThinking: () => {
			const available = deps.actions.availableThinkingLevels();
			if (!(available.length === 1 && available[0] === "off")) deps.actions.onCycleThinking();
			deps.refreshFooter();
			deps.requestRender();
		},
		requestShutdown: () => void controller.shutdown(),
		toggleStatus: deps.overlay.toggleFooterDashboardState,
		toggleDispatchBoard: deps.overlay.toggleDispatchBoardOverlay,
		backgroundDispatch: deps.actions.backgroundActiveDispatch,
		openModelSelector: deps.overlay.openModelOverlayState,
		openTree: deps.overlay.openTreeOverlayState,
		cycleScopedModelForward: () => {
			deps.actions.cycleScopedModelForward();
			deps.refreshFooter();
			deps.requestRender();
		},
		cycleScopedModelBackward: () => {
			deps.actions.cycleScopedModelBackward();
			deps.refreshFooter();
			deps.requestRender();
		},
		dismissNotifications: () => controller.dismissNotifications(),
		toggleToolExpansion: () => controller.toggleToolExpansion(),
		toggleAllToolExpansion: () => {
			if (deps.chatPanel.toggleAllToolsExpanded()) deps.requestRender();
		},
		toggleLiveToolOutput: () => {
			deps.chatPanel.toggleLiveToolOutput();
			deps.requestRender();
		},
		toggleThinkingExpansion: () => controller.toggleThinkingExpansion(),
		toggleAllThinkingExpansion: () => {
			if (deps.chatPanel.toggleAllThinking()) deps.requestRender();
		},
		openExternalEditor: deps.editorSubmit.openExternalEditorForInput,
		queueFollowUp: deps.editorSubmit.queueFollowUpFromEditor,
		interruptWithMessage: deps.editorSubmit.interruptFromEditor,
		restoreQueuedFollowUps: deps.editorSubmit.restoreQueuedFollowUpsToEditor,
	});
	const leaderKeys = createLeaderKeyController({
		matchesLeader: (input) => deps.keybindings.matches(input, "clio.leader"),
		leaderTargets: () => deps.keybindings.leaderTargets(),
		dispatchAction: (id) => deps.dispatchAction(id, keyActionDeps()),
		isRelease: isKeyRelease,
		onStateChange: (pending) => {
			deps.onLeaderStateChange?.(pending);
			deps.refreshFooter();
			deps.requestRender();
		},
	});

	controller = createApplicationController({
		clock: deps.clock ?? { now: Date.now },
		signals: deps.signals ?? {
			takeInterruptOwnership: () => getTerminationCoordinator().releaseInterruptOwnership(),
			on: (signal, listener) => void process.on(signal, listener),
			off: (signal, listener) => void process.off(signal, listener),
		},
		intervals: deps.intervals ?? {
			setInterval: (callback, delayMs) => setInterval(callback, delayMs),
			clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
		},
		intervalsToClear: deps.intervalsToClear ?? [],
		leaderKeys,
		getOverlayState: () => deps.overlay.getState(),
		routeOverlayKey: (data) =>
			routeOverlayKey(
				data,
				deps.overlay.getState(),
				{
					cancelPermission: () => deps.overlay.closeOverlay(),
					confirmPermission: () => deps.overlay.confirmPermission(),
					stopTurnFromPermission: () => deps.overlay.stopTurnFromPermission(),
					closeOverlay: () => deps.overlay.closeOverlay(),
					selectPreviousDispatch: () => {
						deps.dispatchBoard.selectPrevious();
						deps.requestRender();
					},
					selectNextDispatch: () => {
						deps.dispatchBoard.selectNext();
						deps.requestRender();
					},
					steerSelectedDispatch: deps.steerSelectedDispatch,
					cancelSelectedDispatch: deps.cancelSelectedDispatch,
					cancelAskUser: () => deps.overlay.cancelAskUser(),
				},
				(input, id) => deps.keybindings.matches(input, id),
			),
		matchesAction: (data, id) => deps.keybindings.matches(data, id),
		dispatchAction: (id) => deps.dispatchAction(id, keyActionDeps()),
		cancelActiveEditorBash: deps.cancelActiveEditorBash,
		isStreaming: deps.isStreaming,
		cancelActiveRun: deps.cancelActiveRun,
		getEditorText: () => deps.editor.getText(),
		clearEditor: () => deps.editor.setText(""),
		requestRender: deps.requestRender,
		// The footer pulls the flag when it refreshes, so the refresh has to land
		// before the controller asks for the frame. The controller owns the render
		// request on this path, which is why this hook does not make one.
		onShutdownArmedChange: (armed) => {
			deps.onShutdownArmedChange?.(armed);
			deps.refreshFooter();
		},
		closeOverlay: () => deps.overlay.closeOverlay(),
		listNotifications: () => deps.notifications.list(),
		dismissNotification: (id) => deps.notifications.dismiss(id),
		dismissAllNotifications: () => deps.notifications.dismissAll(),
		toggleLastToolExpanded: () => deps.chatPanel.toggleLastToolExpanded(),
		toggleAllToolsExpanded: () => deps.chatPanel.toggleAllToolsExpanded(),
		toggleLastThinking: () => deps.chatPanel.toggleLastThinking(),
		toggleAllThinking: () => deps.chatPanel.toggleAllThinking(),
		shutdownDisposers: [
			() => deps.shutdown.stopTickers(),
			() => leaderKeys.dispose(),
			() => deps.shutdown.disposeInteractiveTickers(),
			() => deps.shutdown.disposeBeforeStatus(),
			() => deps.shutdown.disposeProjectionPrimary(),
			() => deps.shutdown.disposeStatus(),
			() => deps.shutdown.disposeProjectionRemaining(),
			() => deps.shutdown.disposeOverlay(),
			() => deps.shutdown.stopAgentProgress(),
			() => deps.shutdown.disposeChat(),
			() => deps.shutdown.disposeSubscriptions(),
		],
		stopUi: deps.stopUi,
		cancelParkedCalls: deps.cancelParkedCalls,
		onShutdown: deps.onShutdown,
		registerTerminalTeardown:
			deps.registerTerminalTeardown ?? ((teardown) => getTerminationCoordinator().onDrain(teardown)),
		// stderr for the same reason src/core/termination.ts uses it for a failed
		// hook: by the time teardown fails there is no UI left to carry a notice.
		reportShutdownFailure:
			deps.reportShutdownFailure ??
			((step, error) => {
				process.stderr.write(
					`[clio:interactive] ${step} failed: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}),
	});
	deps.registerInputListener(controller.handleInput);
	return controller;
}
