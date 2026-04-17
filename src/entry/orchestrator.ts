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
import { IntelligenceDomainModule } from "../domains/intelligence/index.js";
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import type { ModesContract } from "../domains/modes/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import { PromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { startInteractive } from "../interactive/index.js";

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
		SessionDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		// scheduling before dispatch: dispatch consults scheduling.preflight()
		// during admission to gate on the session budget ceiling.
		DispatchDomainModule,
		IntelligenceDomainModule,
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

	// CLIO_INTERACTIVE=1 is the current env; CLIO_PHASE1_INTERACTIVE=1 is a
	// backward-compat alias from Phase 1's stub loop. Both route into the
	// minimal interactive TUI introduced in Phase 9.
	const runInteractive = process.env.CLIO_INTERACTIVE === "1" || process.env.CLIO_PHASE1_INTERACTIVE === "1";
	if (!runInteractive) {
		process.stdout.write(`${chalk.dim("  (non-interactive boot. pass CLIO_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	const modes = result.getContract<ModesContract>("modes");
	const providers = result.getContract<ProvidersContract>("providers");
	if (!modes || !providers || !dispatch) {
		process.stderr.write("clio: interactive mode requires modes + providers + dispatch contracts; aborting.\n");
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}

	await startInteractive({
		modes,
		providers,
		dispatch,
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
