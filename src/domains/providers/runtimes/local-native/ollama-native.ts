import type { Api, Model } from "@mariozechner/pi-ai";

import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withAsIs } from "../common/local-synth.js";

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

const ollamaNativeRuntime: RuntimeDescriptor = {
	id: "ollama-native",
	displayName: "Ollama (native)",
	kind: "http",
	tier: "local-native",
	apiFamily: "ollama-native",
	auth: "none",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointBase(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
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
		return out;
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = endpointBase(endpoint);
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
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "ollama-native",
			provider: "ollama",
			baseUrlForEndpoint: withAsIs,
		});
	},
};

export default ollamaNativeRuntime;
