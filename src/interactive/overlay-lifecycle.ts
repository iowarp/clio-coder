import type { ClioSettings } from "../core/config.js";
import { loadMemoryRecordsSync, type MemoryRecord } from "../domains/memory/index.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import { installSkill } from "../domains/resources/skills/marketplace.js";
import { resolveSessionCwd } from "../domains/session/cwd-fallback.js";
import type { SessionContract } from "../domains/session/index.js";
import type { OverlayHandle } from "../engine/tui.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import { buildReplayAgentMessagesFromTurns, rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { appendNotice } from "./command-output.js";
import { openContextOverlay } from "./context-overlay.js";
import { openCostOverlay } from "./cost-overlay.js";
import { isDispatchBoardRowCancellable, isDispatchBoardRowSteerable } from "./dispatch-board.js";
import { openFleetOverlay } from "./fleet-overlay.js";
import { openMemoryOverlay } from "./memory-overlay.js";
import { createOverlayAuthLifecycle } from "./overlay-auth-lifecycle.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { createOverlayPermissionLifecycle, type OverlayPermissionLifecycle } from "./overlay-permission-lifecycle.js";
import { openAgentsOverlay } from "./overlays/agents.js";
import { openAskUserOverlay } from "./overlays/ask-user.js";
import { contextResetOptions, openContextResetOverlay } from "./overlays/context-reset.js";
import { openCwdFallbackOverlay } from "./overlays/cwd-fallback.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openMessagePickerOverlay } from "./overlays/message-picker.js";
import { openModelOverlay } from "./overlays/model-selector.js";
import { openPromptsOverlay } from "./overlays/prompts.js";
import { extractScopeFromSettings, openScopedOverlay } from "./overlays/scoped-models.js";
import { openSessionOverlay } from "./overlays/session-selector.js";
import { openSettingsOverlay } from "./overlays/settings.js";
import { openSkillsHub } from "./overlays/skills-hub.js";
import {
	openThinkingOverlay,
	readThinkingLevel,
	resolveAvailableThinkingLevels,
	resolveThinkingCapability,
	resolveThinkingLabeler,
} from "./overlays/thinking-selector.js";
import { openTreeOverlay } from "./overlays/tree-selector.js";
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

