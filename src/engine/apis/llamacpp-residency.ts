import { emitResidencyNotice, RECONCILE_TTL_MS } from "./residency.js";

/**
 * Residency observation and switching for llama.cpp router gateways. Clio
 * records resident-model swaps for notices, and asks managed routers to load
 * the selected model before inference so model picker changes are real.
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

const LOAD_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

const observedCache = new Map<string, { modelId: string; at: number }>();

type LlamaCppModelState = "loaded" | "loading" | "unloaded" | "failed" | "unknown";

interface LlamaCppResidentModel {
	id: string;
	tags: string[];
}

interface LlamaCppRouterModel extends LlamaCppResidentModel {
	state: LlamaCppModelState;
}

interface LlamaCppRouterProps {
	maxInstances?: number;
}

/** Test-only: clear the TTL cache. */
export function resetLlamaCppResidencyState(): void {
	observedCache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routerModelState(entry: Record<string, unknown>): LlamaCppModelState {
	const status = entry.status;
	const state = isRecord(status) ? status.value : status;
	if (state === "loaded" || state === "loading" || state === "unloaded" || state === "failed") return state;
	return "unknown";
}

function parseRouterModels(payload: unknown): LlamaCppRouterModel[] {
	if (!isRecord(payload)) return [];
	const data = payload.data;
	if (!Array.isArray(data)) return [];
	const models: LlamaCppRouterModel[] = [];
	for (const entry of data) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
		models.push({ id: entry.id, state: routerModelState(entry), tags });
	}
	return models;
}

function residentModel(model: LlamaCppRouterModel): boolean {
	return model.state === "loaded" || model.state === "loading";
}

/** Extract resident (loaded or loading) model records from a /v1/models payload. */
export function parseLlamaCppResidentModels(payload: unknown): LlamaCppResidentModel[] {
	return parseRouterModels(payload)
		.filter(residentModel)
		.map((entry) => ({ id: entry.id, tags: entry.tags }));
}

/** Extract resident (loaded or loading) model ids from a /v1/models payload. */
export function parseLlamaCppResident(payload: unknown): string[] {
	return parseLlamaCppResidentModels(payload).map((entry) => entry.id);
}

export function parseLlamaCppRouterProps(payload: unknown): LlamaCppRouterProps {
	if (!isRecord(payload)) return {};
	const maxInstances = payload.max_instances;
	return typeof maxInstances === "number" && Number.isFinite(maxInstances) && maxInstances > 0
		? { maxInstances: Math.floor(maxInstances) }
		: {};
}

function rootUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function propsUrl(baseUrl: string): string {
	return `${rootUrl(baseUrl)}/props`;
}

function loadUrl(baseUrl: string): string {
	return `${rootUrl(baseUrl)}/models/load`;
}

function unloadUrl(baseUrl: string): string {
	return `${rootUrl(baseUrl)}/models/unload`;
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

async function fetchRouterModels(
	input: LlamaCppResidencyInput,
	fetchImpl: typeof fetch,
): Promise<LlamaCppRouterModel[]> {
	const response = await fetchImpl(modelsUrl(input.baseUrl), {
		signal: AbortSignal.timeout(input.timeoutMs ?? 1500),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return parseRouterModels(await response.json());
}

async function postRouterModel(fetchImpl: typeof fetch, url: string, modelId: string): Promise<void> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: modelId }),
		signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
	});
	if (response.ok) return;
	throw new Error(`llama.cpp router rejected ${url}: HTTP ${response.status}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoaded(
	input: LlamaCppResidencyInput,
	fetchImpl: typeof fetch,
	modelId: string,
): Promise<LlamaCppRouterModel[]> {
	const started = Date.now();
	while (Date.now() - started < LOAD_TIMEOUT_MS) {
		const models = await fetchRouterModels(input, fetchImpl);
		const model = models.find((entry) => entry.id === modelId);
		if (model?.state === "loaded") return models;
		if (model?.state === "failed") throw new Error(`llama.cpp router reports '${modelId}' failed to load`);
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`timed out waiting for '${modelId}' to load`);
}

function taggedRole(model: LlamaCppResidentModel): string | null {
	const role = model.tags.find((tag) => tag.startsWith("role:"));
	return role ? role.slice("role:".length) : null;
}

function modelLabel(model: LlamaCppResidentModel): string {
	const role = taggedRole(model);
	return role ? `${model.id} (${role})` : model.id;
}

function protectedResident(model: LlamaCppResidentModel): boolean {
	return model.tags.includes("pinned:true") || taggedRole(model) === "scout";
}

function emitManagedSwap(input: LlamaCppResidencyInput, evicted: ReadonlyArray<LlamaCppResidentModel>): void {
	emitResidencyNotice({
		kind: "swap",
		level: "info",
		targetId: input.targetId,
		runtimeId: input.runtimeId,
		model: input.keepModelId,
		message: `'${input.targetId}' unloads resident '${evicted.map(modelLabel).join(", ")}' before loading '${input.keepModelId}' on the llama.cpp router.`,
		detail: { swappedOut: evicted.map((entry) => entry.id).join(", ") },
	});
}

async function restoreProtectedResidents(
	input: LlamaCppResidencyInput,
	fetchImpl: typeof fetch,
	protectedModels: ReadonlyArray<LlamaCppResidentModel>,
): Promise<void> {
	if (protectedModels.length === 0) return;
	const current = await fetchRouterModels(input, fetchImpl);
	let changed = false;
	for (const model of protectedModels) {
		const state = current.find((entry) => entry.id === model.id)?.state;
		if (state === "loaded") continue;
		changed = true;
		if (state !== "loading") await postRouterModel(fetchImpl, loadUrl(input.baseUrl), model.id);
		await waitForLoaded(input, fetchImpl, model.id);
	}
	if (!changed) return;
	const finalModels = await fetchRouterModels(input, fetchImpl);
	const keep = finalModels.find((entry) => entry.id === input.keepModelId);
	if (keep?.state !== "loaded") throw new Error(`protected-resident restore displaced '${input.keepModelId}'`);
}

/** Ensure the selected llama.cpp router model is resident before inference. */
export async function ensureLlamaCppResidency(input: LlamaCppResidencyInput): Promise<void> {
	const fetchImpl = input.fetchImpl ?? fetch;
	let models: LlamaCppRouterModel[];
	try {
		models = await fetchRouterModels(input, fetchImpl);
	} catch {
		return;
	}
	if (!models.some((entry) => entry.state !== "unknown")) return;

	const protectedModels = models.filter((entry) => entry.id !== input.keepModelId && protectedResident(entry));
	const evict = models.filter(
		(entry) => residentModel(entry) && entry.id !== input.keepModelId && !protectedResident(entry),
	);
	if (evict.length > 0) emitManagedSwap(input, evict);

	for (const model of evict) {
		await postRouterModel(fetchImpl, unloadUrl(input.baseUrl), model.id);
	}

	const selected = models.find((entry) => entry.id === input.keepModelId);
	if (selected?.state !== "loaded") {
		if (selected?.state !== "loading") await postRouterModel(fetchImpl, loadUrl(input.baseUrl), input.keepModelId);
		await waitForLoaded(input, fetchImpl, input.keepModelId);
	}

	await restoreProtectedResidents(input, fetchImpl, protectedModels);
	const now = input.now ?? Date.now;
	observedCache.set(`llamacpp|${input.baseUrl}`, { modelId: input.keepModelId, at: now() });
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
