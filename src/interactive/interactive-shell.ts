import type { Component, Terminal } from "../engine/tui.js";
import { ProcessTerminal, TUI } from "../engine/tui.js";
import { createRenderTrace, type RenderTrace, renderTracePath, traceTerminalWrites } from "./render-trace.js";

export interface InteractiveShellTui {
	addChild(component: Component): void;
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

	return {
		terminal,
		tui,
		mount(root, focus): void {
			if (mounted) return;
			mounted = true;
			tui.addChild(root);
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
			try {
				tui.stop();
			} catch {
				// TUI may already be stopped by a closed input stream.
			}
		},
		complete(code): void {
			if (completedCode !== null) return;
			completedCode = code;
			resolveRun?.(code);
		},
	};
}

/**
 * Trace for the current process, created once when CLIO_RENDER_TRACE names a
 * file. The panel wires its render metrics into the same instance, so the
 * frame rows carry both the build cost and the write cost.
 */
let activeRenderTrace: RenderTrace | null = null;

export function getActiveRenderTrace(): RenderTrace | null {
	return activeRenderTrace;
}

/** Production factories stay here so the composition root does not own them. */
export function createProcessInteractiveShell(): InteractiveShell<ProcessTerminal, TUI> {
	const tracePath = renderTracePath();
	if (tracePath) {
		activeRenderTrace = createRenderTrace(tracePath);
		const trace = activeRenderTrace;
		process.once("exit", () => trace.close());
	}
	const trace = activeRenderTrace;
	return createInteractiveShell({
		createTerminal: () => {
			const terminal = new ProcessTerminal();
			return trace ? traceTerminalWrites(terminal, trace) : terminal;
		},
		createTui: (terminal) => new TUI(terminal),
	});
}
