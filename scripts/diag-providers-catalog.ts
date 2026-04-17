/**
 * Phase 4 slice 1 diag. Exercises the pure-logic providers layer: catalog,
 * matcher, discovery, and health. No CLIO_HOME, no settings I/O; discovery
 * is driven by an in-memory settings object.
 */

import { DEFAULT_SETTINGS } from "../src/core/defaults.js";
import { PROVIDER_CATALOG, getModelSpec, getProviderSpec } from "../src/domains/providers/catalog.js";
import { discoverProviders } from "../src/domains/providers/discovery.js";
import { applyProbeResult, initialHealth } from "../src/domains/providers/health.js";
import { match } from "../src/domains/providers/matcher.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-providers-catalog] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-providers-catalog] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function main(): void {
	// catalog
	check("catalog:non-empty", PROVIDER_CATALOG.length > 0, `len=${PROVIDER_CATALOG.length}`);
	const anthropic = getProviderSpec("anthropic");
	check("catalog:getProviderSpec(anthropic)", anthropic.models.length >= 1, `models=${anthropic.models.length}`);
	const sonnet = getModelSpec("anthropic", "claude-sonnet-4-6");
	check("catalog:getModelSpec(anthropic, sonnet-4-6)", sonnet !== null && sonnet.thinkingCapable === true);
	check("catalog:getModelSpec(anthropic, nonexistent)", getModelSpec("anthropic", "nonexistent") === null);

	// matcher — exact
	const exact = match({ requestedProviderId: "anthropic", requestedModelId: "claude-sonnet-4-6" });
	check(
		"matcher:exact-anthropic-sonnet",
		exact.confidence === "exact" && exact.providerId === "anthropic" && exact.modelId === "claude-sonnet-4-6",
		`got ${JSON.stringify(exact)}`,
	);

	// matcher — model-only fallback (first catalog provider carrying the model)
	const modelOnly = match({ requestedModelId: "claude-sonnet-4-6" });
	check(
		"matcher:model-only-fallback",
		modelOnly.confidence === "exact" && modelOnly.providerId === "anthropic",
		`got ${JSON.stringify(modelOnly)}`,
	);

	// matcher — provider-only fallback (first compatible model from the provider)
	const providerOnly = match({ requestedProviderId: "anthropic" });
	const anthropicModelIds = new Set(getProviderSpec("anthropic").models.map((m) => m.id));
	check(
		"matcher:provider-only-fallback",
		providerOnly.confidence === "fallback" && anthropicModelIds.has(providerOnly.modelId),
		`got ${JSON.stringify(providerOnly)}`,
	);

	// matcher — thinking capability fallback
	const thinking = match({ requiredCapabilities: ["thinking"] });
	const thinkingModel = getModelSpec(thinking.providerId, thinking.modelId);
	check(
		"matcher:thinking-capability",
		thinkingModel !== null && thinkingModel.thinkingCapable === true,
		`got ${JSON.stringify(thinking)}`,
	);

	// matcher — unknown model throws
	let threw = false;
	try {
		match({ requestedModelId: "nonexistent-model-xyz" });
	} catch (err) {
		threw = err instanceof Error && /no provider match/.test(err.message);
	}
	check("matcher:unknown-model-throws", threw);

	// discovery — anthropic enabled + cred present
	const settings = {
		...DEFAULT_SETTINGS,
		runtimes: { ...DEFAULT_SETTINGS.runtimes, enabled: ["anthropic"] },
	} as typeof DEFAULT_SETTINGS;
	const availability = discoverProviders({
		settings,
		credentialsPresent: new Set(["ANTHROPIC_API_KEY"]),
	});
	const anthropicAvail = availability.find((a) => a.id === "anthropic");
	check(
		"discovery:anthropic-available",
		anthropicAvail?.available === true && anthropicAvail?.hasCredential === true,
		`got ${JSON.stringify(anthropicAvail)}`,
	);
	const openaiAvail = availability.find((a) => a.id === "openai");
	check(
		"discovery:openai-disabled",
		openaiAvail?.available === false && openaiAvail?.reason === "disabled",
		`got ${JSON.stringify(openaiAvail)}`,
	);

	// discovery — enabled but credential missing
	const missingCred = discoverProviders({
		settings,
		credentialsPresent: new Set<string>(),
	});
	const anthropicMissing = missingCred.find((a) => a.id === "anthropic");
	check(
		"discovery:anthropic-missing-credential",
		anthropicMissing?.available === false && anthropicMissing?.reason === "missing credential",
		`got ${JSON.stringify(anthropicMissing)}`,
	);

	// discovery — bedrock has no credEnv, so credential counts as present when enabled
	const bedrockSettings = {
		...DEFAULT_SETTINGS,
		runtimes: { ...DEFAULT_SETTINGS.runtimes, enabled: ["bedrock"] },
	} as typeof DEFAULT_SETTINGS;
	const bedrockAvail = discoverProviders({
		settings: bedrockSettings,
		credentialsPresent: new Set<string>(),
	}).find((a) => a.id === "bedrock");
	check(
		"discovery:bedrock-no-credEnv-available",
		bedrockAvail?.available === true && bedrockAvail?.hasCredential === true,
		`got ${JSON.stringify(bedrockAvail)}`,
	);

	// health
	const initial = initialHealth("anthropic");
	check(
		"health:initial",
		initial.status === "unknown" && initial.lastCheckAt === null && initial.latencyMs === null,
		`got ${JSON.stringify(initial)}`,
	);

	const healthy = applyProbeResult(initial, { ok: true, latencyMs: 50, at: "2026-04-17T00:00:00.000Z" });
	check(
		"health:probe-ok-healthy",
		healthy.status === "healthy" && healthy.latencyMs === 50 && healthy.lastError === null,
		`got ${JSON.stringify(healthy)}`,
	);

	const down = applyProbeResult(initial, { ok: false, error: "boom", at: "2026-04-17T00:00:00.000Z" });
	check("health:probe-fail-down", down.status === "down" && down.lastError === "boom", `got ${JSON.stringify(down)}`);

	// health — degraded branch (ok + high latency)
	const degraded = applyProbeResult(initialHealth("foo"), { ok: true, latencyMs: 5000 });
	check("health:probe-ok-degraded", degraded.status === "degraded", `got ${JSON.stringify(degraded)}`);

	// discovery — one entry per catalog provider, no duplicates
	const allEnabled = {
		...DEFAULT_SETTINGS,
		runtimes: { ...DEFAULT_SETTINGS.runtimes, enabled: PROVIDER_CATALOG.map((p) => p.id) },
	} as typeof DEFAULT_SETTINGS;
	const fullDiscovery = discoverProviders({
		settings: allEnabled,
		credentialsPresent: new Set(["ANTHROPIC_API_KEY"]),
	});
	check(
		"discovery:one-entry-per-catalog-length",
		fullDiscovery.length === PROVIDER_CATALOG.length,
		`len=${fullDiscovery.length} catalog=${PROVIDER_CATALOG.length}`,
	);
	const discoveredIds = fullDiscovery.map((a) => a.id);
	const uniqueIds = new Set(discoveredIds);
	const catalogIds = new Set(PROVIDER_CATALOG.map((p) => p.id));
	const allPresentOnce =
		uniqueIds.size === discoveredIds.length &&
		uniqueIds.size === catalogIds.size &&
		[...catalogIds].every((id) => uniqueIds.has(id));
	check("discovery:one-entry-per-catalog-unique", allPresentOnce, `ids=${JSON.stringify(discoveredIds)}`);

	if (failures.length > 0) {
		process.stderr.write(`[diag-providers-catalog] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-providers-catalog] PASS\n");
}

main();
