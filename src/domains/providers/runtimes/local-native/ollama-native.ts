import type { Api, Model } from "@earendil-works/pi-ai";

import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { synthLocalModel, targetBaseUrl, withAsIs } from "../common/local-synth.js";

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
	contextWindow: 8192,
	maxTokens: 4096,
};

interface OllamaTagsResponse {
	models?: Array<{ name?: unknown }>;
}

interface OllamaPsResponse {
	models?: Array<{ name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown }>;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resident models reported by `/api/ps`, keyed by wire id. Best-effort: the
 * probe still succeeds on `/api/tags` alone, so an `/api/ps` failure (older
 * server, transient error) simply omits load state rather than failing
 * discovery. Captures the VRAM/total footprint Ollama reports for each.
 */
async function probeResidentModelStates(
	base: string,
	ctx: ProbeContext,
): Promise<Record<string, ProbeModelStatus> | undefined> {
	const opts = { url: `${base}/api/ps`, timeoutMs: ctx.httpTimeoutMs } as const;
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
		states[id] = status;
	}
	return Object.keys(states).length > 0 ? states : undefined;
}

const ollamaNativeRuntime: RuntimeDescriptor = {
	id: "ollama-native",
	displayName: "Ollama (native)",
	kind: "http",
	tier: "local-native",
	apiFamily: "ollama-native",
	auth: "none",
	defaultCapabilities,
	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = targetBaseUrl(target);
		if (!base) return { ok: false, error: "target has no url" };
		const opts = { url: `${base}/api/tags`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OllamaTagsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OllamaTagsResponse>(opts));
		if (!result.ok) {
			const failed: ProbeResult = { ok: false };
			if (result.error) failed.error = result.error;
			if (result.latencyMs !== undefined) failed.latencyMs = result.latencyMs;
			return failed;
		}
		const out: ProbeResult = { ok: true };
		if (result.latencyMs !== undefined) out.latencyMs = result.latencyMs;
		const modelStates = await probeResidentModelStates(base, ctx);
		if (modelStates) out.modelStates = modelStates;
		return out;
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = targetBaseUrl(target);
		if (!base) return [];
		const opts = { url: `${base}/api/tags`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OllamaTagsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OllamaTagsResponse>(opts));
		if (!result.ok || !result.data?.models) return [];
		return result.data.models
			.map((row) => (typeof row?.name === "string" ? row.name : null))
			.filter((name): name is string => name !== null);
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "ollama-native",
			provider: "ollama",
			baseUrlForTarget: withAsIs,
		});
	},
};

export default ollamaNativeRuntime;
