import type { Api, Model } from "@mariozechner/pi-ai";

import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withAsIs } from "../common/local-synth.js";
import { probeLlamaCppProps } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
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

function url(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}

const llamacppAnthropicRuntime: RuntimeDescriptor = {
	id: "llamacpp-anthropic",
	displayName: "llama.cpp (Anthropic-compat)",
	kind: "http",
	tier: "local-native",
	apiFamily: "anthropic-messages",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = url(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		const healthOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal ? probeHttp({ ...healthOpts, signal: ctx.signal }) : probeHttp(healthOpts));
		if (!health.ok) return health;
		const headOpts = {
			url: `${base}/v1/messages`,
			method: "HEAD" as const,
			timeoutMs: ctx.httpTimeoutMs,
		};
		const head = await (ctx.signal ? probeHttp({ ...headOpts, signal: ctx.signal }) : probeHttp(headOpts));
		if (!head.ok) return head;
		const props = await probeLlamaCppProps(base, ctx);
		const enriched: ProbeResult = { ...head };
		if (props.discoveredCapabilities) enriched.discoveredCapabilities = props.discoveredCapabilities;
		if (props.serverVersion) enriched.serverVersion = props.serverVersion;
		return enriched;
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = url(endpoint);
		if (!base) return [];
		const opts = { url: `${base}/v1/models`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OpenAIModelsResponse>(opts));
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
			apiFamily: "anthropic-messages",
			provider: "llamacpp",
			baseUrlForEndpoint: withAsIs,
		});
	},
};

export default llamacppAnthropicRuntime;
