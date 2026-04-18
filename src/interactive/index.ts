import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { SuperModeConfirmation } from "../domains/modes/contract.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { type ThinkingLevel, getAvailableThinkingLevels } from "../domains/providers/resolver.js";
import type { SessionContract } from "../domains/session/contract.js";
import { Editor, ProcessTerminal, TUI, Text, isKeyRelease, matchesKey } from "../engine/tui.js";
import type { Model } from "../engine/types.js";
import type { ChatLoop } from "./chat-loop.js";
import { createChatPanel } from "./chat-panel.js";
import { openCostOverlay } from "./cost-overlay.js";
import { createDispatchBoardStore, formatDispatchBoardLines } from "./dispatch-board.js";
import { buildFooter } from "./footer-panel.js";
import { buildLayout, defaultBanner } from "./layout.js";
import { openHotkeysOverlay } from "./overlays/hotkeys.js";
import { openMessagePickerOverlay } from "./overlays/message-picker.js";
import { openModelOverlay } from "./overlays/model-selector.js";
import { extractScopeFromSettings, openScopedOverlay } from "./overlays/scoped-models.js";
import { openSessionOverlay } from "./overlays/session-selector.js";
import { openSettingsOverlay } from "./overlays/settings.js";
import { openThinkingOverlay, readThinkingLevel } from "./overlays/thinking-selector.js";
import { openTreeOverlay } from "./overlays/tree-selector.js";
import { openProvidersOverlay } from "./providers-overlay.js";
import { openReceiptsOverlay, verifyReceiptFile } from "./receipts-overlay.js";
import { type RunIo, type SlashCommandContext, dispatchSlashCommand, parseSlashCommand } from "./slash-commands.js";
import { renderSuperOverlayLines } from "./super-overlay.js";

// Re-exports preserve the public surface for diag scripts that import these
// names from "interactive/index.js". Slice 2.6 relocated the implementations
// into slash-commands.ts.
export {
	BUILTIN_SLASH_COMMANDS,
	type BuiltinSlashCommand,
	type HandleRunDeps,
	type RunIo,
	type SlashCommand,
	type SlashCommandContext,
	type SlashCommandKind,
	dispatchSlashCommand,
	handleRun,
	parseSlashCommand,
} from "./slash-commands.js";

export interface InteractiveDeps {
	bus: SafeEventBus;
	modes: ModesContract;
	providers: ProvidersContract;
	dispatch: DispatchContract;
	observability: ObservabilityContract;
	chat: ChatLoop;
	session?: SessionContract;
	/** XDG data dir (clioDataDir()). `/receipt verify` reads from <dataDir>/receipts/<id>.json. */
	dataDir: string;
	/**
	 * Resolver for the current `workers.default` block. `/run` uses this to
	 * short-circuit with an actionable error when no provider is configured
	 * instead of letting the dispatch throw with no config context.
	 */
	getWorkerDefault?: () => { provider?: string; model?: string; endpoint?: string } | undefined;
	/**
	 * Resolver for current settings. Footer reads the orchestrator target
	 * (what chat actually dispatches to) rather than the providers catalog's
	 * first-available entry.
	 */
	getSettings?: () => Readonly<ClioSettings>;
	/**
	 * Resolver for the active orchestrator model. Used to clamp the /thinking
	 * overlay and Shift+Tab cycle to model capability and to drive the footer's
	 * `◆ <level>` reasoning suffix.
	 */
	getOrchestratorModel?: () => Model<never> | undefined;
	/** Optional resolver for the active session id used as the cost overlay title suffix. */
	getSessionId?: () => string | null;
	/** Persist a thinking level chosen in the /thinking overlay. */
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
	/** Persist the next thinking level when Shift+Tab is pressed. */
	onCycleThinking?: () => void;
	/** Persist the orchestrator target selected in /model. */
	onSelectModel?: (ref: { providerId: string; modelId: string; endpoint?: string }) => void;
	/** Persist the next `provider.scope` list committed in /scoped-models. */
	onSetScope?: (scope: string[]) => void;
	/** Write handler the /settings overlay uses to persist cycled values. */
	writeSettings?: (next: ClioSettings) => void;
	/** Resume a past session id. Called from the /resume overlay. */
	onResumeSession?: (sessionId: string) => void;
	/** Start a fresh session. Called from /new. */
	onNewSession?: () => void;
	/**
	 * Fork from a parent assistant turn picked in /fork. Default wiring
	 * delegates to session.fork(parentTurnId); the override exists so
	 * future slices can layer telemetry or settings merging on top.
	 */
	onForkSession?: (parentTurnId: string) => void;
	/**
	 * Run /compact for the current session. Resolves the compaction model
	 * (settings.compaction.model with fallback to the orchestrator target),
	 * reads session entries, streams a summary via the session compaction
	 * engine, and persists a compactionSummary entry. Slice 12c ships the
	 * hook; 12d adds the auto-trigger and overflow-recovery path.
	 */
	onCompact?: (instructions: string | undefined) => Promise<void>;
	/** Advance the orchestrator target one step forward through `provider.scope`. */
	onCycleScopedModelForward?: () => void;
	/** Advance the orchestrator target one step backward through `provider.scope`. */
	onCycleScopedModelBackward?: () => void;
	onShutdown: () => Promise<void>;
}

