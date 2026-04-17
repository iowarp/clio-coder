/**
 * Shutdown coordinator implementing the four-phase sequence from spec §17:
 *   DRAIN     stop accepting new input / dispatch
 *   TERMINATE kill active workers (wired in Phase 7)
 *   PERSIST   atomic writes of domain state
 *   EXIT      tear down TUI and process.exit
 *
 * Phase 1 wires the scaffolding and the process signal handlers so later phases
 * can register hooks without reinventing the state machine.
 */

import { BusChannels } from "./bus-events.js";
import { getSharedBus } from "./shared-bus.js";

export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

type Hook = () => void | Promise<void>;

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

		this.phase = "draining";
		bus.emit(BusChannels.ShutdownRequested, { phase: this.phase });
		await this.runHooks(this.drainHooks);
		bus.emit(BusChannels.ShutdownDrained, {});

		this.phase = "terminating";
		await this.runHooks(this.terminateHooks);
		bus.emit(BusChannels.ShutdownTerminated, {});

		this.phase = "persisting";
		await this.runHooks(this.persistHooks);
		bus.emit(BusChannels.ShutdownPersisted, {});

		this.phase = "exiting";
		bus.emit(BusChannels.SessionEnd, { exitCode: this.exitCode });
		process.exit(this.exitCode);
	}

	private async runHooks(hooks: Hook[]): Promise<void> {
		for (const hook of hooks) {
			try {
				await hook();
			} catch (err) {
				console.error("[clio:termination] hook failed:", err);
			}
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
