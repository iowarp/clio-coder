import { appendNotice } from "./command-output.js";
import { createOverlayAskUserLifecycle, type OverlayAskUserLifecycle } from "./overlay-ask-user-lifecycle.js";
import { createOverlayAuthLifecycle } from "./overlay-auth-lifecycle.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { createOverlayGeneralOpeners } from "./overlay-general-openers.js";
import { createOverlayModelSelectors } from "./overlay-model-selectors.js";
import { createOverlayPermissionLifecycle, type OverlayPermissionLifecycle } from "./overlay-permission-lifecycle.js";
import { createOverlayResourceOpeners } from "./overlay-resource-openers.js";
import { createOverlaySessionLifecycle } from "./overlay-session-lifecycle.js";
import { createOverlayTransitions } from "./overlay-transitions.js";
import {
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayHint,
	permissionOverlayTitle,
} from "./permission-overlay.js";

export * from "./overlay-key-routing.js";

import type { OverlayState } from "./overlay-key-routing.js";
import type { SettingsCenterRowId, SettingsSectionId } from "./overlays/settings.js";

// Runtime lifecycle construction lives beside the pure modal key router so the
// application composition root no longer owns the mutable overlay state.
export type OverlayLifecycleApplicationDeps = Pick<
	import("./interactive-application.js").InteractiveDeps,
	| "bus"
	| "chat"
	| "commitSetting"
	| "dataDir"
	| "dispatch"
	| "getFleetNodes"
	| "getSessionId"
	| "getSettings"
	| "getTaskBoard"
	| "userTasks"
	| "getDecisionBoard"
	| "getTaskMemoryStatus"
	| "interop"
	| "observability"
	| "onContextClear"
	| "onForkSession"
	| "onResumeSession"
	| "onSelectModel"
	| "providers"
	| "readSessionEntries"
	| "registerAskUserHandler"
	| "resources"
	| "session"
	| "stateDir"
	| "supersedeDecision"
	| "toolRegistry"
	| "writeSettings"
>;

/** Pending proposals from the report this process already holds; the picker never probes. */
function interopProposalsFor(
	interop: NonNullable<OverlayLifecycleApplicationDeps["interop"]>,
): () => ReadonlyArray<import("../domains/interop/index.js").InteropProposal> {
	return () => {
		const report = interop.lastReport();
		return report === null ? [] : interop.proposals(report);
	};
}

