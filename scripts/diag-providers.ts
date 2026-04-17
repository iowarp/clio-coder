/**
 * Providers-domain diag. Separates config-only readiness from the explicit
 * live probe path while keeping CI offline by default.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DiagMode = "config" | "live";

const RUN_LIVE = process.env.CLIO_DIAG_LIVE === "1";
const failures: string[] = [];

function emit(status: "OK" | "FAIL" | "SKIP", mode: DiagMode, label: string, detail?: string): void {
	const suffix = detail ? ` ${detail}` : "";
	const line = `[diag-providers] [${mode}] ${status.padEnd(4)} ${label}${suffix}\n`;
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, capMs: number, pollMs = 10): Promise<{ ok: boolean; elapsedMs: number }> {
	const start = Date.now();
	const deadline = start + capMs;
	while (!check()) {
		if (Date.now() > deadline) return { ok: false, elapsedMs: Date.now() - start };
		await sleep(pollMs);
	}
	return { ok: true, elapsedMs: Date.now() - start };
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
	for (const k of ENV_KEYS) {
		if (k !== "CLIO_HOME") delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
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
				"    - amazon-bedrock",
				"    - llamacpp",
				"    - lmstudio",
				"    - ollama",
				"    - openai-compat",
				"",
			].join("\n"),
		);

		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const expectedData = join(home, "data");
		const resolvedData = clioDataDir();
		if (resolvedData !== expectedData) {
			throw new Error(`expected data dir ${expectedData}, got ${resolvedData}`);
		}
		check("config", "xdg:data-dir-matches-home", true);

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
		check("config", "domain:loaded", result.loaded.includes("providers"), `loaded=${result.loaded.join(",")}`);

		type ProvidersContractType = import("../src/domains/providers/contract.js").ProvidersContract;
		type ProviderIdType = import("../src/domains/providers/catalog.js").ProviderId;
		const providers = result.getContract<ProvidersContractType>("providers");
		check("config", "domain:contract-exposed", providers !== undefined);
		if (!providers) {
			await result.stop();
			return;
		}

		const initial = providers.list();
		check("config", "list:has-11-entries", initial.length === 11, `len=${initial.length}`);

		const unavailable = initial.filter((e) => !e.available).map((e) => e.id);
		const available = initial
			.filter((e) => e.available)
			.map((e) => e.id)
			.sort();
		const expectedCredless = ["amazon-bedrock", "llamacpp", "lmstudio", "ollama", "openai-compat"].sort();
		check(
			"config",
			"list:only-credless-available",
			available.length === expectedCredless.length && expectedCredless.every((id, i) => available[i] === id),
			`available=${JSON.stringify(available)} unavailable=${JSON.stringify(unavailable)}`,
		);

		const credBearing: ReadonlyArray<string> = ["anthropic", "openai", "google", "groq", "mistral", "openrouter"];
		const allCredBearingUnavailable = credBearing.every((id) => unavailable.includes(id));
		check(
			"config",
			"list:all-cred-bearing-unavailable",
			allCredBearingUnavailable,
			`unavailable=${JSON.stringify(unavailable)}`,
		);

		const anthropicInitial = initial.find((e) => e.id === "anthropic");
		check(
			"config",
			"list:anthropic-reason-missing-credential",
			anthropicInitial?.reason === "missing credential",
			`reason=${anthropicInitial?.reason}`,
		);
		check(
			"config",
			"list:anthropic-health-initial-unknown",
			anthropicInitial?.health.status === "unknown",
			`status=${anthropicInitial?.health.status}`,
		);

		providers.credentials.set("anthropic" as ProviderIdType, "sk-ant-diagp4s4-do-not-log");
		check("config", "credentials:hasKey-anthropic", providers.credentials.hasKey("anthropic" as ProviderIdType));

		const anthropicAdapter = providers.getAdapter("anthropic" as ProviderIdType);
		check(
			"config",
			"getAdapter:anthropic-returned",
			anthropicAdapter !== null && anthropicAdapter.id === "anthropic",
			`id=${anthropicAdapter?.id ?? "null"}`,
		);
		const missing = providers.getAdapter("nonexistent" as unknown as ProviderIdType);
		check("config", "getAdapter:unknown-null", missing === null);

		const anthropicConfig = anthropicAdapter?.canSatisfy({
			modelId: "claude-sonnet-4-6",
			credentialsPresent: new Set<string>(["ANTHROPIC_API_KEY"]),
		});
		check(
			"config",
			"adapter:anthropic-canSatisfy-ready",
			anthropicConfig?.ok === true,
			`got=${JSON.stringify(anthropicConfig)}`,
		);

		const llamacppAdapter = providers.getAdapter("llamacpp" as ProviderIdType);
		const llamacppConfig = llamacppAdapter?.canSatisfy({
			modelId: "",
			credentialsPresent: new Set<string>(),
			endpoints: {},
		});
		check(
			"config",
			"adapter:llamacpp-canSatisfy-no-endpoints",
			llamacppConfig?.ok === false && llamacppConfig.reason === "no llamacpp endpoints configured",
			`got=${JSON.stringify(llamacppConfig)}`,
		);

		await providers.probeAll();
		check("config", "probeAll:bus-fired-for-all", healthEvents === 11, `events=${healthEvents}`);

		const afterConfig = providers.list();
		const anthropicAfterConfig = afterConfig.find((e) => e.id === "anthropic");
		check(
			"config",
			"list:anthropic-available-after-probeAll",
			anthropicAfterConfig?.available === true,
			`available=${anthropicAfterConfig?.available} reason=${anthropicAfterConfig?.reason}`,
		);
		check(
			"config",
			"list:anthropic-health-healthy-after-probeAll",
			anthropicAfterConfig?.health.status === "healthy",
			`status=${anthropicAfterConfig?.health.status} error=${anthropicAfterConfig?.health.lastError ?? "null"}`,
		);

		const openaiAfterConfig = afterConfig.find((e) => e.id === "openai");
		check(
			"config",
			"list:openai-health-down-after-probeAll",
			openaiAfterConfig?.health.status === "down",
			`status=${openaiAfterConfig?.health.status}`,
		);

		const llamacppAfterConfig = afterConfig.find((e) => e.id === "llamacpp");
		check(
			"config",
			"list:llamacpp-health-down-after-probeAll",
			llamacppAfterConfig?.health.status === "down" &&
				llamacppAfterConfig?.health.lastError === "no llamacpp endpoints configured",
			`status=${llamacppAfterConfig?.health.status} error=${llamacppAfterConfig?.health.lastError ?? "null"}`,
		);

		// Slice 2: discovered-model registration. The engine's local side-registry
		// must gain an entry per id listed in a healthy EndpointProbeResult.models,
		// keyed by `${modelId}@${endpoint}`. No network: we call the registrar
		// directly with a stub spec and a stub model list.
		const engineAi = await import("../src/engine/ai.js");
		type EndpointSpecType = import("../src/core/defaults.js").EndpointSpec;
		type PiModel = ReturnType<typeof engineAi.getModel>;
		const s2Endpoint = "s2-mock";
		const s2Spec: EndpointSpecType = { url: "http://127.0.0.1:9999" };
		const s2ModelIds = [
			"Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
			"meta-llama-3.1-8b-instruct",
			"gpt-oss-20b",
			"qwen3.6-35b-a3b",
			"myqwen3-thing",
			"qwenm-xyz",
		] as const;
		engineAi.registerDiscoveredLocalModels("llamacpp", s2Endpoint, s2Spec, s2ModelIds);
		let s2Registered = 0;
		for (const id of s2ModelIds) {
			const model = engineAi.getLocalRegisteredModel("llamacpp", `${id}@${s2Endpoint}`);
			if (model) s2Registered += 1;
		}
		check(
			"config",
			"s2:discovered-models-registered",
			s2Registered === s2ModelIds.length,
			`registered=${s2Registered}/${s2ModelIds.length}`,
		);

		const s2VlKey = `${s2ModelIds[0]}@${s2Endpoint}`;
		const s2VlModel = engineAi.getModel("llamacpp", s2VlKey) as PiModel & { baseUrl?: string };
		check(
			"config",
			"s2:getModel-baseUrl-ends-in-/v1",
			typeof s2VlModel.baseUrl === "string" && s2VlModel.baseUrl.endsWith("/v1"),
			`baseUrl=${s2VlModel.baseUrl}`,
		);

		const s2VlRich = s2VlModel as unknown as {
			reasoning?: boolean;
			input?: readonly string[];
			contextWindow?: number;
			compat?: { thinkingFormat?: string };
		};
		check(
			"config",
			"s2:qwen3-vl-preset-applied",
			s2VlRich.reasoning === true &&
				Array.isArray(s2VlRich.input) &&
				s2VlRich.input.includes("image") &&
				s2VlRich.contextWindow === 262144 &&
				s2VlRich.compat?.thinkingFormat === "qwen-chat-template",
			`reasoning=${s2VlRich.reasoning} input=${JSON.stringify(s2VlRich.input)} ctx=${s2VlRich.contextWindow} tf=${s2VlRich.compat?.thinkingFormat ?? "null"}`,
		);

		const s2QwenText = engineAi.getModel("llamacpp", `${s2ModelIds[3]}@${s2Endpoint}`) as PiModel;
		const s2QwenTextRich = s2QwenText as unknown as {
			reasoning?: boolean;
			input?: readonly string[];
			contextWindow?: number;
			compat?: { thinkingFormat?: string };
		};
		check(
			"config",
			"s2:qwen3.6-text-preset-applied",
			s2QwenTextRich.reasoning === true &&
				Array.isArray(s2QwenTextRich.input) &&
				s2QwenTextRich.input.length === 1 &&
				s2QwenTextRich.input[0] === "text" &&
				s2QwenTextRich.contextWindow === 262144 &&
				s2QwenTextRich.compat?.thinkingFormat === "qwen-chat-template",
			`reasoning=${s2QwenTextRich.reasoning} input=${JSON.stringify(s2QwenTextRich.input)} ctx=${s2QwenTextRich.contextWindow} tf=${s2QwenTextRich.compat?.thinkingFormat ?? "null"}`,
		);

		const s2FalsePositiveIds = [s2ModelIds[4], s2ModelIds[5]] as const;
		for (const id of s2FalsePositiveIds) {
			const model = engineAi.getModel("llamacpp", `${id}@${s2Endpoint}`) as PiModel;
			const richModel = model as unknown as {
				reasoning?: boolean;
				compat?: { thinkingFormat?: string };
			};
			check(
				"config",
				`s2:${id}-keeps-safe-baseline`,
				richModel.reasoning === false && richModel.compat?.thinkingFormat === undefined,
				`reasoning=${richModel.reasoning} tf=${richModel.compat?.thinkingFormat ?? "null"}`,
			);
		}

		// Wildcard `@${endpoint}` key set at boot by registerLocalProviders must
		// survive the per-model additions above. Re-running the boot registrar
		// and then the discovered-model registrar reproduces the production
		// order (settings load -> live probe).
		engineAi.registerLocalProviders({
			llamacpp: {
				endpoints: {
					[s2Endpoint]: s2Spec,
				},
			},
		});
		engineAi.registerDiscoveredLocalModels("llamacpp", s2Endpoint, s2Spec, s2ModelIds);
		const s2Wildcard = engineAi.getLocalRegisteredModel("llamacpp", `@${s2Endpoint}`);
		check(
			"config",
			"s2:wildcard-key-preserved",
			s2Wildcard !== undefined,
			`wildcard=${s2Wildcard ? "present" : "missing"}`,
		);

		// Hermetic extension-path regression for endpoint discovery replacement:
		// drive providers.probeEndpoints() with a stub adapter so no HTTP runs,
		// then assert each healthy probe batch replaces the prior endpoint models
		// while keeping the wildcard fallback key intact.
		const { readSettings, writeSettings } = await import("../src/core/config.js");
		const s2ReplaceEndpoint = "s2-replace";
		const nextSettings = readSettings();
		nextSettings.providers.llamacpp.endpoints = {
			[s2ReplaceEndpoint]: {
				url: s2Spec.url,
				default_model: "bootstrap-default",
			},
		};
		writeSettings(nextSettings);
		const s2Reloaded = await waitFor(() => {
			const entry = providers.list().find((provider) => provider.id === "llamacpp");
			return entry?.endpoints?.some((endpoint) => endpoint.name === s2ReplaceEndpoint) ?? false;
		}, 2000);
		check("config", "s2:replacement-settings-reloaded", s2Reloaded.ok, `elapsedMs=${s2Reloaded.elapsedMs}`);

		engineAi.registerLocalProviders(readSettings().providers ?? {});
		const s2StubbedAdapter = providers.getAdapter("llamacpp" as ProviderIdType);
		const originalProbeEndpoints = s2StubbedAdapter?.probeEndpoints;
		let s2StubModels: readonly string[] = ["stale-model", "stale-extra"];
		if (s2StubbedAdapter?.probeEndpoints) {
			s2StubbedAdapter.probeEndpoints = async (endpoints) => [
				{
					name: s2ReplaceEndpoint,
					url: endpoints[s2ReplaceEndpoint]?.url ?? s2Spec.url,
					ok: true,
					models: [...s2StubModels],
				},
			];
		}
		await providers.probeEndpoints();
		const s2SeededStale = engineAi.getLocalRegisteredModel("llamacpp", `stale-model@${s2ReplaceEndpoint}`);
		check("config", "s2:replacement-seed-registered", s2SeededStale !== undefined);

		s2StubModels = ["fresh-model"];
		await providers.probeEndpoints();
		const s2StaleAfterReplace = engineAi.getLocalRegisteredModel("llamacpp", `stale-model@${s2ReplaceEndpoint}`);
		const s2FreshAfterReplace = engineAi.getLocalRegisteredModel("llamacpp", `fresh-model@${s2ReplaceEndpoint}`);
		const s2WildcardAfterReplace = engineAi.getLocalRegisteredModel("llamacpp", `@${s2ReplaceEndpoint}`);
		check(
			"config",
			"s2:replacement-clears-stale-models",
			s2StaleAfterReplace === undefined && s2FreshAfterReplace !== undefined && s2WildcardAfterReplace !== undefined,
			`stale=${s2StaleAfterReplace ? "present" : "missing"} fresh=${s2FreshAfterReplace ? "present" : "missing"} wildcard=${s2WildcardAfterReplace ? "present" : "missing"}`,
		);

		s2StubModels = [];
		await providers.probeEndpoints();
		const s2FreshAfterEmpty = engineAi.getLocalRegisteredModel("llamacpp", `fresh-model@${s2ReplaceEndpoint}`);
		const s2WildcardAfterEmpty = engineAi.getLocalRegisteredModel("llamacpp", `@${s2ReplaceEndpoint}`);
		check(
			"config",
			"s2:healthy-empty-probe-clears-old-models",
			s2FreshAfterEmpty === undefined && s2WildcardAfterEmpty !== undefined,
			`fresh=${s2FreshAfterEmpty ? "present" : "missing"} wildcard=${s2WildcardAfterEmpty ? "present" : "missing"}`,
		);

		if (s2StubbedAdapter && originalProbeEndpoints) {
			s2StubbedAdapter.probeEndpoints = originalProbeEndpoints;
		}

		if (!RUN_LIVE) {
			skip("live", "probeAllLive:skipped", "set CLIO_DIAG_LIVE=1 to exercise providers.probeAllLive()");
			await result.stop();
			return;
		}

		const liveEventStart = healthEvents;
		await providers.probeAllLive();
		check(
			"live",
			"probeAllLive:bus-fired-for-all",
			healthEvents - liveEventStart === 11,
			`delta=${healthEvents - liveEventStart}`,
		);

		const afterLive = providers.list();
		const anthropicAfterLive = afterLive.find((e) => e.id === "anthropic");
		check(
			"live",
			"list:anthropic-health-down-after-probeAllLive",
			anthropicAfterLive?.health.status === "down" &&
				anthropicAfterLive?.health.lastError === "live probe not implemented for anthropic; config-only",
			`status=${anthropicAfterLive?.health.status} error=${anthropicAfterLive?.health.lastError ?? "null"}`,
		);

		const llamacppAfterLive = afterLive.find((e) => e.id === "llamacpp");
		check(
			"live",
			"list:llamacpp-health-down-after-probeAllLive",
			llamacppAfterLive?.health.status === "down" &&
				llamacppAfterLive?.health.lastError === "no llamacpp endpoints configured",
			`status=${llamacppAfterLive?.health.status} error=${llamacppAfterLive?.health.lastError ?? "null"}`,
		);

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