export const SHIFT_TAB = "\x1b[Z";
export const CTRL_D = "\x04";
export const CTRL_B = "\x02";
export const CTRL_L = "\x0c";
export const CTRL_P = "\x10";
// pi-coding-agent emits Shift+Ctrl+P as the CSI-u sequence for key 80 with the
// shift+ctrl modifiers. Terminals in kitty-protocol mode deliver this literally;
// legacy terminals without CSI-u will not fire this binding, by design — fall
// back to /scoped-models to reach the scope in that environment.
export const SHIFT_CTRL_P = "\x1b[80;6u";
export const ALT_S = "\x1bs";
export const ALT_M = "\x1bm";
export const ALT_T = "\x1bt";
export const ENTER = "\r";
export const ESC = "\x1b";
export type OverlayState =
	| "closed"
	| "super-confirm"
	| "dispatch-board"
	| "providers"
	| "cost"
	| "receipts"
	| "thinking"
	| "model"
	| "scoped-models"
	| "settings"
	| "resume"
	| "tree"
	| "message-picker"
	| "hotkeys";

export interface KeyBindingDeps {
	cycleMode: () => void;
	cycleThinking: () => void;
	requestShutdown: () => void;
	requestSuper: () => void;
	toggleDispatchBoard: () => void;
	openModelSelector: () => void;
	openTree: () => void;
	cycleScopedModelForward: () => void;
	cycleScopedModelBackward: () => void;
}

export interface SuperOverlayKeyDeps {
	cancelSuper: () => void;
	confirmSuper: (conf: SuperModeConfirmation) => void;
	now: () => number;
}

export interface DispatchBoardOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ProvidersOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface CostOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ReceiptsOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ThinkingOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ModelOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ScopedModelsOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface SettingsOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ResumeOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface TreeOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface MessagePickerOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface HotkeysOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface OverlayKeyDeps
	extends SuperOverlayKeyDeps,
		DispatchBoardOverlayKeyDeps,
		ProvidersOverlayKeyDeps,
		CostOverlayKeyDeps,
		ReceiptsOverlayKeyDeps,
		ThinkingOverlayKeyDeps,
		ModelOverlayKeyDeps,
		ScopedModelsOverlayKeyDeps,
		SettingsOverlayKeyDeps,
		ResumeOverlayKeyDeps,
		TreeOverlayKeyDeps,
		MessagePickerOverlayKeyDeps,
		HotkeysOverlayKeyDeps {
	requestShutdown: () => void;
}

/** Pure key router: returns true when the input was consumed. */
export function routeInteractiveKey(data: string, deps: KeyBindingDeps): boolean {
	if (data === ALT_S) {
		deps.requestSuper();
		return true;
	}
	if (data === SHIFT_TAB) {
		deps.cycleThinking();
		return true;
	}
	if (data === ALT_M) {
		deps.cycleMode();
		return true;
	}
	if (data === ALT_T) {
		deps.openTree();
		return true;
	}
	if (data === CTRL_B) {
		deps.toggleDispatchBoard();
		return true;
	}
	if (data === CTRL_L) {
		deps.openModelSelector();
		return true;
	}
	if (data === SHIFT_CTRL_P) {
		// Match before CTRL_P so the longer sequence wins. SHIFT_CTRL_P starts
		// with \x1b, CTRL_P is a single \x10 byte, so the two do not prefix-match.
		deps.cycleScopedModelBackward();
		return true;
	}
	if (data === CTRL_P) {
		deps.cycleScopedModelForward();
		return true;
	}
	if (data === CTRL_D) {
		deps.requestShutdown();
		return true;
	}
	return false;
}

