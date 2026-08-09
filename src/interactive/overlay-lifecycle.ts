import { loadMemoryRecordsSync, type MemoryRecord } from "../domains/memory/index.js";
import { installSkill } from "../domains/resources/skills/marketplace.js";
import { appendNotice } from "./command-output.js";
import { openContextOverlay } from "./context-overlay.js";
import { openCostOverlay } from "./cost-overlay.js";
import { isDispatchBoardRowCancellable, isDispatchBoardRowSteerable } from "./dispatch-board.js";
import { openFleetOverlay } from "./fleet-overlay.js";
import { openMemoryOverlay } from "./memory-overlay.js";
import { createOverlayAskUserLifecycle, type OverlayAskUserLifecycle } from "./overlay-ask-user-lifecycle.js";
import { createOverlayAuthLifecycle } from "./overlay-auth-lifecycle.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { createOverlayModelSelectors } from "./overlay-model-selectors.js";
import { createOverlayPermissionLifecycle, type OverlayPermissionLifecycle } from "./overlay-permission-lifecycle.js";
import { createOverlaySessionLifecycle } from "./overlay-session-lifecycle.js";
import { createOverlayTransitions } from "./overlay-transitions.js";
import { openAgentsOverlay } from "./overlays/agents.js";
import { contextResetOptions, openContextResetOverlay } from "./overlays/context-reset.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openPromptsOverlay } from "./overlays/prompts.js";
import { openSkillsHub } from "./overlays/skills-hub.js";
import { createPermissionOverlayBody, PERMISSION_OVERLAY_WIDTH, permissionOverlayTitle } from "./permission-overlay.js";
import { openProvidersOverlay } from "./providers-overlay.js";
import { openTasksOverlay } from "./tasks-overlay.js";
import { createDefaultArtifactProviders } from "./view/artifacts.js";
import { openViewOverlay } from "./view/view-overlay.js";

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

	const openCostOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "cost";
		overlayTransitions.handle = openCostOverlay(tui, deps.app.observability, {
			sessionId: deps.app.getSessionId?.() ?? null,
		});
		tui.requestRender();
	};

	const openContextViewOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "context-view";
		overlayTransitions.handle = openContextOverlay(tui, () => deps.app.chat.contextLedger(), {
			bus: deps.app.bus,
			chat: deps.app.chat,
		});
		tui.requestRender();
	};

	const openContextResetOverlayState = (): void => {
		if (overlayTransitions.state !== "closed" || !deps.app.onContextClear) return;
		overlayTransitions.state = "context-reset";
		overlayTransitions.handle = openContextResetOverlay(tui, {
			onReset: (choice) => {
				closeOverlay();
				const onContextClear = deps.app.onContextClear;
				if (!onContextClear) return;
				void Promise.resolve()
					.then(() => onContextClear(contextResetOptions(choice)))
					.catch((err) => {
						const msg = err instanceof Error ? err.message : String(err);
						io.stderr(`[/context reset] ${msg}\n`);
					})
					.finally(() => {
						footer.refresh();
						tui.requestRender();
					});
			},
			onCancel: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const toggleFooterDashboardState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		footer.toggleExpanded();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const openTasksOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "tasks";
		overlayTransitions.handle = openTasksOverlay(tui, () => deps.app.getTaskBoard?.() ?? null, {
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMemoryOverlayState = (): void => {
		if (overlayTransitions.state !== "closed" || !deps.app.getTaskMemoryStatus) return;
		let records: MemoryRecord[] = [];
		try {
			records = loadMemoryRecordsSync(deps.app.dataDir);
		} catch (error) {
			notify(
				"warning",
				`memory: durable lessons unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"memory:durable-read",
			);
		}
		overlayTransitions.state = "memory";
		overlayTransitions.handle = openMemoryOverlay(tui, deps.app.getTaskMemoryStatus, () => records, {
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openFleetOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "fleet";
		overlayTransitions.handle = openFleetOverlay(tui, deps.app.dispatch, {
			bus: deps.app.bus,
			providers: deps.app.providers,
			getObservability: () => deps.getObservabilitySnapshot(),
			...(deps.app.agents ? { agents: deps.app.agents } : {}),
			...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
			...(deps.app.getFleetNodes ? { getFleetNodes: deps.app.getFleetNodes } : {}),
			...(deps.app.writeSettings
				? {
						writeSettings: (next) => {
							deps.app.writeSettings?.(next);
							footer.refresh();
						},
					}
				: {}),
			notice: notify,
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openViewOverlayState = (initialFilter?: string): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "view";
		const sessionMeta = deps.app.session?.current() ?? null;
		overlayTransitions.handle = openViewOverlay(tui, {
			providers: createDefaultArtifactProviders({
				stateDir: deps.app.stateDir,
				dataDir: deps.app.dataDir,
				dispatch: deps.app.dispatch,
				sessionMeta,
				readSessionEntries: deps.app.readSessionEntries,
			}),
			...(initialFilter ? { initialFilter } : {}),
			notice: (level, text, key) => notify(level, text, key),
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openResumeOverlayState = overlaySessions.openResume;
	const openTreeOverlayState = overlaySessions.openTree;
	const openMessagePickerOverlayState = overlaySessions.openMessagePicker;

	const openHelpOverlayState = (query?: string): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "help";
		overlayTransitions.handle = openHelpOverlay(tui, keybindings, () => closeOverlay(), query);
		tui.requestRender();
	};

	const openAgentsOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "agents";
		overlayTransitions.handle = openAgentsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const openSkillsHubState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "skills-hub";
		overlayTransitions.handle = openSkillsHub(tui, {
			listSkills: () => deps.app.resources?.skills(process.cwd()) ?? { items: [], diagnostics: [] },
			cacheDir: deps.app.cacheDir,
			setEditorText: (text) => {
				editor.setText(text);
				tui.requestRender();
			},
			notice: (level, text) => deps.getSlashContext().notice(level, text),
			installSkill: async (name) => {
				const result = installSkill({ source: name, scope: "project" });
				return { name: result.name, path: result.path, warnings: result.warnings };
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openPromptsOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "prompts";
		overlayTransitions.handle = openPromptsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const openExtensionsOverlayState = (): void => {
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "extensions";
		overlayTransitions.handle = openExtensionsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const toggleDispatchBoardOverlay = (): void => {
		if (overlayTransitions.state === "dispatch-board") {
			closeOverlay();
			return;
		}
		if (overlayTransitions.state !== "closed") return;
		overlayTransitions.state = "dispatch-board";
		dispatchBoard.resetSelection();
		// Size to the terminal at open: near-full width on narrow screens, capped
		// at 96 columns so ultrawide terminals keep readable cards. pi clamps the
		// overlay if the terminal shrinks and the live board re-renders to fit.
		overlayTransitions.handle = showOverlayFrame(tui, dispatchBoard, {
			title: "Fleet Runs",
			footerHint: () => {
				const row = dispatchBoard.selectedRow();
				const entries = [{ key: "↑↓", verb: "select" }];
				if (row && isDispatchBoardRowSteerable(row)) {
					entries.push({ key: "s", verb: "steer" });
				}
				if (row && isDispatchBoardRowCancellable(row)) {
					entries.push({ key: "x", verb: "cancel" });
				}
				return buildHint("browse", entries);
			},
			anchor: "center",
			width: Math.max(44, Math.min(96, terminal.columns - 4)),
		});
		interactiveTickers.startDispatchBoardTicker();
		tui.requestRender();
	};

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
		openHelpOverlayState,
		openAgentsOverlayState,
		openSkillsHubState,
		openPromptsOverlayState,
		openExtensionsOverlayState,
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
