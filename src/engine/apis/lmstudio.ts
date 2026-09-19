import type { Api, Model } from "@earendil-works/pi-ai";

import { residencyTargetKey } from "../../core/residency-target-key.js";
import {
	invalidateLmStudioCatalog,
	listLmStudioModels,
	lmStudioRootUrl,
	loadedContextLength,
	requestLmStudioJson,
	resolveLmStudioInstance,
} from "../../domains/providers/runtimes/common/lmstudio-http.js";
import type { TargetDescriptor } from "../../domains/providers/types/target-descriptor.js";
import { coResidentContextCeiling, fitLoadContextLength } from "./lmstudio-residency.js";
import {
	declareRuntimeNoticeProducer,
	emitResidencyMutation,
	markClioLoaded,
	reconcileResidency,
	residencyManagedFor,
} from "./residency.js";
import { withResidencyLock } from "./residency-lock.js";
import type { ResidentModelInfo } from "./resident-models.js";

interface LmStudioModelMetadata {
	clioCoder?: {
		targetId: string;
		runtimeId: string;
		lifecycle?: "user-managed" | "clio-coder-managed";
		lmstudio?: TargetDescriptor["lmstudio"];
		lmstudioDefaultModel?: string;
	};
}

const ownedInstancesByTarget = new Map<string, Set<string>>();

function ownedInstances(targetKey: string): Set<string> {
	let owned = ownedInstancesByTarget.get(targetKey);
	if (!owned) {
		owned = new Set<string>();
		ownedInstancesByTarget.set(targetKey, owned);
	}
	return owned;
}

function responseInstanceId(data: unknown): string | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const id = (data as { instance_id?: unknown }).instance_id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function metadata(model: Model<Api>): NonNullable<LmStudioModelMetadata["clioCoder"]> | undefined {
	return (model as Model<Api> & LmStudioModelMetadata).clioCoder;
}

function targetForModel(model: Model<"openai-completions">): TargetDescriptor | null {
	const info = metadata(model);
	if (info?.runtimeId !== "lmstudio" || !model.baseUrl) return null;
	return {
		id: info.targetId,
		runtime: "lmstudio",
		url: lmStudioRootUrl(model.baseUrl),
		defaultModel: info.lmstudioDefaultModel ?? model.id,
		...(model.headers ? { auth: { headers: model.headers } } : {}),
		...(info.lifecycle ? { lifecycle: info.lifecycle } : {}),
		...(info.lmstudio ? { lmstudio: info.lmstudio } : {}),
	};
}

function lmStudioLoadBody(
	modelKey: string,
	settings: NonNullable<NonNullable<TargetDescriptor["lmstudio"]>["load"]>,
): Record<string, unknown> {
	const body: Record<string, unknown> = { model: modelKey, echo_load_config: true };
	if (settings.contextLength !== undefined) body.context_length = settings.contextLength;
	if (settings.flashAttention !== undefined) body.flash_attention = settings.flashAttention;
	if (settings.evalBatchSize !== undefined) body.eval_batch_size = settings.evalBatchSize;
	if (settings.numExperts !== undefined) body.num_experts = settings.numExperts;
	if (settings.offloadKvCacheToGpu !== undefined) body.offload_kv_cache_to_gpu = settings.offloadKvCacheToGpu;
	return body;
}

