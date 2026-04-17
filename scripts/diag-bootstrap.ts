/**
 * Phase 6 slice 7 diag. Measures orchestrator boot timing across the full
 * domain stack. Not a performance gate — intended for diagnosis. Prints a
 * `boot: <ms>` line and always exits 0 (with a stderr warning when the boot
 * takes longer than 1000ms).
 *
 * Boots in-process against a hermetic CLIO_HOME and, on success, runs a clean
 * shutdown through the domain loader (no termination coordinator) to release
 * state before the process ends.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOOT_BUDGET_MS = 1000;

async function main(): Promise<void> {
	const projectRoot = process.cwd();
	const workerJs = join(projectRoot, "dist/worker/entry.js");
	if (!existsSync(workerJs)) {
		process.stdout.write("[diag-bootstrap] building dist/ ...\n");
		execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	}
	if (!existsSync(workerJs)) {
		process.stderr.write(`[diag-bootstrap] build did not produce ${workerJs}\n`);
		process.exit(0);
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-bootstrap-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { resetTerminationCoordinator } = await import("../src/core/termination.js");
		resetTerminationCoordinator();

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { PromptsDomainModule } = await import("../src/domains/prompts/index.js");
		const { AgentsDomainModule } = await import("../src/domains/agents/index.js");
		const { DispatchDomainModule } = await import("../src/domains/dispatch/index.js");
		const { SessionDomainModule } = await import("../src/domains/session/index.js");
		const { LifecycleDomainModule } = await import("../src/domains/lifecycle/index.js");

		const start = Date.now();
		const loaded = await loadDomains([
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
		const bootMs = Date.now() - start;

		process.stdout.write(`boot: ${bootMs} ms (domains=${loaded.loaded.length})\n`);
		if (bootMs > BOOT_BUDGET_MS) {
			process.stderr.write(
				`[diag-bootstrap] WARN boot exceeded ${BOOT_BUDGET_MS}ms budget (${bootMs}ms) — diagnostic only, not a gate\n`,
			);
		}

		await loaded.stop();
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`[diag-bootstrap] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(0);
});
