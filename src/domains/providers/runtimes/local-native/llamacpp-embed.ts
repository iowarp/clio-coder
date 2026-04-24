import type { Api, Model } from "@mariozechner/pi-ai";

import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { EmbedResult } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withV1 } from "../common/local-synth.js";
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

function endpointUrl(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
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

async function postJson<T>(
	url: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<{ status: number; data: T | null }> {
	const init: RequestInit = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
	if (signal) init.signal = signal;
	const response = await fetch(url, init);
	if (!response.ok) return { status: response.status, data: null };
	try {
		const data = (await response.json()) as T;
		return { status: response.status, data };
	} catch {
		return { status: response.status, data: null };
	}
}

const llamacppEmbedRuntime: RuntimeDescriptor = {
	id: "llamacpp-embed",
	displayName: "llama.cpp (embeddings)",
	kind: "http",
	tier: "local-native",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointUrl(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		const healthOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal ? probeHttp({ ...healthOpts, signal: ctx.signal }) : probeHttp(healthOpts));
		if (!health.ok) return health;
		const probeResponse = await fetch(`${base}/embedding`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "probe" }),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		}).catch((err) => {
			return new Response(null, { status: 599, statusText: String(err) });
		});
		if (!probeResponse.ok) {
			return { ok: false, error: `/embedding not available: HTTP ${probeResponse.status}` };
		}
		const props = await probeLlamaCppProps(base, ctx);
		const result: ProbeResult = { ok: true };
		if (health.latencyMs !== undefined) result.latencyMs = health.latencyMs;
		if (props.discoveredCapabilities) result.discoveredCapabilities = props.discoveredCapabilities;
		if (props.serverVersion) result.serverVersion = props.serverVersion;
		return result;
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = endpointUrl(endpoint);
		if (!base) return [];
		return probeOpenAIModels(base, ctx);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "llamacpp",
			baseUrlForEndpoint: withV1,
		});
	},
	async embed(endpoint: EndpointDescriptor, input: string | string[], ctx: ProbeContext): Promise<EmbedResult> {
		const base = endpointUrl(endpoint);
		if (!base) throw new Error("endpoint has no url");
		const modelId = endpoint.defaultModel ?? "default";
		const inputs = Array.isArray(input) ? input : [input];
		const oai = await postJson<OaiEmbeddingResponse>(
			`${base}/v1/embeddings`,
			{ input: inputs, model: modelId, encoding_format: "float" },
			ctx.signal,
		);
		if (oai.data && Array.isArray(oai.data.data)) {
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
