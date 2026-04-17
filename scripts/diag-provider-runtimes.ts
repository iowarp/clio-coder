/**
 * Provider-runtime diag. Exercises config-only readiness separately from the
 * explicit live probe path.
 */

import type { ProviderId } from "../src/domains/providers/catalog.js";
import type { RuntimeAdapter } from "../src/domains/providers/runtime-contract.js";
import { RUNTIME_ADAPTERS } from "../src/domains/providers/runtimes/index.js";

interface AdapterCase {
	id: ProviderId;
	credEnv: string | null;
	validModel: string;
	/** Whether canSatisfy rejects unknown model ids. */
	rejectsUnknownModel: boolean;
	/** Whether the legacy config probe fails when credentials are absent. */
	probeFailsWithoutCreds: boolean;
}

type DiagMode = "config" | "live";

const RUN_LIVE = process.env.CLIO_DIAG_LIVE === "1";

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
	// llamacpp/lmstudio/ollama/openai-compat are covered by the dedicated
	// local-engine diags because their live probe path performs real HTTP.
];

const failures: string[] = [];

function emit(status: "OK" | "FAIL" | "SKIP", mode: DiagMode, label: string, detail?: string): void {
	const suffix = detail ? ` ${detail}` : "";
	const line = `[diag-provider-runtimes] [${mode}] ${status.padEnd(4)} ${label}${suffix}\n`;
	if (status === "FAIL") process.stderr.write(line);
	else process.stdout.write(line);
}

function check(mode: DiagMode, label: string, ok: boolean, detail?: string): void {
	if (ok) {
		emit("OK", mode, label);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	emit("FAIL", mode, label, detail ? `(${detail})` : undefined);
}

function skip(mode: DiagMode, label: string, detail: string): void {
	emit("SKIP", mode, label, `(${detail})`);
}

function findAdapter(id: ProviderId): RuntimeAdapter {
	const adapter = RUNTIME_ADAPTERS.find((a) => a.id === id);
	if (!adapter) throw new Error(`adapter not registered: ${id}`);
	return adapter;
}

async function main(): Promise<void> {
	const expectedOrder: ReadonlyArray<ProviderId> = [
		"anthropic",
		"openai",
		"google",
		"groq",
		"mistral",
		"openrouter",
		"amazon-bedrock",
		"llamacpp",
		"lmstudio",
		"ollama",
		"openai-compat",
	];
	const expectedProviderIds = new Set<string>(expectedOrder);
	const providerAdapters = RUNTIME_ADAPTERS.filter((a) => expectedProviderIds.has(String(a.id)));
	check("config", "registry:provider-length", providerAdapters.length === 11, `len=${providerAdapters.length}`);

	const ids = providerAdapters.map((a) => a.id);
	const uniqueIds = new Set(ids);
	check("config", "registry:unique-ids", uniqueIds.size === ids.length, `ids=${JSON.stringify(ids)}`);
	check(
		"config",
		"registry:order",
		expectedOrder.every((id, i) => providerAdapters[i]?.id === id),
		`got ${JSON.stringify(ids)}`,
	);

	for (const c of CASES) {
		const adapter = findAdapter(c.id);
		const credsSet = c.credEnv ? new Set<string>([c.credEnv]) : new Set<string>();

		const satisfyOk = adapter.canSatisfy({ modelId: c.validModel, credentialsPresent: credsSet });
		check("config", `${c.id}:canSatisfy-valid`, satisfyOk.ok === true, `got ${JSON.stringify(satisfyOk)}`);

		if (c.rejectsUnknownModel) {
			const satisfyBad = adapter.canSatisfy({ modelId: "nonexistent-xyz", credentialsPresent: credsSet });
			check("config", `${c.id}:canSatisfy-unknown-rejected`, satisfyBad.ok === false, `got ${JSON.stringify(satisfyBad)}`);
		}

		const health = adapter.initialHealth();
		check(
			"config",
			`${c.id}:initialHealth-unknown`,
			health.status === "unknown" && health.providerId === c.id,
			`got ${JSON.stringify(health)}`,
		);

		const probeOk = await adapter.probe({ credentialsPresent: credsSet });
		check("config", `${c.id}:probe-ok`, probeOk.ok === true, `got ${JSON.stringify(probeOk)}`);

		if (c.probeFailsWithoutCreds) {
			const probeBad = await adapter.probe({ credentialsPresent: new Set<string>() });
			check("config", `${c.id}:probe-fail-without-creds`, probeBad.ok === false, `got ${JSON.stringify(probeBad)}`);
		} else {
			const probeStill = await adapter.probe({ credentialsPresent: new Set<string>() });
			check("config", `${c.id}:probe-ok-without-creds`, probeStill.ok === true, `got ${JSON.stringify(probeStill)}`);
		}

		if (!RUN_LIVE) {
			skip("live", `${c.id}:probeLive-skipped`, "set CLIO_DIAG_LIVE=1 to exercise adapter.probeLive()");
			continue;
		}

		check("live", `${c.id}:probeLive-exposed`, typeof adapter.probeLive === "function");
		if (!adapter.probeLive) continue;
		const live = await adapter.probeLive({ credentialsPresent: credsSet });
		check(
			"live",
			`${c.id}:probeLive-config-only-error`,
			live.ok === false && live.error === `live probe not implemented for ${c.id}; config-only`,
			`got ${JSON.stringify(live)}`,
		);
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
