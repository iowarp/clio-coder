/**
 * Phase 4 slice 2 diag. Exercises each RuntimeAdapter stub without issuing
 * network traffic. Verifies canSatisfy branches, initialHealth, and the
 * sync probe contract.
 */

import type { ProviderId } from "../src/domains/providers/catalog.js";
import type { RuntimeAdapter } from "../src/domains/providers/runtime-contract.js";
import { RUNTIME_ADAPTERS } from "../src/domains/providers/runtimes/index.js";

interface AdapterCase {
	id: ProviderId;
	credEnv: string | null;
	validModel: string;
	/** Whether canSatisfy rejects unknown model ids. openrouter+local accept anything. */
	rejectsUnknownModel: boolean;
	/** Whether probe returns ok=false when no credentials are provided. amazon-bedrock+local succeed regardless. */
	probeFailsWithoutCreds: boolean;
}

const CASES: ReadonlyArray<AdapterCase> = [
	{
		id: "anthropic",
		credEnv: "ANTHROPIC_API_KEY",
		validModel: "claude-sonnet-4-6",
		rejectsUnknownModel: true,
		probeFailsWithoutCreds: true,
	},
	{
		id: "openai",
		credEnv: "OPENAI_API_KEY",
		validModel: "gpt-5",
		rejectsUnknownModel: true,
		probeFailsWithoutCreds: true,
	},
	{
		id: "google",
		credEnv: "GOOGLE_API_KEY",
		validModel: "gemini-2.5-pro",
		rejectsUnknownModel: true,
		probeFailsWithoutCreds: true,
	},
	{
		id: "groq",
		credEnv: "GROQ_API_KEY",
		validModel: "llama-4-scout",
		rejectsUnknownModel: true,
		probeFailsWithoutCreds: true,
	},
	{
		id: "mistral",
		credEnv: "MISTRAL_API_KEY",
		validModel: "mistral-large-2",
		rejectsUnknownModel: true,
		probeFailsWithoutCreds: true,
	},
	{
		id: "openrouter",
		credEnv: "OPENROUTER_API_KEY",
		validModel: "openai/gpt-5",
		rejectsUnknownModel: false,
		probeFailsWithoutCreds: true,
	},
	{
		id: "amazon-bedrock",
		credEnv: null,
		validModel: "anthropic.claude-sonnet-4-6",
		rejectsUnknownModel: true,
		probeFailsWithoutCreds: false,
	},
	{ id: "local", credEnv: null, validModel: "llama-local", rejectsUnknownModel: false, probeFailsWithoutCreds: false },
];

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-provider-runtimes] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-provider-runtimes] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function findAdapter(id: ProviderId): RuntimeAdapter {
	const adapter = RUNTIME_ADAPTERS.find((a) => a.id === id);
	if (!adapter) throw new Error(`adapter not registered: ${id}`);
	return adapter;
}

async function main(): Promise<void> {
	// RUNTIME_ADAPTERS now contains 8 provider adapters, the Claude SDK
	// adapter (tier=sdk, id=claude-sdk, registered in Phase 8), and 6 CLI
	// adapters. Provider-tier checks below scope to the catalog-backed
	// provider slice; claude-sdk is covered by diag-cli-runtimes... no,
	// diag-claude-sdk.
	const expectedOrder: ReadonlyArray<ProviderId> = [
		"anthropic",
		"openai",
		"google",
		"groq",
		"mistral",
		"openrouter",
		"amazon-bedrock",
		"local",
	];
	const expectedProviderIds = new Set<string>(expectedOrder);
	const providerAdapters = RUNTIME_ADAPTERS.filter((a) => expectedProviderIds.has(String(a.id)));
	check("registry:provider-length", providerAdapters.length === 8, `len=${providerAdapters.length}`);

	const ids = providerAdapters.map((a) => a.id);
	const uniqueIds = new Set(ids);
	check("registry:unique-ids", uniqueIds.size === ids.length, `ids=${JSON.stringify(ids)}`);

	check(
		"registry:order",
		expectedOrder.every((id, i) => providerAdapters[i]?.id === id),
		`got ${JSON.stringify(ids)}`,
	);

	for (const c of CASES) {
		const adapter = findAdapter(c.id);
		const credsSet = c.credEnv ? new Set<string>([c.credEnv]) : new Set<string>();

		// 1. canSatisfy with a valid model + expected creds → ok=true
		const satisfyOk = adapter.canSatisfy({ modelId: c.validModel, credentialsPresent: credsSet });
		check(`${c.id}:canSatisfy-valid`, satisfyOk.ok === true, `got ${JSON.stringify(satisfyOk)}`);

		// 2. canSatisfy with an unknown model → ok=false (except openrouter + local)
		if (c.rejectsUnknownModel) {
			const satisfyBad = adapter.canSatisfy({ modelId: "nonexistent-xyz", credentialsPresent: credsSet });
			check(`${c.id}:canSatisfy-unknown-rejected`, satisfyBad.ok === false, `got ${JSON.stringify(satisfyBad)}`);
		}

		// 3. initialHealth.status === "unknown"
		const health = adapter.initialHealth();
		check(
			`${c.id}:initialHealth-unknown`,
			health.status === "unknown" && health.providerId === c.id,
			`got ${JSON.stringify(health)}`,
		);

		// 4. probe with creds present → ok=true
		const probeOk = await adapter.probe({ credentialsPresent: credsSet });
		check(`${c.id}:probe-ok`, probeOk.ok === true, `got ${JSON.stringify(probeOk)}`);

		// 5. probe with empty creds → ok=false (except amazon-bedrock + local)
		if (c.probeFailsWithoutCreds) {
			const probeBad = await adapter.probe({ credentialsPresent: new Set<string>() });
			check(`${c.id}:probe-fail-without-creds`, probeBad.ok === false, `got ${JSON.stringify(probeBad)}`);
		} else {
			const probeStill = await adapter.probe({ credentialsPresent: new Set<string>() });
			check(`${c.id}:probe-ok-without-creds`, probeStill.ok === true, `got ${JSON.stringify(probeStill)}`);
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-provider-runtimes] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-provider-runtimes] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-provider-runtimes] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
