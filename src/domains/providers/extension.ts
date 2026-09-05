import { BusChannels } from "../../core/bus-events.js";
import { type ClioSettings, readSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { ensurePiAiRegistered } from "../../engine/ai.js";
import { registerClioApiProviders, setGlobalDefaultMaxOutputTokens } from "../../engine/apis/index.js";
import { registerClioOAuthProviders } from "../../engine/oauth.js";
import type { ConfigContract } from "../config/contract.js";

import { authNotRequiredStatus, openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "./auth/index.js";
import { mergeCapabilities } from "./capabilities.js";
import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "./catalog.js";
import type { ContextWindowProvenance, ProvidersContract, TargetHealth, TargetStatus } from "./contract.js";
import { credentialsPresent } from "./credentials.js";
import { recordEndpointSlotsFromStatus } from "./endpoint-capacity.js";
import { resolveProviderKnowledgeBaseRoots } from "./knowledge-base-path.js";
import { probeCapabilitiesForModel } from "./model-capabilities.js";
import { loadPluginRuntimes } from "./plugins.js";
import { getRuntimeRegistry } from "./registry.js";
import { registerBuiltinRuntimes } from "./runtimes/builtins.js";
import { listKnownModelsForRuntime } from "./support.js";
import { readTargetModelSnapshot, recordTargetModelSnapshot } from "./target-model-cache.js";
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
		const roots = resolveProviderKnowledgeBaseRoots(import.meta.url);
		if (roots.length === 0) return new NullKnowledgeBase();
		return new FileKnowledgeBase(roots);
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

export interface MergedCapabilities {
	capabilities: CapabilityFlags;
	contextWindowProvenance: ContextWindowProvenance;
}

function positiveWindow(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Merge the four capability layers for a target's own default model and record
 * which of them answered the context window.
 *
 * The probe layer is selected by `probeCapabilitiesForModel`, the one exact-id
 * selector every other consumer already uses. A router that serves several
 * models publishes a `/v1/models` row per model, and only the row keyed to this
 * target's wire model may answer for it; a sibling model's window is another
 * model's fact. Reading that row also means a router whose `/props` reports
 * `n_ctx: 0` still discovers the window it did publish, instead of silently
 * falling back to the runtime descriptor's placeholder.
 */
function capabilitiesFor(
	desc: RuntimeDescriptor,
	target: TargetDescriptor,
	probe: ProbeMerge,
	kb: KnowledgeBase,
): MergedCapabilities {
	const kbHit = target.defaultModel ? kb.lookup(target.defaultModel) : null;
	const catalogModel = target.defaultModel ? getCatalogModelForRuntime(desc.id, target.defaultModel) : undefined;
	const base = capabilitiesFromCatalogModel(desc.defaultCapabilities, catalogModel);
	const probeCaps = probeCapabilitiesForModel({ target, ...probe }, target.defaultModel);
	const userOverride = target.capabilities ?? null;
	const capabilities = mergeCapabilities(base, kbHit?.entry.capabilities ?? null, probeCaps, userOverride);
	return {
		capabilities,
		contextWindowProvenance: contextWindowProvenanceOf(kbHit, catalogModel, probeCaps, userOverride),
	};
}

function contextWindowProvenanceOf(
	kbHit: ReturnType<KnowledgeBase["lookup"]> | null,
	catalogModel: ReturnType<typeof getCatalogModelForRuntime>,
	probeCaps: Partial<CapabilityFlags> | null,
	userOverride: Partial<CapabilityFlags> | null,
): ContextWindowProvenance {
	if (positiveWindow(userOverride?.contextWindow) !== undefined) return "configured";
	if (positiveWindow(probeCaps?.contextWindow) !== undefined) return "discovered";
	if (positiveWindow(kbHit?.entry.capabilities?.contextWindow) !== undefined) return "catalog";
	if (positiveWindow(catalogModel?.contextWindow) !== undefined) return "catalog";
	return "runtime-default";
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
	cachedModels: ReadonlyArray<string>,
	desc: RuntimeDescriptor,
): "probe" | "cache" | "runtime" | "none" {
	if (probe?.models !== undefined) return "probe";
	if (preservePreviousProbe && previous?.discoveredModels && previous.discoveredModels.length > 0) return "cache";
	if (cachedModels.length > 0) return "cache";
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

export interface ProbeMerge {
	discoveredModels: string[];
	discoveredModelLabels: Readonly<Record<string, string>>;
	discoveredModelsSource: "probe" | "cache" | "runtime" | "none";
	discoveredModelStates: NonNullable<TargetStatus["discoveredModelStates"]> | null;
	probeCapabilities: NonNullable<TargetStatus["probeCapabilities"]> | null;
	probeModelCapabilities: NonNullable<TargetStatus["probeModelCapabilities"]> | null;
	probeModelId: NonNullable<TargetStatus["probeModelId"]> | null;
	probeNotes?: ReadonlyArray<string>;
	probeSurfaces?: NonNullable<TargetStatus["probeSurfaces"]>;
}

/**
 * Merge a fresh probe result with the previous known status. A probe that was
 * not attempted (`probe === null`) or that failed (`probe.ok === false`) must
 * not discard the last successful catalog and load states for an unchanged
 * target: a transient outage keeps the known models selectable, sourced from
 * `cache`, while health and availability (decided by the caller from `probe`)
 * reflect the failure. Only a successful probe replaces the catalog.
 */
function mergeProbeResult(
	desc: RuntimeDescriptor,
	target: TargetDescriptor,
	probe: ProbeResult | null,
	previous: TargetStatus | undefined,
	cachedModels: ReadonlyArray<string> = [],
	cachedModelLabels: Readonly<Record<string, string>> = {},
): ProbeMerge {
	const probeSucceeded = probe?.ok ?? false;
	const preservePrevious = !probeSucceeded && previous !== undefined && sameProbeIdentity(previous.target, target);
	const probeCapabilities =
		probe?.discoveredCapabilities ?? (preservePrevious ? previous.probeCapabilities : null) ?? null;
	const probeModelCapabilities =
		probe?.modelCapabilities ?? (preservePrevious ? previous.probeModelCapabilities : null) ?? null;
	const probeModelId =
		probe?.discoveredCapabilities !== undefined
			? (probe.capabilityModelId ?? null)
			: ((preservePrevious ? previous.probeModelId : null) ?? null);
	const probeNotes =
		probe?.notes && probe.notes.length > 0 ? probe.notes : preservePrevious ? previous.probeNotes : undefined;
	const probeSurfaces = probe?.surfaces ?? (preservePrevious ? previous.probeSurfaces : undefined);
	const discoveredModels = uniqueModels(
		probe?.models ??
			(preservePrevious ? previous.discoveredModels : undefined) ??
			(cachedModels.length > 0 ? cachedModels : undefined) ??
			desc.knownModels ??
			[],
	);
	const discoveredModelStates = probe?.modelStates ?? (preservePrevious ? previous.discoveredModelStates : null) ?? null;
	const discoveredModelLabels =
		probe?.modelLabels ??
		(preservePrevious ? previous.discoveredModelLabels : undefined) ??
		(cachedModels.length > 0 ? cachedModelLabels : undefined) ??
		{};
	const merge: ProbeMerge = {
		discoveredModels,
		discoveredModelLabels,
		discoveredModelsSource: discoveredModelsSource(probe, preservePrevious, previous, cachedModels, desc),
		discoveredModelStates,
		probeCapabilities,
		probeModelCapabilities,
		probeModelId,
	};
	if (probeNotes && probeNotes.length > 0) merge.probeNotes = probeNotes;
	if (probeSurfaces && Object.keys(probeSurfaces).length > 0) merge.probeSurfaces = probeSurfaces;
	return merge;
}

/**
 * Whether a reachable target can serve the model it is configured to serve by
 * default. Reachability alone was the whole of `health`, so a target whose
 * `defaultModel` the server had never heard of printed `healthy` until the
 * first turn. This is judged only from a live list on a runtime with no static
 * catalog: the catalog is the authority for cloud runtimes, and a cached or
 * descriptor-supplied list says nothing about the server in front of us.
 * Returns the reason when the default is not served, null when it is or when
 * there is no live evidence either way.
 */
function unservedDefaultModelReason(
	desc: Pick<RuntimeDescriptor, "id" | "externalAgentLoop">,
	target: Pick<TargetDescriptor, "defaultModel">,
	merge: Pick<ProbeMerge, "discoveredModels" | "discoveredModelsSource" | "discoveredModelStates">,
): string | null {
	const model = target.defaultModel;
	if (!model) return null;
	if (merge.discoveredModelsSource !== "probe" || merge.discoveredModels.length === 0) return null;
	if (listKnownModelsForRuntime(desc.id).length > 0 && desc.externalAgentLoop?.modelCatalog !== "live-authoritative") {
		return null;
	}
	if (merge.discoveredModels.includes(model)) return null;
	// LM Studio lists a loaded model under its instance id and keeps the model
	// key in the state map; the request path resolves either.
	if (merge.discoveredModelStates && model in merge.discoveredModelStates) return null;
	return `default model '${model}' is not advertised by the target`;
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

	async function buildProbeContextForTarget(
		target: TargetDescriptor,
		desc: RuntimeDescriptor,
		signal?: AbortSignal,
	): Promise<ProbeContext> {
		const probeCtx: ProbeContext = {
			credentialsPresent: credentialsPresent(),
			httpTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		};
		if (!targetRequiresAuth(target, desc)) return probeCtx;
		try {
			const resolution = await authStore.resolveForTarget(resolveAuthTarget(target, desc), {
				includeFallback: false,
				...(signal ? { signal } : {}),
			});
			if (resolution.apiKey) probeCtx.authToken = resolution.apiKey;
		} catch {
			// Authenticated probes should still return a runtime-specific missing-auth error.
		}
		return probeCtx;
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
			if (previous?.probeSurfaces) out.probeSurfaces = previous.probeSurfaces;
			return out;
		}
		const availability = availabilityFor(desc, target, authStatusFor);
		const cachedSnapshot = readTargetModelSnapshot(target);
		const cachedModels = cachedSnapshot?.models ?? [];
		const merge = mergeProbeResult(desc, target, probe, previous, cachedModels, cachedSnapshot?.modelLabels ?? {});
		const { capabilities, contextWindowProvenance } = capabilitiesFor(desc, target, merge, kb);
		const healthy = probe !== null ? probe.ok : null;
		const unservedDefault = probe?.ok ? unservedDefaultModelReason(desc, target, merge) : null;
		const health: TargetHealth =
			probe === null
				? (previous?.health ?? emptyHealth())
				: {
						status: healthy ? (unservedDefault === null ? "healthy" : "degraded") : "down",
						lastCheckAt: new Date().toISOString(),
						lastError: probe.error ?? unservedDefault,
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
			contextWindowProvenance,
			probeCapabilities: merge.probeCapabilities,
			probeModelCapabilities: merge.probeModelCapabilities,
			probeModelId: merge.probeModelId,
			discoveredModels: merge.discoveredModels,
			discoveredModelLabels: merge.discoveredModelLabels,
			discoveredModelsSource: merge.discoveredModelsSource,
			discoveredModelStates: merge.discoveredModelStates,
		};
		if (merge.probeNotes && merge.probeNotes.length > 0) out.probeNotes = merge.probeNotes;
		if (merge.probeSurfaces) out.probeSurfaces = merge.probeSurfaces;
		return out;
	}

	async function probeTargetInternal(
		target: TargetDescriptor,
		live: boolean,
		options?: { reasoning?: boolean; signal?: AbortSignal },
	): Promise<TargetStatus> {
		options?.signal?.throwIfAborted();
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
		const probeCtx = await buildProbeContextForTarget(target, desc, options?.signal);
		options?.signal?.throwIfAborted();
		let probeResult: ProbeResult;
		try {
			probeResult = await desc.probe(target, probeCtx);
		} catch (err) {
			probeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		options?.signal?.throwIfAborted();
		if (probeResult.ok && typeof desc.probeModels === "function" && !probeResult.models) {
			try {
				const ids = await desc.probeModels(target, probeCtx);
				probeResult = { ...probeResult, models: ids };
			} catch {
				// model discovery is best-effort; keep probe as-is.
			}
		}
		options?.signal?.throwIfAborted();
		if (probeResult.ok && options?.reasoning !== false && typeof desc.probeReasoning === "function") {
			const settings = readConfig();
			const orchestratorTarget = settings.chat.target === target.id ? settings.chat.model : null;
			const candidateModelId = orchestratorTarget ?? target.defaultModel ?? null;
			if (candidateModelId) {
				try {
					const result = await desc.probeReasoning(target, candidateModelId, probeCtx);
					options?.signal?.throwIfAborted();
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
		// A cancelled role preparation must not publish failed/stale target state.
		options?.signal?.throwIfAborted();
		const status = buildStatus(target, desc, probeResult, previous);
		statuses.set(target.id, status);
		if (probeResult.ok && probeResult.models !== undefined) {
			recordTargetModelSnapshot(
				target,
				probeResult.models,
				probeResult.modelLabels ? { modelLabels: probeResult.modelLabels } : {},
			);
		}
		// Durable so the next process resolves this endpoint's real slot count
		// instead of the conservative default. Fire and forget: the probe's answer
		// is already in `statuses`, and a failed write must not fail the probe.
		void recordEndpointSlotsFromStatus(status);
		context.bus.emit(BusChannels.ProviderHealth, { id: target.id, status });
		return status;
	}

	async function probeReasoningForModelInternal(targetId: string, modelId: string): Promise<boolean | null> {
		const settings = readConfig();
		const target = settings.targets.find((ep) => ep.id === targetId);
		if (!target) return null;
		const desc = registry.get(target.runtime);
		if (!desc || typeof desc.probeReasoning !== "function") return null;
		const probeCtx = await buildProbeContextForTarget(target, desc);
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
			registerClioOAuthProviders();
			registerBuiltinRuntimes(registry);
			const settings = readConfig();
			setGlobalDefaultMaxOutputTokens(settings.chat.maxOutputTokens);
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
		async probeTarget(id, options) {
			const settings = readConfig();
			const target = settings.targets.find((ep) => ep.id === id);
			if (!target) return null;
			return probeTargetInternal(target, true, options);
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
		auth: {
			statusForTarget(target, runtime) {
				if (!targetRequiresAuth(target, runtime)) {
					return authNotRequiredStatus(resolveAuthTarget(target, runtime).providerId);
				}
				return authStore.statusForTarget(resolveAuthTarget(target, runtime), { includeFallback: false });
			},
			resolveForTarget(target, runtime, options) {
				if (!targetRequiresAuth(target, runtime)) {
					return Promise.resolve(authNotRequiredStatus(resolveAuthTarget(target, runtime).providerId));
				}
				return authStore.resolveForTarget(resolveAuthTarget(target, runtime), {
					includeFallback: false,
					...(options?.signal ? { signal: options.signal } : {}),
				});
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
			damageReason() {
				return authStore.damageReason();
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
