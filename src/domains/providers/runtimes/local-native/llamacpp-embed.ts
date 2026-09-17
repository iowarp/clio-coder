import type { Api, Model } from "../../../../engine/types.js";

import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EmbedResult } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { synthLocalModel, targetRootUrl, withV1 } from "../common/local-synth.js";
import { probeLlamaCppProps, probeOpenAIModels } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: true,
	rerank: false,
	fim: false,
	contextWindow: 8192,
	maxTokens: 0,
};

function targetUrl(target: TargetDescriptor): string | null {
	return targetRootUrl(target);
}

interface NativeEmbeddingItem {
	index?: number;
	embedding?: number[][] | number[];
}

interface OaiEmbeddingResponse {
	data?: Array<{ embedding?: number[]; index?: number }>;
	model?: string;
	usage?: { prompt_tokens?: number; total_tokens?: number };
}

function meanPool(matrix: number[][]): number[] {
	if (matrix.length === 0) return [];
	const dim = matrix[0]?.length ?? 0;
	const sum = new Array<number>(dim).fill(0);
	for (const row of matrix) {
		for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (row[i] ?? 0);
	}
	return sum.map((v) => v / matrix.length);
}

function flattenNativeEmbedding(entry: NativeEmbeddingItem): number[] {
	const value = entry.embedding;
	if (!value || value.length === 0) return [];
	if (Array.isArray(value[0])) return meanPool(value as number[][]);
	return value as number[];
}

const llamacppEmbedRuntime: RuntimeDescriptor = {
	id: "llamacpp-embed",
	displayName: "llama.cpp (embeddings)",
	kind: "http",
	tier: "local-native",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	hidden: true,
	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = targetUrl(target);
		if (!base) return { ok: false, error: "target has no url" };
		const healthOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal ? probeHttp({ ...healthOpts, signal: ctx.signal }) : probeHttp(healthOpts));
		if (!health.ok) return health;
		const probeResponse = await probeHttp({
			url: `${base}/embedding`,
			method: "POST",
			timeoutMs: ctx.httpTimeoutMs,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "probe" }),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (!probeResponse.ok) {
			return { ok: false, error: `/embedding not available: ${probeResponse.error}` };
		}
		const props = await probeLlamaCppProps(base, ctx, target.defaultModel);
		const result: ProbeResult = { ok: true };
		if (health.latencyMs !== undefined) result.latencyMs = health.latencyMs;
		if (props.discoveredCapabilities) result.discoveredCapabilities = props.discoveredCapabilities;
		if (props.serverVersion) result.serverVersion = props.serverVersion;
		return result;
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = targetUrl(target);
		if (!base) return [];
		return probeOpenAIModels(base, ctx);
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "llamacpp",
			baseUrlForTarget: withV1,
		});
	},
	async embed(target: TargetDescriptor, input: string | string[], ctx: ProbeContext): Promise<EmbedResult> {
		const base = targetUrl(target);
		if (!base) throw new Error("target has no url");
		const modelId = target.defaultModel ?? "default";
		const inputs = Array.isArray(input) ? input : [input];
		const oai = await probeJson<OaiEmbeddingResponse>({
			url: `${base}/v1/embeddings`,
			method: "POST",
			timeoutMs: ctx.httpTimeoutMs,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: inputs, model: modelId, encoding_format: "float" }),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (oai.ok && oai.data && Array.isArray(oai.data.data)) {
			const rows = oai.data.data;
			const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			const vectors = sorted.map((row) => row.embedding ?? []);
			const tokens = oai.data.usage?.total_tokens ?? oai.data.usage?.prompt_tokens ?? undefined;
			const dim = vectors[0]?.length ?? 0;
			const result: EmbedResult = {
				vectors,
				model: oai.data.model ?? modelId,
				dimensions: dim,
			};
			if (tokens !== undefined) result.tokensUsed = tokens;
			return result;
		}
		// Only endpoint-unavailable responses permit trying the native route.
		// Cancellation, transport failures and malformed successes must not
		// submit a second inference request.
		if (oai.status === undefined || ![404, 405, 501].includes(oai.status)) {
			throw new Error(`llama.cpp embedding failed: ${oai.error ?? "invalid OAI embedding response"}`);
		}
		if (ctx.signal?.aborted) throw new Error("llama.cpp embedding failed: aborted by caller");
		const probeOpts = { url: `${base}/embedding`, timeoutMs: ctx.httpTimeoutMs } as const;
		const native = await (ctx.signal
			? probeJson<NativeEmbeddingItem[]>({
					...probeOpts,
					method: "POST",
					body: JSON.stringify({ content: inputs }),
					headers: { "content-type": "application/json" },
					signal: ctx.signal,
				})
			: probeJson<NativeEmbeddingItem[]>({
					...probeOpts,
					method: "POST",
					body: JSON.stringify({ content: inputs }),
					headers: { "content-type": "application/json" },
				}));
		if (!native.ok || !native.data) {
			throw new Error(`llama.cpp embedding failed: ${native.error ?? "unknown"}`);
		}
		const items = native.data;
		items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		const vectors = items.map(flattenNativeEmbedding);
		return {
			vectors,
			model: modelId,
			dimensions: vectors[0]?.length ?? 0,
		};
	},
};

export default llamacppEmbedRuntime;
