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
import { clioOwnership, forgetClioLoad, leaseClioModel, recordClioLoad } from "./lmstudio-ownership.js";
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
	const load = effectiveLmStudioLoad(info.lmstudio, model.id);
	const lmstudio = info.lmstudio ? { ...info.lmstudio, ...(load ? { load } : {}) } : undefined;
	return {
		id: info.targetId,
		runtime: "lmstudio",
		url: lmStudioRootUrl(model.baseUrl),
		defaultModel: info.lmstudioDefaultModel ?? model.id,
		...(model.headers ? { auth: { headers: model.headers } } : {}),
		...(info.lifecycle ? { lifecycle: info.lifecycle } : {}),
		...(lmstudio ? { lmstudio } : {}),
	};
}

type LmStudioLoad = NonNullable<NonNullable<TargetDescriptor["lmstudio"]>["load"]>;

/** Each load profile field and the key LM Studio's load body and instance config use for it. */
const LOAD_WIRE_KEYS = [
	["contextLength", "context_length"],
	["flashAttention", "flash_attention"],
	["evalBatchSize", "eval_batch_size"],
	["numExperts", "num_experts"],
	["offloadKvCacheToGpu", "offload_kv_cache_to_gpu"],
	["parallel", "parallel"],
	["speculativeDraftMaxTokens", "speculative_draft_max_tokens"],
] as const satisfies ReadonlyArray<readonly [keyof LmStudioLoad, string]>;