async function post(
	target: TargetDescriptor,
	path: string,
	body: Record<string, unknown>,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const headers = new Headers(target.auth?.headers);
	headers.set("content-type", "application/json");
	if (apiKey?.trim() && !headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey.trim()}`);
	invalidateLmStudioCatalog(target);
	const response = await requestLmStudioJson(
		`${lmStudioRootUrl(target.url ?? "")}${path}`,
		{ method: "POST", headers, body: JSON.stringify(body) },
		path === "/api/v1/models/load" ? 120_000 : 5_000,
		signal,
	);
	if (!response.ok) throw new Error(response.error ?? `LM Studio ${path} returned HTTP ${response.status}`);
	invalidateLmStudioCatalog(target);
	return response.data;
}

async function unloadOwnedInstance(
	target: TargetDescriptor,
	targetKey: string,
	instanceId: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const owned = ownedInstances(targetKey);
	if (!owned.has(instanceId)) return false;
	await post(target, "/api/v1/models/unload", { instance_id: instanceId }, apiKey, signal);
	owned.delete(instanceId);
	return true;
}

async function loadOwnedInstance(
	target: TargetDescriptor,
	targetKey: string,
	body: Record<string, unknown>,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	requestModel?: Model<"openai-completions">,
): Promise<string | undefined> {
	const data = await post(target, "/api/v1/models/load", body, apiKey, signal);
	const loadedWindow = (data as { load_config?: { context_length?: unknown } } | null)?.load_config?.context_length;
	if (requestModel) capToLoadedContext(requestModel, loadedWindow);
	const instanceId = responseInstanceId(data);
	if (instanceId) {
		ownedInstances(targetKey).add(instanceId);
		if (typeof body.model === "string") markClioLoaded(targetKey, body.model);
	}
	return instanceId;
}

function capToLoadedContext(model: Model<"openai-completions">, window: unknown): void {
	if (typeof window === "number" && Number.isFinite(window) && window > 0) {
		model.contextWindow = Math.min(model.contextWindow > 0 ? model.contextWindow : window, window);
	}
}

/**
 * Residency runs before every request, and the same co-residency facts held
 * every turn, so the peer warning printed once per turn (issue #185). Each
 * distinct fact is said once per process; a new target, model, or peer set is
 * a new fact.
 */
const announcedResidencyFacts = new Set<string>();

const emitResidencyNotice = declareRuntimeNoticeProducer("lmstudio-residency", ["co-resident", "stress"]);

function emitResidencyNoticeOnce(key: string, notice: Parameters<typeof emitResidencyNotice>[0]): void {
	if (announcedResidencyFacts.has(key)) return;
	announcedResidencyFacts.add(key);
	emitResidencyNotice(notice);
}

export async function ensureLmStudioResidency(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<string> {
	const info = metadata(model);
	const load = info?.lmstudio?.load;
	if (
		info?.runtimeId === "lmstudio" &&
		model.baseUrl &&
		residencyManagedFor(info.lifecycle) &&
		load &&
		Object.keys(load).length > 0
	) {
		// Read the catalog after taking the lock so concurrent loads reuse the new instance.
		return withResidencyLock(
			residencyTargetKey("lmstudio", lmStudioRootUrl(model.baseUrl)),
			() => ensureLmStudioResidencyUnlocked(model, options),
			options.signal,
		);
	}
	return ensureLmStudioResidencyUnlocked(model, options);
}

async function ensureLmStudioResidencyUnlocked(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<string> {
	const target = targetForModel(model);
	if (!target) return model.id;
	const info = metadata(model);
	if (!info) return model.id;
	options.signal?.throwIfAborted();
	const managed = residencyManagedFor(info.lifecycle);
	const load = target.lmstudio?.load;
	const explicitLoad = managed && load !== undefined && Object.keys(load).length > 0;
	const ctx = {
		credentialsPresent: new Set<string>(),
		httpTimeoutMs: 5_000,
		...(options.apiKey ? { authToken: options.apiKey } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	};
	const catalog = await listLmStudioModels(target, ctx, explicitLoad ? 0 : 3000);
	if (!catalog.ok) {
		if (!explicitLoad) return model.id;
		throw new Error(catalog.error ?? "LM Studio model listing failed");
	}
	const resolution = resolveLmStudioInstance(target, catalog.models, model.id, info.lmstudioDefaultModel);
	if (resolution.state === "unknown") {
		if (!explicitLoad) return model.id;
		const resident = catalog.models.flatMap((entry) => entry.loadedInstances.map((instance) => instance.id));
		throw new Error(
			`LM Studio target '${info.targetId}' does not advertise model '${model.id}'. Resident instances: ${resident.length > 0 ? resident.join(", ") : "none"}. Configure an explicit LM Studio load before requesting an unlisted model.`,
		);
	}
	if (resolution.wireModelId !== model.id) {
		emitResidencyNoticeOnce(`resolved|${info.targetId}|${model.id}|${resolution.wireModelId}`, {
			kind: "co-resident",
			level: "info",
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: model.id,
			message: `LM Studio resolved '${model.id}' to loaded instance '${resolution.wireModelId}' on target '${info.targetId}'.`,
			detail: { requestedModel: model.id, wireModel: resolution.wireModelId },
		});
	}
	if (resolution.peerTargets.length > 0) {
		const peers = resolution.peerTargets.join(", ");
		const requested = resolution.wireModelId === model.id ? "" : ` (requested '${model.id}')`;
		emitResidencyNoticeOnce(`peer|${info.targetId}|${model.id}|${resolution.wireModelId}|${peers}`, {
			kind: "co-resident",
			level: "warning",
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: resolution.wireModelId,
			message: `LM Studio instance '${resolution.wireModelId}'${requested} is also loaded on ${peers}; a request may be served by that LM Link peer, and the footer and usage ledger name the id that answered when it differs.`,
			detail: { requestedModel: model.id, wireModel: resolution.wireModelId, peerTargets: peers },
		});
	}
	capToLoadedContext(model, loadedContextLength(resolution.instance));
	if (!explicitLoad || !load || resolution.instance) return resolution.wireModelId;
	if (catalog.tier !== "0.4+") return resolution.wireModelId;
	const modelKey = resolution.model?.key ?? model.id;
	let instances = catalog.models.flatMap((entry) =>
		entry.loadedInstances.map((instance) => ({ modelKey: entry.key, identifier: instance.id, instance })),
	);
	const targetKey = residencyTargetKey("lmstudio", target.url ?? model.baseUrl);
	const contextLength = target.lmstudio?.load?.contextLength;
	const plan = await reconcileResidency({
		targetKey,
		targetId: info.targetId,
		runtimeId: "lmstudio",
		keepModelId: modelKey,
		managed,
		strategy: "jit",
		ttlMs: 0, // The fresh catalog, not a previous load attempt, determines residency.
		...(options.signal ? { signal: options.signal } : {}),
		...(contextLength !== undefined ? { contextLength } : {}),
		...(model.contextWindow > 0 ? { modelMaxContext: model.contextWindow } : {}),
		listResident: async () => [...new Set(instances.map((entry) => entry.modelKey))].map((modelId) => ({ modelId })),
		unload: async (id) => {
			const released = new Set<string>();
			for (const entry of instances.filter((resident) => resident.modelKey === id)) {
				if (await unloadOwnedInstance(target, targetKey, entry.identifier, options.apiKey, options.signal)) {
					released.add(entry.identifier);
				}
			}
			instances = instances.filter((resident) => !released.has(resident.identifier));
		},
	});
	let body = lmStudioLoadBody(modelKey, load);
	if (load.contextLength !== undefined) {
		const fit = fitLoadContextLength({
			requested: load.contextLength,
			resident: instances,
			keepModelId: modelKey,
			ceiling: coResidentContextCeiling(),
		});
		body = { ...body, context_length: fit.contextLength };
		if (fit.clampedFrom !== undefined) {
			emitResidencyNotice({
				kind: "stress",
				level: "warning",
				targetId: info.targetId,
				runtimeId: "lmstudio",
				model: model.id,
				message: `loading '${model.id}' alongside ${fit.neighbours.join(", ")}: context clamped ${fit.clampedFrom} to ${fit.contextLength} tokens`,
				detail: { requestedContext: fit.clampedFrom, loadContext: fit.contextLength },
			});
		}
	}
	const loadAndReport = async (): Promise<string> => {
		const instanceId = await loadOwnedInstance(target, targetKey, body, options.apiKey, options.signal, model);
		emitResidencyMutation({
			targetKey,
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: modelKey,
			operation: "load",
		});
		return instanceId ?? model.id;
	};
	try {
		return await loadAndReport();
	} catch (error) {
		options.signal?.throwIfAborted();
		const message = error instanceof Error ? error.message : String(error);
		const capacityError =
			/insufficient[_ ](?:system[_ ])?(?:resources|memory)|out of (?:device |gpu |system )?memory|not enough (?:free )?(?:vram|memory)/i.test(
				message,
			);
		if (!capacityError || plan.decision !== "reconcile" || plan.fallbackEvict.length === 0) throw error;
		const evicted: typeof instances = [];
		try {
			for (const candidate of plan.fallbackEvict) {
				for (const entry of instances.filter((resident) => resident.modelKey === candidate.modelId)) {
					if (await unloadOwnedInstance(target, targetKey, entry.identifier, options.apiKey, options.signal)) {
						evicted.push(entry);
						emitResidencyMutation({
							targetKey,
							targetId: info.targetId,
							runtimeId: "lmstudio",
							model: candidate.modelId,
							operation: "evict",
						});
					}
				}
			}
			if (evicted.length === 0) throw error;
			return await loadAndReport();
		} catch (retryError) {
			// A rejected replacement must not leave an otherwise working server empty.
			for (const entry of evicted) {
				const restore: Record<string, unknown> = { model: entry.modelKey };
				for (const key of [
					"context_length",
					"flash_attention",
					"eval_batch_size",
					"num_experts",
					"offload_kv_cache_to_gpu",
				]) {
					if (entry.instance.config[key] !== undefined) restore[key] = entry.instance.config[key];
				}
				try {
					await loadOwnedInstance(target, targetKey, restore, options.apiKey, undefined);
					emitResidencyMutation({
						targetKey,
						targetId: info.targetId,
						runtimeId: "lmstudio",
						model: entry.modelKey,
						operation: "load",
					});
				} catch {
					emitResidencyNotice({
						kind: "stress",
						level: "error",
						targetId: info.targetId,
						runtimeId: "lmstudio",
						model: entry.modelKey,
						message: `LM Studio could not restore '${entry.modelKey}' after the replacement load failed. Reload it on the server.`,
					});
				}
			}
			throw retryError;
		}
	}
}

/**
 * Model keys with at least one loaded instance on the model's LM Studio target,
 * as the REST listing reports them now. The degraded-inference watchdog calls
 * this when a turn slows down, so the notice names what shares the server.
 */
export async function listLmStudioResidentModels(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<ResidentModelInfo[]> {
	const target = targetForModel(model);
	if (!target) throw new Error("no LM Studio target for model");
	const catalog = await listLmStudioModels(target, {
		credentialsPresent: new Set<string>(),
		httpTimeoutMs: 1_500,
		...(options.apiKey ? { authToken: options.apiKey } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (!catalog.ok) throw new Error(catalog.error ?? "LM Studio model listing failed");
	return catalog.models.filter((entry) => entry.loadedInstances.length > 0).map((entry) => ({ modelId: entry.key }));
}
