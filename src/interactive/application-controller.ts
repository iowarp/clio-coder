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
	"clio.message.interrupt",
	"clio.message.dequeue",
	"clio.thinking.expand",
	"clio.thinking.expandAll",
] as const satisfies ReadonlyArray<ClioKeybinding>;

const GLOBAL_ACTION_ORDER = [
	"clio.status.toggle",
	"clio.thinking.cycle",
	"clio.session.tree",
	"clio.dispatchBoard.toggle",
	"clio.tasks.open",
	"clio.decisions.open",
	"clio.dispatch.background",
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
	/**
	 * Take SIGINT from whatever armed it before this controller existed and
	 * return the call that gives it back.
	 */
	takeInterruptOwnership(): () => void;
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
	/** Let pi-tui's focused Editor own dedicated prompt-history actions before app bindings. */
	matchesEditorHistory: (data: string) => boolean;
	matchesAction: (data: string, id: ClioKeybinding) => boolean;
	dispatchAction: (id: ClioKeybinding) => boolean;
	cancelActiveEditorBash: () => boolean;
	isStreaming: () => boolean;
	cancelActiveRun: () => void;
	getEditorText: () => string;
	clearEditor: () => void;
	requestRender: () => void;
	/**
	 * Ctrl+C armed the double-tap and is waiting for the second press, or the
	 * window lapsed and it no longer is. Every other Ctrl+C outcome changes
	 * something the operator can see; arming changed nothing at all, so the
	 * 500ms window that quits was undiscoverable and a first press was
	 * indistinguishable from a key the application never received (issue #108).
	 * The footer's leader indicator exists for exactly this reason and this
	 * rides beside it.
	 */
	onShutdownArmedChange?: (armed: boolean) => void;
	closeOverlay: () => void;
	listNotifications: () => ReadonlyArray<{ id: string }>;
	dismissNotification: (id: string) => void;
	dismissAllNotifications: () => void;
	toggleLastToolExpanded: () => boolean;
	toggleAllToolsExpanded: () => boolean;
	toggleLastThinking: () => boolean;
	toggleAllThinking: () => boolean;
	shutdownDisposers: ReadonlyArray<() => void>;
	/** Settle the last presentation mutation into an accepted/drained frame. */
	beforeStopUi?: () => Promise<void>;
	stopUi: () => void;
	cancelParkedCalls: (reason: string) => void;
	onShutdown: () => Promise<void>;
	/**
	 * Report a teardown step that failed. Deliberately not the UI notice channel:
	 * interactive teardown disposes that before the application's own shutdown
	 * runs, so a notice raised here would have nowhere to land.
	 */
	reportShutdownFailure: (step: string, error: unknown) => void;
	/**
	 * Register a terminal teardown to run on shutdown paths that never reach
	 * this controller.
	 *
	 * `/quit` and Ctrl+C both come through here and stop the terminal on the
	 * way out. A signal does not: SIGTERM goes straight to the termination
	 * coordinator, which runs its hooks and calls process.exit with the TUI
	 * still owning the screen. Measured on a pty, `kill -TERM` left the cursor
	 * hidden, the last private-mode sequence on the wire being `?25l`, where
	 * `/quit` on the same build ended with `?25h`.
	 */
	registerTerminalTeardown?: (teardown: () => void | Promise<void>) => void;
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

	let shutdownArmed = false;
	let armedIndicator: ApplicationIntervalHandle | null = null;

	const clearArmedIndicatorTimer = (): void => {
		if (!armedIndicator) return;
		deps.intervals.clearInterval(armedIndicator);
		armedIndicator = null;
	};

	/**
	 * Raise or drop the armed indicator. Arming schedules its own expiry because
	 * nothing repaints an idle prompt on its own: the footer ticker returns early
	 * when no turn is running, so a hint left standing would outlive the window
	 * and promise a quit the next press no longer performs. The interval
	 * coordinator is the only scheduler this boundary owns, so the callback
	 * cancels its own handle and fires once.
	 */
	const setShutdownArmed = (armed: boolean): void => {
		if (!armed && !shutdownArmed) return;
		// Re-arming while an earlier expiry is still pending restarts the window
		// rather than returning early: the clock and the timer are independent, so
		// a press that lands after the window by the clock but before the late
		// timer fires must not leave that timer to clear the hint mid-window.
		clearArmedIndicatorTimer();
		const changed = armed !== shutdownArmed;
		shutdownArmed = armed;
		if (armed) {
			armedIndicator = deps.intervals.setInterval(() => setShutdownArmed(false), APPLICATION_DOUBLE_TAP_MS);
			armedIndicator.unref?.();
		}
		if (changed) deps.onShutdownArmedChange?.(armed);
		deps.requestRender();
	};

	/** Teardown steps that threw, held until the terminal is safe to write past. */
	const failures: Array<{ step: string; error: unknown }> = [];

	/**
	 * Release one process-level resource. A step that throws has left a resource
	 * either already released or beyond this boundary's reach; either way the
	 * remaining steps still have to run. The terminal is the common case, since
	 * it can close before shutdown begins and stopping it twice is harmless.
	 * Continuing is not the same as calling it a success, so the failure is kept.
	 */
	const release = (step: string, action: () => void): void => {
		try {
			action();
		} catch (error) {
			failures.push({ step, error });
		}
	};

	/**
	 * Hand the collected failures to the diagnostic. Draining means a second call
	 * cannot repeat what the first already reported.
	 */
	const reportFailures = (): void => {
		for (const failure of failures.splice(0)) {
			try {
				deps.reportShutdownFailure(failure.step, failure.error);
			} catch {
				// A diagnostic that cannot report has nowhere left to report to.
			}
		}
	};

	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		let failed = false;
		// The signal path calls this without awaiting it, so a failing step must
		// not escape as an unhandled rejection, and `run` has to settle either
		// way or the process hangs with nothing left to resolve it.
		try {
			release("signal handoff", () => deps.signals.off("SIGINT", handleCtrlC));
			// Ownership goes back before teardown runs, so an interrupt during a
			// slow release still reaches a handler that exits the process.
			release("signal handoff", () => restoreInterruptOwner());
			release("keep-alive interval", () => deps.intervals.clearInterval(keepAlive));
			// Quitting while the double-tap hint is up leaves a timer scheduled
			// against a terminal that is about to stop. Released silently: there is
			// no frame left to repaint it out of.
			release("armed indicator", () => {
				shutdownArmed = false;
				clearArmedIndicatorTimer();
			});
			for (const interval of deps.intervalsToClear) {
				release("owned interval", () => deps.intervals.clearInterval(interval));
			}
			for (const dispose of deps.shutdownDisposers) release("shutdown disposer", dispose);
			if (deps.beforeStopUi) {
				try {
					await deps.beforeStopUi();
				} catch (error) {
					failures.push({ step: "final frame", error });
				}
			}
			release("terminal stop", () => deps.stopUi());
			release("parked calls", () => deps.cancelParkedCalls("Clio Coder shutting down"));
			// Reported here rather than as each step fails: the terminal is down by
			// now, so a diagnostic cannot land on top of a TUI still painting. It
			// also has to precede onShutdown, which exits the process.
			failed = failures.length > 0;
			reportFailures();
			await deps.onShutdown();
		} catch (error) {
			failed = true;
			failures.push({ step: "application shutdown", error });
			reportFailures();
		} finally {
			// Nothing reads this code today, which is exactly why it should not
			// claim a clean teardown that did not happen.
			resolveRun(failed ? 1 : 0);
		}
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
			// A press that cancelled a run is not intent to quit, so it must not
			// arm the shutdown clock. Leaving it armed meant the natural gesture
			// of pressing again when the first press looked like it did nothing
			// killed the application mid-turn, with the last frame still reading
			// `writing` and no word about the session being saved. Quitting still
			// works: once the run is cancelled, two presses inside the window do
			// what they have always done.
			lastCtrlCAt = 0;
			setShutdownArmed(false);
			deps.cancelActiveRun();
			return;
		}
		if (action === "close-overlay") {
			lastCtrlCAt = 0;
			setShutdownArmed(false);
			deps.closeOverlay();
			return;
		}
		if (action === "clear-editor") {
			setShutdownArmed(false);
			deps.clearEditor();
			deps.requestRender();
			return;
		}
		// arm-shutdown. The one branch that used to fall off the end of this
		// function with nothing to show for the press.
		setShutdownArmed(true);
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
		// pi-tui's dedicated history actions are editor actions even when an
		// operator has rebound a Clio application action onto the same chord. Leave
		// the input unconsumed so TuiBase delivers it to the focused Editor.
		if (deps.getOverlayState() === "closed" && deps.matchesEditorHistory(data)) return undefined;

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

	// One owner holds SIGINT at a time. Boot arms process termination first and
	// Node runs listeners in registration order, so this controller only sees the
	// first press if the previous owner hands it over. Everything else on the
	// signal stays put: clearing it wholesale would disarm handlers this process
	// never installed, including an embedder's.
	const restoreInterruptOwner = deps.signals.takeInterruptOwnership();
	deps.signals.on("SIGINT", handleCtrlC);
	// Every exit gives the terminal back, including the ones that never reach
	// this controller. Stopping an already-stopped terminal is a no-op, so the
	// ordinary path running both is harmless.
	deps.registerTerminalTeardown?.(async () => {
		if (deps.beforeStopUi) {
			try {
				await deps.beforeStopUi();
			} catch (error) {
				failures.push({ step: "final frame", error });
			}
		}
		release("terminal stop", () => deps.stopUi());
		reportFailures();
	});

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
