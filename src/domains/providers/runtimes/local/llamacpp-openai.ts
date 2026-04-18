import type { Api, Model } from "@mariozechner/pi-ai";

import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withV1 } from "../common/local-synth.js";
import { probeLlamaCppProps } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: true,
	contextWindow: 8192,
	maxTokens: 4096,
};

interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown }>;
}

function endpointUrl(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}

const llamacppOpenaiRuntime: RuntimeDescriptor = {
	id: "llamacpp",
	displayName: "llama.cpp (OpenAI-compat)",
	kind: "http",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointUrl(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		const probeOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal ? probeHttp({ ...probeOpts, signal: ctx.signal }) : probeHttp(probeOpts));
		if (!health.ok) return health;
		const props = await probeLlamaCppProps(base, ctx);
		const enriched: ProbeResult = { ...health };
		if (props.discoveredCapabilities) enriched.discoveredCapabilities = props.discoveredCapabilities;
		if (props.serverVersion) enriched.serverVersion = props.serverVersion;
		return enriched;
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = endpointUrl(endpoint);
		if (!base) return [];
		const probeOpts = { url: `${base}/v1/models`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OpenAIModelsResponse>({ ...probeOpts, signal: ctx.signal })
			: probeJson<OpenAIModelsResponse>(probeOpts));
		if (!result.ok || !result.data?.data) return [];
		return result.data.data
			.map((row) => (typeof row?.id === "string" ? row.id : null))
			.filter((id): id is string => id !== null);
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
};

export default llamacppOpenaiRuntime;
