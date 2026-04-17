import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 10 diag. Verifies the scheduling domain's budget verdicts and that
 * budget.alert fires when dispatch.enqueued would cross the ceiling.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-scheduling] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-scheduling] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-scheduling-"));
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
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { resetSharedBus, getSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();

		writeFileSync(join(home, "settings.yaml"), "");

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { PromptsDomainModule } = await import("../src/domains/prompts/index.js");
		const { AgentsDomainModule } = await import("../src/domains/agents/index.js");
		const { DispatchDomainModule } = await import("../src/domains/dispatch/index.js");
		const { SessionDomainModule } = await import("../src/domains/session/index.js");
		const { ObservabilityDomainModule } = await import("../src/domains/observability/index.js");
		const { SchedulingDomainModule } = await import("../src/domains/scheduling/index.js");
		const { BusChannels } = await import("../src/core/bus-events.js");

		const result = await loadDomains([
			ConfigDomainModule,
			ProvidersDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			PromptsDomainModule,
			AgentsDomainModule,
			DispatchDomainModule,
			SessionDomainModule,
			ObservabilityDomainModule,
			SchedulingDomainModule,
		]);
		check("domain:loaded", result.loaded.includes("scheduling"), `loaded=${result.loaded.join(",")}`);

		type SchedulingContractType = import("../src/domains/scheduling/contract.js").SchedulingContract;
		type ObservabilityContractType = import("../src/domains/observability/contract.js").ObservabilityContract;
		const sched = result.getContract<SchedulingContractType>("scheduling");
		const obs = result.getContract<ObservabilityContractType>("observability");
		check("domain:contract-exposed", sched !== undefined && obs !== undefined);
		if (!sched || !obs) {
			await result.stop();
			return;
		}

		const ceiling = sched.ceilingUsd();
		check("budget:ceiling-positive", ceiling > 0, `ceiling=${ceiling}`);
		check("budget:under-zero", sched.checkCeiling(0) === "under");
		check("budget:at-ceiling", sched.checkCeiling(ceiling) === "at");
		check("budget:over-ceiling", sched.checkCeiling(ceiling + 1) === "over");

		check("cluster:empty-nodes", sched.listNodes().length === 0);
		check("concurrency:no-active", sched.activeWorkers() === 0);
		check("concurrency:acquire", sched.tryAcquireWorker() === true);
		check("concurrency:active-after-acquire", sched.activeWorkers() === 1);
		sched.releaseWorker();
		check("concurrency:active-after-release", sched.activeWorkers() === 0);

		const bus = getSharedBus();
		const alerts: Array<{ level: unknown; currentUsd: unknown; ceilingUsd: unknown }> = [];
		const off = bus.on(BusChannels.BudgetAlert, (payload) => {
			alerts.push(payload as { level: unknown; currentUsd: unknown; ceilingUsd: unknown });
		});

		// Enqueue while under budget — no alert.
		bus.emit(BusChannels.DispatchEnqueued, { runId: "r1", agentId: "a" });
		check("alert:none-under-budget", alerts.length === 0, `alerts=${alerts.length}`);

		// Drive observability over the ceiling and re-enqueue.
		const overTokens = Math.ceil(((ceiling + 1) * 1_000_000) / ((3 + 15) / 2));
		obs.recordTokens("anthropic", "claude-sonnet-4-6", overTokens);
		bus.emit(BusChannels.DispatchEnqueued, { runId: "r2", agentId: "a" });
		check("alert:fires-over-budget", alerts.length === 1, `alerts=${alerts.length}`);
		if (alerts[0]) {
			check("alert:level-over", alerts[0].level === "over", `level=${String(alerts[0].level)}`);
			check("alert:ceiling-value", alerts[0].ceilingUsd === ceiling, `got=${String(alerts[0].ceilingUsd)}`);
		}

		off();
		await result.stop();
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-scheduling] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-scheduling] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-scheduling] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
