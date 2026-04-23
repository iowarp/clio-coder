import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BusChannels } from "../../core/bus-events.js";
import { type ClioSettings, readSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { ensurePiAiRegistered } from "../../engine/ai.js";
import { registerClioApiProviders } from "../../engine/apis/index.js";
import type { ConfigContract } from "../config/contract.js";

import { openAuthStorage, resolveAuthTarget } from "./auth/index.js";
import { mergeCapabilities } from "./capabilities.js";
import type { EndpointHealth, EndpointStatus, ProvidersContract } from "./contract.js";
import { credentialsPresent } from "./credentials.js";
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
		const dir = fileURLToPath(new URL("./models/", import.meta.url));
		if (!existsSync(dir)) return new NullKnowledgeBase();
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
	if (desc.kind === "subprocess") {
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
	return mergeCapabilities(
		desc.defaultCapabilities,
		kbHit?.entry.capabilities ?? null,
		probe?.discoveredCapabilities ?? null,
		endpoint.capabilities ?? null,
	);
}

export function createProvidersBundle(context: DomainContext): DomainBundle<ProvidersContract> {
	const registry = getRuntimeRegistry();
	const authStore = openAuthStorage();
	const kb = loadKnowledgeBase();
	const statuses = new Map<string, EndpointStatus>();

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
			return {
				endpoint,
				runtime: null,
				available: false,
				reason: "unknown runtime",
				health: previous?.health ?? emptyHealth(),
				capabilities: previous?.capabilities ?? EMPTY_CAPABILITIES,
				discoveredModels: previous?.discoveredModels ?? [],
			};
		}
		const availability = availabilityFor(desc, endpoint, authStatusFor);
		const capabilities = capabilitiesFor(desc, endpoint, probe, kb);
		const discoveredModels = probe?.models ?? previous?.discoveredModels ?? [];
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
		return {
			endpoint,
			runtime: desc,
			available,
			reason,
			health,
			capabilities,
			discoveredModels,
		};
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
		const status = buildStatus(endpoint, desc, probeResult, previous);
		statuses.set(endpoint.id, status);
		context.bus.emit(BusChannels.ProviderHealth, { id: endpoint.id, status });
		return status;
	}

	async function probeAll(): Promise<void> {
		const settings = readConfig();
		const next = new Map<string, EndpointStatus>();
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
				return authStore.statusForTarget(resolveAuthTarget(endpoint, runtime), { includeFallback: false });
			},
			resolveForTarget(endpoint, runtime) {
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
		},
		knowledgeBase: kb,
	};

	return { extension, contract };
}
