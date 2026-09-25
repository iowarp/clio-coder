import { CLIO_MIN_CONTEXT_WINDOW, CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import type { Api, Model } from "../../../../engine/types.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { synthLocalModel, targetRootUrl, withAsIs } from "../common/local-synth.js";
import { ollamaModelIds } from "../common/ollama-model-ids.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: CLIO_MIN_CONTEXT_WINDOW,
	maxTokens: CLIO_MIN_MAX_OUTPUT_TOKENS,
};

interface OllamaTagsResponse {
	models?: Array<{ name?: unknown; details?: { context_length?: unknown } }>;
}

interface OllamaShowResponse {
	model_info?: Record<string, unknown>;
	parameters?: unknown;
}

interface OllamaPsResponse {
	models?: Array<{
		name?: unknown;
		model?: unknown;
		size?: unknown;
		size_vram?: unknown;
		context_length?: unknown;
	}>;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function probeHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers = new Headers(target.auth?.headers);
	const envName = target.auth?.apiKeyEnvVar;
	const token = ctx.authToken ?? (envName && ctx.credentialsPresent.has(envName) ? process.env[envName] : undefined);
	if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
	return Object.fromEntries(headers);
}

/**
 * Resident models reported by `/api/ps`, keyed by wire id. Best-effort: the
 * probe still succeeds on `/api/tags` alone, so an `/api/ps` failure (older
 * server, transient error) simply omits load state rather than failing
 * discovery. Captures the VRAM/total footprint Ollama reports for each, and the
 * window the model is actually loaded at: Ollama serves a resident model at
 * `context_length`, which is routinely far below the model's own maximum
 * (`OLLAMA_CONTEXT_LENGTH`, or the server default), and that smaller number is
 * the one a run has to be planned against.
 */
async function probeResidentModelStates(
	base: string,
	ctx: ProbeContext,
	headers: Record<string, string>,
): Promise<Record<string, ProbeModelStatus> | undefined> {
	const opts = { url: `${base}/api/ps`, headers, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<OllamaPsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OllamaPsResponse>(opts));
	if (!result.ok || !result.data?.models) return undefined;
	const states: Record<string, ProbeModelStatus> = {};
	for (const row of result.data.models) {
		const id = typeof row?.model === "string" ? row.model : typeof row?.name === "string" ? row.name : null;
		if (!id) continue;
		const status: ProbeModelStatus = { state: "loaded" };
		const sizeVram = positiveNumber(row?.size_vram);
		if (sizeVram !== undefined) status.sizeVramBytes = sizeVram;
		const size = positiveNumber(row?.size);
		if (size !== undefined) status.sizeBytes = size;
		const contextLength = positiveNumber(row?.context_length);
		if (contextLength !== undefined) status.contextLength = contextLength;
		for (const alias of ollamaModelIds(id, ...(typeof row.name === "string" ? [row.name] : []))) {
			states[alias] = status;
		}
	}
	return Object.keys(states).length > 0 ? states : undefined;
}

/**
 * The window a model can be opened at, from `/api/show`. `model_info` carries
 * the trained maximum as `<architecture>.context_length`; a `num_ctx` baked
 * into the Modelfile `parameters` caps what Ollama loads it at when a request
 * does not ask for more, so the smaller of the two is the model's window.
 * A target that sends its own `num_ctx` replaces the baked one, so `baked`
 * is false there and only the trained maximum bounds it. Undefined when the
 * server does not report the maximum.
 */
async function probeModelContextWindow(
	base: string,
	model: string,
	ctx: ProbeContext,
	baked: boolean,
	headers: Record<string, string>,
): Promise<number | undefined> {
	const opts = {
		url: `${base}/api/show`,
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ model }),
		timeoutMs: ctx.httpTimeoutMs,
	} as const;
	const result = await (ctx.signal
		? probeJson<OllamaShowResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OllamaShowResponse>(opts));
	const info = result.ok ? result.data?.model_info : undefined;
	if (!info || typeof info !== "object") return undefined;
	const arch = info["general.architecture"];
	const maximum =
		typeof arch === "string"
			? positiveNumber(info[`${arch}.context_length`])
			: positiveNumber(Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1]);
	if (maximum === undefined || !baked) return maximum;
	const params = result.data?.parameters;
	const bakedNumCtx = typeof params === "string" ? /^num_ctx\s+(\d+)\s*$/m.exec(params)?.[1] : undefined;
	const bakedWindow = bakedNumCtx !== undefined ? positiveNumber(Number(bakedNumCtx)) : undefined;
	return bakedWindow !== undefined ? Math.min(maximum, bakedWindow) : maximum;
}

const ollamaRuntime: RuntimeDescriptor = {
	id: "ollama",
	displayName: "Ollama (native)",
	kind: "http",
	tier: "local-native",
	apiFamily: "ollama-native",
	auth: "none",
	defaultCapabilities,
	requestedContextWindow(target: TargetDescriptor): number | undefined {
		return target.ollama?.numCtx;
	},
	coldContextWindowCap: CLIO_MIN_CONTEXT_WINDOW,
	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = targetRootUrl(target);
		if (!base) return { ok: false, error: "target has no url" };
		const headers = probeHeaders(target, ctx);
		const opts = { url: `${base}/api/tags`, headers, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OllamaTagsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OllamaTagsResponse>(opts));
		if (!result.ok) {
			const failed: ProbeResult = { ok: false };
			if (result.error) failed.error = result.error;
			if (result.latencyMs !== undefined) failed.latencyMs = result.latencyMs;
			return failed;
		}
		// The client environment does not describe the daemon's OLLAMA_NUM_PARALLEL.
		// Its API exposes no slot count; maxConcurrentRequests supplies an explicit override.
		const out: ProbeResult = { ok: true, discoveredCapabilities: { parallelSlots: 1 } };
		if (result.latencyMs !== undefined) out.latencyMs = result.latencyMs;
		// The model maximum, which bounds planning when the model is not
		// resident. Newer servers put it on every `/api/tags` row; older ones
		// (0.18.x) do not, so the default model is asked `/api/show` directly.
		const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
		for (const row of result.data?.models ?? []) {
			const window = positiveNumber(row?.details?.context_length);
			if (typeof row?.name === "string" && window !== undefined) modelCapabilities[row.name] = { contextWindow: window };
		}
		const defaultModel = target.defaultModel?.trim();
		const [window, modelStates] = await Promise.all([
			defaultModel
				? probeModelContextWindow(base, defaultModel, ctx, target.ollama?.numCtx === undefined, headers)
				: undefined,
			probeResidentModelStates(base, ctx, headers),
		]);
		if (defaultModel && window !== undefined) modelCapabilities[defaultModel] = { contextWindow: window };
		if (Object.keys(modelCapabilities).length > 0) out.modelCapabilities = modelCapabilities;
		if (modelStates) out.modelStates = modelStates;
		return out;
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = targetRootUrl(target);
		if (!base) return [];
		const opts = { url: `${base}/api/tags`, headers: probeHeaders(target, ctx), timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OllamaTagsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OllamaTagsResponse>(opts));
		if (!result.ok || !result.data?.models) return [];
		return result.data.models
			.map((row) => (typeof row?.name === "string" ? row.name : null))
			.filter((name): name is string => name !== null);
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const canonicalTarget = target.runtime === "ollama" ? target : { ...target, runtime: "ollama" };
		return synthLocalModel({
			target: canonicalTarget,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "ollama-native",
			provider: "ollama",
			baseUrlForTarget: withAsIs,
		});
	},
};

export default ollamaRuntime;
