import type { Api, Model } from "@mariozechner/pi-ai";

import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withV1 } from "../common/local-synth.js";
import type { OpenAIModelsResponse } from "../common/probe-helpers.js";

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

async function fetchModels(base: string, ctx: ProbeContext): Promise<string[]> {
	for (const path of ["/api/v0/models", "/v1/models"]) {
		const opts = { url: `${base}${path}`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OpenAIModelsResponse>(opts));
		if (result.ok && result.data?.data) {
			return result.data.data
				.map((row) => (typeof row?.id === "string" ? row.id : null))
				.filter((id): id is string => id !== null);
		}
	}
	return [];
}

const lmstudioRuntime: RuntimeDescriptor = {
	id: "lmstudio",
	displayName: "LM Studio",
	kind: "http",
	apiFamily: "openai-completions",
	auth: "none",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointBase(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		for (const path of ["/api/v0/models", "/v1/models"]) {
			const opts = { url: `${base}${path}`, timeoutMs: ctx.httpTimeoutMs } as const;
			const result = await (ctx.signal
				? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
				: probeJson<OpenAIModelsResponse>(opts));
			if (result.ok) {
				const out: ProbeResult = { ok: true };
				if (result.latencyMs !== undefined) out.latencyMs = result.latencyMs;
				return out;
			}
		}
		return { ok: false, error: "lmstudio model list unreachable" };
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = endpointBase(endpoint);
		if (!base) return [];
		return fetchModels(base, ctx);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "lmstudio",
			baseUrlForEndpoint: withV1,
		});
	},
};

export default lmstudioRuntime;
