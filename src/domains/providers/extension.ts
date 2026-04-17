import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { registerDiscoveredLocalModels, registerLocalProviders } from "../../engine/ai.js";
import type { ConfigContract } from "../config/contract.js";
import { PROVIDER_CATALOG, type ProviderId, isLocalEngineId } from "./catalog.js";
import type { ProviderEndpointEntry, ProviderListEntry, ProvidersContract } from "./contract.js";
import { type CredentialStore, credentialsPresent, openCredentialStore } from "./credentials.js";
import { discoverProviders } from "./discovery.js";
import { type ProviderHealth, applyProbeResult, initialHealth } from "./health.js";
import type { EndpointProbeResult, RuntimeAdapter } from "./runtime-contract.js";
import { RUNTIME_ADAPTERS } from "./runtimes/index.js";

export function createProvidersBundle(context: DomainContext): DomainBundle<ProvidersContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) {
		throw new Error("providers domain requires 'config' contract");
	}
	const config: ConfigContract = maybeConfig;

	let credStore: CredentialStore | null = null;
	const healthState = new Map<ProviderId, ProviderHealth>();
	const endpointProbes = new Map<ProviderId, EndpointProbeResult[]>();

	// ProviderHealth + probeAll operate only on catalog-backed adapters. CLI
	// adapters and the Claude SDK adapter (tier=sdk but not in the catalog)
	// live in RUNTIME_ADAPTERS for discovery but do not participate in the
	// provider health bus; their readiness is reported via diag-cli-runtimes
	// and diag-claude-sdk respectively.
	const catalogIds = new Set<string>(PROVIDER_CATALOG.map((p) => p.id));
	const providerAdapters: ReadonlyArray<RuntimeAdapter> = RUNTIME_ADAPTERS.filter((a) => catalogIds.has(String(a.id)));

	function adapterById(id: ProviderId): RuntimeAdapter | null {
		return RUNTIME_ADAPTERS.find((a) => a.id === id) ?? null;
	}

	function computeList(): ReadonlyArray<ProviderListEntry> {
		const settings = config.get();
		const present = credentialsPresent();
		const avail = discoverProviders({ settings, credentialsPresent: present });
		const byId = new Map(avail.map((a) => [a.id, a]));
		const localProviders = settings.providers ?? {};
		return PROVIDER_CATALOG.map((spec) => {
			const a = byId.get(spec.id);
			const h = healthState.get(spec.id) ?? initialHealth(spec.id);
			const entry: ProviderListEntry = {
				id: spec.id,
				displayName: spec.displayName,
				tier: spec.tier,
				available: a?.available ?? false,
				reason: a?.reason ?? "unknown",
				health: h,
			};
			if (isLocalEngineId(String(spec.id))) {
				const engineKey = spec.id as "llamacpp" | "lmstudio" | "ollama" | "openai-compat";
				const endpoints = localProviders[engineKey]?.endpoints ?? {};
				const probeResults = endpointProbes.get(spec.id) ?? [];
				const probeByName = new Map(probeResults.map((p) => [p.name, p]));
				entry.endpoints = Object.entries(endpoints).map(([name, epSpec]): ProviderEndpointEntry => {
					const e: ProviderEndpointEntry = {
						name,
						url: epSpec.url,
					};
					if (epSpec.default_model) e.defaultModel = epSpec.default_model;
					const probe = probeByName.get(name);
					if (probe) e.probe = probe;
					return e;
				});
			}
			return entry;
		});
	}

	function probeFromVerdict(verdict: { ok: boolean; reason: string }): {
		ok: boolean;
		error?: string;
		latencyMs?: number;
	} {
		return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
	}

	async function runProbeSweep(mode: "config" | "live"): Promise<void> {
		const present = credentialsPresent();
		const settings = config.get();
		const localProviders = settings.providers ?? {};
		for (const adapter of providerAdapters) {
			const endpoints = isLocalEngineId(String(adapter.id))
				? localProviders[adapter.id as "llamacpp" | "lmstudio" | "ollama" | "openai-compat"]?.endpoints
				: undefined;
			const localConfigInput =
				endpoints === undefined
					? { modelId: "", credentialsPresent: present }
					: { modelId: "", credentialsPresent: present, endpoints };
			const result =
				mode === "config"
					? isLocalEngineId(String(adapter.id))
						? probeFromVerdict(adapter.canSatisfy(localConfigInput))
						: await adapter.probe({ credentialsPresent: present, endpoints })
					: await (adapter.probeLive ?? adapter.probe).call(adapter, { credentialsPresent: present, endpoints });
			const prev = healthState.get(adapter.id) ?? initialHealth(adapter.id);
			const probe: { ok: boolean; latencyMs?: number; error?: string } = { ok: result.ok };
			if (result.latencyMs !== undefined) probe.latencyMs = result.latencyMs;
			if (result.error !== undefined) probe.error = result.error;
			const next = applyProbeResult(prev, probe);
			healthState.set(adapter.id, next);
			context.bus.emit(BusChannels.ProviderHealth, { providerId: adapter.id, health: next });
		}
	}

	async function runEndpointProbeSweep(): Promise<void> {
		const settings = config.get();
		const localProviders = settings.providers ?? {};
		for (const adapter of providerAdapters) {
			if (!adapter.probeEndpoints) continue;
			const engineKey = adapter.id as "llamacpp" | "lmstudio" | "ollama" | "openai-compat";
			const endpoints = localProviders[engineKey]?.endpoints ?? {};
			if (Object.keys(endpoints).length === 0) {
				endpointProbes.set(adapter.id, []);
				continue;
			}
			const results = await adapter.probeEndpoints(endpoints);
			endpointProbes.set(adapter.id, results);
			for (const probe of results) {
				if (!probe.ok) continue;
				const spec = endpoints[probe.name];
				if (!spec) continue;
				const modelIds = probe.models ?? [];
				registerDiscoveredLocalModels(adapter.id, probe.name, spec, modelIds);
			}
		}
	}

	const extension: DomainExtension = {
		async start() {
			credStore = openCredentialStore();
			for (const adapter of providerAdapters) {
				healthState.set(adapter.id, adapter.initialHealth());
			}
			// Compute initial availability so discovery side-effects (if any future
			// ones arise) are exercised at boot. Discovery itself is pure today.
			const settings = config.get();
			const present = credentialsPresent();
			discoverProviders({ settings, credentialsPresent: present });
			// Register local-engine endpoints with the pi-ai side-registry so
			// workers can resolve `getModel(providerId, "${modelId}@${endpointName}")`.
			registerLocalProviders(settings.providers ?? {});
		},
		async stop() {
			// no-op; credential store has no close handle
		},
	};

	const contract: ProvidersContract = {
		list() {
			return computeList();
		},
		getAdapter(id: ProviderId): RuntimeAdapter | null {
			return adapterById(id);
		},
		async probeAll(): Promise<void> {
			await runProbeSweep("config");
		},
		async probeEndpoints(): Promise<void> {
			await runEndpointProbeSweep();
		},
		async probeAllLive(): Promise<void> {
			await runProbeSweep("live");
		},
		async probeEndpointsLive(): Promise<void> {
			await runEndpointProbeSweep();
		},
		credentials: {
			hasKey(providerId: ProviderId): boolean {
				if (!credStore) return false;
				return credStore.get(providerId) !== null;
			},
			set(providerId: ProviderId, key: string): void {
				if (!credStore) throw new Error("providers domain not started");
				credStore.set(providerId, key);
			},
			remove(providerId: ProviderId): void {
				if (!credStore) return;
				credStore.remove(providerId);
			},
		},
	};

	return { extension, contract };
}
