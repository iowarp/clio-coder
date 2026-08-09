import { appendNotice } from "./command-output.js";
import { createOverlayAskUserLifecycle, type OverlayAskUserLifecycle } from "./overlay-ask-user-lifecycle.js";
import { createOverlayAuthLifecycle } from "./overlay-auth-lifecycle.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { createOverlayGeneralOpeners } from "./overlay-general-openers.js";
import { createOverlayModelSelectors } from "./overlay-model-selectors.js";
import { createOverlayPermissionLifecycle, type OverlayPermissionLifecycle } from "./overlay-permission-lifecycle.js";
import { createOverlayResourceOpeners } from "./overlay-resource-openers.js";
import { createOverlaySessionLifecycle } from "./overlay-session-lifecycle.js";
import { createOverlayTransitions } from "./overlay-transitions.js";
import { createPermissionOverlayBody, PERMISSION_OVERLAY_WIDTH, permissionOverlayTitle } from "./permission-overlay.js";
import { openProvidersOverlay } from "./providers-overlay.js";

export * from "./overlay-key-routing.js";

import type { OverlayState } from "./overlay-key-routing.js";

// Runtime lifecycle construction lives beside the pure modal key router so the
// application composition root no longer owns the mutable overlay state.
export type OverlayLifecycleApplicationDeps = Pick<
	import("./interactive-application.js").InteractiveDeps,
	| "agents"
	| "bus"
	| "cacheDir"
	| "chat"
	| "commitSetting"
	| "dataDir"
	| "dispatch"
	| "getFleetNodes"
	| "getSessionId"
	| "getSettings"
	| "getTaskBoard"
	| "getTaskMemoryStatus"
	| "observability"
	| "onContextClear"
	| "onForkSession"
	| "onResumeSession"
	| "onSelectModel"
	| "onSetScope"
	| "onSetThinkingLevel"
	| "providers"
	| "readSessionEntries"
	| "registerAskUserHandler"
	| "resources"
	| "session"
	| "stateDir"
	| "toolRegistry"
	| "writeSettings"
>;

export interface OverlayLifecycleRuntimeDeps {
	app: OverlayLifecycleApplicationDeps;
	tui: import("../engine/tui.js").TUI;
	footer: import("./footer/dashboard.js").FooterDashboardPanel;
	interactiveTickers: import("./interactive-tickers.js").InteractiveTickers;
	busNoticeSink: Parameters<typeof import("./command-output.js").appendNotice>[2];
	chatRenderer: { applyEvent(event: import("./chat-loop.js").ToolApprovalStateEvent): void };
	notify: (level: import("./providers-overlay.js").TargetsHubNoticeLevel, text: string, key?: string) => void;
	terminal: Pick<import("../engine/tui.js").ProcessTerminal, "columns">;
	dispatchBoard: ReturnType<typeof import("./dispatch-board.js").createDispatchBoardView>;
	getObservabilitySnapshot: () => import("../domains/observability/index.js").ObservabilitySnapshot;
	chatPanel: import("./chat-panel.js").ChatPanel;
	io: import("./slash-commands.js").RunIo;
	readStructuredEntries: (sessionId: string) => import("../domains/session/index.js").SessionEntry[];
	announceTaskMemorySeedOffer: () => void;
	keybindings: ReturnType<typeof import("./keybinding-manager.js").createKeybindingManager>;
	editor: Pick<import("./clio-editor.js").ClioEditor, "getText" | "setText">;
	getSlashContext: () => import("./slash-commands.js").SlashCommandContext;
	showOverlayFrame?: typeof showClioOverlayFrame;
	openAuthDialog?: typeof import("./overlays/auth-dialog.js").openAuthDialog;
	openProvidersOverlay?: typeof openProvidersOverlay;
	openAskUserOverlay?: typeof import("./overlays/ask-user.js").openAskUserOverlay;
	openThinkingOverlay?: typeof import("./overlays/thinking-selector.js").openThinkingOverlay;
	openModelOverlay?: typeof import("./overlays/model-selector.js").openModelOverlay;
	openScopedOverlay?: typeof import("./overlays/scoped-models.js").openScopedOverlay;
	openSettingsOverlay?: typeof import("./overlays/settings.js").openSettingsOverlay;
	openSessionOverlay?: typeof import("./overlays/session-selector.js").openSessionOverlay;
	openTreeOverlay?: typeof import("./overlays/tree-selector.js").openTreeOverlay;
	openMessagePickerOverlay?: typeof import("./overlays/message-picker.js").openMessagePickerOverlay;
	openCwdFallbackOverlay?: typeof import("./overlays/cwd-fallback.js").openCwdFallbackOverlay;
	openCostOverlay?: typeof import("./cost-overlay.js").openCostOverlay;
	openContextOverlay?: typeof import("./context-overlay.js").openContextOverlay;
	openContextResetOverlay?: typeof import("./overlays/context-reset.js").openContextResetOverlay;
	openTasksOverlay?: typeof import("./tasks-overlay.js").openTasksOverlay;
	openMemoryOverlay?: typeof import("./memory-overlay.js").openMemoryOverlay;
	openFleetOverlay?: typeof import("./fleet-overlay.js").openFleetOverlay;
	openViewOverlay?: typeof import("./view/view-overlay.js").openViewOverlay;
	openHelpOverlay?: typeof import("./overlays/help-reference.js").openHelpOverlay;
	openAgentsOverlay?: typeof import("./overlays/agents.js").openAgentsOverlay;
	openSkillsHub?: typeof import("./overlays/skills-hub.js").openSkillsHub;
	openPromptsOverlay?: typeof import("./overlays/prompts.js").openPromptsOverlay;
	openExtensionsOverlay?: typeof import("./overlays/extensions.js").openExtensionsOverlay;
}

