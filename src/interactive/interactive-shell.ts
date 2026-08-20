import type { Component, Terminal, TuiMode, TuiRenderObserver } from "../engine/tui.js";
import { InstrumentedTuiAltScreen, InstrumentedTuiMainScreen, ProcessTerminal, type TUI } from "../engine/tui.js";
import {
	createRenderTrace,
	type RenderTrace,
	renderTracePath,
	traceComponentRenders,
	traceProcessStdout,
} from "./render-trace.js";
import type { StdoutBackpressureGate } from "./stdout-backpressure.js";
import { installStdoutBackpressureGate } from "./stdout-backpressure.js";

export interface InteractiveShellTui {
	readonly mode?: TuiMode;
	addChild(component: Component): void;
	removeChild?(component: Component): void;
	setLayoutRoot?(component: Component | undefined): void;
	setFocus(component: Component): void;
	start(): void;
	stop(): void;
	requestRender(): void;
	renderNow?(force?: boolean): void;
}

export interface InteractiveShellInterval {
	unref?(): void;
}

export interface InteractiveShellDeps<
	TTerminal extends Terminal = Terminal,
	TTui extends InteractiveShellTui = InteractiveShellTui,
> {
	createTerminal: () => TTerminal;
	createTui: (terminal: TTerminal) => TTui;
	scheduleInterval?: (callback: () => void, intervalMs: number) => InteractiveShellInterval;
	clearScheduledInterval?: (handle: InteractiveShellInterval) => void;
	prepareRoot?: (root: Component) => void;
	onStop?: () => void | Promise<void>;
}

export interface InteractiveShell<
	TTerminal extends Terminal = Terminal,
	TTui extends InteractiveShellTui = InteractiveShellTui,
> {
	terminal: TTerminal;
	tui: TTui;
	mount(root: Component, focus: Component): void;
	anchor(): Promise<number>;
	releaseAnchor(): void;
	stop(): void;
	/** Issue the latest model frame and wait a finite bound for stdout drain. */
	commitCurrentFrame(timeoutMs?: number): Promise<number | null>;
	/** True after this process has observed stdout saturation at least once. */
	hasObservedBackpressure(): boolean;
	/** Enable admission control only while presentation pacing is actually active. */
	setStreamPacingActive(active: boolean): void;
	/** Await asynchronous teardown work started by stop(), including trace-file settlement. */
	settle(): Promise<void>;
	/** Resolve after the next render transaction that reaches terminal commit. */
	nextCommittedFrame(): Promise<number | null>;
	complete(code: number): void;
}

const KEEP_ALIVE_INTERVAL_MS = 1 << 30;

/**
 * Own the process-level TUI shell without owning overlays or application
 * collaborators. Mounting and anchoring remain separate because startup
 * installs the footer, tool, and workspace tickers after TUI.start() but
 * before the keep-alive anchor. Keeping that seam explicit prevents an
 * extraction from silently changing initialization order.
 */
export function createInteractiveShell<TTerminal extends Terminal, TTui extends InteractiveShellTui>(
	deps: InteractiveShellDeps<TTerminal, TTui>,
): InteractiveShell<TTerminal, TTui> {
	const terminal = deps.createTerminal();
	const tui = deps.createTui(terminal);
	const scheduleInterval =
		deps.scheduleInterval ??
		((callback: () => void, intervalMs: number): InteractiveShellInterval => setInterval(callback, intervalMs));
	const clearScheduledInterval =
		deps.clearScheduledInterval ?? ((handle: InteractiveShellInterval): void => clearInterval(handle as NodeJS.Timeout));

	let mounted = false;
	let keepAlive: InteractiveShellInterval | null = null;
	let resolveRun: ((code: number) => void) | null = null;
	let run: Promise<number> | null = null;
	let completedCode: number | null = null;
	let stopped = false;
	let stopSettlement: Promise<void> | null = null;

	return {
		terminal,
		tui,
		mount(root, focus): void {
			if (mounted) return;
			mounted = true;
			deps.prepareRoot?.(root);
			tui.addChild(root);
			if (tui.mode === "fullscreen") tui.setLayoutRoot?.(root);
			tui.setFocus(focus);
			tui.start();
		},
		anchor(): Promise<number> {
			if (run) return run;
			run = new Promise<number>((resolve) => {
				resolveRun = resolve;
				if (completedCode !== null) resolve(completedCode);
			});
			// Piped or /dev/null stdin can close while the interactive process is
			// still draining. This timer deliberately stays referenced.
			keepAlive = scheduleInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
			return run;
		},
		releaseAnchor(): void {
			if (!keepAlive) return;
			clearScheduledInterval(keepAlive);
			keepAlive = null;
		},
		stop(): void {
			if (stopped) return;
			stopped = true;
			try {
				tui.stop();
			} catch {
				// TUI may already be stopped by a closed input stream.
			} finally {
				try {
					stopSettlement = Promise.resolve(deps.onStop?.()).then(() => undefined);
				} catch {
					// Teardown is best effort, like a terminal that already closed.
					stopSettlement = Promise.resolve();
				}
			}
		},
		async commitCurrentFrame(): Promise<number | null> {
			if (!tui.renderNow) {
				tui.requestRender();
				return null;
			}
			tui.renderNow(false);
			return null;
		},
		hasObservedBackpressure: () => false,
		setStreamPacingActive: () => {},
		settle(): Promise<void> {
			return stopSettlement ?? Promise.resolve();
		},
		nextCommittedFrame(): Promise<number | null> {
			return Promise.resolve(null);
		},
		complete(code): void {
			if (completedCode !== null) return;
			completedCode = code;
			resolveRun?.(code);
		},
	};
}

