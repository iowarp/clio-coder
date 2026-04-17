import type { Model } from "@mariozechner/pi-ai";
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
import type { ChatLoop } from "./chat-loop.js";
import { createChatPanel } from "./chat-panel.js";
import { openCostOverlay } from "./cost-overlay.js";
import { createDispatchBoardStore, formatDispatchBoardLines } from "./dispatch-board.js";
import { buildFooter } from "./footer-panel.js";
import { buildLayout, defaultBanner } from "./layout.js";
import { openThinkingOverlay, readThinkingLevel } from "./overlays/thinking-selector.js";
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
	onShutdown: () => Promise<void>;
}

export const SHIFT_TAB = "\x1b[Z";
export const CTRL_D = "\x04";
export const CTRL_B = "\x02";
export const ALT_S = "\x1bs";
export const ALT_M = "\x1bm";
export const ENTER = "\r";
export const ESC = "\x1b";
export type OverlayState =
	| "closed"
	| "super-confirm"
	| "dispatch-board"
	| "providers"
	| "cost"
	| "receipts"
	| "thinking";

export interface KeyBindingDeps {
	cycleMode: () => void;
	cycleThinking: () => void;
	requestShutdown: () => void;
	requestSuper: () => void;
	toggleDispatchBoard: () => void;
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

export interface OverlayKeyDeps
	extends SuperOverlayKeyDeps,
		DispatchBoardOverlayKeyDeps,
		ProvidersOverlayKeyDeps,
		CostOverlayKeyDeps,
		ReceiptsOverlayKeyDeps,
		ThinkingOverlayKeyDeps {
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
	if (data === CTRL_B) {
		deps.toggleDispatchBoard();
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
		});
		return consumed ? { consume: true } : undefined;
	});

	return run;
}
