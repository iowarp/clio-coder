/**
 * Shutdown coordinator implementing the four-phase sequence from spec §17:
 *   DRAIN     stop accepting new input / dispatch
 *   TERMINATE kill active workers (wired in Phase 7)
 *   PERSIST   atomic writes of domain state
 *   EXIT      tear down TUI and process.exit
 *
 * Each registered hook runs under a per-hook timeout so a single slow or
 * hanging hook cannot block the TUI from exiting. The cap is 500ms by
 * default and can be overridden via CLIO_SHUTDOWN_HOOK_MS for tests.
 * Timed-out hooks are logged and shutdown continues to the next hook.
 */

import { BusChannels } from "./bus-events.js";
import { getSharedBus } from "./shared-bus.js";

export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

type Hook = () => void | Promise<void>;

/** Wall-clock budget per hook and per domain.stop() call. */
export const DEFAULT_SHUTDOWN_HOOK_MS = 500;

export function resolveShutdownHookBudgetMs(): number {
	const raw = process.env.CLIO_SHUTDOWN_HOOK_MS;
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
		timer.unref?.();
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

	getPhase(): TerminationPhase {
		return this.phase;
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
		const debug = process.env.CLIO_DEBUG_SHUTDOWN === "1";
		const budgetMs = resolveShutdownHookBudgetMs();
		const mark = debug ? process.hrtime.bigint() : 0n;
		const log = (msg: string): void => {
			if (!debug) return;
			const ms = Number(process.hrtime.bigint() - mark) / 1e6;
			process.stderr.write(`[clio:shutdown] +${ms.toFixed(1)}ms ${msg}\n`);
		};

		this.phase = "draining";
		bus.emit(BusChannels.ShutdownRequested, { phase: this.phase });
		log("drain:start");
		await this.runHooks(this.drainHooks, "drain", budgetMs, log);
		log("drain:end");
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
				console.error("[clio:termination] hook failed:", err);
			});
			const dt = Number(process.hrtime.bigint() - t0) / 1e6;
			if (!completed) {
				process.stderr.write(
					`[clio:termination] ${phase}[${i}] exceeded ${budgetMs}ms budget; abandoning and continuing shutdown\n`,
				);
			}
			log(`  ${phase}[${i}] ${dt.toFixed(1)}ms${completed ? "" : " (timed out)"}`);
		}
	}

	installSignalHandlers(): void {
		const handler = (signal: NodeJS.Signals): void => {
			process.stderr.write(`\nclio: received ${signal}, shutting down...\n`);
			void this.shutdown(signal === "SIGINT" ? 130 : 143);
		};
		process.once("SIGINT", handler);
		process.once("SIGTERM", handler);
	}
}

let coordinator: TerminationCoordinator | null = null;

export function getTerminationCoordinator(): TerminationCoordinator {
	if (!coordinator) coordinator = new TerminationCoordinator();
	return coordinator;
}

export function resetTerminationCoordinator(): void {
	coordinator = null;
}
