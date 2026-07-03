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

/** Test-only: clear the TTL cache. */
export function resetLlamaCppResidencyState(): void {
	observedCache.clear();
}

/** Extract resident (loaded or loading) model ids from a /v1/models payload. */
export function parseLlamaCppResident(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	const resident: string[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const id = (entry as { id?: unknown }).id;
		const status = (entry as { status?: { value?: unknown } }).status;
		const state = status && typeof status === "object" ? (status as { value?: unknown }).value : undefined;
		if (typeof id === "string" && (state === "loaded" || state === "loading")) resident.push(id);
	}
	return resident;
}

function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
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

	let resident: string[];
	try {
		const fetchImpl = input.fetchImpl ?? fetch;
		const response = await fetchImpl(modelsUrl(input.baseUrl), {
			signal: AbortSignal.timeout(input.timeoutMs ?? 1500),
		});
		if (!response.ok) return;
		resident = parseLlamaCppResident(await response.json());
	} catch {
		return;
	}
	observedCache.set(key, { modelId: input.keepModelId, at: now() });

	const keepResident = resident.includes(input.keepModelId);
	const others = resident.filter((id) => id !== input.keepModelId);
	if (others.length === 0) return;
	if (!keepResident) {
		emitResidencyNotice({
			kind: "swap",
			level: "info",
			targetId: input.targetId,
			runtimeId: input.runtimeId,
			model: input.keepModelId,
			message: `'${input.targetId}' router swaps resident '${others.join(", ")}' for '${input.keepModelId}' (full server-side reload; recorded transition).`,
			detail: { swappedOut: others.join(", ") },
		});
		return;
	}
	emitResidencyNotice({
		kind: "stress",
		level: "warning",
		targetId: input.targetId,
		runtimeId: input.runtimeId,
		model: input.keepModelId,
		message: `'${input.targetId}' holds ${others.join(", ")} alongside '${input.keepModelId}'; expect degraded generation until one is unloaded.`,
		detail: { residentCount: resident.length },
	});
}