/** Pure overlay key router: returns true when the input was consumed. */
export function routeSuperOverlayKey(data: string, deps: SuperOverlayKeyDeps): boolean {
	if (data === ENTER) {
		deps.confirmSuper({
			requestedBy: "keybind",
			acceptedAt: deps.now(),
		});
		return true;
	}
	if (data === ESC) {
		deps.cancelSuper();
		return true;
	}
	return false;
}

/** Pure overlay key router for the dispatch board. */
export function routeDispatchBoardOverlayKey(data: string, deps: DispatchBoardOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /providers overlay. Esc closes; everything else is swallowed. */
export function routeProvidersOverlayKey(data: string, deps: ProvidersOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /cost overlay. Esc closes; everything else is swallowed. */
export function routeCostOverlayKey(data: string, deps: CostOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /receipts overlay. Esc closes. Every other
 * key is left untouched so the Box-wrapped SelectList can handle Up/Down/Enter
 * through the TUI's focused-component pipeline.
 */
export function routeReceiptsOverlayKey(data: string, deps: ReceiptsOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /thinking overlay. Same policy as receipts:
 * Esc closes; arrows and Enter fall through to the focused SelectList.
 */
export function routeThinkingOverlayKey(data: string, deps: ThinkingOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /model overlay. Same policy as thinking:
 * Esc closes; arrows and Enter fall through to the focused SelectList.
 */
export function routeModelOverlayKey(data: string, deps: ModelOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /scoped-models overlay. Esc closes; Space
 * toggles inclusion and Enter commits, both handled inside ScopedOverlayBox.
 */
export function routeScopedModelsOverlayKey(data: string, deps: ScopedModelsOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /settings overlay. Esc closes; every other
 * key falls through to the focused SettingsList for cycling and search.
 */
export function routeSettingsOverlayKey(data: string, deps: SettingsOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /resume overlay. Esc closes; arrows and
 * Enter fall through to the focused SelectList.
 */
export function routeResumeOverlayKey(data: string, deps: ResumeOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /tree overlay. Esc is intentionally NOT
 * consumed here because the overlay runs in three submodes (browse,
 * edit-label, confirm-delete) and Esc cancels a submode before it closes the
 * overlay. TreeOverlayBox.handleInput calls the onClose dep itself when Esc
 * is pressed in browse mode; every other key also falls through to the Box.
 */
export function routeTreeOverlayKey(_data: string, _deps: TreeOverlayKeyDeps): boolean {
	return false;
}

/**
 * Pure overlay key router for the /fork message-picker. Esc closes; arrows
 * and Enter fall through to the focused SelectList (same policy as /resume).
 */
export function routeMessagePickerOverlayKey(data: string, deps: MessagePickerOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /hotkeys overlay. Esc closes; everything
 * else is swallowed so arrow keys cannot disturb the banner-style render.
 */
export function routeHotkeysOverlayKey(data: string, deps: HotkeysOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Ctrl+C must still raise SIGINT while any overlay is open. */
export function shouldPassCtrlCToProcess(data: string, overlayState: OverlayState): boolean {
	return overlayState !== "closed" && matchesKey(data, "ctrl+c") && !isKeyRelease(data);
}

/** Overlay inputs always stay inside the overlay except for Ctrl+D shutdown. */
export function routeOverlayKey(data: string, overlayState: OverlayState, deps: OverlayKeyDeps): boolean {
	if (overlayState === "closed") return false;
	if (shouldPassCtrlCToProcess(data, overlayState)) return false;
	if (data === CTRL_D) {
		deps.requestShutdown();
		return true;
	}
	if (overlayState === "super-confirm") {
		routeSuperOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "providers") {
		routeProvidersOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "cost") {
		routeCostOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "receipts") {
		// Do not swallow arrow keys or Enter; the focused SelectList needs them.
		return routeReceiptsOverlayKey(data, deps);
	}
	if (overlayState === "thinking") {
		// Same policy as receipts: the Box forwards unconsumed input to the SelectList.
		return routeThinkingOverlayKey(data, deps);
	}
	if (overlayState === "model") {
		// Same policy as thinking: the Box forwards unconsumed input to the SelectList.
		return routeModelOverlayKey(data, deps);
	}
	if (overlayState === "scoped-models") {
		// The ScopedOverlayBox owns Space and Enter; route only Esc here.
		return routeScopedModelsOverlayKey(data, deps);
	}
	if (overlayState === "settings") {
		// SettingsList owns Enter/Space/search; route only Esc here.
		return routeSettingsOverlayKey(data, deps);
	}
	if (overlayState === "resume") {
		// SelectList owns arrows and Enter; route only Esc here.
		return routeResumeOverlayKey(data, deps);
	}
	if (overlayState === "tree") {
		// TreeOverlayBox owns its full keymap including Esc (submode-aware);
		// routeTreeOverlayKey is a no-op stub kept for shape symmetry.
		return routeTreeOverlayKey(data, deps);
	}
	if (overlayState === "message-picker") {
		// SelectList owns arrows and Enter; route only Esc here.
		return routeMessagePickerOverlayKey(data, deps);
	}
	if (overlayState === "hotkeys") {
		return routeHotkeysOverlayKey(data, deps);
	}
	routeDispatchBoardOverlayKey(data, deps);
	return true;
}

const IDENTITY = (s: string): string => s;

export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const banner = defaultBanner();
	const chatPanel = createChatPanel();
	const footer = buildFooter({
		modes: deps.modes,
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.getOrchestratorModel ? { getOrchestratorModel: deps.getOrchestratorModel } : {}),
	});
	const editor = new Editor(tui, {
		borderColor: IDENTITY,
		selectList: {
			selectedPrefix: IDENTITY,
			selectedText: IDENTITY,
			description: IDENTITY,
			scrollInfo: IDENTITY,
			noMatch: IDENTITY,
		},
	});
	editor.focused = true;

	const superOverlayLines = renderSuperOverlayLines();
	const superOverlayWidth = superOverlayLines.reduce((max, line) => Math.max(max, line.length), 0);
	const superOverlay = new Text(superOverlayLines.join("\n"), 0, 0);
	const dispatchBoardStore = createDispatchBoardStore(deps.bus);
	const dispatchBoard = new Text(formatDispatchBoardLines(dispatchBoardStore.rows()).join("\n"), 0, 0);
	const dispatchBoardWidth = formatDispatchBoardLines([]).reduce((max, line) => Math.max(max, line.length), 0);

	const io: RunIo = {
		stdout: (s) => process.stdout.write(s),
		stderr: (s) => process.stderr.write(s),
	};

	const unsubscribeChat = deps.chat.onEvent((event) => {
		chatPanel.applyEvent(event);
		tui.requestRender();
	});

	const slashCtx: SlashCommandContext = {
		io,
		dispatch: deps.dispatch,
		bus: deps.bus,
		dataDir: deps.dataDir,
		workerDefault: () => deps.getWorkerDefault?.(),
		shutdown: () => {
			void shutdown();
		},
		openProviders: () => openProvidersOverlayState(),
		openCost: () => openCostOverlayState(),
		openReceipts: () => openReceiptsOverlayState(),
		openThinking: () => openThinkingOverlayState(),
		openModel: () => openModelOverlayState(),
		openScopedModels: () => openScopedModelsOverlayState(),
		openSettings: () => openSettingsOverlayState(),
		openResume: () => openResumeOverlayState(),
		startNewSession: () => startNewSession(),
		openTree: () => openTreeOverlayState(),
		openMessagePicker: () => openMessagePickerOverlayState(),
		openHotkeys: () => openHotkeysOverlayState(),
		runCompact: (instructions) => {
			if (!deps.onCompact) {
				io.stderr("[/compact] compaction not wired; pass onCompact to startInteractive\n");
				return;
			}
			const task = deps.onCompact(instructions);
			void task.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				io.stderr(`[/compact] ${msg}\n`);
			});
		},
		verifyReceipt: (runId) => verifyReceiptFile(deps.dataDir, runId),
		submitChat: (text) => {
			chatPanel.appendUser(text);
			tui.requestRender();
			void (async () => {
				try {
					await deps.chat.submit(text);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[interactive] chat failed: ${msg}\n`);
				} finally {
					tui.requestRender();
				}
			})();
		},
		render: () => tui.requestRender(),
	};

	editor.onSubmit = (text: string): void => {
		dispatchSlashCommand(parseSlashCommand(text), slashCtx);
	};

	const root = buildLayout({ banner, chat: chatPanel, editor, footer: footer.view });
	tui.addChild(root);
	tui.setFocus(editor);
	tui.start();

	let resolveRun: (code: number) => void = () => {};
	const run = new Promise<number>((resolve) => {
		resolveRun = resolve;
	});

	// Anchor the Node event loop while the TUI is alive. Piped or /dev/null
	// stdin (used by diag harnesses) can close early, which would otherwise
	// let the process exit before the termination coordinator runs.
	const keepAlive = setInterval(() => {}, 1 << 30);

	let overlayState: OverlayState = "closed";
	let overlayHandle: ReturnType<TUI["showOverlay"]> | null = null;
	let dispatchBoardTicker: ReturnType<typeof setInterval> | null = null;
	let shuttingDown = false;

	const renderDispatchBoard = (): void => {
		dispatchBoard.setText(formatDispatchBoardLines(dispatchBoardStore.rows()).join("\n"));
		dispatchBoard.invalidate();
	};

	const stopDispatchBoardTicker = (): void => {
		if (!dispatchBoardTicker) return;
		clearInterval(dispatchBoardTicker);
		dispatchBoardTicker = null;
	};

	const startDispatchBoardTicker = (): void => {
		stopDispatchBoardTicker();
		dispatchBoardTicker = setInterval(() => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}, 250);
	};

	const closeOverlay = (): void => {
		if (overlayState === "closed") return;
		overlayState = "closed";
		stopDispatchBoardTicker();
		overlayHandle?.hide();
		overlayHandle = null;
		tui.requestRender();
	};

	const openSuperOverlay = (): void => {
		if (overlayState !== "closed") return;
		deps.modes.requestSuper("keybind");
		overlayState = "super-confirm";
		overlayHandle = tui.showOverlay(superOverlay, {
			anchor: "center",
			width: superOverlayWidth,
		});
		tui.requestRender();
	};

	const openProvidersOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "providers";
		overlayHandle = openProvidersOverlay(tui, deps.providers);
		tui.requestRender();
	};

	const openCostOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "cost";
		overlayHandle = openCostOverlay(tui, deps.observability, {
			bus: deps.bus,
			sessionId: deps.getSessionId?.() ?? null,
		});
		tui.requestRender();
	};

	const openReceiptsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "receipts";
		overlayHandle = openReceiptsOverlay(tui, deps.dispatch);
		tui.requestRender();
	};

	const openThinkingOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "thinking";
		const settings = deps.getSettings?.();
		const current = settings ? readThinkingLevel(settings) : "off";
		const available = getAvailableThinkingLevels(deps.getOrchestratorModel?.());
		overlayHandle = openThinkingOverlay(tui, {
			current,
			available,
			onSelect: (next) => {
				deps.onSetThinkingLevel?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openModelOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		overlayState = "model";
		overlayHandle = openModelOverlay(tui, {
			settings,
			providers: deps.providers,
			onSelect: (ref) => {
				deps.onSelectModel?.(ref);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openScopedModelsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		overlayState = "scoped-models";
		overlayHandle = openScopedOverlay(tui, {
			currentScope: extractScopeFromSettings(settings),
			onCommit: (next) => {
				deps.onSetScope?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openSettingsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.getSettings || !deps.writeSettings) return;
		overlayState = "settings";
		const getSettings = deps.getSettings;
		const writeSettingsOut = deps.writeSettings;
		overlayHandle = openSettingsOverlay(tui, {
			getSettings,
			writeSettings: (next) => {
				writeSettingsOut(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openResumeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) {
			io.stderr("[/resume] session contract unavailable\n");
			return;
		}
		const sessionContract = deps.session;
		overlayState = "resume";
		overlayHandle = openSessionOverlay(tui, {
			session: sessionContract,
			onResume: (sessionId) => {
				deps.onResumeSession?.(sessionId);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openTreeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) {
			io.stderr("[/tree] session contract unavailable\n");
			return;
		}
		const sessionContract = deps.session;
		overlayState = "tree";
		overlayHandle = openTreeOverlay(tui, {
			session: sessionContract,
			onSwitchBranch: (sessionId) => {
				try {
					sessionContract.switchBranch(sessionId);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/tree] switchBranch failed: ${msg}\n`);
				}
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMessagePickerOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) {
			io.stderr("[/fork] session contract unavailable\n");
			return;
		}
		const sessionContract = deps.session;
		// No-op stderr when there is no current session so the user can tell
		// the overlay is intentionally inert rather than broken.
		if (sessionContract.current() === null) {
			io.stderr("[/fork] no current session to fork from; start one with /new or /resume first\n");
			return;
		}
		overlayState = "message-picker";
		overlayHandle = openMessagePickerOverlay(tui, {
			session: sessionContract,
			onFork: (parentTurnId) => {
				try {
					if (deps.onForkSession) {
						deps.onForkSession(parentTurnId);
					} else {
						sessionContract.fork(parentTurnId);
					}
					chatPanel.reset();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/fork] fork failed: ${msg}\n`);
				}
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const startNewSession = (): void => {
		if (!deps.onNewSession) {
			io.stderr("[/new] session contract unavailable\n");
			return;
		}
		deps.onNewSession();
		chatPanel.reset();
		footer.refresh();
		tui.requestRender();
	};

	const openHotkeysOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "hotkeys";
		overlayHandle = openHotkeysOverlay(tui);
		tui.requestRender();
	};

	const toggleDispatchBoardOverlay = (): void => {
		if (overlayState === "dispatch-board") {
			closeOverlay();
			return;
		}
		if (overlayState !== "closed") return;
		renderDispatchBoard();
		overlayState = "dispatch-board";
		overlayHandle = tui.showOverlay(dispatchBoard, {
			anchor: "center",
			width: dispatchBoardWidth,
		});
		startDispatchBoardTicker();
		tui.requestRender();
	};

	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		clearInterval(keepAlive);
		stopDispatchBoardTicker();
		dispatchBoardStore.unsubscribe();
		unsubscribeChat();
		for (const unsubscribe of dispatchBoardRenderUnsubscribers) unsubscribe();
		try {
			tui.stop();
		} catch {
			// TUI may already be stopped; swallow.
		}
		await deps.onShutdown();
		resolveRun(0);
	};

	const dispatchBoardRenderUnsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchStarted, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchProgress, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchCompleted, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchFailed, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
	];

	tui.addInputListener((data: string) => {
		if (shouldPassCtrlCToProcess(data, overlayState)) {
			process.kill(process.pid, "SIGINT");
			return { consume: true };
		}

		const overlayConsumed = routeOverlayKey(data, overlayState, {
			cancelSuper: () => {
				closeOverlay();
			},
			confirmSuper: (conf) => {
				deps.modes.confirmSuper(conf);
				closeOverlay();
				footer.refresh();
				tui.requestRender();
			},
			now: () => Date.now(),
			closeOverlay,
			requestShutdown: () => {
				void shutdown();
			},
		});
		if (overlayConsumed) {
			return { consume: true };
		}
		if (overlayState === "closed" && data === ESC && deps.chat.isStreaming()) {
			deps.chat.cancel();
			return { consume: true };
		}

		const consumed = routeInteractiveKey(data, {
			cycleMode: () => {
				deps.modes.cycleNormal();
				footer.refresh();
				tui.requestRender();
			},
			cycleThinking: () => {
				const available = getAvailableThinkingLevels(deps.getOrchestratorModel?.());
				if (available.length === 1 && available[0] === "off") {
					footer.refresh();
					tui.requestRender();
					return;
				}
				deps.onCycleThinking?.();
				footer.refresh();
				tui.requestRender();
			},
			requestShutdown: () => {
				void shutdown();
			},
			requestSuper: () => {
				openSuperOverlay();
			},
			toggleDispatchBoard: () => {
				toggleDispatchBoardOverlay();
			},
			openModelSelector: () => {
				openModelOverlayState();
			},
			openTree: () => {
				openTreeOverlayState();
			},
			cycleScopedModelForward: () => {
				deps.onCycleScopedModelForward?.();
				footer.refresh();
				tui.requestRender();
			},
			cycleScopedModelBackward: () => {
				deps.onCycleScopedModelBackward?.();
				footer.refresh();
				tui.requestRender();
			},
		});
		return consumed ? { consume: true } : undefined;
	});

	return run;
}
