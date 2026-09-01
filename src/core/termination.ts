/**
 * Shutdown coordinator implementing the four-phase sequence from spec §17:
 *   DRAIN     stop accepting new input / dispatch
 *   TERMINATE kill active workers (wired in Phase 7)
 *   PERSIST   atomic writes of domain state
 *   EXIT      tear down TUI and process.exit
 *
 * Each registered hook runs under a per-hook timeout so a single slow or
 * hanging hook cannot block the TUI from exiting. The cap is 500ms by
 * default and can be overridden via CLIO_CODER_SHUTDOWN_HOOK_MS for tests.
 * Timed-out hooks are logged and shutdown continues to the next hook.
 *
 * Every diagnostic here is written after the TUI has stopped: the interactive
 * controller stops the terminal before it calls shutdown(), and the signal path
 * stops it from a drain hook, which precedes persist. The renderer is gone, so
 * a diagnostic goes to stderr and is wrapped to the terminal width so it does
 * not overrun the frame the TUI just handed back.
 */

import { BusChannels } from "./bus-events.js";
import { getSharedBus } from "./shared-bus.js";

export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

type Hook = () => void | Promise<void>;

/** Wall-clock budget per hook and per domain.stop() call. */
export const DEFAULT_SHUTDOWN_HOOK_MS = 500;

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGTERM: 143,
};

/**
 * Break `text` into lines no wider than `width` columns, at spaces where
 * possible and mid-word when a single token is wider than the terminal.
 */
function wrapToWidth(text: string, width: number): string[] {
	if (!Number.isFinite(width) || width < 1) return [text];
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
		let token = word;
		while (token.length > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			lines.push(token.slice(0, width));
			token = token.slice(width);
		}
		if (!current) current = token;
		else if (current.length + 1 + token.length <= width) current = `${current} ${token}`;
		else {
			lines.push(current);
			current = token;
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

/**
 * Emit a shutdown notice on stderr, wrapped to the terminal width when stderr
 * or stdout is a TTY. Off a TTY the text goes out unwrapped, since a log
 * consumer wants one record per line.
 */
export function writeShutdownNotice(text: string): void {
	const width = process.stderr.columns ?? process.stdout.columns;
	const lines = width === undefined ? [text] : wrapToWidth(text, width);
	process.stderr.write(`${lines.join("\n")}\n`);
}

export function resolveShutdownHookBudgetMs(): number {
	const raw = process.env.CLIO_CODER_SHUTDOWN_HOOK_MS;
	if (raw === undefined) return DEFAULT_SHUTDOWN_HOOK_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHUTDOWN_HOOK_MS;
	return parsed;
}

/**
 * Run `op` with a wall-clock cap. Resolves true when `op` completes within
 * the budget, false when the cap fires first. Errors from `op` are swallowed
 * and reported via `onError` so a rejecting hook cannot propagate past the
 * shutdown coordinator.
 */
export async function runWithBudget(
	op: () => void | Promise<void>,
	budgetMs: number,
	onError?: (err: unknown) => void,
): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), budgetMs);
	});
	try {
		const done = Promise.resolve()
			.then(() => op())
			.then(() => "done" as const)
			.catch((err) => {
				onError?.(err);
				return "done" as const;
			});
		const outcome = await Promise.race([done, timeout]);
		return outcome === "done";
	} finally {
		if (timer) clearTimeout(timer);
	}
}

class TerminationCoordinator {
	private phase: TerminationPhase = "idle";
	private readonly drainHooks: Hook[] = [];
	private readonly terminateHooks: Hook[] = [];
	private readonly persistHooks: Hook[] = [];
	private exitCode = 0;
	private started = false;
	private drained = false;
	private readonly pendingNotices: string[] = [];
	private signalHandler: ((signal: NodeJS.Signals) => void) | null = null;

	getPhase(): TerminationPhase {
		return this.phase;
	}

	/**
	 * The process exit code this shutdown will use. Set before any hook runs,
	 * so a hook sealing terminal accounting records the same status the process
	 * reports (130 for SIGINT, 143 for SIGTERM).
	 */
	getExitCode(): number {
		return this.exitCode;
	}

	onDrain(hook: Hook): void {
		this.drainHooks.push(hook);
	}
	onTerminate(hook: Hook): void {
		this.terminateHooks.push(hook);
	}
	onPersist(hook: Hook): void {
		this.persistHooks.push(hook);
	}

	async shutdown(code = 0): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.exitCode = code;
		const bus = getSharedBus();
		const debug = process.env.CLIO_CODER_DEBUG_SHUTDOWN === "1";
		const budgetMs = resolveShutdownHookBudgetMs();
		const mark = debug ? process.hrtime.bigint() : 0n;
		const log = (msg: string): void => {
			if (!debug) return;
			const ms = Number(process.hrtime.bigint() - mark) / 1e6;
			process.stderr.write(`[clio-coder:shutdown] +${ms.toFixed(1)}ms ${msg}\n`);
		};

