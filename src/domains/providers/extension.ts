import { BusChannels } from "../../core/bus-events.js";
import { type ClioSettings, readSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { ensurePiAiRegistered } from "../../engine/ai.js";
import { registerClioApiProviders } from "../../engine/apis/index.js";
import type { ConfigContract } from "../config/contract.js";

import { authNotRequiredStatus, openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "./auth/index.js";
import { mergeCapabilities } from "./capabilities.js";
import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "./catalog.js";
import type { EndpointHealth, EndpointStatus, ProvidersContract } from "./contract.js";
import { credentialsPresent } from "./credentials.js";
import { resolveProvidersModelsDir } from "./knowledge-base-path.js";
import { loadPluginRuntimes } from "./plugins.js";
import { getRuntimeRegistry } from "./registry.js";
import { registerBuiltinRuntimes } from "./runtimes/builtins.js";
import type { CapabilityFlags } from "./types/capability-flags.js";
import { EMPTY_CAPABILITIES } from "./types/capability-flags.js";
import type { EndpointDescriptor } from "./types/endpoint-descriptor.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseEntry,
	type KnowledgeBaseHit,
} from "./types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "./types/runtime-descriptor.js";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

class NullKnowledgeBase implements KnowledgeBase {
	lookup(_modelId: string): KnowledgeBaseHit | null {
		return null;
	}
	entries(): ReadonlyArray<KnowledgeBaseEntry> {
		return [];
	}
}

function loadKnowledgeBase(): KnowledgeBase {
	try {
		const dir = resolveProvidersModelsDir(import.meta.url);
		if (!dir) return new NullKnowledgeBase();
		return new FileKnowledgeBase(dir);
	} catch (err) {
		process.stderr.write(`[providers] knowledge base disabled: ${err instanceof Error ? err.message : String(err)}\n`);
		return new NullKnowledgeBase();
	}
}

function emptyHealth(): EndpointHealth {
	return { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null };
}

function availabilityFor(
	desc: RuntimeDescriptor,
	endpoint: EndpointDescriptor,
	authStatusFor: (endpoint: EndpointDescriptor, runtime: RuntimeDescriptor) => { available: boolean; reason: string },
): { available: boolean; reason: string } {
	if (desc.kind === "subprocess" || desc.kind === "sdk") {
		return { available: true, reason: desc.auth };
	}
	if (desc.auth === "api-key" || desc.auth === "oauth") {
		return authStatusFor(endpoint, desc);
	}
	return { available: true, reason: desc.auth };
}

function capabilitiesFor(
	desc: RuntimeDescriptor,
	endpoint: EndpointDescriptor,
	probe: ProbeResult | null,
	kb: KnowledgeBase,
): CapabilityFlags {
	const kbHit = endpoint.defaultModel ? kb.lookup(endpoint.defaultModel) : null;
	const base = capabilitiesFromCatalogModel(
		desc.defaultCapabilities,
		endpoint.defaultModel ? getCatalogModelForRuntime(desc.id, endpoint.defaultModel) : undefined,
	);
	return mergeCapabilities(
		base,
		kbHit?.entry.capabilities ?? null,
		probe?.discoveredCapabilities ?? null,
		endpoint.capabilities ?? null,
	);
}

function uniqueModels(ids: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		const trimmed = id.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

export function createProvidersBundle(context: DomainContext): DomainBundle<ProvidersContract> {
	const registry = getRuntimeRegistry();
	const authStore = openAuthStorage();
	const kb = loadKnowledgeBase();
	const statuses = new Map<string, EndpointStatus>();
	const reasoningCache = new Map<string, boolean>();
	const unsubscribeConfigListeners: Array<() => void> = [];

	function reasoningCacheKey(endpointId: string, modelId: string): string {
		return `${endpointId}:${modelId}`;
	}

	function readConfig(): ClioSettings {
		const config = context.getContract<ConfigContract>("config");
		if (config) return config.get();
		return readSettings();
	}

	function authStatusFor(
		endpoint: EndpointDescriptor,
		runtime: RuntimeDescriptor,
	): { available: boolean; reason: string } {
		const target = resolveAuthTarget(endpoint, runtime);
		if (!targetRequiresAuth(endpoint, runtime)) {
			return { available: true, reason: "auth:not-required" };
		}
		const status = authStore.statusForTarget(target, { includeFallback: false });
		if (status.available) {
			switch (status.source) {
				case "runtime-override":
					return { available: true, reason: `override:${target.providerId}` };
				case "stored-api-key":
					return { available: true, reason: `store:api_key:${target.providerId}` };
				case "stored-oauth":
					return { available: true, reason: `store:oauth:${target.providerId}` };
				case "environment":
					return { available: true, reason: status.detail ? `env:${status.detail}` : `env:${target.providerId}` };
				case "fallback":
					return { available: true, reason: `fallback:${target.providerId}` };
				default:
					return { available: true, reason: target.providerId };
			}
		}
		const envHint = target.explicitEnvVar ? `${target.explicitEnvVar} or ` : "";
		return { available: false, reason: `missing auth (${envHint}store:${target.providerId})` };
	}

	function buildStatus(
		endpoint: EndpointDescriptor,
		desc: RuntimeDescriptor | null,
		probe: ProbeResult | null,
		previous?: EndpointStatus,
	): EndpointStatus {
		if (!desc) {
			const out: EndpointStatus = {
				endpoint,
				runtime: null,
				available: false,
				reason: "unknown runtime",
				health: previous?.health ?? emptyHealth(),
				capabilities: previous?.capabilities ?? EMPTY_CAPABILITIES,
				probeCapabilities: previous?.probeCapabilities ?? null,
				discoveredModels: previous?.discoveredModels ?? [],
			};
			if (previous?.probeNotes && previous.probeNotes.length > 0) out.probeNotes = previous.probeNotes;
			return out;
		}
		const availability = availabilityFor(desc, endpoint, authStatusFor);
		const capabilities = capabilitiesFor(desc, endpoint, probe, kb);
		const probeCapabilities = probe?.discoveredCapabilities ?? previous?.probeCapabilities ?? null;
		const probeNotes = probe?.notes && probe.notes.length > 0 ? probe.notes : previous?.probeNotes;
		const discoveredModels = uniqueModels(probe?.models ?? previous?.discoveredModels ?? desc.knownModels ?? []);
		const healthy = probe !== null ? probe.ok : null;
		const health: EndpointHealth =
			probe === null
				? (previous?.health ?? emptyHealth())
				: {
						status: healthy ? "healthy" : "down",
						lastCheckAt: new Date().toISOString(),
						lastError: probe.error ?? null,
						latencyMs: probe.latencyMs ?? null,
					};
		const available = availability.available && (probe === null || probe.ok);
		const reason = probe !== null && !probe.ok ? (probe.error ?? "probe failed") : availability.reason;
		const out: EndpointStatus = {
			endpoint,
			runtime: desc,
			available,
			reason,
			health,
			capabilities,
			probeCapabilities,
			discoveredModels,
		};
		if (probeNotes && probeNotes.length > 0) out.probeNotes = probeNotes;
		return out;
	}

	async function probeEndpointInternal(endpoint: EndpointDescriptor, live: boolean): Promise<EndpointStatus> {
		const previous = statuses.get(endpoint.id);
		const desc = registry.get(endpoint.runtime);
		if (!desc) {
			const status = buildStatus(endpoint, null, null, previous);
			statuses.set(endpoint.id, status);
			context.bus.emit(BusChannels.ProviderHealth, { id: endpoint.id, status });
			return status;
		}
		if (!live || typeof desc.probe !== "function") {
			const status = buildStatus(endpoint, desc, null, previous);
			statuses.set(endpoint.id, status);
			return status;
		}
		const probeCtx: ProbeContext = {
			credentialsPresent: credentialsPresent(),
			httpTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
		};
		let probeResult: ProbeResult;
		try {
			probeResult = await desc.probe(endpoint, probeCtx);
		} catch (err) {
			probeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		if (probeResult.ok && typeof desc.probeModels === "function" && !probeResult.models) {
			try {
				const ids = await desc.probeModels(endpoint, probeCtx);
				probeResult = { ...probeResult, models: ids };
			} catch {
				// model discovery is best-effort; keep probe as-is.
			}
		}
		if (probeResult.ok && typeof desc.probeReasoning === "function") {
			const settings = readConfig();
			const orchestratorTarget = settings.orchestrator.endpoint === endpoint.id ? settings.orchestrator.model : null;
			const candidateModelId = orchestratorTarget ?? endpoint.defaultModel ?? null;
			if (candidateModelId) {
				try {
					const result = await desc.probeReasoning(endpoint, candidateModelId, probeCtx);
					reasoningCache.set(reasoningCacheKey(endpoint.id, candidateModelId), result.reasoning);
					if (result.reasoning) {
						probeResult = {
							...probeResult,
							discoveredCapabilities: { ...(probeResult.discoveredCapabilities ?? {}), reasoning: true },
						};
					}
				} catch {
					// reasoning detection is best-effort; missing/timeout leaves the cache cold.
				}
			}
		}
		const status = buildStatus(endpoint, desc, probeResult, previous);
		statuses.set(endpoint.id, status);
		context.bus.emit(BusChannels.ProviderHealth, { id: endpoint.id, status });
		return status;
	}

	async function probeReasoningForModelInternal(endpointId: string, modelId: string): Promise<boolean | null> {
		const settings = readConfig();
		const endpoint = settings.endpoints.find((ep) => ep.id === endpointId);
		if (!endpoint) return null;
		const desc = registry.get(endpoint.runtime);
		if (!desc || typeof desc.probeReasoning !== "function") return null;
		const probeCtx: ProbeContext = {
			credentialsPresent: credentialsPresent(),
			httpTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
		};
		try {
			const result = await desc.probeReasoning(endpoint, modelId, probeCtx);
			reasoningCache.set(reasoningCacheKey(endpointId, modelId), result.reasoning);
			return result.reasoning;
		} catch {
			return null;
		}
	}

	async function probeAll(): Promise<void> {
		const settings = readConfig();
		const next = new Map<string, EndpointStatus>();
		reasoningCache.clear();
		for (const endpoint of settings.endpoints) {
			const desc = registry.get(endpoint.runtime);
			const status = buildStatus(endpoint, desc, null, statuses.get(endpoint.id));
			next.set(endpoint.id, status);
		}
		statuses.clear();
		for (const [id, status] of next) {
			statuses.set(id, status);
		}
	}

	async function probeAllLive(): Promise<void> {
		const settings = readConfig();
		await Promise.all(settings.endpoints.map((ep) => probeEndpointInternal(ep, true)));
	}

	const extension: DomainExtension = {
		async start() {
			ensurePiAiRegistered();
			registerClioApiProviders();
			registerBuiltinRuntimes(registry);
			const settings = readConfig();
			await loadPluginRuntimes(registry, settings);
			await probeAll();
			const config = context.getContract<ConfigContract>("config");
			if (config) {
				for (const kind of ["hotReload", "nextTurn", "restartRequired"] as const) {
					unsubscribeConfigListeners.push(
						config.onChange(kind, () => {
							void probeAll();
						}),
					);
				}
			}
		},
		async stop() {
			for (const unsubscribe of unsubscribeConfigListeners.splice(0)) unsubscribe();
		},
	};

	const contract: ProvidersContract = {
		list() {
			return Array.from(statuses.values());
		},
		getEndpoint(id) {
			const settings = readConfig();
			return settings.endpoints.find((ep) => ep.id === id) ?? null;
		},
		getRuntime(id) {
			return registry.get(id);
		},
		probeAll,
		probeAllLive,
		async probeEndpoint(id) {
			const settings = readConfig();
			const endpoint = settings.endpoints.find((ep) => ep.id === id);
			if (!endpoint) return null;
			return probeEndpointInternal(endpoint, true);
		},
		disconnectEndpoint(id) {
			const settings = readConfig();
			const endpoint = settings.endpoints.find((ep) => ep.id === id);
			if (!endpoint) return null;
			for (const key of Array.from(reasoningCache.keys())) {
				if (key.startsWith(`${id}:`)) reasoningCache.delete(key);
			}
			const status = buildStatus(endpoint, registry.get(endpoint.runtime), null);
			statuses.set(endpoint.id, status);
			context.bus.emit(BusChannels.ProviderHealth, { id: endpoint.id, status });
			return status;
		},
		getDetectedReasoning(endpointId, modelId) {
			const cached = reasoningCache.get(reasoningCacheKey(endpointId, modelId));
			return cached ?? null;
		},
		probeReasoningForModel(endpointId, modelId) {
			return probeReasoningForModelInternal(endpointId, modelId);
		},
		credentials: {
			hasKey(providerId) {
				const stored = authStore.get(providerId);
				return stored?.type === "api_key";
			},
			get(providerId) {
				const stored = authStore.get(providerId);
				return stored?.type === "api_key" ? stored.key : null;
			},
			set(providerId, key) {
				authStore.setApiKey(providerId, key);
			},
			remove(providerId) {
				authStore.remove(providerId);
			},
		},
		auth: {
			statusForTarget(endpoint, runtime) {
				if (!targetRequiresAuth(endpoint, runtime)) {
					return authNotRequiredStatus(resolveAuthTarget(endpoint, runtime).providerId);
				}
				return authStore.statusForTarget(resolveAuthTarget(endpoint, runtime), { includeFallback: false });
			},
			resolveForTarget(endpoint, runtime) {
				if (!targetRequiresAuth(endpoint, runtime)) {
					return Promise.resolve(authNotRequiredStatus(resolveAuthTarget(endpoint, runtime).providerId));
				}
				return authStore.resolveForTarget(resolveAuthTarget(endpoint, runtime), { includeFallback: false });
			},
			getStored(providerId) {
				return authStore.get(providerId) ?? null;
			},
			listStored() {
				return authStore.listStored();
			},
			setApiKey(providerId, key) {
				authStore.setApiKey(providerId, key);
			},
			remove(providerId) {
				authStore.remove(providerId);
			},
			login(providerId, callbacks) {
				return authStore.login(providerId, callbacks);
			},
			logout(providerId) {
				authStore.logout(providerId);
			},
			getOAuthProviders() {
				return authStore.getOAuthProviders();
			},
			setRuntimeOverrideForTarget(endpoint, _runtime, key) {
				authStore.setRuntimeOverride(endpoint.id, key);
			},
			clearRuntimeOverrideForTarget(endpoint, _runtime) {
				authStore.clearRuntimeOverride(endpoint.id);
			},
		},
		knowledgeBase: kb,
	};

	return { extension, contract };
}
