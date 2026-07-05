import { emitResidencyNotice, RECONCILE_TTL_MS } from "./residency.js";

/**
 * Residency observation for llama.cpp router gateways. The router keeps at
 * most its configured instance count resident and swaps server-side when a
 * request names a different model, so unlike LM Studio there is nothing for
 * Clio to unload; the failure mode is a swap (a full server-side reload)
 * happening without a trace. This observer reads the router's /v1/models
 * status field ahead of inference, fire-and-forget with a TTL, and records
 * the transition (or double-residency stress) through the same notice
 * channel the VRAM reconciler uses.
 */

export interface LlamaCppResidencyInput {
	/** OpenAI-compatible base URL, e.g. http://host:8080/v1. */
	baseUrl: string;
	targetId: string;
	runtimeId: string;
	keepModelId: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	ttlMs?: number;
	/** Probe timeout; the observer must never stall a turn. */
	timeoutMs?: number;
}

const observedCache = new Map<string, { modelId: string; at: number }>();

interface LlamaCppResidentModel {
	id: string;
	tags: string[];
}

interface LlamaCppRouterProps {
	maxInstances?: number;
}

/** Test-only: clear the TTL cache. */
export function resetLlamaCppResidencyState(): void {
	observedCache.clear();
}

/** Extract resident (loaded or loading) model records from a /v1/models payload. */
export function parseLlamaCppResidentModels(payload: unknown): LlamaCppResidentModel[] {
	if (!payload || typeof payload !== "object") return [];
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	const resident: LlamaCppResidentModel[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { id?: unknown; status?: { value?: unknown }; tags?: unknown };
		const id = record.id;
		const status = record.status;
		const state = status && typeof status === "object" ? (status as { value?: unknown }).value : undefined;
		if (typeof id !== "string" || (state !== "loaded" && state !== "loading")) continue;
		const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
		resident.push({ id, tags });
	}
	return resident;
}

/** Extract resident (loaded or loading) model ids from a /v1/models payload. */
export function parseLlamaCppResident(payload: unknown): string[] {
	return parseLlamaCppResidentModels(payload).map((entry) => entry.id);
}

export function parseLlamaCppRouterProps(payload: unknown): LlamaCppRouterProps {
	if (!payload || typeof payload !== "object") return {};
	const maxInstances = (payload as { max_instances?: unknown }).max_instances;
	return typeof maxInstances === "number" && Number.isFinite(maxInstances) && maxInstances > 0
		? { maxInstances: Math.floor(maxInstances) }
		: {};
}

function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function propsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/props`;
}

async function fetchRouterProps(input: LlamaCppResidencyInput, fetchImpl: typeof fetch): Promise<LlamaCppRouterProps> {
	try {
		const response = await fetchImpl(propsUrl(input.baseUrl), {
			signal: AbortSignal.timeout(input.timeoutMs ?? 1500),
		});
		if (!response.ok) return {};
		return parseLlamaCppRouterProps(await response.json());
	} catch {
		return {};
	}
}

function taggedRole(model: LlamaCppResidentModel): string | null {
	const role = model.tags.find((tag) => tag.startsWith("role:"));
	return role ? role.slice("role:".length) : null;
}

function modelLabel(model: LlamaCppResidentModel): string {
	const role = taggedRole(model);
	return role ? `${model.id} (${role})` : model.id;
}

/**
 * Observe the router's resident set and record a swap or double-residency.
 * Best-effort: any fetch failure or malformed payload is silent, and the
 * whole call is designed to be dispatched fire-and-forget.
 */
export async function observeLlamaCppResidency(input: LlamaCppResidencyInput): Promise<void> {
	const now = input.now ?? Date.now;
	const ttl = input.ttlMs ?? RECONCILE_TTL_MS;
	const key = `llamacpp|${input.baseUrl}`;
	const cached = observedCache.get(key);
	if (cached && cached.modelId === input.keepModelId && now() - cached.at < ttl) return;

	let resident: LlamaCppResidentModel[];
	let fetchImpl: typeof fetch;
	try {
		fetchImpl = input.fetchImpl ?? fetch;
		const response = await fetchImpl(modelsUrl(input.baseUrl), {
			signal: AbortSignal.timeout(input.timeoutMs ?? 1500),
		});
		if (!response.ok) return;
		resident = parseLlamaCppResidentModels(await response.json());
	} catch {
		return;
	}
	observedCache.set(key, { modelId: input.keepModelId, at: now() });

	const keepResident = resident.some((entry) => entry.id === input.keepModelId);
	const others = resident.filter((entry) => entry.id !== input.keepModelId);
	if (others.length === 0) return;
	if (!keepResident) {
		emitResidencyNotice({
			kind: "swap",
			level: "info",
			targetId: input.targetId,
			runtimeId: input.runtimeId,
			model: input.keepModelId,
			message: `'${input.targetId}' router swaps resident '${others.map(modelLabel).join(", ")}' for '${input.keepModelId}' (full server-side reload; recorded transition).`,
			detail: { swappedOut: others.map((entry) => entry.id).join(", ") },
		});
		return;
	}

	const props = await fetchRouterProps(input, fetchImpl);
	const residentCount = resident.length;
	const maxInstances = props.maxInstances;
	const coResidentNames = others.map(modelLabel).join(", ");
	if (maxInstances !== undefined && residentCount <= maxInstances) {
		emitResidencyNotice({
			kind: "co-resident",
			level: "info",
			targetId: input.targetId,
			runtimeId: input.runtimeId,
			model: input.keepModelId,
			message: `'${input.targetId}' has ${residentCount}/${maxInstances} llama.cpp router instances resident (${coResidentNames} alongside '${input.keepModelId}'). Clio allows this but cannot verify remaining VRAM from the router; keep the setup only while weights and KV caches fit in GPU memory.`,
			detail: { residentCount, maxInstances },
		});
		return;
	}

	emitResidencyNotice({
		kind: "stress",
		level: "warning",
		targetId: input.targetId,
		runtimeId: input.runtimeId,
		model: input.keepModelId,
		message: `'${input.targetId}' holds ${coResidentNames} alongside '${input.keepModelId}', and Clio cannot verify enough remaining VRAM. If generation spills to CPU RAM, unload a model, lower context, or move scouts/workers to a different target.`,
		detail: maxInstances === undefined ? { residentCount } : { residentCount, maxInstances },
	});
}
