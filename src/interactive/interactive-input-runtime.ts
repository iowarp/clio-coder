import { getTerminationCoordinator } from "../core/termination.js";
import { CLIO_APP_KEYBINDING_IDS, type ClioKeybinding } from "../domains/config/keybindings.js";
import {
	decodePrintableKey,
	isKeyRelease,
	type Keybinding,
	matchesKey,
	type TUI,
	TuiAltScreen,
} from "../engine/tui.js";
import {
	type ApplicationClock,
	type ApplicationController,
	type ApplicationInputResult,
	type ApplicationIntervalCoordinator,
	type ApplicationIntervalHandle,
	type ApplicationSignalCoordinator,
	createApplicationController,
} from "./application-controller.js";
import { focusedComponent, keyboardOwner } from "./keyboard-owner.js";
import { createLeaderKeyController, type LeaderTarget } from "./leader-key.js";
import { createLeaderMenu } from "./leader-menu.js";
import { type OverlayState, routeOverlayKey } from "./overlay-lifecycle.js";
import type { RenderInputAction } from "./render-trace.js";

export interface InteractiveInputKeyActionDeps {
	matches: (data: string, id: ClioKeybinding) => boolean;
	canExit: () => boolean;
	cycleThinking: () => void;
	requestShutdown: () => void;
	toggleStatus: () => void;
	toggleDispatchBoard: () => void;
	toggleFilesPane: () => void;
	openTasks: () => void;
	openDecisions: () => void;
	backgroundDispatch: () => void;
	openModelSelector: () => void;
	openLibrary: () => void;
	openTree: () => void;
	cycleScopedModelForward: () => void;
	cycleScopedModelBackward: () => void;
	dismissNotifications: () => void;
	cycleOutputStyle: () => void;
	openExternalEditor: () => void;
	queueFollowUp: () => void;
	interruptWithMessage: () => void;
	restoreQueuedFollowUps: () => void;
}