		this.phase = "draining";
		bus.emit(BusChannels.ShutdownRequested, { phase: this.phase });
		log("drain:start");
		await this.runHooks(this.drainHooks, "drain", budgetMs, log);
		log("drain:end");
		this.drained = true;
		this.flushNotices();
		bus.emit(BusChannels.ShutdownDrained, {});

		this.phase = "terminating";
		log("terminate:start");
		await this.runHooks(this.terminateHooks, "terminate", budgetMs, log);
		log("terminate:end");
		bus.emit(BusChannels.ShutdownTerminated, {});

		this.phase = "persisting";
		log("persist:start");
		await this.runHooks(this.persistHooks, "persist", budgetMs, log);
		log("persist:end");
		bus.emit(BusChannels.ShutdownPersisted, {});

		this.phase = "exiting";
		bus.emit(BusChannels.SessionEnd, { exitCode: this.exitCode });
		log("process.exit");
		process.exit(this.exitCode);
	}

	private async runHooks(hooks: Hook[], phase: string, budgetMs: number, log: (msg: string) => void): Promise<void> {
		for (let i = 0; i < hooks.length; i++) {
			const hook = hooks[i];
			if (!hook) continue;
			const t0 = process.hrtime.bigint();
			const completed = await runWithBudget(hook, budgetMs, (err) => {
				const message = err instanceof Error ? err.message : String(err);
				writeShutdownNotice(`[clio-coder:termination] ${phase}[${i}] failed: ${message}`);
				if (err instanceof Error && err.stack) log(err.stack);
			});
			const dt = Number(process.hrtime.bigint() - t0) / 1e6;
			if (!completed) {
				writeShutdownNotice(`[clio-coder:termination] ${phase}[${i}] exceeded ${budgetMs}ms budget; shutdown continues`);
			}
			log(`  ${phase}[${i}] ${dt.toFixed(1)}ms${completed ? "" : " (timed out)"}`);
		}
	}

	/**
	 * SIGHUP is here for the same reason as SIGTERM. Without a listener Node
	 * takes its default action and the process dies with no shutdown at all,
	 * which on a TUI session means the terminal is never given back. Exit codes
	 * follow the 128+signal convention.
	 */
	installSignalHandlers(): void {
		if (this.signalHandler) return;
		const handler = (signal: NodeJS.Signals): void => {
			this.notice(`Clio Coder: received ${signal}, shutting down...`);
			void this.shutdown(SIGNAL_EXIT_CODES[signal] ?? 143);
		};
		this.signalHandler = handler;
		process.once("SIGINT", handler);
		process.once("SIGTERM", handler);
		process.once("SIGHUP", handler);
	}

	/**
	 * Report something the operator should read after the process is gone,
	 * such as which signal ended it. Nothing here knows whether a TUI is on
	 * screen, but it does know that the terminal teardown is a drain hook: so
	 * until drain has finished the notice is held, and the moment it has, the
	 * notice goes to the terminal the TUI just handed back. Written straight
	 * away once drain is over, which is the case for a re-armed SIGINT arriving
	 * mid-shutdown. A second SIGTERM or SIGHUP inside the drain window takes
	 * Node's default action and the held notice dies with the process; that
	 * window is bounded by the per-hook budget and the shell reports the kill.
	 */
	notice(text: string): void {
		if (this.drained) {
			writeShutdownNotice(text);
			return;
		}
		this.pendingNotices.push(text);
	}

	private flushNotices(): void {
		for (const text of this.pendingNotices.splice(0)) writeShutdownNotice(text);
	}

	/**
	 * Hand SIGINT to a foreground owner and return the call that takes it back.
	 *
	 * Boot arms this coordinator before any interactive surface exists, and Node
	 * runs signal listeners in registration order, so a TUI that merely added its
	 * own listener would lose every first press to a shutdown already underway.
	 * One owner holds the interrupt at a time and the transfer is explicit.
	 * SIGTERM is not part of the handover; it is never an interactive gesture.
	 */
	releaseInterruptOwnership(): () => void {
		const handler = this.signalHandler;
		if (!handler) return () => {};
		process.off("SIGINT", handler);
		let restored = false;
		return () => {
			if (restored) return;
			restored = true;
			process.once("SIGINT", handler);
		};
	}
}

let coordinator: TerminationCoordinator | null = null;

export function getTerminationCoordinator(): TerminationCoordinator {
	if (!coordinator) coordinator = new TerminationCoordinator();
	return coordinator;
}
