import type { ClioKeybinding } from "../domains/config/keybindings.js";
import { isKeyRelease, matchesKey } from "../engine/tui.js";
import type { LeaderKeyController } from "./leader-key.js";
import { isEscapeKey, type OverlayState, overlayOwnsInput } from "./overlay-lifecycle.js";

export const APPLICATION_DOUBLE_TAP_MS = 500;

const CLOSED_ACTION_ORDER = [
	"clio.notifications.dismiss",
	"clio.tool.expand",
	"clio.tool.expandAll",
	"clio.tool.liveOutput",
	"clio.editor.external",
	"clio.message.followUp",
	"clio.message.dequeue",
	"clio.thinking.expand",
	"clio.thinking.expandAll",
] as const satisfies ReadonlyArray<ClioKeybinding>;

const GLOBAL_ACTION_ORDER = [
	"clio.status.toggle",
	"clio.thinking.cycle",
	"clio.session.tree",
	"clio.dispatchBoard.toggle",
	"clio.model.select",
	// Backward stays ahead of forward so prefix-overlapping user bindings keep
	// the same more-specific-first behavior as the original input listener.
	"clio.model.cycleBackward",
	"clio.model.cycleForward",
	"clio.exit",
] as const satisfies ReadonlyArray<ClioKeybinding>;

export type CtrlCAction = "cancel-stream" | "close-overlay" | "clear-editor" | "arm-shutdown" | "shutdown";

export interface CtrlCActionState {
	overlayState: OverlayState;
	streaming: boolean;
	editorText: string;
	lastCtrlCAt: number;
	now: number;
}

function resolveApplicationCtrlCAction(state: CtrlCActionState): CtrlCAction {
	if (state.overlayState !== "closed") return "close-overlay";
	if (state.lastCtrlCAt > 0 && state.now - state.lastCtrlCAt <= APPLICATION_DOUBLE_TAP_MS) return "shutdown";
	if (state.streaming) return "cancel-stream";
	if (state.editorText.length > 0) return "clear-editor";
	return "arm-shutdown";
}

export interface ApplicationClock {
	now(): number;
}

export interface ApplicationSignalCoordinator {
	removeAllListeners(signal: "SIGINT"): void;
	on(signal: "SIGINT", listener: () => void): void;
	off(signal: "SIGINT", listener: () => void): void;
}

export interface ApplicationIntervalHandle {
	unref?(): void;
}

export interface ApplicationIntervalCoordinator {
	setInterval(callback: () => void, delayMs: number): ApplicationIntervalHandle;
	clearInterval(handle: ApplicationIntervalHandle): void;
}

export interface ApplicationControllerDeps {
	clock: ApplicationClock;
	signals: ApplicationSignalCoordinator;
	intervals: ApplicationIntervalCoordinator;
	intervalsToClear: ReadonlyArray<ApplicationIntervalHandle>;
	leaderKeys: LeaderKeyController;
	getOverlayState: () => OverlayState;
	routeOverlayKey: (data: string) => boolean;
	matchesAction: (data: string, id: ClioKeybinding) => boolean;
	dispatchAction: (id: ClioKeybinding) => boolean;
	cancelActiveEditorBash: () => boolean;
	isStreaming: () => boolean;
	cancelActiveRun: () => void;
	getEditorText: () => string;
	clearEditor: () => void;
	requestRender: () => void;
	closeOverlay: () => void;
	listNotifications: () => ReadonlyArray<{ id: string }>;
	dismissNotification: (id: string) => void;
	dismissAllNotifications: () => void;
	toggleLastToolExpanded: () => boolean;
	toggleAllToolsExpanded: () => boolean;
	toggleLastThinking: () => boolean;
	toggleAllThinking: () => boolean;
	shutdownDisposers: ReadonlyArray<() => void>;
	stopUi: () => void;
	cancelParkedCalls: (reason: string) => void;
	onShutdown: () => Promise<void>;
}

export type ApplicationInputResult = { consume: true } | undefined;

export interface ApplicationController {
	run: Promise<number>;
	handleInput(data: string): ApplicationInputResult;
	handleCtrlC(): void;
	dismissNotifications(): void;
	toggleToolExpansion(): void;
	toggleThinkingExpansion(): void;
	shutdown(): Promise<void>;
}

/**
 * Own the final application boundary: input precedence, double-tap clocks,
 * SIGINT, and the one ordered path that releases process-level resources.
 */
