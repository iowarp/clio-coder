import type { Api, Model } from "@mariozechner/pi-ai";

import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { RerankResult } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type {
	ProbeContext,
	ProbeResult,
	RuntimeDescriptor,
} from "../../types/runtime-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withV1 } from "../common/local-synth.js";
import { probeLlamaCppProps, probeOpenAIModels } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: true,
	fim: false,
	contextWindow: 8192,
	maxTokens: 0,
};

function endpointUrl(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}

interface JinaRerankResponse {
	model?: string;
	results?: Array<{
		index?: number;
		relevance_score?: number;
		document?: { text?: string } | string;
	}>;
}

const llamacppRerankRuntime: RuntimeDescriptor = {
	id: "llamacpp-rerank",
	displayName: "llama.cpp (rerank)",
	kind: "http",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointUrl(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		const healthOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal
			? probeHttp({ ...healthOpts, signal: ctx.signal })
			: probeHttp(healthOpts));
		if (!health.ok) return health;
		const modelId = endpoint.defaultModel ?? "default";
		const probeResponse = await fetch(`${base}/reranking`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "probe", documents: ["a"], model: modelId }),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		}).catch((err) => new Response(null, { status: 599, statusText: String(err) }));
		if (!(probeResponse.status === 200 || probeResponse.status === 202)) {
			return { ok: false, error: `/reranking not available: HTTP ${probeResponse.status}` };
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
	synthesizeModel(
		endpoint: EndpointDescriptor,
		wireModelId: string,
		kb: KnowledgeBaseHit | null,
	): Model<Api> {
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
	async rerank(
		endpoint: EndpointDescriptor,
		query: string,
		documents: string[],
		ctx: ProbeContext,
	): Promise<RerankResult> {
		const base = endpointUrl(endpoint);
		if (!base) throw new Error("endpoint has no url");
		const modelId = endpoint.defaultModel ?? "default";
		const req = {
			url: `${base}/reranking`,
			method: "POST" as const,
			timeoutMs: ctx.httpTimeoutMs,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query,
				documents,
				top_n: documents.length,
				model: modelId,
			}),
		};
		const result = await (ctx.signal
			? probeJson<JinaRerankResponse>({ ...req, signal: ctx.signal })
			: probeJson<JinaRerankResponse>(req));
		if (!result.ok || !result.data) {
			throw new Error(`llama.cpp rerank failed: ${result.error ?? "unknown"}`);
		}
		const rows = result.data.results ?? [];
		const items = rows.map((row) => {
			const idx = typeof row.index === "number" ? row.index : 0;
			const score = typeof row.relevance_score === "number" ? row.relevance_score : 0;
			const doc =
				typeof row.document === "string"
					? row.document
					: typeof row.document?.text === "string"
						? row.document.text
						: undefined;
			const item: RerankResult["items"][number] = { index: idx, score };
			if (doc !== undefined) item.document = doc;
			return item;
		});
		return { items, model: result.data.model ?? modelId };
	},
};

export default llamacppRerankRuntime;
