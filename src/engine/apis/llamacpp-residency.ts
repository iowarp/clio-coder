import { performance } from "node:perf_hooks";
import { sleep } from "../../core/timers.js";
import {
	type ResidencyAdapter,
	ResidencyPreconditionError,
	reconcileResidency,
	resetResidencyState,
	residencyManaged,
	residentTagProtected,
} from "./residency.js";

/**
 * llama.cpp router adapter for the shared residency reconciler
 * (residency.ts). The router is a multi-model server: `/v1/models` reports
 * per-model load state and tags, `/props` advertises `max_instances`, and
 * models load/unload through explicit POSTs. This module maps that surface
 * onto the reconciler's "router" strategy so co-residency, capacity math,
 * protection tiers, opt-outs, TTL dedupe, and the cross-process lock all come
 * from the one shared policy. Plain llama-server builds without router load
 * states are never managed.
 */

export interface LlamaCppResidencyInput {
	/** OpenAI-compatible base URL, e.g. http://host:8080/v1. */
	baseUrl: string;
	targetId: string;
	runtimeId: string;
	keepModelId: string;
	/**
	 * Combined env + target lifecycle opt-out verdict from the caller
	 * (residencyManagedFor). Defaults to the env-only switch.
	 */
	managed?: boolean;
	fetchImpl?: typeof fetch;
	now?: () => number;
	ttlMs?: number;
	/** Probe timeout; a residency probe must never stall a turn. */
	timeoutMs?: number;
	/** Test-only override for the cross-process mutation lock. */
	withLock?<T>(targetKey: string, fn: () => Promise<T>): Promise<T>;
}

const LOAD_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

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

/** Test-only: clear the reconciler's TTL cache and Clio-loaded registry. */
export function resetLlamaCppResidencyState(): void {
	resetResidencyState();
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

async function waitForLoaded(input: LlamaCppResidencyInput, fetchImpl: typeof fetch, modelId: string): Promise<void> {
	const started = performance.now();
	while (performance.now() - started < LOAD_TIMEOUT_MS) {
		const models = await fetchRouterModels(input, fetchImpl);
		const model = models.find((entry) => entry.id === modelId);
		if (model?.state === "loaded") return;
		if (model?.state === "failed") throw new Error(`llama.cpp router reports '${modelId}' failed to load`);
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`timed out waiting for '${modelId}' to load`);
}

async function ensureModelLoaded(
	input: LlamaCppResidencyInput,
	fetchImpl: typeof fetch,
	modelId: string,
	knownState: LlamaCppModelState | undefined,
): Promise<void> {
	if (knownState === "loaded") return;
	if (knownState !== "loading") await postRouterModel(fetchImpl, loadUrl(input.baseUrl), modelId);
	await waitForLoaded(input, fetchImpl, modelId);
}

/**
 * A router whose capacity Clio could not read may satisfy a load by
 * displacing an LRU resident. Reload any tag-pinned resident the load
 * displaced (one bounded pass), then verify the restore did not displace the
 * keep model in turn.
 */
async function restoreDisplacedPinned(
	input: LlamaCppResidencyInput,
	fetchImpl: typeof fetch,
	before: ReadonlyArray<LlamaCppRouterModel>,
): Promise<void> {
	const pinned = before.filter(
		(entry) => residentModel(entry) && entry.id !== input.keepModelId && residentTagProtected(entry.tags),
	);
	if (pinned.length === 0) return;
	const current = await fetchRouterModels(input, fetchImpl);
	let changed = false;
	for (const model of pinned) {
		const state = current.find((entry) => entry.id === model.id)?.state;
		if (state === "loaded") continue;
		changed = true;
		await ensureModelLoaded(input, fetchImpl, model.id, state);
	}
	if (!changed) return;
	const finalModels = await fetchRouterModels(input, fetchImpl);
	const keep = finalModels.find((entry) => entry.id === input.keepModelId);
	if (keep?.state !== "loaded") throw new Error(`pinned-resident restore displaced '${input.keepModelId}'`);
}

/** Ensure the selected llama.cpp router model is resident before inference. */
export async function ensureLlamaCppResidency(input: LlamaCppResidencyInput): Promise<void> {
	const fetchImpl = input.fetchImpl ?? fetch;
	let snapshot: LlamaCppRouterModel[] = [];
	const adapter: ResidencyAdapter = {
		targetKey: `llamacpp|${input.baseUrl}`,
		targetId: input.targetId,
		runtimeId: input.runtimeId,
		keepModelId: input.keepModelId,
		managed: input.managed ?? residencyManaged(),
		strategy: "router",
		listResident: async () => {
			const models = await fetchRouterModels(input, fetchImpl);
			if (!models.some((entry) => entry.state !== "unknown")) {
				throw new Error("not a llama.cpp router: /v1/models reports no load states");
			}
			snapshot = models;
			return models.filter(residentModel).map((entry) => ({ modelId: entry.id, tags: entry.tags }));
		},
		// The router enumerates every configured preset, resident or not, so a keep
		// model missing from that listing is one this server cannot load at all.
		// Reported from the snapshot listResident already fetched, so the check
		// costs no extra round trip.
		assertLoadable: async () => {
			if (snapshot.some((entry) => entry.id === input.keepModelId)) return;
			throw new ResidencyPreconditionError(
				`llama.cpp router on '${input.targetId}' does not serve '${input.keepModelId}'; it lists ${snapshot.length} model(s). Residency left the target untouched. Fix the wire model id in settings, or add the preset to the server.`,
			);
		},
		capacity: async () => (await fetchRouterProps(input, fetchImpl)).maxInstances,
		keepModelTags: async () => snapshot.find((entry) => entry.id === input.keepModelId)?.tags,
		unload: (modelId) => postRouterModel(fetchImpl, unloadUrl(input.baseUrl), modelId),
		load: async (modelId) => {
			const state = snapshot.find((entry) => entry.id === modelId)?.state;
			if (state === "loaded") return;
			await ensureModelLoaded(input, fetchImpl, modelId, state);
			await restoreDisplacedPinned(input, fetchImpl, snapshot);
		},
	};
	if (input.withLock) adapter.withLock = input.withLock;
	if (input.now) adapter.now = input.now;
	if (input.ttlMs !== undefined) adapter.ttlMs = input.ttlMs;
	await reconcileResidency(adapter);
}