function handleCwdFallbackCancel(
	preResumeSessionId: string | null,
	deps: { session: SessionContract; openResumeOverlay: () => void; onWarning: (msg: string) => void },
): void {
	const currentId = deps.session.current()?.id ?? null;
	if (preResumeSessionId && preResumeSessionId !== currentId) {
		try {
			deps.session.switchBranch(preResumeSessionId);
		} catch (err) {
			deps.onWarning(
				`[cwd-fallback] could not restore prior session: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		return;
	}
	deps.openResumeOverlay();
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
	} = deps;
	let settingsOverlayRefresh: (() => void) | null = null;
	let overlayState: OverlayState = "closed";
	let overlayHandle: OverlayHandle | null = null;
	let overlayPermission: OverlayPermissionLifecycle | null = null;
	let pendingAskUserCancel: (() => void) | null = null;
	let askUserSession: ReturnType<typeof openAskUserOverlay> | null = null;
	let askUserCancelledForTurn = false;
	let unregisterAskUserHandler: (() => void) | null = null;

	const overlayAuth = createOverlayAuthLifecycle({
		tui,
		providers: deps.app.providers,
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		notify,
		refreshFooter: () => footer.refresh(),
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		getOverlayState: () => overlayState,
		setOverlayState: (state) => {
			overlayState = state;
		},
		getOverlayHandle: () => overlayHandle,
		setOverlayHandle: (handle) => {
			overlayHandle = handle;
		},
		...(openAuthDialogFactory ? { openAuthDialog: openAuthDialogFactory } : {}),
	});

	const closeOverlay = (): void => {
		if (overlayState === "closed") return;
		if (overlayState === "ask-user" && pendingAskUserCancel) {
			pendingAskUserCancel();
			return;
		}
		if (overlayState === "auth") {
			overlayAuth.finish(true);
			return;
		}
		const leaving = overlayState;
		overlayState = "closed";
		interactiveTickers.stopDispatchBoardTicker();
		overlayHandle?.hide();
		overlayHandle = null;
		if (leaving === "permission-confirm") overlayPermission?.onPermissionOverlayClosed();
		interactiveTickers.renderContextIsland();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	overlayPermission = createOverlayPermissionLifecycle({
		...(deps.app.toolRegistry ? { toolRegistry: deps.app.toolRegistry } : {}),
		bus: deps.app.bus,
		dispatch: deps.app.dispatch,
		getAutonomy: () => deps.app.getSettings?.().autonomy ?? "auto-edit",
		getOverlayState: () => overlayState,
		openPermissionOverlay: (view) => {
			if (overlayState !== "closed") return false;
			overlayState = "permission-confirm";
			overlayHandle = showOverlayFrame(tui, createPermissionOverlayBody(view), {
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

	const closeAskUserSession = (): void => {
		pendingAskUserCancel = null;
		const session = askUserSession;
		askUserSession = null;
		if (session) {
			session.close();
			if (overlayHandle === session) overlayHandle = null;
		} else if (overlayState === "ask-user") {
			overlayHandle?.hide();
			overlayHandle = null;
		}
		if (overlayState === "ask-user") overlayState = "closed";
		interactiveTickers.renderContextIsland();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const ensureAskUserSession = (): ReturnType<typeof openAskUserOverlay> | null => {
		if (overlayState !== "closed" && overlayState !== "ask-user") return null;
		if (askUserSession) return askUserSession;
		overlayState = "ask-user";
		askUserSession = openAskUserOverlay(tui, {
			onCancel: () => {
				pendingAskUserCancel?.();
			},
		});
		overlayHandle = askUserSession;
		tui.requestRender();
		return askUserSession;
	};

	const cancelAskUserSession = (): void => {
		askUserCancelledForTurn = true;
		const session = askUserSession;
		session?.cancel();
		closeAskUserSession();
	};

	const openAskUserOverlayState: AskUserHandler = async (questions, invokeOptions) => {
		const toolBacked = Boolean(invokeOptions?.turnId || invokeOptions?.toolCallId);
		if (toolBacked && askUserCancelledForTurn) return cancelledAskUserResult();
		const session = ensureAskUserSession();
		if (!session) return cancelledAskUserResult();
		pendingAskUserCancel = cancelAskUserSession;
		const result = await session.ask(questions);
		if (result.cancelled === true || !toolBacked) {
			if (result.cancelled === true) askUserCancelledForTurn = true;
			closeAskUserSession();
		} else {
			interactiveTickers.renderContextIsland();
			interactiveTickers.renderTaskIsland();
			tui.requestRender();
		}
		return result;
	};
	unregisterAskUserHandler = deps.app.registerAskUserHandler?.(openAskUserOverlayState) ?? null;

	const openProvidersOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "providers";
		overlayHandle = openProvidersOverlayFactory(tui, deps.app.providers, {
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
		if (overlayState !== "closed") return;
		overlayState = "cost";
		overlayHandle = openCostOverlay(tui, deps.app.observability, {
			sessionId: deps.app.getSessionId?.() ?? null,
		});
		tui.requestRender();
	};

	const openContextViewOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "context-view";
		overlayHandle = openContextOverlay(tui, () => deps.app.chat.contextLedger(), {
			bus: deps.app.bus,
			chat: deps.app.chat,
		});
		tui.requestRender();
	};

	const openContextResetOverlayState = (): void => {
		if (overlayState !== "closed" || !deps.app.onContextClear) return;
		overlayState = "context-reset";
		overlayHandle = openContextResetOverlay(tui, {
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
		if (overlayState !== "closed") return;
		footer.toggleExpanded();
		interactiveTickers.renderTaskIsland();
		tui.requestRender();
	};

	const openTasksOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "tasks";
		overlayHandle = openTasksOverlay(tui, () => deps.app.getTaskBoard?.() ?? null, {
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMemoryOverlayState = (): void => {
		if (overlayState !== "closed" || !deps.app.getTaskMemoryStatus) return;
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
		overlayState = "memory";
		overlayHandle = openMemoryOverlay(tui, deps.app.getTaskMemoryStatus, () => records, {
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openFleetOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "fleet";
		overlayHandle = openFleetOverlay(tui, deps.app.dispatch, {
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
		if (overlayState !== "closed") return;
		overlayState = "view";
		const sessionMeta = deps.app.session?.current() ?? null;
		overlayHandle = openViewOverlay(tui, {
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

	const openThinkingOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "thinking";
		const settings = deps.app.getSettings?.();
		const current = settings
			? (resolveThinkingCapability(deps.app.providers, settings)?.effectiveLevel ?? readThinkingLevel(settings))
			: "off";
		const available = settings
			? resolveAvailableThinkingLevels(deps.app.providers, settings)
			: (["off"] as ThinkingLevel[]);
		const thinkingOverlayDeps: Parameters<typeof openThinkingOverlay>[1] = {
			current,
			available,
			onSelect: (next) => {
				deps.app.onSetThinkingLevel?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
			...(settings ? { labelFor: resolveThinkingLabeler(deps.app.providers, settings) } : {}),
		};
		overlayHandle = openThinkingOverlay(tui, thinkingOverlayDeps);
		tui.requestRender();
	};

	const openModelOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.app.getSettings?.();
		if (!settings) return;
		overlayState = "model";
		overlayHandle = openModelOverlay(tui, {
			settings,
			...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
			providers: deps.app.providers,
			bus: deps.app.bus,
			onSelect: (ref) => {
				deps.app.onSelectModel?.(ref);
				footer.refresh();
			},
			onToggleFavorite: (ref, favorite) => {
				if (!deps.app.getSettings || !deps.app.writeSettings) return;
				const next = structuredClone(deps.app.getSettings()) as ClioSettings;
				const value = `${ref.target}/${ref.model}`;
				const current = new Set(next.modelSelector?.favorites ?? []);
				if (favorite) current.add(value);
				else current.delete(value);
				next.modelSelector = {
					...(next.modelSelector ?? { recentLimit: 12, favorites: [] }),
					favorites: [...current],
				};
				deps.app.writeSettings(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openScopedModelsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.app.getSettings?.();
		if (!settings) return;
		overlayState = "scoped-models";
		overlayHandle = openScopedOverlay(tui, {
			providers: deps.app.providers,
			currentScope: extractScopeFromSettings(settings),
			onCommit: (next) => {
				deps.app.onSetScope?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openSettingsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.getSettings || !deps.app.writeSettings) return;
		overlayState = "settings";
		const getSettings = deps.app.getSettings;
		const writeSettingsOut = deps.app.writeSettings;
		const commitSettingOut = deps.app.commitSetting;
		const handle = openSettingsOverlay(tui, {
			getSettings,
			providers: deps.app.providers,
			writeSettings: (next) => {
				writeSettingsOut(next);
				footer.refresh();
			},
			...(commitSettingOut
				? {
						commitSetting: (id, next, scope) => {
							commitSettingOut(id, next, scope);
							footer.refresh();
						},
					}
				: {}),
			notice: notify,
			onClose: () => {
				settingsOverlayRefresh = null;
				closeOverlay();
			},
		});
		overlayHandle = handle;
		settingsOverlayRefresh = handle.refreshRows;
		void (async () => {
			try {
				await deps.app.providers.probeAllLive();
				if (overlayState === "settings") settingsOverlayRefresh?.();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				notify("warning", `settings model refresh failed: ${msg}`, "settings:model-refresh");
			}
		})();
		tui.requestRender();
	};

	const openResumeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) {
			emitCommandNotice(deps.getSlashContext().notice, "error", "resume", "session contract unavailable");
			return;
		}
		const sessionContract = deps.app.session;
		const preResumeSessionId = sessionContract.current()?.id ?? null;
		overlayState = "resume";
		overlayHandle = openSessionOverlay(tui, {
			session: sessionContract,
			onResume: (sessionId) => {
				deps.app.onResumeSession?.(sessionId);
				// Replay the resumed session's on-disk turns into the chat
				// panel so the user sees their prior transcript, and reset
				// chat-loop's lastTurnId + agent.state.messages so the next
				// submit parents onto the resumed leaf rather than inheriting
				// whatever state the previous session left behind. Row 51
				// regression fix.
				try {
					const turns = readStructuredEntries(sessionId);
					chatPanel.reset();
					rehydrateChatPanelFromTurns(chatPanel, turns);
					const replayMessages = buildReplayAgentMessagesFromTurns(turns);
					const leafTurnId = sessionContract.tree(sessionId).leafId;
					deps.app.chat.resetForSession(leafTurnId, replayMessages);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/resume] transcript replay failed: ${msg}\n`);
				}
				if (sessionContract.current()?.id === sessionId && sessionId !== preResumeSessionId) {
					announceTaskMemorySeedOffer();
				}
				footer.refresh();
				tui.requestRender();
			},
			onClose: () => {
				closeOverlay();
				// Post-close cwd check: if /resume landed on a session whose
				// recorded cwd is no longer valid, pop the cwd-fallback
				// overlay so the user can either continue in the terminal's
				// cwd or cancel back to the prior session. Queued as a
				// microtask so the resume overlay state machine fully
				// settles before the next overlay opens.
				queueMicrotask(() => {
					const current = sessionContract.current();
					if (!current) return;
					if (current.id === preResumeSessionId) return;
					const probe = resolveSessionCwd(current);
					if (probe.ok) return;
					openCwdFallbackOverlayState({
						sessionCwd: typeof current.cwd === "string" ? current.cwd : "",
						reason: probe.reason,
						preResumeSessionId,
					});
				});
			},
		});
		tui.requestRender();
	};

	const openTreeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) {
			notify("error", "tree unavailable: session contract is not wired", "tree:unavailable");
			return;
		}
		const sessionContract = deps.app.session;
		overlayState = "tree";
		overlayHandle = openTreeOverlay(tui, {
			session: sessionContract,
			onSwitchTurn: (turnId) => {
				try {
					sessionContract.switchTurn(turnId);
					const sessionId = sessionContract.current()?.id ?? null;
					if (!sessionId) throw new Error("no current session after turn switch");
					const turns = readStructuredEntries(sessionId);
					chatPanel.reset();
					rehydrateChatPanelFromTurns(chatPanel, turns, { uptoTurnId: turnId });
					const replayMessages = buildReplayAgentMessagesFromTurns(turns, { uptoTurnId: turnId });
					deps.app.chat.resetForSession(turnId, replayMessages);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					notify("error", `tree switch failed: ${msg}`, "tree:switch-failed");
				}
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMessagePickerOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) {
			emitCommandNotice(deps.getSlashContext().notice, "error", "fork", "session contract unavailable");
			return;
		}
		const sessionContract = deps.app.session;
		// No-op notice when there is no current session so the user can tell
		// the overlay is intentionally inert rather than broken.
		if (sessionContract.current() === null) {
			emitCommandNotice(
				deps.getSlashContext().notice,
				"warn",
				"fork",
				"no current session to fork from; start one with /new or /resume first",
			);
			return;
		}
		overlayState = "message-picker";
		overlayHandle = openMessagePickerOverlay(tui, {
			session: sessionContract,
			onFork: (parentTurnId) => {
				try {
					if (deps.app.onForkSession) {
						deps.app.onForkSession(parentTurnId);
					} else {
						sessionContract.fork(parentTurnId);
					}
					chatPanel.reset();
					const forkedSessionId = sessionContract.current()?.id ?? null;
					if (forkedSessionId) {
						try {
							const forkedTurns = readStructuredEntries(forkedSessionId);
							rehydrateChatPanelFromTurns(chatPanel, forkedTurns);
							const replayMessages = buildReplayAgentMessagesFromTurns(forkedTurns);
							const leafTurnId = sessionContract.tree(forkedSessionId).leafId ?? parentTurnId;
							deps.app.chat.resetForSession(leafTurnId, replayMessages);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							io.stderr(`[/fork] transcript replay failed: ${msg}\n`);
							deps.app.chat.resetForSession(null);
						}
					}
					if (!forkedSessionId) deps.app.chat.resetForSession(null);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/fork] fork failed: ${msg}\n`);
				}
				footer.refresh();
				tui.requestRender();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	/**
	 * Pop the cwd-fallback overlay after /resume landed on a session whose
	 * recorded cwd no longer exists on disk (see src/domains/session/
	 * cwd-fallback.ts for the reasons). Continue silently accepts the
	 * broken-cwd session. Downstream file ops will surface real errors.
	 * Cancel restores the prior session when one existed, or re-opens the
	 * /resume picker so the user can select a different session.
	 */
	const openCwdFallbackOverlayState = (args: {
		sessionCwd: string;
		reason: "no-cwd" | "missing" | "not-a-directory";
		preResumeSessionId: string | null;
	}): void => {
		if (overlayState !== "closed") return;
		if (!deps.app.session) return;
		const sessionContract = deps.app.session;
		overlayState = "cwd-fallback";
		overlayHandle = openCwdFallbackOverlay(tui, {
			sessionCwd: args.sessionCwd,
			currentCwd: process.cwd(),
			reason: args.reason,
			onContinue: () => {
				// Accept the broken-cwd session. First fs access will surface a
				// real error; no extra bookkeeping here. The user chose this
				// explicitly, so leave meta.cwd untouched.
				footer.refresh();
			},
			onCancel: () => {
				handleCwdFallbackCancel(args.preResumeSessionId, {
					session: sessionContract,
					// queueMicrotask defers past the current overlay's close so the
					// resume overlay opens cleanly on a quiesced overlay stack.
					openResumeOverlay: () => queueMicrotask(() => openResumeOverlayState()),
					onWarning: (msg) => io.stderr(msg),
				});
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openHelpOverlayState = (query?: string): void => {
		if (overlayState !== "closed") return;
		overlayState = "help";
		overlayHandle = openHelpOverlay(tui, keybindings, () => closeOverlay(), query);
		tui.requestRender();
	};

	const openAgentsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "agents";
		overlayHandle = openAgentsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const openSkillsHubState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "skills-hub";
		overlayHandle = openSkillsHub(tui, {
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
		if (overlayState !== "closed") return;
		overlayState = "prompts";
		overlayHandle = openPromptsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const openExtensionsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "extensions";
		overlayHandle = openExtensionsOverlay(tui, deps.getSlashContext(), () => closeOverlay());
		tui.requestRender();
	};

	const toggleDispatchBoardOverlay = (): void => {
		if (overlayState === "dispatch-board") {
			closeOverlay();
			return;
		}
		if (overlayState !== "closed") return;
		overlayState = "dispatch-board";
		dispatchBoard.resetSelection();
		// Size to the terminal at open: near-full width on narrow screens, capped
		// at 96 columns so ultrawide terminals keep readable cards. pi clamps the
		// overlay if the terminal shrinks and the live board re-renders to fit.
		overlayHandle = showOverlayFrame(tui, dispatchBoard, {
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
		getState: () => overlayState,
		closeOverlay,
		finishAuthOverlay: overlayAuth.finish,
		openAskUserOverlayState,
		closeAskUserSession,
		isAskUserWaiting: () => askUserSession?.isWaiting() ?? false,
		resetAskUserCancellation: () => {
			askUserCancelledForTurn = false;
		},
		refreshSettingsOverlay: () => settingsOverlayRefresh?.(),
		openProvidersOverlayState,
		openCostOverlayState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		toggleFooterDashboardState,
		openTasksOverlayState,
		openMemoryOverlayState,
		openFleetOverlayState,
		openViewOverlayState,
		openThinkingOverlayState,
		openModelOverlayState,
		openScopedModelsOverlayState,
		openSettingsOverlayState,
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
		cancelAskUser: () => pendingAskUserCancel?.(),
		dispose: () => {
			overlayPermission?.dispose();
			unregisterAskUserHandler?.();
			unregisterAskUserHandler = null;
			pendingAskUserCancel?.();
		},
	};
}