export interface OverlayLifecycleController {
	getState(): OverlayState;
	closeOverlay(): void;
	finishAuthOverlay(dismiss: boolean): void;
	openAskUserOverlayState: import("../tools/ask-user.js").AskUserHandler;
	closeAskUserSession(): void;
	isAskUserWaiting(): boolean;
	resetAskUserCancellation(): void;
	refreshSettingsOverlay(): void;
	openProvidersOverlayState(): void;
	openCostOverlayState(): void;
	openContextViewOverlayState(): void;
	openContextResetOverlayState(): void;
	toggleFooterDashboardState(): void;
	openTasksOverlayState(): void;
	openMemoryOverlayState(): void;
	openFleetOverlayState(): void;
	openViewOverlayState(initialFilter?: string): void;
	openThinkingOverlayState(): void;
	openModelOverlayState(): void;
	openScopedModelsOverlayState(): void;
	openSettingsOverlayState(): void;
	openResumeOverlayState(): void;
	openTreeOverlayState(): void;
	openMessagePickerOverlayState(): void;
	openHelpOverlayState(query?: string): void;
	openAgentsOverlayState(): void;
	openSkillsHubState(): void;
	openPromptsOverlayState(): void;
	openExtensionsOverlayState(): void;
	toggleDispatchBoardOverlay(): void;
	confirmPermission(): void;
	cancelAskUser(): void;
	dispose(): void;
}