/**
 * Trace for the current process, created once when CLIO_CODER_RENDER_TRACE names a
 * file. The panel wires its render metrics into the same instance, so the
 * frame rows carry both the build cost and the write cost.
 */
let activeRenderTrace: RenderTrace | null = null;

export function getActiveRenderTrace(): RenderTrace | null {
	return activeRenderTrace;
}

/**
 * Wait for ordinary admission, but never let a missing drain erase the final
 * model state. After the finite pre-render bound, exactly one caller-supplied
 * final frame is still issued; a post-render drain wait is likewise bounded.
 */
export async function settleLatestInteractiveFrame(
	gate: Pick<StdoutBackpressureGate, "whenWritable"> | null,
	timeoutMs: number,
	renderFrame: () => Promise<number>,
): Promise<number> {
	const writableBeforeRender = gate ? await gate.whenWritable(timeoutMs) : true;
	const frameId = await renderFrame();
	if (writableBeforeRender && gate) await gate.whenWritable(timeoutMs);
	return frameId;
}

/** Production factories stay here so the composition root does not own them. */
export function createProcessInteractiveShell(
	options: {
		tuiMode?: TuiMode;
		onFirstFrameCommit?: (frameId: number) => void;
		streamPacingActive?: boolean;
		/** Construction fault seams for process-global rollback contracts. */
		testing?: {
			createTerminal?: () => ProcessTerminal;
			createTui?: (terminal: ProcessTerminal) => TUI;
		};
	} = {},
): InteractiveShell<ProcessTerminal, TUI> {
	const tracePath = renderTracePath();
	let restoreStdout: (() => void) | null = null;
	let restoreFirstFrameStdout: (() => void) | null = null;
	let restoreRoot: (() => void) | null = null;
	let backpressure: StdoutBackpressureGate | null = null;
	let observedBackpressure = false;
	if (tracePath) {
		let candidate: RenderTrace | null = null;
		try {
			candidate = createRenderTrace(tracePath);
			restoreStdout = traceProcessStdout(candidate);
			activeRenderTrace = candidate;
		} catch {
			// A diagnostics path must never prevent the interactive application from starting.
			restoreStdout?.();
			restoreStdout = null;
			void candidate?.close().catch(() => {});
			activeRenderTrace = null;
		}
	} else activeRenderTrace = null;
	const trace = activeRenderTrace;
	if (trace && options.onFirstFrameCommit) trace.onFirstFrameCommit(options.onFirstFrameCommit);
	let firstFrameDelivered = false;
	let firstFrameSeq = 0;
	let firstFrameActive = false;
	let firstFrameWrote = false;
	if (!trace && options.onFirstFrameCommit) {
		const stdout = process.stdout;
		const original = stdout.write;
		const wrapped = function (this: typeof stdout, ...args: unknown[]): boolean {
			const returned = Reflect.apply(original, this, args) as boolean;
			if (firstFrameActive) firstFrameWrote = true;
			return returned;
		} as typeof stdout.write;
		stdout.write = wrapped;
		restoreFirstFrameStdout = () => {
			if (stdout.write === wrapped) stdout.write = original;
		};
	}
	const firstFrameOnlyObserver: TuiRenderObserver = {
		isEnabled: () => !firstFrameDelivered,
		beginFrame: () => {
			firstFrameSeq += 1;
			firstFrameActive = true;
			firstFrameWrote = false;
			return firstFrameSeq;
		},
		endFrame: (frame) => {
			firstFrameActive = false;
			if (firstFrameDelivered || !firstFrameWrote) return;
			firstFrameDelivered = true;
			options.onFirstFrameCommit?.(frame as number);
			restoreFirstFrameStdout?.();
			restoreFirstFrameStdout = null;
		},
		beginPhase: () => null,
		endPhase: () => {},
	};
	const primaryObserver = trace ?? (options.onFirstFrameCommit ? firstFrameOnlyObserver : null);
	let committedFrameSequence = 0;
	const frameWaiters: Array<{ resolve: (frameId: number) => void }> = [];
	const renderObserver: TuiRenderObserver = {
		isEnabled: () => frameWaiters.length > 0 || (primaryObserver !== null && (primaryObserver.isEnabled?.() ?? true)),
		beginFrame: (fields) => ({
			primary: primaryObserver?.beginFrame(fields),
			primaryActive: primaryObserver !== null && (primaryObserver.isEnabled?.() ?? true),
			frameId: ++committedFrameSequence,
		}),
		endFrame: (token) => {
			const frame = token as { primary: unknown; primaryActive: boolean; frameId: number };
			if (frame.primaryActive) primaryObserver?.endFrame(frame.primary);
			for (const waiter of frameWaiters.splice(0)) waiter.resolve(frame.frameId);
		},
		beginPhase: (token, phase) => {
			const frame = token as { primary: unknown; primaryActive: boolean };
			return frame.primaryActive ? primaryObserver?.beginPhase(frame.primary, phase) : null;
		},
		endPhase: (token, phase, phaseToken) => {
			const frame = token as { primary: unknown; primaryActive: boolean };
			if (frame.primaryActive) primaryObserver?.endPhase(frame.primary, phase, phaseToken);
		},
	};
	const renderAdmission = {
		get blocked() {
			return backpressure?.blocked ?? false;
		},
		onWritable(listener: () => void) {
			if (backpressure) return backpressure.onWritable(listener);
			queueMicrotask(listener);
			return () => {};
		},
	};
	const setStreamPacingActive = (active: boolean): void => {
		if (active) {
			backpressure ??= installStdoutBackpressureGate();
			return;
		}
		if (!backpressure) return;
		observedBackpressure ||= backpressure.observed;
		backpressure.restore();
		backpressure = null;
	};
	let instrumentationCleanupStarted = false;
	let instrumentationCleanupPromise: Promise<void> = Promise.resolve();
	const cleanupInstrumentation = (): Promise<void> => {
		if (instrumentationCleanupStarted) return instrumentationCleanupPromise;
		instrumentationCleanupStarted = true;
		const errors: unknown[] = [];
		const attempt = (operation: () => void): void => {
			try {
				operation();
			} catch (error) {
				errors.push(error);
			}
		};
		attempt(() => setStreamPacingActive(false));
		attempt(() => restoreRoot?.());
		restoreRoot = null;
		attempt(() => restoreStdout?.());
		restoreStdout = null;
		attempt(() => restoreFirstFrameStdout?.());
		restoreFirstFrameStdout = null;
		if (activeRenderTrace === trace) activeRenderTrace = null;
		instrumentationCleanupPromise = (async () => {
			if (trace) {
				try {
					await trace.close();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "interactive shell instrumentation cleanup failed");
		})();
		return instrumentationCleanupPromise;
	};
	let shell: InteractiveShell<ProcessTerminal, TUI>;
	try {
		setStreamPacingActive(options.streamPacingActive === true);
		shell = createInteractiveShell({
			createTerminal: options.testing?.createTerminal ?? (() => new ProcessTerminal()),
			createTui: (terminal) =>
				options.testing?.createTui?.(terminal) ??
				(options.tuiMode === "fullscreen"
					? new InstrumentedTuiAltScreen(terminal, renderObserver, undefined, undefined, undefined, renderAdmission)
					: new InstrumentedTuiMainScreen(terminal, renderObserver, undefined, undefined, renderAdmission)),
			prepareRoot: (root) => {
				if (trace) restoreRoot = traceComponentRenders(root, trace);
			},
			onStop: cleanupInstrumentation,
		});
	} catch (error) {
		void cleanupInstrumentation().catch(() => {});
		throw error;
	}
	return {
		...shell,
		nextCommittedFrame(): Promise<number | null> {
			return new Promise<number>((resolve) => {
				frameWaiters.push({ resolve });
			});
		},
		async commitCurrentFrame(timeoutMs = 30_000): Promise<number | null> {
			return await settleLatestInteractiveFrame(backpressure, timeoutMs, async () => {
				const tui = shell.tui as TUI & { renderNow(force?: boolean): void };
				const waiter: { resolve: (frameId: number) => void } = { resolve: () => {} };
				const frame = new Promise<number>((resolve) => {
					waiter.resolve = resolve;
					frameWaiters.push(waiter);
				});
				try {
					// Even when the writable never drains, issue exactly one bounded
					// final frame. This finite write commits the newest model state
					// without reopening ordinary frame production.
					tui.renderNow(true);
				} catch (error) {
					const index = frameWaiters.indexOf(waiter);
					if (index >= 0) frameWaiters.splice(index, 1);
					throw error;
				}
				return await frame;
			});
		},
		hasObservedBackpressure: () => observedBackpressure || backpressure?.observed === true,
		setStreamPacingActive,
	};
}
