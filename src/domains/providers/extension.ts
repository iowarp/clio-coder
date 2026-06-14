import { BusChannels } from "../../core/bus-events.js";
import { type ClioSettings, readSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { ensurePiAiRegistered } from "../../engine/ai.js";
import { registerClioApiProviders, setGlobalDefaultMaxOutputTokens } from "../../engine/apis/index.js";
import type { ConfigContract } from "../config/contract.js";

import { authNotRequiredStatus, openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "./auth/index.js";
import { mergeCapabilities } from "./capabilities.js";
import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "./catalog.js";
import type { ProvidersContract, TargetHealth, TargetStatus } from "./contract.js";
import { credentialsPresent } from "./credentials.js";
import { resolveProvidersModelsDir } from "./knowledge-base-path.js";
import { loadPluginRuntimes } from "./plugins.js";
import { getRuntimeRegistry } from "./registry.js";
import { registerBuiltinRuntimes } from "./runtimes/builtins.js";
import type { CapabilityFlags } from "./types/capability-flags.js";
import { EMPTY_CAPABILITIES } from "./types/capability-flags.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseEntry,
	type KnowledgeBaseHit,
} from "./types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

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

function emptyHealth(): TargetHealth {
	return { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null };
}

function availabilityFor(
	desc: RuntimeDescriptor,
	target: TargetDescriptor,
	authStatusFor: (target: TargetDescriptor, runtime: RuntimeDescriptor) => { available: boolean; reason: string },
): { available: boolean; reason: string } {
	if (desc.auth === "api-key" || desc.auth === "oauth") {
		return authStatusFor(target, desc);
	}
	return { available: true, reason: desc.auth };
}

function capabilitiesFor(
	desc: RuntimeDescriptor,
	target: TargetDescriptor,
	probe: ProbeResult | null,
	kb: KnowledgeBase,
): CapabilityFlags {
	const kbHit = target.defaultModel ? kb.lookup(target.defaultModel) : null;
	const base = capabilitiesFromCatalogModel(
		desc.defaultCapabilities,
		target.defaultModel ? getCatalogModelForRuntime(desc.id, target.defaultModel) : undefined,
	);
	const probeCaps =
		!probe?.capabilityModelId || !target.defaultModel || probe.capabilityModelId === target.defaultModel
			? (probe?.discoveredCapabilities ?? null)
			: null;
	return mergeCapabilities(base, kbHit?.entry.capabilities ?? null, probeCaps, target.capabilities ?? null);
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

function discoveredModelsSource(
	probe: ProbeResult | null,
	preservePreviousProbe: boolean,
	previous: TargetStatus | undefined,
	desc: RuntimeDescriptor,
): "probe" | "cache" | "runtime" | "none" {
	if (probe?.models !== undefined) return "probe";
	if (preservePreviousProbe && previous?.discoveredModels && previous.discoveredModels.length > 0) return "cache";
	if (desc.knownModels && desc.knownModels.length > 0) return "runtime";
	return "none";
}

function sameProbeIdentity(previous: TargetDescriptor, next: TargetDescriptor): boolean {
	return (
		previous.id === next.id &&
		previous.runtime === next.runtime &&
		(previous.url ?? "") === (next.url ?? "") &&
		(previous.defaultModel ?? "") === (next.defaultModel ?? "")
	);
}

export function createProvidersBundle(context: DomainContext): DomainBundle<ProvidersContract> {
	const registry = getRuntimeRegistry();
	const authStore = openAuthStorage();
	const kb = loadKnowledgeBase();
	const statuses = new Map<string, TargetStatus>();
	const reasoningCache = new Map<string, boolean>();
	const unsubscribeConfigListeners: Array<() => void> = [];

	function reasoningCacheKey(targetId: string, modelId: string): string {
		return `${targetId}:${modelId}`;
	}

	function readConfig(): ClioSettings {
		const config = context.getContract<ConfigContract>("config");
		if (config) return config.get();
		return readSettings();
	}

	function authStatusFor(target: TargetDescriptor, runtime: RuntimeDescriptor): { available: boolean; reason: string } {
		const authTarget = resolveAuthTarget(target, runtime);
		if (!targetRequiresAuth(target, runtime)) {
			return { available: true, reason: "auth:not-required" };
		}
		const status = authStore.statusForTarget(authTarget, { includeFallback: false });
		if (status.available) {
			switch (status.source) {
				case "runtime-override":
					return { available: true, reason: `override:${authTarget.providerId}` };
				case "stored-api-key":
					return { available: true, reason: `store:api_key:${authTarget.providerId}` };
				case "stored-oauth":
					return { available: true, reason: `store:oauth:${authTarget.providerId}` };
				case "environment":
					return { available: true, reason: status.detail ? `env:${status.detail}` : `env:${authTarget.providerId}` };
				case "fallback":
					return { available: true, reason: `fallback:${authTarget.providerId}` };
				default:
					return { available: true, reason: authTarget.providerId };
			}
		}
		const envHint = authTarget.explicitEnvVar ? `${authTarget.explicitEnvVar} or ` : "";
		return { available: false, reason: `missing auth (${envHint}store:${authTarget.providerId})` };
	}

	function buildStatus(
		target: TargetDescriptor,
		desc: RuntimeDescriptor | null,
		probe: ProbeResult | null,
		previous?: TargetStatus,
	): TargetStatus {
		if (!desc) {
			const out: TargetStatus = {
				target,
				runtime: null,
				available: false,
				reason: "unknown runtime",
				health: previous?.health ?? emptyHealth(),
				capabilities: previous?.capabilities ?? EMPTY_CAPABILITIES,
				probeCapabilities: previous?.probeCapabilities ?? null,
				probeModelCapabilities: previous?.probeModelCapabilities ?? null,
				probeModelId: previous?.probeModelId ?? null,
				discoveredModels: previous?.discoveredModels ?? [],
				discoveredModelsSource: previous?.discoveredModelsSource ?? "none",
				discoveredModelStates: previous?.discoveredModelStates ?? null,
			};
			if (previous?.probeNotes && previous.probeNotes.length > 0) out.probeNotes = previous.probeNotes;
			return out;
		}
		const availability = availabilityFor(desc, target, authStatusFor);
		const capabilities = capabilitiesFor(desc, target, probe, kb);
		const preservePreviousProbe = probe === null && previous !== undefined && sameProbeIdentity(previous.target, target);
		const probeCapabilities =
			probe?.discoveredCapabilities ?? (preservePreviousProbe ? previous.probeCapabilities : null) ?? null;
		const probeModelCapabilities =
			probe?.modelCapabilities ?? (preservePreviousProbe ? previous.probeModelCapabilities : null) ?? null;
		const probeModelId =
			probe?.discoveredCapabilities !== undefined
				? (probe.capabilityModelId ?? null)
				: ((preservePreviousProbe ? previous.probeModelId : null) ?? null);
		const probeNotes =
			probe?.notes && probe.notes.length > 0 ? probe.notes : preservePreviousProbe ? previous.probeNotes : undefined;
		const discoveredModels = uniqueModels(
			probe?.models ?? (preservePreviousProbe ? previous.discoveredModels : undefined) ?? desc.knownModels ?? [],
		);
		const modelStates = probe?.modelStates ?? (preservePreviousProbe ? previous.discoveredModelStates : null) ?? null;
		const modelSource = discoveredModelsSource(probe, preservePreviousProbe, previous, desc);
		const healthy = probe !== null ? probe.ok : null;
		const health: TargetHealth =
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
		const out: TargetStatus = {
			target,
			runtime: desc,
			available,
			reason,
			health,
			capabilities,
			probeCapabilities,
			probeModelCapabilities,
			probeModelId,
			discoveredModels,
			discoveredModelsSource: modelSource,
			discoveredModelStates: modelStates,
		};
		if (probeNotes && probeNotes.length > 0) out.probeNotes = probeNotes;
		return out;
	}

	async function probeTargetInternal(target: TargetDescriptor, live: boolean): Promise<TargetStatus> {
		const previous = statuses.get(target.id);
		const desc = registry.get(target.runtime);
		if (!desc) {
			const status = buildStatus(target, null, null, previous);
			statuses.set(target.id, status);
			context.bus.emit(BusChannels.ProviderHealth, { id: target.id, status });
			return status;
		}
		if (!live || typeof desc.probe !== "function") {
			const status = buildStatus(target, desc, null, previous);
			statuses.set(target.id, status);
			return status;
		}
		const probeCtx: ProbeContext = {
			credentialsPresent: credentialsPresent(),
			httpTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
		};
		let probeResult: ProbeResult;
		try {
			probeResult = await desc.probe(target, probeCtx);
		} catch (err) {
			probeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		if (probeResult.ok && typeof desc.probeModels === "function" && !probeResult.models) {
			try {
				const ids = await desc.probeModels(target, probeCtx);
				probeResult = { ...probeResult, models: ids };
			} catch {
				// model discovery is best-effort; keep probe as-is.
			}
		}
		if (probeResult.ok && typeof desc.probeReasoning === "function") {
			const settings = readConfig();
			const orchestratorTarget = settings.orchestrator.target === target.id ? settings.orchestrator.model : null;
			const candidateModelId = orchestratorTarget ?? target.defaultModel ?? null;
			if (candidateModelId) {
				try {
					const result = await desc.probeReasoning(target, candidateModelId, probeCtx);
					reasoningCache.set(reasoningCacheKey(target.id, candidateModelId), result.reasoning);
					const capabilityModelId = probeResult.capabilityModelId ?? null;
					if (capabilityModelId === null || capabilityModelId === candidateModelId) {
						probeResult = {
							...probeResult,
							discoveredCapabilities: { ...(probeResult.discoveredCapabilities ?? {}), reasoning: result.reasoning },
							modelCapabilities: {
								...(probeResult.modelCapabilities ?? {}),
								[candidateModelId]: {
									...(probeResult.modelCapabilities?.[candidateModelId] ?? {}),
									reasoning: result.reasoning,
								},
							},
							capabilityModelId: capabilityModelId ?? candidateModelId,
						};
					}
				} catch {
					// reasoning detection is best-effort; missing/timeout leaves the cache cold.
				}
			}
		}
		const status = buildStatus(target, desc, probeResult, previous);
		statuses.set(target.id, status);
		context.bus.emit(BusChannels.ProviderHealth, { id: target.id, status });
		return status;
	}

	async function probeReasoningForModelInternal(targetId: string, modelId: string): Promise<boolean | null> {
		const settings = readConfig();
		const target = settings.targets.find((ep) => ep.id === targetId);
		if (!target) return null;
		const desc = registry.get(target.runtime);
		if (!desc || typeof desc.probeReasoning !== "function") return null;
		const probeCtx: ProbeContext = {
			credentialsPresent: credentialsPresent(),
			httpTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
		};
		try {
			const result = await desc.probeReasoning(target, modelId, probeCtx);
			reasoningCache.set(reasoningCacheKey(targetId, modelId), result.reasoning);
			return result.reasoning;
		} catch {
			return null;
		}
	}

	async function probeAll(): Promise<void> {
		const settings = readConfig();
		const next = new Map<string, TargetStatus>();
		reasoningCache.clear();
		for (const target of settings.targets) {
			const desc = registry.get(target.runtime);
			const status = buildStatus(target, desc, null, statuses.get(target.id));
			next.set(target.id, status);
		}
		statuses.clear();
		for (const [id, status] of next) {
			statuses.set(id, status);
		}
	}

	async function probeAllLive(): Promise<void> {
		const settings = readConfig();
		const activeIds = new Set(settings.targets.map((ep) => ep.id));
		for (const id of Array.from(statuses.keys())) {
			if (!activeIds.has(id)) statuses.delete(id);
		}
		await Promise.all(settings.targets.map((ep) => probeTargetInternal(ep, true)));
	}

	const extension: DomainExtension = {
		async start() {
			ensurePiAiRegistered();
			registerClioApiProviders();
			registerBuiltinRuntimes(registry);
			const settings = readConfig();
			setGlobalDefaultMaxOutputTokens(settings.defaults.maxTokens);
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
		getTarget(id) {
			const settings = readConfig();
			return settings.targets.find((ep) => ep.id === id) ?? null;
		},
		getRuntime(id) {
			return registry.get(id);
		},
		probeAll,
		probeAllLive,
		async probeTarget(id) {
			const settings = readConfig();
			const target = settings.targets.find((ep) => ep.id === id);
			if (!target) return null;
			return probeTargetInternal(target, true);
		},
		disconnectTarget(id) {
			const settings = readConfig();
			const target = settings.targets.find((ep) => ep.id === id);
			if (!target) return null;
			for (const key of Array.from(reasoningCache.keys())) {
				if (key.startsWith(`${id}:`)) reasoningCache.delete(key);
			}
			const status = buildStatus(target, registry.get(target.runtime), null);
			statuses.set(target.id, status);
			context.bus.emit(BusChannels.ProviderHealth, { id: target.id, status });
			return status;
		},
		getDetectedReasoning(targetId, modelId) {
			const cached = reasoningCache.get(reasoningCacheKey(targetId, modelId));
			return cached ?? null;
		},
		probeReasoningForModel(targetId, modelId) {
			return probeReasoningForModelInternal(targetId, modelId);
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
			statusForTarget(target, runtime) {
				if (!targetRequiresAuth(target, runtime)) {
					return authNotRequiredStatus(resolveAuthTarget(target, runtime).providerId);
				}
				return authStore.statusForTarget(resolveAuthTarget(target, runtime), { includeFallback: false });
			},
			resolveForTarget(target, runtime) {
				if (!targetRequiresAuth(target, runtime)) {
					return Promise.resolve(authNotRequiredStatus(resolveAuthTarget(target, runtime).providerId));
				}
				return authStore.resolveForTarget(resolveAuthTarget(target, runtime), { includeFallback: false });
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
			setRuntimeOverrideForTarget(target, _runtime, key) {
				authStore.setRuntimeOverride(target.id, key);
			},
			clearRuntimeOverrideForTarget(target, _runtime) {
				authStore.clearRuntimeOverride(target.id);
			},
		},
		knowledgeBase: kb,
	};

	return { extension, contract };
}