export function createOverlayLifecycle(deps: OverlayLifecycleRuntimeDeps): OverlayLifecycleController {
	const {
		tui,
		footer,
		interactiveTickers,
		busNoticeSink,
		chatRenderer,
		notify,
		terminal,
		dispatchBoard,
		chatPanel,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		keybindings,
		editor,
		showOverlayFrame = showClioOverlayFrame,
		openAuthDialog: openAuthDialogFactory,
		openProvidersOverlay: openProvidersOverlayFactory = openProvidersOverlay,
		openAskUserOverlay: openAskUserOverlayFactory,
		openThinkingOverlay: openThinkingOverlayFactory,
		openModelOverlay: openModelOverlayFactory,
		openScopedOverlay: openScopedOverlayFactory,
		openSettingsOverlay: openSettingsOverlayFactory,
		openSessionOverlay: openSessionOverlayFactory,
		openTreeOverlay: openTreeOverlayFactory,
		openMessagePickerOverlay: openMessagePickerOverlayFactory,
		openCwdFallbackOverlay: openCwdFallbackOverlayFactory,
		openCostOverlay: openCostOverlayFactory,
		openContextOverlay: openContextOverlayFactory,
		openContextResetOverlay: openContextResetOverlayFactory,
		openTasksOverlay: openTasksOverlayFactory,
		openMemoryOverlay: openMemoryOverlayFactory,
		openFleetOverlay: openFleetOverlayFactory,
		openViewOverlay: openViewOverlayFactory,
		openHelpOverlay: openHelpOverlayFactory,
		openAgentsOverlay: openAgentsOverlayFactory,
		openSkillsHub: openSkillsHubFactory,
		openPromptsOverlay: openPromptsOverlayFactory,
		openExtensionsOverlay: openExtensionsOverlayFactory,
	} = deps;
	let overlayPermission: OverlayPermissionLifecycle | null = null;
	let overlayAskUser: OverlayAskUserLifecycle | null = null;
	const overlayTransitions = createOverlayTransitions({
		stopDispatchBoardTicker: () => interactiveTickers.stopDispatchBoardTicker(),
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		cancelPendingAskUser: () => overlayAskUser?.cancelPending() ?? false,
		finishAuth: (dismiss) => overlayAuth.finish(dismiss),
		onPermissionOverlayClosed: () => overlayPermission?.onPermissionOverlayClosed(),
	});
	const closeOverlay = overlayTransitions.close;

	const overlayAuth = createOverlayAuthLifecycle({
		tui,
		providers: deps.app.providers,
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		notify,
		refreshFooter: () => footer.refresh(),
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		getOverlayState: () => overlayTransitions.state,
		setOverlayState: (state) => {
			overlayTransitions.state = state;
		},
		getOverlayHandle: () => overlayTransitions.handle,
		setOverlayHandle: (handle) => {
			overlayTransitions.handle = handle;
		},
		...(openAuthDialogFactory ? { openAuthDialog: openAuthDialogFactory } : {}),
	});

	overlayPermission = createOverlayPermissionLifecycle({
		...(deps.app.toolRegistry ? { toolRegistry: deps.app.toolRegistry } : {}),
		bus: deps.app.bus,
		dispatch: deps.app.dispatch,
		getAutonomy: () => deps.app.getSettings?.().autonomy ?? "auto-edit",
		getOverlayState: () => overlayTransitions.state,
		openPermissionOverlay: (view) => {
			if (overlayTransitions.state !== "closed") return false;
			overlayTransitions.state = "permission-confirm";
			overlayTransitions.handle = showOverlayFrame(tui, createPermissionOverlayBody(view), {
				anchor: "center",
				width: PERMISSION_OVERLAY_WIDTH,
				title: permissionOverlayTitle(),
				footerHint: buildHint("commit", [{ key: "Enter", verb: "allow once" }]),
			});
			tui.requestRender();
			return true;
		},
		closeOverlay,
		appendNotice: (level, text) => appendNotice(level, text, busNoticeSink),
		applyApprovalState: (event) => chatRenderer.applyEvent(event),
		requestRender: () => tui.requestRender(),
	});

	overlayAskUser = createOverlayAskUserLifecycle({
		tui,
		getOverlayState: () => overlayTransitions.state,
		setOverlayState: (state) => {
			overlayTransitions.state = state;
		},
		getOverlayHandle: () => overlayTransitions.handle,
		setOverlayHandle: (handle) => {
			overlayTransitions.handle = handle;
		},
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		...(deps.app.registerAskUserHandler ? { registerHandler: deps.app.registerAskUserHandler } : {}),
		...(openAskUserOverlayFactory ? { openAskUserOverlay: openAskUserOverlayFactory } : {}),
	});

	const overlayModelSelectors = createOverlayModelSelectors({
		tui,
		transitions: overlayTransitions,
		providers: deps.app.providers,
		bus: deps.app.bus,
		refreshFooter: () => footer.refresh(),
		notify,
		closeOverlay,
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		...(deps.app.writeSettings ? { writeSettings: deps.app.writeSettings } : {}),
		...(deps.app.commitSetting ? { commitSetting: deps.app.commitSetting } : {}),
		...(deps.app.onSelectModel ? { onSelectModel: deps.app.onSelectModel } : {}),
		...(deps.app.onSetScope ? { onSetScope: deps.app.onSetScope } : {}),
		...(deps.app.onSetThinkingLevel ? { onSetThinkingLevel: deps.app.onSetThinkingLevel } : {}),
		...(openThinkingOverlayFactory ? { openThinkingOverlay: openThinkingOverlayFactory } : {}),
		...(openModelOverlayFactory ? { openModelOverlay: openModelOverlayFactory } : {}),
		...(openScopedOverlayFactory ? { openScopedOverlay: openScopedOverlayFactory } : {}),
		...(openSettingsOverlayFactory ? { openSettingsOverlay: openSettingsOverlayFactory } : {}),
	});

	const overlayResourceOpeners = createOverlayResourceOpeners({
		tui,
		transitions: overlayTransitions,
		keybindings,
		editor,
		getSlashContext: deps.getSlashContext,
		cacheDir: deps.app.cacheDir,
		...(deps.app.resources ? { resources: deps.app.resources } : {}),
		closeOverlay,
		...(openHelpOverlayFactory ? { openHelpOverlay: openHelpOverlayFactory } : {}),
		...(openAgentsOverlayFactory ? { openAgentsOverlay: openAgentsOverlayFactory } : {}),
		...(openSkillsHubFactory ? { openSkillsHub: openSkillsHubFactory } : {}),
		...(openPromptsOverlayFactory ? { openPromptsOverlay: openPromptsOverlayFactory } : {}),
		...(openExtensionsOverlayFactory ? { openExtensionsOverlay: openExtensionsOverlayFactory } : {}),
	});

	const overlaySessions = createOverlaySessionLifecycle({
		tui,
		transitions: overlayTransitions,
		...(deps.app.session ? { session: deps.app.session } : {}),
		chat: deps.app.chat,
		chatPanel,
		readStructuredEntries,
		getSlashNotice: () => deps.getSlashContext().notice,
		...(deps.app.onResumeSession ? { onResumeSession: deps.app.onResumeSession } : {}),
		...(deps.app.onForkSession ? { onForkSession: deps.app.onForkSession } : {}),
		announceTaskMemorySeedOffer,
		refreshFooter: () => footer.refresh(),
		requestRender: () => tui.requestRender(),
		stderr: (text) => io.stderr(text),
		notify,
		...(openSessionOverlayFactory ? { openSessionOverlay: openSessionOverlayFactory } : {}),
		...(openTreeOverlayFactory ? { openTreeOverlay: openTreeOverlayFactory } : {}),
		...(openMessagePickerOverlayFactory ? { openMessagePickerOverlay: openMessagePickerOverlayFactory } : {}),
		...(openCwdFallbackOverlayFactory ? { openCwdFallbackOverlay: openCwdFallbackOverlayFactory } : {}),
	});

	const overlayGeneralOpeners = createOverlayGeneralOpeners({
		tui,
		transitions: overlayTransitions,
		observability: deps.app.observability,
		...(deps.app.getSessionId ? { getSessionId: deps.app.getSessionId } : {}),
		getContextLedger: () => deps.app.chat.contextLedger(),
		contextChat: deps.app.chat,
		bus: deps.app.bus,
		...(deps.app.onContextClear ? { onContextClear: deps.app.onContextClear } : {}),
		stderr: (text) => io.stderr(text),
		refreshFooter: () => footer.refresh(),
		toggleFooter: () => footer.toggleExpanded(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		...(deps.app.getTaskBoard ? { getTaskBoard: deps.app.getTaskBoard } : {}),
		...(deps.app.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.app.getTaskMemoryStatus } : {}),
		dataDir: deps.app.dataDir,
		notify,
		dispatch: deps.app.dispatch,
		providers: deps.app.providers,
		getObservabilitySnapshot: deps.getObservabilitySnapshot,
		...(deps.app.agents ? { agents: deps.app.agents } : {}),
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		...(deps.app.getFleetNodes ? { getFleetNodes: deps.app.getFleetNodes } : {}),
		...(deps.app.writeSettings ? { writeSettings: deps.app.writeSettings } : {}),
		stateDir: deps.app.stateDir,
		getSessionMeta: () => deps.app.session?.current() ?? null,
		...(deps.app.readSessionEntries ? { readSessionEntries: deps.app.readSessionEntries } : {}),
		terminal,
		dispatchBoard,
		startDispatchBoardTicker: () => interactiveTickers.startDispatchBoardTicker(),
		closeOverlay,
		showOverlayFrame,
		...(openCostOverlayFactory ? { openCostOverlay: openCostOverlayFactory } : {}),
		...(openContextOverlayFactory ? { openContextOverlay: openContextOverlayFactory } : {}),
		...(openContextResetOverlayFactory ? { openContextResetOverlay: openContextResetOverlayFactory } : {}),
		...(openTasksOverlayFactory ? { openTasksOverlay: openTasksOverlayFactory } : {}),
		...(openMemoryOverlayFactory ? { openMemoryOverlay: openMemoryOverlayFactory } : {}),
		...(openFleetOverlayFactory ? { openFleetOverlay: openFleetOverlayFactory } : {}),
		...(openViewOverlayFactory ? { openViewOverlay: openViewOverlayFactory } : {}),
	});

	const openProvidersOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "providers";
		overlayTransitions.handle = openProvidersOverlayFactory(tui, deps.app.providers, {
			bus: deps.app.bus,
			...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
			...(deps.app.writeSettings
				? {
						writeSettings: (next) => {
							deps.app.writeSettings?.(next);
							footer.refresh();
						},
					}
				: {}),
			connectTarget: (targetId) => overlayAuth.openConnectFlow(targetId),
			notice: notify,
		});
		tui.requestRender();
	};

	const openResumeOverlayState = overlaySessions.openResume;
	const openTreeOverlayState = overlaySessions.openTree;
	const openMessagePickerOverlayState = overlaySessions.openMessagePicker;
	const openCostOverlayState = overlayGeneralOpeners.openCost;
	const openContextViewOverlayState = overlayGeneralOpeners.openContextView;
	const openContextResetOverlayState = overlayGeneralOpeners.openContextReset;
	const toggleFooterDashboardState = overlayGeneralOpeners.toggleFooter;
	const openTasksOverlayState = overlayGeneralOpeners.openTasks;
	const openMemoryOverlayState = overlayGeneralOpeners.openMemory;
	const openFleetOverlayState = overlayGeneralOpeners.openFleet;
	const openViewOverlayState = overlayGeneralOpeners.openView;
	const toggleDispatchBoardOverlay = overlayGeneralOpeners.toggleDispatchBoard;

	return {
		getState: () => overlayTransitions.state,
		closeOverlay,
		finishAuthOverlay: overlayAuth.finish,
		openAskUserOverlayState: overlayAskUser.handler,
		closeAskUserSession: overlayAskUser.close,
		isAskUserWaiting: overlayAskUser.isWaiting,
		resetAskUserCancellation: overlayAskUser.resetCancellation,
		refreshSettingsOverlay: overlayModelSelectors.refreshSettingsOverlay,
		openProvidersOverlayState,
		openCostOverlayState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		toggleFooterDashboardState,
		openTasksOverlayState,
		openMemoryOverlayState,
		openFleetOverlayState,
		openViewOverlayState,
		openThinkingOverlayState: overlayModelSelectors.openThinkingOverlayState,
		openModelOverlayState: overlayModelSelectors.openModelOverlayState,
		openScopedModelsOverlayState: overlayModelSelectors.openScopedModelsOverlayState,
		openSettingsOverlayState: overlayModelSelectors.openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState: overlayResourceOpeners.openHelpOverlayState,
		openAgentsOverlayState: overlayResourceOpeners.openAgentsOverlayState,
		openSkillsHubState: overlayResourceOpeners.openSkillsHubState,
		openPromptsOverlayState: overlayResourceOpeners.openPromptsOverlayState,
		openExtensionsOverlayState: overlayResourceOpeners.openExtensionsOverlayState,
		toggleDispatchBoardOverlay,
		confirmPermission: () => {
			overlayPermission?.confirm();
			footer.refresh();
			tui.requestRender();
		},
		cancelAskUser: overlayAskUser.cancel,
		dispose: () => {
			overlayPermission?.dispose();
			overlayAskUser?.dispose();
		},
	};
}
