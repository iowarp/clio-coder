import type { Component, Terminal, TuiMode, TuiRenderObserver } from "../engine/tui.js";
import {
	InstrumentedTuiAltScreen,
	InstrumentedTuiMainScreen,
	ProcessTerminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "../engine/tui.js";
import {
	createRenderTrace,
	type RenderTrace,
	renderTracePath,
	traceComponentRenders,
	traceProcessStdout,
} from "./render-trace.js";

export interface InteractiveShellTui {
	readonly mode?: TuiMode;
	addChild(component: Component): void;
	setLayoutRoot?(component: Component | undefined): void;
	setFocus(component: Component): void;
	start(): void;
	stop(): void;
	requestRender(): void;
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
	/** Await asynchronous teardown work started by stop(), including trace-file settlement. */
	settle(): Promise<void>;
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
		settle(): Promise<void> {
			return stopSettlement ?? Promise.resolve();
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

/** Production factories stay here so the composition root does not own them. */
export function createProcessInteractiveShell(
	options: { tuiMode?: TuiMode; onFirstFrameCommit?: (frameId: number) => void } = {},
): InteractiveShell<ProcessTerminal, TUI> {
	const tracePath = renderTracePath();
	let restoreStdout: (() => void) | null = null;
	let restoreFirstFrameStdout: (() => void) | null = null;
	let restoreRoot: (() => void) | null = null;
	if (tracePath) {
		try {
			activeRenderTrace = createRenderTrace(tracePath);
			restoreStdout = traceProcessStdout(activeRenderTrace);
		} catch {
			// A diagnostics path must never prevent the interactive application from starting.
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
	const renderObserver = trace ?? firstFrameOnlyObserver;
	return createInteractiveShell({
		createTerminal: () => new ProcessTerminal(),
		createTui: (terminal) =>
			options.tuiMode === "fullscreen"
				? options.onFirstFrameCommit || trace
					? new InstrumentedTuiAltScreen(terminal, renderObserver)
					: new TuiAltScreen(terminal)
				: options.onFirstFrameCommit || trace
					? new InstrumentedTuiMainScreen(terminal, renderObserver)
					: new TuiMainScreen(terminal),
		prepareRoot: (root) => {
			if (trace) restoreRoot = traceComponentRenders(root, trace);
		},
		onStop: async () => {
			restoreRoot?.();
			restoreRoot = null;
			restoreStdout?.();
			restoreStdout = null;
			restoreFirstFrameStdout?.();
			restoreFirstFrameStdout = null;
			if (activeRenderTrace === trace) activeRenderTrace = null;
			if (trace) await trace.close();
		},
	});
}
