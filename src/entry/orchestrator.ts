import chalk from "chalk";
import { BusChannels } from "../core/bus-events.js";
import { loadDomains } from "../core/domain-loader.js";
import { getSharedBus } from "../core/shared-bus.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";

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
	termination.installSignalHandlers();

	ensureInstalled();
	timer.mark("install check");

	const result = await loadDomains([ConfigDomainModule, LifecycleDomainModule]);
	timer.mark(`domains loaded (${result.loaded.length})`);

	bus.emit(BusChannels.SessionStart, { at: Date.now() });
	timer.mark("session_start fired");

	process.stdout.write(BANNER);
	if (process.env.CLIO_TIMING === "1") {
		process.stdout.write(timer.report() + "\n");
	}

	const runInteractive = process.env.CLIO_PHASE1_INTERACTIVE === "1";
	if (!runInteractive) {
		process.stdout.write(chalk.dim("  (Phase 1 stub. Interactive loop lands in Phase 6.)") + "\n");
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	// A real interactive loop lands in Phase 6. This stub keeps the process alive
	// until the user sends SIGINT/SIGTERM, so Phase 1 can smoke-test boot-and-idle.
	await new Promise<void>((resolve) => {
		termination.onDrain(() => resolve());
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