export interface InteractiveInputRuntimeDeps {
	tui?: TUI;
	hasQueuedMessages?: () => boolean;
	explainProtectedExit?: () => void;
	explainSearchUnavailable?: () => void;
	explainThinkingUnavailable?: () => void;
	keybindings: {
		matches(data: string, id: Keybinding): boolean;
		leaderTargets(): ReadonlyArray<LeaderTarget>;
		getKeys?(id: Keybinding): ReadonlyArray<string>;
		getDescription?(id: Keybinding): string;
		onReload?(listener: () => void): () => void;
	};
	dispatchAction: (id: ClioKeybinding, deps: InteractiveInputKeyActionDeps) => boolean;
	actions: {
		canExit(): boolean;
		cycleOutputStyle(): void;
		availableThinkingLevels(): ReadonlyArray<string>;
		onCycleThinking(): void;
		cycleScopedModelForward(): void;
		cycleScopedModelBackward(): void;
		/** Convert the newest attached dispatch into a detached batch and notice the outcome. */
		backgroundActiveDispatch(): void;
		/** Toggle the files pane; the application decides what "inactive" says. */
		toggleFilesPane(): void;
	};
	overlay: {
		getState(): OverlayState;
		closeOverlay(): void;
		confirmPermission(): void;
		stopTurnFromPermission(): void;
		canInspectMutation(): boolean;
		isInspectingMutation(): boolean;
		toggleMutationInspection(): void;
		scrollMutationInspection(delta: number): void;
		togglePermissionTerms(): void;
		cancelAskUser(): void;
		toggleFooterDashboardState(): void;
		toggleDispatchBoardOverlay(): void;
		openModelOverlayState(): void;
		openSkillsHubState(): void;
		openTreeOverlayState(): void;
		openTasksOverlayState(): void;
		openDecisionsOverlayState(): void;
	};
	refreshFooter: () => void;
	/** Armed/disarmed transitions of the Ctrl+G leader, for the footer indicator. */
	onLeaderStateChange?: (pending: boolean) => void;
	/** Armed/disarmed transitions of the Ctrl+C double tap, for the same indicator row. */
	onShutdownArmedChange?: (armed: boolean) => void;
	dispatchBoard: {
		selectPrevious(): void;
		selectNext(): void;
		toggleDetail(): void;
	};
	/** Enter in the workers view; false falls through to the detail toggle. */
	watchSelectedDispatch: () => boolean;
	steerSelectedDispatch: () => void;
	cancelSelectedDispatch: () => void;
	cancelActiveEditorBash: () => boolean;
	isStreaming: () => boolean;
	cancelActiveRun: () => void;
	editor: {
		getText(): string;
		setText(text: string): void;
		handleInput?(data: string): void;
		applyEdit?(operation: import("./overlay-key-routing.js").DraftEditOperation | "undo"): void;
		isShowingAutocomplete?(): boolean;
	};
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
	beforeStopUi?: () => Promise<void>;
	cancelParkedCalls: (reason: string) => void;
	onShutdown: () => Promise<void>;
	reportShutdownFailure?: (step: string, error: unknown) => void;
	/** Defaults to the process termination coordinator's drain phase. */
	registerTerminalTeardown?: (teardown: () => void | Promise<void>) => void;
	registerInputListener: (listener: (data: string) => ApplicationInputResult) => void;
	onInputIngress?: (action: RenderInputAction, data: string) => void;
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
			else deps.explainThinkingUnavailable?.();
			deps.refreshFooter();
			deps.requestRender();
		},
		requestShutdown: () => void controller.shutdown(),
		toggleStatus: deps.overlay.toggleFooterDashboardState,
		toggleDispatchBoard: deps.overlay.toggleDispatchBoardOverlay,
		openTasks: deps.overlay.openTasksOverlayState,
		openDecisions: deps.overlay.openDecisionsOverlayState,
		backgroundDispatch: deps.actions.backgroundActiveDispatch,
		toggleFilesPane: deps.actions.toggleFilesPane,
		openModelSelector: deps.overlay.openModelOverlayState,
		openLibrary: deps.overlay.openSkillsHubState,
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
		cycleOutputStyle: deps.actions.cycleOutputStyle,
		openExternalEditor: deps.editorSubmit.openExternalEditorForInput,
		queueFollowUp: deps.editorSubmit.queueFollowUpFromEditor,
		interruptWithMessage: deps.editorSubmit.interruptFromEditor,
		restoreQueuedFollowUps: deps.editorSubmit.restoreQueuedFollowUpsToEditor,
	});
	const focused = () => (deps.tui ? focusedComponent(deps.tui) : null);
	const search = () => (deps.tui instanceof TuiAltScreen && deps.tui.isSearchFocused ? deps.tui : null);
	const owner = () => keyboardOwner(focused());
	const ownerAction = (): ClioKeybinding | undefined =>
		(
			({
				"skills-hub": "clio-coder.library.toggle",
				model: "clio-coder.model.select",
				tree: "clio-coder.session.tree",
				"dispatch-board": "clio-coder.dispatchBoard.toggle",
			}) as Partial<Record<OverlayState, ClioKeybinding>>
		)[deps.overlay.getState()];
	const canToggleOwner = () => deps.overlay.getState() === "dispatch-board" || owner().keyboardScope === "browse";
	const targets = (): ReadonlyArray<LeaderTarget> => {
		const all = deps.keybindings.leaderTargets();
		const filtered = search()
			? all.filter(({ id }) => id === "tui.editor.undo" || id === "tui.altScreen.search")
			: deps.overlay.getState() === "closed"
				? all
				: all.filter(
						({ id }) =>
							(id === ownerAction() && canToggleOwner()) ||
							(id === "tui.editor.undo" &&
								(owner().keyboardScope === "edit" || deps.overlay.getState() === "permission-confirm")),
					);
		return filtered.map((entry) => ({
			...entry,
			label: deps.keybindings.getDescription?.(entry.id) ?? entry.id,
			...(entry.id === "clio-coder.thinking.cycle" &&
			deps.actions.availableThinkingLevels().every((level) => level === "off")
				? { disabledReason: "This model supports only off" }
				: {}),
		}));
	};
	const menu = deps.tui
		? createLeaderMenu(
				deps.tui,
				() => (search() ? "Transcript search" : overlayScopeLabel(deps.overlay.getState())),
				(id) => deps.keybindings.getKeys?.(id).join(" / ") ?? "",
			)
		: undefined;
	const dispatchLeader = (id: Keybinding): boolean => {
		if (id === "tui.editor.undo") {
			if (search()) search()?.undoSearchQuery();
			else if (deps.overlay.getState() === "closed" || deps.overlay.getState() === "permission-confirm")
				deps.editor.applyEdit?.("undo");
			else owner().undoInput?.();
			deps.requestRender();
			return true;
		}
		if (id.startsWith("tui.altScreen.")) {
			const tui = deps.tui;
			if (!(tui instanceof TuiAltScreen)) {
				deps.explainSearchUnavailable?.();
				return true;
			}
			switch (id) {
				case "tui.altScreen.search":
					tui.toggleSearch();
					break;
				case "tui.altScreen.pageUp":
					tui.scrollBy(-Math.max(1, tui.terminal.rows - 3));
					break;
				case "tui.altScreen.pageDown":
					tui.scrollBy(Math.max(1, tui.terminal.rows - 3));
					break;
				case "tui.altScreen.top":
					tui.scrollToTop();
					break;
				case "tui.altScreen.bottom":
					tui.scrollToBottom();
					break;
				case "tui.altScreen.previousPrompt":
					tui.scrollToPrompt(-1);
					break;
				case "tui.altScreen.nextPrompt":
					tui.scrollToPrompt(1);
					break;
			}
			return true;
		}
		if (deps.overlay.getState() !== "closed") {
			if (id === ownerAction() && canToggleOwner()) deps.overlay.closeOverlay();
			return true;
		}
		return deps.dispatchAction(id as ClioKeybinding, keyActionDeps());
	};
	const leaderKeys = createLeaderKeyController({
		matchesLeader: (input) => deps.keybindings.matches(input, "clio-coder.leader"),
		leaderTargets: targets,
		dispatchAction: dispatchLeader,
		...(menu ? { onMenuChange: menu } : {}),
		isRelease: isKeyRelease,
		onStateChange: (pending) => {
			deps.onLeaderStateChange?.(pending);
			deps.refreshFooter();
			deps.requestRender();
		},
	});

	const removeReload = deps.keybindings.onReload?.(() => leaderKeys.reset());
	controller = createApplicationController({
		routeComposerKey: (data) => {
			if (deps.keybindings.matches(data, "tui.altScreen.search") && !(deps.tui instanceof TuiAltScreen)) {
				deps.explainSearchUnavailable?.();
				return true;
			}
			return false;
		},
		isSearchFocused: () => search() !== null,
		closeSearch: () => search()?.closeSearch(),
		isAutocompleteVisible: () => deps.editor.isShowingAutocomplete?.() ?? false,
		hasQueuedMessages: () => deps.hasQueuedMessages?.() ?? false,
		explainProtectedExit: () => deps.explainProtectedExit?.(),
		forwardFocusedInput: (data) => {
			const active = search();
			if (active) {
				if (
					deps.keybindings.matches(data, "tui.altScreen.search") ||
					deps.keybindings.matches(data, "tui.altScreen.searchClose") ||
					matchesKey(data, "escape")
				)
					active.closeSearch();
				else if (deps.keybindings.matches(data, "tui.altScreen.searchNext")) active.navigateSearch(1);
				else if (deps.keybindings.matches(data, "tui.altScreen.searchPrevious")) active.navigateSearch(-1);
				else focused()?.handleInput?.(data);
			} else focused()?.handleInput?.(data);
			deps.requestRender();
		},
		cancelFocusedOwner: () => {
			const state = deps.overlay.getState();
			if (["permission-confirm", "cost", "context-view", "side-question", "dispatch-board", "auth"].includes(state))
				deps.overlay.closeOverlay();
			else if (focused()?.handleInput) {
				focused()?.handleInput?.("\x1b");
				deps.requestRender();
			} else deps.overlay.closeOverlay();
		},
		matchesRepeatableInput: (data) => {
			// Safety takes precedence over hostile user collisions.
			if (CLIO_APP_KEYBINDING_IDS.some((id) => id !== "clio-coder.exit" && deps.keybindings.matches(data, id)))
				return false;
			if (deps.keybindings.matches(data, "clio-coder.exit"))
				return matchesKey(data, "ctrl+d") && deps.editor.getText().length > 0 && deps.overlay.getState() === "closed";
			if (
				["clio-coder.exit", "clio-coder.leader", "tui.input.submit", "tui.select.confirm", "tui.select.cancel"].some((id) =>
					deps.keybindings.matches(data, id as Keybinding),
				) ||
				matchesKey(data, "ctrl+c") ||
				matchesKey(data, "escape")
			)
				return false;
			const editable = deps.overlay.getState() === "closed" || search() !== null || owner().keyboardScope === "edit";
			if (editable && (decodePrintableKey(data) !== undefined || deps.keybindings.matches(data, "tui.input.newLine")))
				return true;
			const navigation = ["up", "down", "left", "right", "home", "end", "pageUp", "pageDown"] as const;
			if (navigation.some((key) => matchesKey(data, key))) return true;
			if (
				deps.overlay.getState() !== "closed" &&
				["tui.select.up", "tui.select.down"].some((id) => deps.keybindings.matches(data, id as Keybinding))
			)
				return true;
			if (
				deps.overlay.getState() === "closed" &&
				["pageUp", "pageDown", "top", "bottom", "previousPrompt", "nextPrompt"].some((name) =>
					deps.keybindings.matches(data, `tui.altScreen.${name}` as Keybinding),
				)
			)
				return true;
			return (
				(deps.overlay.getState() === "closed" ||
					search() !== null ||
					owner().keyboardScope === "edit" ||
					deps.overlay.getState() === "permission-confirm") &&
				[
					"cursorLeft",
					"cursorRight",
					"cursorWordLeft",
					"cursorWordRight",
					"cursorLineStart",
					"cursorLineEnd",
					"deleteCharBackward",
					"deleteCharForward",
					"deleteWordBackward",
					"deleteWordForward",
					"deleteToLineStart",
					"deleteToLineEnd",
					"historyPrevious",
					"historyNext",
				].some((name) => deps.keybindings.matches(data, `tui.editor.${name}` as Keybinding))
			);
		},
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
					composerHasDraft: () => deps.editor.getText().length > 0,
					canInspectMutation: () => deps.overlay.canInspectMutation(),
					isInspectingMutation: () => deps.overlay.isInspectingMutation(),
					toggleMutationInspection: () => deps.overlay.toggleMutationInspection(),
					scrollMutationInspection: (delta) => deps.overlay.scrollMutationInspection(delta),
					togglePermissionTerms: () => deps.overlay.togglePermissionTerms(),
					canToggleOwner,
					editDraft: (operation) => {
						deps.editor.applyEdit?.(operation);
						deps.requestRender();
					},
					closeOverlay: () => deps.overlay.closeOverlay(),
					selectPreviousDispatch: () => {
						deps.dispatchBoard.selectPrevious();
						deps.requestRender();
					},
					selectNextDispatch: () => {
						deps.dispatchBoard.selectNext();
						deps.requestRender();
					},
					toggleSelectedDispatchDetail: () => {
						deps.dispatchBoard.toggleDetail();
						deps.requestRender();
					},
					watchSelectedDispatch: () => {
						const handled = deps.watchSelectedDispatch();
						if (handled) deps.requestRender();
						return handled;
					},
					steerSelectedDispatch: deps.steerSelectedDispatch,
					cancelSelectedDispatch: deps.cancelSelectedDispatch,
					cancelAskUser: () => deps.overlay.cancelAskUser(),
				},
				(input, id) => deps.keybindings.matches(input, id),
			),
		matchesEditorHistory: (data) =>
			deps.keybindings.matches(data, "tui.editor.historyPrevious") ||
			deps.keybindings.matches(data, "tui.editor.historyNext"),
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
		shutdownDisposers: [
			() => deps.shutdown.stopTickers(),
			() => leaderKeys.dispose(),
			() => removeReload?.(),
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
		...(deps.beforeStopUi ? { beforeStopUi: deps.beforeStopUi } : {}),
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
					`[clio-coder:interactive] ${step} failed: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}),
	});
	deps.registerInputListener((data) => {
		deps.onInputIngress?.(classifyInputAction(data, deps), data);

		return controller.handleInput(data);
	});
	return controller;
}

function classifyInputAction(data: string, deps: InteractiveInputRuntimeDeps): RenderInputAction {
	if (data.length === 0 || isKeyRelease(data)) return "no-visual-change";
	if (deps.keybindings.matches(data, "tui.input.submit")) return "submit";
	const sgrMousePrefix = `${String.fromCharCode(27)}[<`;
	if (
		data.startsWith(`${sgrMousePrefix}64;`) ||
		data.startsWith(`${sgrMousePrefix}65;`) ||
		deps.keybindings.matches(data, "tui.altScreen.pageUp") ||
		deps.keybindings.matches(data, "tui.altScreen.pageDown") ||
		deps.keybindings.matches(data, "tui.editor.pageUp") ||
		deps.keybindings.matches(data, "tui.editor.pageDown")
	) {
		return "scroll";
	}
	if (deps.overlay.getState() !== "closed") return "overlay";
	return "editor";
}

/** Operator-facing scope names; overlay state IDs stay inside routing. */
function overlayScopeLabel(state: OverlayState): string {
	const names: Record<OverlayState, string> = {
		closed: "Composer",
		"permission-confirm": "Permission",
		"dispatch-board": "Workers",
		auth: "Authentication",
		cost: "Usage",
		"context-view": "Context",
		"context-reset": "Context reset",
		tasks: "Tasks",
		decisions: "Decisions",
		memory: "Memory",
		view: "View",
		model: "Model",
		"model-scope": "Model cycle set",
		settings: "Settings",
		resume: "Resume",
		tree: "Session tree",
		"message-picker": "Messages",
		"cwd-fallback": "Working directory",
		"ask-user": "Interview",
		help: "Help",
		extensions: "Extensions",
		interop: "Interop",
		"skills-hub": "Library",
		"side-question": "Side question",
		"handoff-review": "Handoff review",
		"fleet-run-approval": "Run approval",
	};
	return names[state];
}