/** The target's load profile with the selected model's override on top. */
export function effectiveLmStudioLoad(
	settings: TargetDescriptor["lmstudio"] | undefined,
	modelId: string,
): LmStudioLoad | undefined {
	const merged = { ...(settings?.load ?? {}), ...(settings?.models?.[modelId]?.load ?? {}) };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function lmStudioLoadBody(modelKey: string, settings: LmStudioLoad): Record<string, unknown> {
	const body: Record<string, unknown> = { model: modelKey, echo_load_config: true };
	for (const [field, wire] of LOAD_WIRE_KEYS) {
		if (settings[field] !== undefined) body[wire] = settings[field];
	}
	return body;
}

/**
 * Where a loaded instance's config differs from the load Clio would issue, as
 * `key loaded to wanted` lines. A key the instance config does not report cannot be
 * verified and counts as matching, so an unreported field never forces a reload loop.
 */
export function lmStudioLoadDrift(body: Record<string, unknown>, config: Readonly<Record<string, unknown>>): string[] {
	const drift: string[] = [];
	for (const [, wire] of LOAD_WIRE_KEYS) {
		const wanted = body[wire];
		const loaded = config[wire];
		if (wanted === undefined || loaded === undefined || loaded === wanted) continue;
		drift.push(`${wire} ${String(loaded)} to ${String(wanted)}`);
	}
	return drift;
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

/** Unload one instance whoever loaded it. Only a load-profile mismatch on a managed target reaches this. */
async function unloadInstance(
	target: TargetDescriptor,
	targetKey: string,
	instanceId: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	await post(target, "/api/v1/models/unload", { instance_id: instanceId }, apiKey, signal);
	ownedInstances(targetKey).delete(instanceId);
	await forgetClioLoad(targetKey, instanceId);
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
	await forgetClioLoad(targetKey, instanceId);
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
		if (typeof body.model === "string") {
			markClioLoaded(targetKey, body.model);
			await recordClioLoad(targetKey, instanceId, body.model);
		}
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

const emitResidencyNotice = declareRuntimeNoticeProducer("lmstudio-residency", ["co-resident", "stress", "swap"]);

function emitResidencyNoticeOnce(key: string, notice: Parameters<typeof emitResidencyNotice>[0]): void {
	if (announcedResidencyFacts.has(key)) return;
	announcedResidencyFacts.add(key);
	emitResidencyNotice(notice);
}

/** The instance a request should name, and the lease that keeps other Clio processes from releasing it. */
export interface LmStudioResidency {
	wireModelId: string;
	/** Ends this process's use of the model. Call it when the stream ends, success or not. */
	release(): Promise<void>;
}

const NO_LEASE = (): Promise<void> => Promise.resolve();

function unleased(wireModelId: string): LmStudioResidency {
	return { wireModelId, release: NO_LEASE };
}

export async function ensureLmStudioResidency(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<LmStudioResidency> {
	const info = metadata(model);
	const load = effectiveLmStudioLoad(info?.lmstudio, model.id);
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
): Promise<LmStudioResidency> {
	const target = targetForModel(model);
	if (!target) return unleased(model.id);
	const info = metadata(model);
	if (!info) return unleased(model.id);
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
		if (!explicitLoad) return unleased(model.id);
		throw new Error(catalog.error ?? "LM Studio model listing failed");
	}
	const resolution = resolveLmStudioInstance(target, catalog.models, model.id, info.lmstudioDefaultModel);
	if (resolution.state === "unknown") {
		if (!explicitLoad) return unleased(model.id);
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
	const keepLoaded = (): string => {
		capToLoadedContext(model, loadedContextLength(resolution.instance));
		return resolution.wireModelId;
	};
	if (!explicitLoad || !load || catalog.tier !== "0.4+") return unleased(keepLoaded());
	const modelKey = resolution.model?.key ?? model.id;
	let instances = catalog.models.flatMap((entry) =>
		entry.loadedInstances.map((instance) => ({ modelKey: entry.key, identifier: instance.id, instance })),
	);
	const targetKey = residencyTargetKey("lmstudio", target.url ?? model.baseUrl);
	const contextLength = load.contextLength;
	const ownership = await clioOwnership(targetKey);
	// Taken while the residency lock is still held, so no other process releases the model in between.
	const leased = async (wireModelId: string): Promise<LmStudioResidency> => ({
		wireModelId,
		release: await leaseClioModel(targetKey, modelKey),
	});
	if (resolution.instance) {
		// Another client's just-in-time load takes the server's GUI defaults. The operator's
		// profile is the contract on a managed target, so a drifted instance is reloaded.
		const wanted = lmStudioLoadBody(modelKey, load);
		if (contextLength !== undefined) {
			wanted.context_length = fitLoadContextLength({
				requested: contextLength,
				resident: instances,
				keepModelId: modelKey,
				ceiling: coResidentContextCeiling(),
			}).contextLength;
		}
		const drift = lmStudioLoadDrift(wanted, resolution.instance.config);
		if (drift.length === 0) return leased(keepLoaded());
		if (ownership.leased.has(modelKey)) {
			// Another Clio request is streaming on this instance; reloading would fail it.
			emitResidencyNoticeOnce(`busy-drift|${info.targetId}|${modelKey}|${drift.join(",")}`, {
				kind: "stress",
				level: "warning",
				targetId: info.targetId,
				runtimeId: "lmstudio",
				model: modelKey,
				message: `'${modelKey}' on target '${info.targetId}' differs from its load profile (${drift.join(", ")}) but another Clio request is using it; Clio reloads it on a later turn once it is idle.`,
			});
			return leased(keepLoaded());
		}
		const stale = resolution.instance.id;
		await unloadInstance(target, targetKey, stale, options.apiKey, options.signal);
		instances = instances.filter((entry) => entry.identifier !== stale);
		emitResidencyMutation({
			targetKey,
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: modelKey,
			operation: "evict",
		});
		emitResidencyNotice({
			kind: "swap",
			level: "info",
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: modelKey,
			message: `reloading '${modelKey}' on target '${info.targetId}' to match its load profile: ${drift.join(", ")}`,
			detail: { instance: stale, drift: drift.join("; ") },
		});
	}
	// LM Studio answers an oversubscribed card by offloading to CPU rather than refusing the load, so a
	// co-resident load is never tested by a capacity error. Release what Clio loaded earlier on this
	// server, from any Clio process, before loading; a model another Clio process is streaming on stays.
	const residentIds = new Set(instances.map((entry) => entry.identifier));
	for (const record of ownership.loads) {
		if (!residentIds.has(record.instanceId)) await forgetClioLoad(targetKey, record.instanceId);
	}
	const recorded = new Set(ownership.loads.map((record) => record.instanceId));
	for (const entry of [...instances]) {
		if (entry.modelKey === modelKey || !recorded.has(entry.identifier) || ownership.leased.has(entry.modelKey)) {
			continue;
		}
		await unloadInstance(target, targetKey, entry.identifier, options.apiKey, options.signal);
		instances = instances.filter((resident) => resident.identifier !== entry.identifier);
		emitResidencyMutation({
			targetKey,
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: entry.modelKey,
			operation: "evict",
		});
		emitResidencyNotice({
			kind: "swap",
			level: "info",
			targetId: info.targetId,
			runtimeId: "lmstudio",
			model: entry.modelKey,
			message: `unloading '${entry.modelKey}', which Clio loaded earlier on target '${info.targetId}', before loading '${modelKey}'`,
			detail: { instance: entry.identifier, replacement: modelKey },
		});
	}
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
		return await leased(await loadAndReport());
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
			return await leased(await loadAndReport());
		} catch (retryError) {
			// A rejected replacement must not leave an otherwise working server empty.
			for (const entry of evicted) {
				const restore: Record<string, unknown> = { model: entry.modelKey };
				for (const [, key] of LOAD_WIRE_KEYS) {
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

/** The LM Studio server and model key behind one LiteLLM route. */
export interface GatewayLmStudioDeployment {
	controlUrl: string;
	modelKey: string;
}

/**
 * Read the LM Studio deployment behind `alias` from a LiteLLM `/v1/model/info` body.
 * Only a route with exactly one deployment that the gateway declares as
 * `model_info.runtime: lm-studio` qualifies, the same deployment declaration the
 * thinking controls rely on; a host name, port or alias is never taken as evidence.
 */
export function lmStudioDeploymentFromModelInfo(body: unknown, alias: string): GatewayLmStudioDeployment | null {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return null;
	const rows = data.filter(
		(row): row is { litellm_params?: Record<string, unknown>; model_info?: Record<string, unknown> } =>
			typeof row === "object" && row !== null && (row as { model_name?: unknown }).model_name === alias,
	);
	if (rows.length !== 1) return null;
	const [row] = rows;
	if (row?.model_info?.runtime !== "lm-studio") return null;
	const apiBase = row.litellm_params?.api_base;
	const upstream = row.litellm_params?.model;
	if (typeof apiBase !== "string" || typeof upstream !== "string") return null;
	// One LiteLLM provider prefix, never more: an LM Studio key may itself hold a slash (openai/gpt-oss-20b).
	const modelKey = upstream.replace(/^(?:openai|lm_studio)\//u, "");
	if (modelKey.length === 0) return null;
	try {
		const url = new URL(apiBase);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	} catch {
		// An api_base that is not a URL names no server Clio could load on.
		return null;
	}
	return { controlUrl: lmStudioRootUrl(apiBase), modelKey };
}

const GATEWAY_DEPLOYMENT_TTL_MS = 5 * 60_000;
const gatewayDeployments = new Map<string, { at: number; deployment: GatewayLmStudioDeployment | null }>();

async function gatewayLmStudioDeployment(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal },
): Promise<GatewayLmStudioDeployment | null> {
	if (!model.baseUrl) return null;
	const root = lmStudioRootUrl(model.baseUrl);
	const cacheKey = `${root}\u0000${model.id}`;
	const cached = gatewayDeployments.get(cacheKey);
	if (cached && Date.now() - cached.at < GATEWAY_DEPLOYMENT_TTL_MS) return cached.deployment;
	const headers = new Headers(model.headers);
	if (options.apiKey?.trim() && !headers.has("authorization"))
		headers.set("authorization", `Bearer ${options.apiKey.trim()}`);
	const response = await requestLmStudioJson(`${root}/v1/model/info`, { headers }, 5_000, options.signal);
	// Detail metadata may be restricted to admin keys; without it the route stays gateway-owned.
	const deployment = response.ok ? lmStudioDeploymentFromModelInfo(response.data, model.id) : null;
	gatewayDeployments.set(cacheKey, { at: Date.now(), deployment });
	return deployment;
}

/** The LM Studio control-plane model that residency runs against for a gateway route. */
function gatewayControlModel(
	model: Model<"openai-completions">,
	deployment: GatewayLmStudioDeployment,
	load: LmStudioLoad,
): Model<"openai-completions"> {
	const info = metadata(model);
	const { headers: _gatewayHeaders, ...rest } = model;
	// The gateway's credentials stay with the gateway; the LM Studio server gets none.
	return {
		...rest,
		id: deployment.modelKey,
		provider: "lmstudio",
		baseUrl: `${deployment.controlUrl}/v1`,
		clioCoder: {
			targetId: info?.targetId ?? model.provider,
			runtimeId: "lmstudio",
			...(info?.lifecycle ? { lifecycle: info.lifecycle } : {}),
			lmstudio: { load },
		},
	} as Model<"openai-completions">;
}

/** Whether a LiteLLM route carries an LM Studio load profile Clio may enforce. */
export function gatewayLmStudioProfile(model: Model<Api>): LmStudioLoad | undefined {
	const info = metadata(model);
	if (info?.runtimeId !== "litellm" || !residencyManagedFor(info.lifecycle)) return undefined;
	return effectiveLmStudioLoad(info.lmstudio, model.id);
}

/**
 * Load a LiteLLM route's LM Studio model with the target's load profile before the
 * request, on the LM Studio server the gateway names for that route. A route that is not
 * a single declared LM Studio deployment, or a gateway that hides its detail metadata,
 * stays gateway-owned and untouched. The request itself still goes to the gateway alias.
 */
export async function ensureGatewayLmStudioResidency(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<() => Promise<void>> {
	const load = gatewayLmStudioProfile(model);
	if (!load) return NO_LEASE;
	const deployment = await gatewayLmStudioDeployment(model, options);
	if (!deployment) return NO_LEASE;
	const control = gatewayControlModel(model, deployment, load);
	const residency = await ensureLmStudioResidency(control, options.signal ? { signal: options.signal } : {});
	if (control.contextWindow > 0 && (model.contextWindow <= 0 || control.contextWindow < model.contextWindow)) {
		model.contextWindow = control.contextWindow;
	}
	return residency.release;
}

/** Resident model keys on the LM Studio server behind a gateway route, for the degraded-inference notice. */
export async function listGatewayLmStudioResidentModels(
	model: Model<"openai-completions">,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<ResidentModelInfo[]> {
	const load = gatewayLmStudioProfile(model);
	const deployment = load ? await gatewayLmStudioDeployment(model, options) : null;
	if (!load || !deployment) return [];
	return listLmStudioResidentModels(
		gatewayControlModel(model, deployment, load),
		options.signal ? { signal: options.signal } : {},
	);
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
