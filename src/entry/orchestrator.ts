import chalk from "chalk";
import { BusChannels } from "../core/bus-events.js";
import { installBusTracer } from "../core/bus-trace.js";
import { loadDomains } from "../core/domain-loader.js";
import { getSharedBus } from "../core/shared-bus.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import { PromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SessionDomainModule } from "../domains/session/index.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

const BANNER = `
  ${chalk.cyan("◆ clio")}  IOWarp orchestrator coding-agent
  ${chalk.dim("v0.1 dev · pi-mono 0.67.4 · ready")}
`;

export async function bootOrchestrator(): Promise<BootResult> {
	const timer = new StartupTimer();
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	// CLIO_BUS_TRACE=1 turns on the stderr bus tracer used by diag scripts
	// (see src/core/bus-trace.ts). Off by default; no production overhead.
	installBusTracer();
	termination.installSignalHandlers();

	ensureInstalled();
	timer.mark("install check");

	const result = await loadDomains([
		ConfigDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		ModesDomainModule,
		PromptsDomainModule,
		AgentsDomainModule,
		DispatchDomainModule,
		SessionDomainModule,
		LifecycleDomainModule,
	]);
	timer.mark(`domains loaded (${result.loaded.length})`);

	// DRAIN: abort active dispatch runs and persist the ledger before domain teardown.
	// PERSIST: invoke domain-loader stop() (reverse topo order) to run each domain's stop hook.
	const dispatch = result.getContract<DispatchContract>("dispatch");
	if (dispatch) {
		termination.onDrain(async () => {
			await dispatch.drain();
		});
	}
	termination.onPersist(async () => {
		await result.stop();
	});

	bus.emit(BusChannels.SessionStart, { at: Date.now() });
	timer.mark("session_start fired");

	process.stdout.write(BANNER);
	if (process.env.CLIO_TIMING === "1") {
		process.stdout.write(`${timer.report()}\n`);
	}

	const runInteractive = process.env.CLIO_PHASE1_INTERACTIVE === "1";
	if (!runInteractive) {
		process.stdout.write(`${chalk.dim("  (Phase 1 stub. Interactive loop lands in Phase 6.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	// A real interactive loop lands in Phase 6. This stub keeps the process alive
	// until the user sends SIGINT/SIGTERM. Signal handlers alone do not hold the
	// Node event loop open, so we park a long no-op interval as an active handle.
	// Once shutdown() fires from the signal handler it runs DRAIN -> TERMINATE ->
	// PERSIST -> EXIT and calls process.exit itself with the correct signal-derived
	// code (130 for SIGINT, 143 for SIGTERM). We never return from this path so
	// the CLI entry cannot race shutdown and exit with code 0 before persist. The
	// interval is deliberately never cleared: process.exit tears everything down.
	void setInterval(() => {}, 1 << 30);
	await new Promise<never>(() => {});
	// Unreachable: the pending promise above is resolved only by process.exit.
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