export function createApplicationController(deps: ApplicationControllerDeps): ApplicationController {
	let resolveRun: (code: number) => void = () => {};
	const run = new Promise<number>((resolve) => {
		resolveRun = resolve;
	});
	const keepAlive = deps.intervals.setInterval(() => {}, 1 << 30);
	let shuttingDown = false;
	let lastCtrlCAt = 0;
	let lastNotificationDismissAt = 0;
	let lastToolExpandAt = 0;
	let lastThinkingExpandAt = 0;

	const isDoubleTap = (lastAt: number, now: number): boolean => lastAt > 0 && now - lastAt <= APPLICATION_DOUBLE_TAP_MS;

	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		deps.signals.off("SIGINT", handleCtrlC);
		deps.intervals.clearInterval(keepAlive);
		for (const interval of deps.intervalsToClear) deps.intervals.clearInterval(interval);
		for (const dispose of deps.shutdownDisposers) dispose();
		try {
			deps.stopUi();
		} catch {
			// The terminal can close before shutdown begins; stopping it twice is harmless.
		}
		deps.cancelParkedCalls("Clio Coder shutting down");
		await deps.onShutdown();
		resolveRun(0);
	};

	const handleCtrlC = (): void => {
		const action = resolveApplicationCtrlCAction({
			overlayState: deps.getOverlayState(),
			streaming: deps.isStreaming(),
			editorText: deps.getEditorText(),
			lastCtrlCAt,
			now: deps.clock.now(),
		});
		if (action === "shutdown") {
			lastCtrlCAt = 0;
			void shutdown();
			return;
		}
		// Preserve the original second clock read. Production uses Date.now for
		// both, while tests can expose ordering at millisecond boundaries.
		lastCtrlCAt = deps.clock.now();
		if (action === "cancel-stream") {
			deps.cancelActiveRun();
			return;
		}
		if (action === "close-overlay") {
			lastCtrlCAt = 0;
			deps.closeOverlay();
			return;
		}
		if (action === "clear-editor") {
			deps.clearEditor();
			deps.requestRender();
		}
	};

	const dismissNotifications = (): void => {
		const now = deps.clock.now();
		const doubleTap = isDoubleTap(lastNotificationDismissAt, now);
		lastNotificationDismissAt = now;
		if (doubleTap) {
			deps.dismissAllNotifications();
			return;
		}
		const first = deps.listNotifications()[0];
		if (first) deps.dismissNotification(first.id);
	};

	const toggleToolExpansion = (): void => {
		const now = deps.clock.now();
		const doubleTap = isDoubleTap(lastToolExpandAt, now);
		lastToolExpandAt = now;
		const changed = doubleTap ? deps.toggleAllToolsExpanded() : deps.toggleLastToolExpanded();
		if (changed) deps.requestRender();
	};

	const toggleThinkingExpansion = (): void => {
		const now = deps.clock.now();
		const doubleTap = isDoubleTap(lastThinkingExpandAt, now);
		lastThinkingExpandAt = now;
		const changed = doubleTap ? deps.toggleAllThinking() : deps.toggleLastThinking();
		if (changed) deps.requestRender();
	};

	const handleInput = (data: string): ApplicationInputResult => {
		const initialOverlayState = deps.getOverlayState();
		if (overlayOwnsInput(initialOverlayState) && deps.leaderKeys.isPending()) deps.leaderKeys.reset();
		if (!overlayOwnsInput(initialOverlayState) && deps.leaderKeys.isPending() && deps.leaderKeys.route(data)) {
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+c") && !isKeyRelease(data)) {
			handleCtrlC();
			return { consume: true };
		}
		if (deps.routeOverlayKey(data)) return { consume: true };
		if (overlayOwnsInput(deps.getOverlayState())) return undefined;
		if (deps.getOverlayState() === "closed" && deps.leaderKeys.route(data)) return { consume: true };
		if (isEscapeKey(data) && deps.cancelActiveEditorBash()) return { consume: true };
		if (isEscapeKey(data) && deps.isStreaming()) {
			deps.cancelActiveRun();
			return { consume: true };
		}

		if (deps.getOverlayState() === "closed" && !isKeyRelease(data)) {
			for (const id of CLOSED_ACTION_ORDER) {
				if (!deps.matchesAction(data, id)) continue;
				deps.dispatchAction(id);
				return { consume: true };
			}
		}
		for (const id of GLOBAL_ACTION_ORDER) {
			if (!deps.matchesAction(data, id)) continue;
			return deps.dispatchAction(id) ? { consume: true } : undefined;
		}
		return undefined;
	};

	deps.signals.removeAllListeners("SIGINT");
	deps.signals.on("SIGINT", handleCtrlC);

	return {
		run,
		handleInput,
		handleCtrlC,
		dismissNotifications,
		toggleToolExpansion,
		toggleThinkingExpansion,
		shutdown,
	};
}