export interface OverlayLifecycleRuntimeDeps {
	app: OverlayLifecycleApplicationDeps;
	tui: import("../engine/tui.js").TUI;
	footer: import("./footer/dashboard.js").FooterDashboardPanel;
	interactiveTickers: import("./interactive-tickers.js").InteractiveTickers;
	busNoticeSink: Parameters<typeof import("./command-output.js").appendNotice>[2];
	chatRenderer: { applyEvent(event: import("./chat-loop.js").ToolApprovalStateEvent): void };
	notify: (level: import("./interactive-subscriptions.js").InteractiveNoticeLevel, text: string, key?: string) => void;
	terminal: Pick<import("../engine/tui.js").ProcessTerminal, "columns">;
	dispatchBoard: ReturnType<typeof import("./dispatch-board.js").createDispatchBoardView>;
	chatPanel: import("./chat-panel.js").ChatPanel;
	/** Clears the transcript and every view folded alongside it; the session overlays call it before a replay. */
	resetTranscript: () => void;
	io: import("./slash-commands.js").RunIo;
	readStructuredEntries: (sessionId: string) => import("../domains/session/index.js").SessionEntry[];
	announceTaskMemorySeedOffer: () => void;
	/** Rescopes the footer's last-turn line when a session overlay changes the branch. */
	setLastTurnSummary?: (summary: import("./status/index.js").TurnSummary | null) => void;
	keybindings: ReturnType<typeof import("./keybinding-manager.js").createKeybindingManager>;
	editor: Pick<import("./clio-editor.js").ClioEditor, "getText" | "setText">;
	getSlashContext: () => import("./slash-commands.js").SlashCommandContext;
	showOverlayFrame?: typeof showClioOverlayFrame;
	openAuthDialog?: typeof import("./overlays/auth-dialog.js").openAuthDialog;
	openAskUserOverlay?: typeof import("./overlays/ask-user.js").openAskUserOverlay;
	openModelOverlay?: typeof import("./overlays/model-selector.js").openModelOverlay;
	openSettingsOverlay?: typeof import("./overlays/settings.js").openSettingsOverlay;
	openSessionOverlay?: typeof import("./overlays/session-selector.js").openSessionOverlay;
	openTreeOverlay?: typeof import("./overlays/tree-selector.js").openTreeOverlay;
	openMessagePickerOverlay?: typeof import("./overlays/message-picker.js").openMessagePickerOverlay;
	openCwdFallbackOverlay?: typeof import("./overlays/cwd-fallback.js").openCwdFallbackOverlay;
	openCostOverlay?: typeof import("./cost-overlay.js").openCostOverlay;
	openContextOverlay?: typeof import("./context-overlay.js").openContextOverlay;
	openContextResetOverlay?: typeof import("./overlays/context-reset.js").openContextResetOverlay;
	openTasksOverlay?: typeof import("./tasks-overlay.js").openTasksOverlay;
	openDecisionsOverlay?: typeof import("./overlays/decisions.js").openDecisionsOverlay;
	openMemoryOverlay?: typeof import("./memory-overlay.js").openMemoryOverlay;
	openViewOverlay?: typeof import("./view/view-overlay.js").openViewOverlay;
	openHelpOverlay?: typeof import("./overlays/help-reference.js").openHelpOverlay;
	openAgentsOverlay?: typeof import("./overlays/agents.js").openAgentsOverlay;
	openSkillsHub?: typeof import("./overlays/skills-hub.js").openSkillsHub;
	openPromptsOverlay?: typeof import("./overlays/prompts.js").openPromptsOverlay;
	openExtensionsOverlay?: typeof import("./overlays/extensions.js").openExtensionsOverlay;
	openInteropOverlay?: typeof import("./overlays/interop.js").openInteropOverlay;
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
	openCostOverlayState(): void;
	openContextViewOverlayState(): void;
	openContextResetOverlayState(): void;
	toggleFooterDashboardState(): void;
	openTasksOverlayState(): void;
	openDecisionsOverlayState(): void;
	openMemoryOverlayState(): void;
	openViewOverlayState(initialFilter?: string): void;
	openModelOverlayState(): void;
	openSettingsOverlayState(section?: SettingsSectionId, rowId?: SettingsCenterRowId): void;
	openResumeOverlayState(): void;
	openTreeOverlayState(): void;
	openMessagePickerOverlayState(): void;
	openHelpOverlayState(query?: string): void;
	openAgentsOverlayState(): void;
	openSkillsHubState(): void;
	openPromptsOverlayState(): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
	toggleDispatchBoardOverlay(): void;
	confirmPermission(): void;
	stopTurnFromPermission(): void;
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
		resetTranscript,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		setLastTurnSummary,
		keybindings,
		editor,
		showOverlayFrame = showClioOverlayFrame,
		openAuthDialog: openAuthDialogFactory,
		openAskUserOverlay: openAskUserOverlayFactory,
		openModelOverlay: openModelOverlayFactory,
		openSettingsOverlay: openSettingsOverlayFactory,
		openSessionOverlay: openSessionOverlayFactory,
		openTreeOverlay: openTreeOverlayFactory,
		openMessagePickerOverlay: openMessagePickerOverlayFactory,
		openCwdFallbackOverlay: openCwdFallbackOverlayFactory,
		openCostOverlay: openCostOverlayFactory,
		openContextOverlay: openContextOverlayFactory,
		openContextResetOverlay: openContextResetOverlayFactory,
		openTasksOverlay: openTasksOverlayFactory,
		openDecisionsOverlay: openDecisionsOverlayFactory,
		openMemoryOverlay: openMemoryOverlayFactory,
		openViewOverlay: openViewOverlayFactory,
		openHelpOverlay: openHelpOverlayFactory,
		openAgentsOverlay: openAgentsOverlayFactory,
		openSkillsHub: openSkillsHubFactory,
		openPromptsOverlay: openPromptsOverlayFactory,
		openExtensionsOverlay: openExtensionsOverlayFactory,
		openInteropOverlay: openInteropOverlayFactory,
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
		onOverlayClosed: () => overlayPermission?.retryPending(),
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
				// Read per frame: the footer names what Enter does right now, and
				// that depends on whether the composer holds a draft.
				footerHint: (innerWidth) => permissionOverlayHint(innerWidth, editor.getText().length > 0),
			});
			tui.requestRender();
			return true;
		},
		closeOverlay,
		appendNotice: (level, text) => appendNotice(level, text, busNoticeSink),
		applyApprovalState: (event) => chatRenderer.applyEvent(event),
		requestRender: () => tui.requestRender(),
		// An operator cancel, audited as one. The reason distinguishes it from an
		// Esc or Ctrl-C in the audit trail without inventing a new abort source.
		stopActiveTurn: (reason) =>
			deps.app.chat.cancel({
				reason,
				source: "stream_cancel",
				auditReason: "operator stopped the turn at a permission prompt",
			}),
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
		...(deps.app.getFleetNodes ? { getFleetNodes: deps.app.getFleetNodes } : {}),
		connectTarget: (targetId) => overlayAuth.openConnectFlow(targetId),
		...(deps.app.interop ? { getInteropProposals: interopProposalsFor(deps.app.interop) } : {}),
		...(openModelOverlayFactory ? { openModelOverlay: openModelOverlayFactory } : {}),
		...(openSettingsOverlayFactory ? { openSettingsOverlay: openSettingsOverlayFactory } : {}),
	});

	const overlayResourceOpeners = createOverlayResourceOpeners({
		tui,
		transitions: overlayTransitions,
		keybindings,
		editor,
		getSlashContext: deps.getSlashContext,
		...(deps.app.resources ? { resources: deps.app.resources } : {}),
		closeOverlay,
		...(openHelpOverlayFactory ? { openHelpOverlay: openHelpOverlayFactory } : {}),
		...(openAgentsOverlayFactory ? { openAgentsOverlay: openAgentsOverlayFactory } : {}),
		...(openSkillsHubFactory ? { openSkillsHub: openSkillsHubFactory } : {}),
		...(openPromptsOverlayFactory ? { openPromptsOverlay: openPromptsOverlayFactory } : {}),
		...(openExtensionsOverlayFactory ? { openExtensionsOverlay: openExtensionsOverlayFactory } : {}),
		...(openInteropOverlayFactory ? { openInteropOverlay: openInteropOverlayFactory } : {}),
	});

	const overlaySessions = createOverlaySessionLifecycle({
		tui,
		transitions: overlayTransitions,
		...(deps.app.session ? { session: deps.app.session } : {}),
		chat: deps.app.chat,
		chatPanel,
		resetTranscript,
		readStructuredEntries,
		getSlashNotice: () => deps.getSlashContext().notice,
		...(deps.app.onResumeSession ? { onResumeSession: deps.app.onResumeSession } : {}),
		...(deps.app.onForkSession ? { onForkSession: deps.app.onForkSession } : {}),
		announceTaskMemorySeedOffer,
		sessionUsage: deps.app.observability,
		...(setLastTurnSummary ? { setLastTurnSummary } : {}),
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
		...(deps.app.userTasks ? { userTasks: deps.app.userTasks } : {}),
		...(deps.app.getDecisionBoard ? { getDecisionBoard: deps.app.getDecisionBoard } : {}),
		...(deps.app.supersedeDecision ? { supersedeDecision: deps.app.supersedeDecision } : {}),
		submitChat: (text) => deps.getSlashContext().submitChat(text),
		...(deps.app.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.app.getTaskMemoryStatus } : {}),
		dataDir: deps.app.dataDir,
		notify,
		dispatch: deps.app.dispatch,
		stateDir: deps.app.stateDir,
		getSessionMeta: () => deps.app.session?.current() ?? null,
		...(deps.app.readSessionEntries ? { readSessionEntries: deps.app.readSessionEntries } : {}),
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		terminal,
		dispatchBoard,
		startDispatchBoardTicker: () => interactiveTickers.startDispatchBoardTicker(),
		closeOverlay,
		showOverlayFrame,
		...(openCostOverlayFactory ? { openCostOverlay: openCostOverlayFactory } : {}),
		...(openContextOverlayFactory ? { openContextOverlay: openContextOverlayFactory } : {}),
		...(openContextResetOverlayFactory ? { openContextResetOverlay: openContextResetOverlayFactory } : {}),
		...(openTasksOverlayFactory ? { openTasksOverlay: openTasksOverlayFactory } : {}),
		...(openDecisionsOverlayFactory ? { openDecisionsOverlay: openDecisionsOverlayFactory } : {}),
		...(openMemoryOverlayFactory ? { openMemoryOverlay: openMemoryOverlayFactory } : {}),
		...(openViewOverlayFactory ? { openViewOverlay: openViewOverlayFactory } : {}),
	});

	const openResumeOverlayState = overlaySessions.openResume;
	const openTreeOverlayState = overlaySessions.openTree;
	const openMessagePickerOverlayState = overlaySessions.openMessagePicker;
	const openCostOverlayState = overlayGeneralOpeners.openCost;
	const openContextViewOverlayState = overlayGeneralOpeners.openContextView;
	const openContextResetOverlayState = overlayGeneralOpeners.openContextReset;
	const toggleFooterDashboardState = overlayGeneralOpeners.toggleFooter;
	const openTasksOverlayState = overlayGeneralOpeners.openTasks;
	const openDecisionsOverlayState = overlayGeneralOpeners.openDecisions;
	const openMemoryOverlayState = overlayGeneralOpeners.openMemory;
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
		openCostOverlayState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		toggleFooterDashboardState,
		openTasksOverlayState,
		openDecisionsOverlayState,
		openMemoryOverlayState,
		openViewOverlayState,
		openModelOverlayState: overlayModelSelectors.openModelOverlayState,
		openSettingsOverlayState: overlayModelSelectors.openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState: overlayResourceOpeners.openHelpOverlayState,
		openAgentsOverlayState: overlayResourceOpeners.openAgentsOverlayState,
		openSkillsHubState: overlayResourceOpeners.openSkillsHubState,
		openPromptsOverlayState: overlayResourceOpeners.openPromptsOverlayState,
		openExtensionsOverlayState: overlayResourceOpeners.openExtensionsOverlayState,
		openInteropOverlayState: overlayResourceOpeners.openInteropOverlayState,
		toggleDispatchBoardOverlay,
		confirmPermission: () => {
			overlayPermission?.confirm();
			footer.refresh();
			tui.requestRender();
		},
		stopTurnFromPermission: () => {
			overlayPermission?.stopTurn();
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
