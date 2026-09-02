import type { Api, Model } from "@earendil-works/pi-ai";

import { residencyTargetKey } from "../../core/residency-target-key.js";
import {
	type LmStudioCatalog,
	type LmStudioLoadedInstance,
	type LmStudioModelInfo,
	listLmStudioModels,
	lmStudioRootUrl,
	requestLmStudioJson,
	resolveLmStudioInstance,
} from "../../domains/providers/runtimes/common/lmstudio-http.js";
import type { TargetDescriptor } from "../../domains/providers/types/target-descriptor.js";
import { coResidentContextCeiling, fitLoadContextLength } from "./lmstudio-residency.js";
import { emitResidencyMutation, emitResidencyNotice, reconcileResidency, residencyManagedFor } from "./residency.js";
import { withResidencyLock } from "./residency-lock.js";

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

function resolveModel(
	catalog: LmStudioCatalog,
	id: string,
): { model: LmStudioModelInfo; instance?: LmStudioLoadedInstance } | null {
	for (const model of catalog.models) {
		if (model.key === id) return { model, ...(model.loadedInstances[0] ? { instance: model.loadedInstances[0] } : {}) };
		const instance = model.loadedInstances.find((entry) => entry.id === id);
		if (instance) return { model, instance };
	}
	return null;
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
	const headers: Record<string, string> = { "content-type": "application/json", ...(target.auth?.headers ?? {}) };
	if (apiKey?.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
	const response = await requestLmStudioJson(
		`${lmStudioRootUrl(target.url ?? "")}${path}`,
		{ method: "POST", headers, body: JSON.stringify(body) },
		5_000,
		signal,
	);
	if (!response.ok) throw new Error(response.error ?? `LM Studio ${path} returned HTTP ${response.status}`);
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
): Promise<string | undefined> {
	const data = await post(target, "/api/v1/models/load", body, apiKey, signal);
	const instanceId = responseInstanceId(data);
	if (instanceId) ownedInstances(targetKey).add(instanceId);
	return instanceId;
}

/**
 * Residency runs before every request, and the same co-residency facts held
 * every turn, so the peer warning printed once per turn (issue #185). Each
 * distinct fact is said once per process; a new target, model, or peer set is
 * a new fact.
 */
const announcedResidencyFacts = new Set<string>();

function emitResidencyNoticeOnce(key: string, notice: Parameters<typeof emitResidencyNotice>[0]): void {
	if (announcedResidencyFacts.has(key)) return;
	announcedResidencyFacts.add(key);
	emitResidencyNotice(notice);
}

export async function ensureLmStudioResidency(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<string> {
	const target = targetForModel(model);
	if (!target) return model.id;
	const info = metadata(model);
	if (!info) return model.id;
	const load = target.lmstudio?.load;
	const ctx = {
		credentialsPresent: new Set<string>(),
		httpTimeoutMs: 5_000,
		...(options.apiKey ? { authToken: options.apiKey } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	};
	const catalog = await listLmStudioModels(target, ctx);
	if (!catalog.ok) throw new Error(catalog.error ?? "LM Studio model listing failed");
	const resolution = resolveLmStudioInstance(target, catalog.models, model.id, info.lmstudioDefaultModel);
	if (resolution.state === "unknown") {
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
	if (!load || Object.keys(load).length === 0 || resolution.instance) return resolution.wireModelId;
	if (catalog.tier !== "0.4+") return resolution.wireModelId;
	const selected = resolveModel(catalog, model.id);
	const modelKey = selected?.model.key ?? model.id;
	let instances = catalog.models.flatMap((entry) =>
		entry.loadedInstances.map((instance) => ({ modelKey: entry.key, identifier: instance.id, instance })),
	);
	const managed = residencyManagedFor(info.lifecycle);
	const targetKey = residencyTargetKey("lmstudio", target.url ?? model.baseUrl);
	const contextLength = target.lmstudio?.load?.contextLength;
	const plan = await reconcileResidency({
		targetKey,
		targetId: info.targetId,
		runtimeId: "lmstudio",
		keepModelId: modelKey,
		managed,
		strategy: "jit",
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
		const instanceId = await loadOwnedInstance(target, targetKey, body, options.apiKey, options.signal);
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
		if (plan.decision === "observe" || plan.fallbackEvict.length === 0) throw error;
		return withResidencyLock(targetKey, async () => {
			for (const candidate of plan.fallbackEvict) {
				for (const entry of instances.filter((resident) => resident.modelKey === candidate.modelId)) {
					if (await unloadOwnedInstance(target, targetKey, entry.identifier, options.apiKey, options.signal)) {
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
			return loadAndReport();
		});
	}
}
