import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 10 diag. Wires Config + Providers + Safety + Modes + Dispatch + Session +
 * Observability against an ephemeral CLIO_HOME, fakes a dispatch completion +
 * safety classification on the bus, and asserts the contract sees them.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-observability] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-observability] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-observability-"));
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
		]);
		check("domain:loaded", result.loaded.includes("observability"), `loaded=${result.loaded.join(",")}`);

		type ObservabilityContractType = import("../src/domains/observability/contract.js").ObservabilityContract;
		const obs = result.getContract<ObservabilityContractType>("observability");
		check("domain:contract-exposed", obs !== undefined);
		if (!obs) {
			await result.stop();
			return;
		}

		const bus = getSharedBus();

		// Faux dispatch run — emit completed with token + duration metadata.
		bus.emit(BusChannels.DispatchCompleted, {
			runId: "run-diag-1",
			exitCode: 0,
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			tokenCount: 5000,
			durationMs: 2345,
		});
		bus.emit(BusChannels.DispatchFailed, { runId: "run-diag-2", exitCode: 1, reason: "failed" });
		bus.emit(BusChannels.SafetyClassified, {
			tool: "read_file",
			actionClass: "read",
			reasons: [],
		});

		const metrics = obs.metrics();
		check("metrics:completed-count", metrics.dispatchesCompleted === 1, `got=${metrics.dispatchesCompleted}`);
		check("metrics:failed-count", metrics.dispatchesFailed === 1, `got=${metrics.dispatchesFailed}`);
		check("metrics:safety-count", metrics.safetyClassifications === 1, `got=${metrics.safetyClassifications}`);
		check("metrics:token-count", metrics.totalTokens === 5000, `got=${metrics.totalTokens}`);
		const hist = metrics.histograms["dispatch.duration_ms"];
		check("metrics:duration-histogram", hist !== undefined && hist.count === 1, `hist=${JSON.stringify(hist)}`);

		check("cost:session-total-positive", obs.sessionCost() > 0, `cost=${obs.sessionCost()}`);
		check("cost:entries-non-empty", obs.costEntries().length === 1, `entries=${obs.costEntries().length}`);

		// Manual accumulation through the contract (for /cost overlay parity).
		obs.recordTokens("openai", "gpt-5", 1000);
		check("cost:manual-accumulate", obs.costEntries().length === 2);

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
		process.stderr.write(`[diag-observability] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-observability] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-observability] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
