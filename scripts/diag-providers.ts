/**
 * Phase 4 slice 4 diag. Exercises the wired ProvidersDomainModule end-to-end
 * against a hermetic CLIO_HOME. Validates:
 *   - list() returns 8 entries (one per catalog provider).
 *   - With no credentials set, every entry is unavailable except `local`
 *     (which has no credentialsEnvVar).
 *   - Setting an anthropic credential flips that entry to available=true and
 *     its health transitions to "healthy" after probeAll().
 *   - getAdapter() returns the anthropic adapter by id and null for unknown ids.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-providers] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-providers] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-providers-"));
	const ENV_KEYS = [
		"CLIO_HOME",
		"CLIO_DATA_DIR",
		"CLIO_CONFIG_DIR",
		"CLIO_CACHE_DIR",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GOOGLE_API_KEY",
		"GROQ_API_KEY",
		"MISTRAL_API_KEY",
		"OPENROUTER_API_KEY",
	] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	// Clear per-kind overrides BEFORE setting CLIO_HOME so that xdg.ts resolves
	// paths under the ephemeral home; clear provider env vars so discovery only
	// sees credentials we inject via the store.
	for (const k of ENV_KEYS) {
		if (k !== "CLIO_HOME") delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		// Touch settings.yaml with every provider id enabled so discoverProviders
		// does not filter on the default ["native"] allowlist.
		writeFileSync(
			join(home, "settings.yaml"),
			[
				"runtimes:",
				"  enabled:",
				"    - anthropic",
				"    - openai",
				"    - google",
				"    - groq",
				"    - mistral",
				"    - openrouter",
				"    - bedrock",
				"    - local",
				"",
			].join("\n"),
		);

		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetSharedBus, getSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
		const { BusChannels } = await import("../src/core/bus-events.js");
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();

		const bus = getSharedBus();
		let healthEvents = 0;
		bus.on(BusChannels.ProviderHealth, () => {
			healthEvents += 1;
		});

		const result = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
		check("domain:loaded", result.loaded.includes("providers"), `loaded=${result.loaded.join(",")}`);

		type ProvidersContractType = import("../src/domains/providers/contract.js").ProvidersContract;
		type ProviderIdType = import("../src/domains/providers/catalog.js").ProviderId;
		const providers = result.getContract<ProvidersContractType>("providers");
		check("domain:contract-exposed", providers !== undefined);
		if (!providers) {
			await result.stop();
			return;
		}

		// 2. list() returns 8 entries
		const initial = providers.list();
		check("list:has-8-entries", initial.length === 8, `len=${initial.length}`);

		// 3. No credentials set → every entry's available === false except
		// those with no credentialsEnvVar in the catalog (local, bedrock).
		// bedrock's AWS SDK chain is outside credentialsPresent()'s purview,
		// so discovery treats it as available when enabled; local has no
		// credential requirement at all.
		const unavailable = initial.filter((e) => !e.available).map((e) => e.id);
		const available = initial
			.filter((e) => e.available)
			.map((e) => e.id)
			.sort();
		check(
			"list:only-credless-available",
			available.length === 2 && available[0] === "bedrock" && available[1] === "local",
			`available=${JSON.stringify(available)} unavailable=${JSON.stringify(unavailable)}`,
		);
		const credBearing: ReadonlyArray<string> = ["anthropic", "openai", "google", "groq", "mistral", "openrouter"];
		const allCredBearingUnavailable = credBearing.every((id) => unavailable.includes(id));
		check("list:all-cred-bearing-unavailable", allCredBearingUnavailable, `unavailable=${JSON.stringify(unavailable)}`);
		const anthropicInitial = initial.find((e) => e.id === "anthropic");
		check(
			"list:anthropic-reason-missing-credential",
			anthropicInitial?.reason === "missing credential",
			`reason=${anthropicInitial?.reason}`,
		);
		check(
			"list:anthropic-health-initial-unknown",
			anthropicInitial?.health.status === "unknown",
			`status=${anthropicInitial?.health.status}`,
		);

		// 4. Set anthropic credential via the contract
		providers.credentials.set("anthropic" as ProviderIdType, "sk-ant-diagp4s4-do-not-log");
		check("credentials:hasKey-anthropic", providers.credentials.hasKey("anthropic" as ProviderIdType));

		// 5. probeAll
		await providers.probeAll();
		check("probe:bus-fired-for-all", healthEvents === 8, `events=${healthEvents}`);

		// 6. list() again: anthropic is available=true, health=healthy
		const afterProbe = providers.list();
		const anthropicAfter = afterProbe.find((e) => e.id === "anthropic");
		check(
			"list:anthropic-available-after-probe",
			anthropicAfter?.available === true,
			`available=${anthropicAfter?.available} reason=${anthropicAfter?.reason}`,
		);
		check(
			"list:anthropic-health-healthy-after-probe",
			anthropicAfter?.health.status === "healthy",
			`status=${anthropicAfter?.health.status} error=${anthropicAfter?.health.lastError ?? "null"}`,
		);
		// local adapter has no credEnv and its probe always returns ok; expect healthy.
		const localAfter = afterProbe.find((e) => e.id === "local");
		check(
			"list:local-health-healthy-after-probe",
			localAfter?.health.status === "healthy",
			`status=${localAfter?.health.status}`,
		);
		// openai has no credential set → probe returns not-ok → status=down
		const openaiAfter = afterProbe.find((e) => e.id === "openai");
		check(
			"list:openai-health-down-after-probe",
			openaiAfter?.health.status === "down",
			`status=${openaiAfter?.health.status}`,
		);

		// 7. getAdapter for anthropic returns the adapter
		const anthropicAdapter = providers.getAdapter("anthropic" as ProviderIdType);
		check(
			"getAdapter:anthropic-returned",
			anthropicAdapter !== null && anthropicAdapter.id === "anthropic",
			`id=${anthropicAdapter?.id ?? "null"}`,
		);

		// 8. getAdapter for unknown id returns null
		const missing = providers.getAdapter("nonexistent" as unknown as ProviderIdType);
		check("getAdapter:unknown-null", missing === null);

		await result.stop();
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
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-providers] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-providers] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-providers] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
