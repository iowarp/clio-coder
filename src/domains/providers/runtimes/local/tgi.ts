import type { Api, Model } from "@mariozechner/pi-ai";

import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withV1 } from "../common/local-synth.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 8192,
	maxTokens: 4096,
};

interface TgiInfoResponse {
	model_id?: unknown;
}

const tgiRuntime: RuntimeDescriptor = {
	id: "tgi",
	displayName: "Text Generation Inference",
	kind: "http",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointBase(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		const opts = { url: `${base}/info`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<TgiInfoResponse>({ ...opts, signal: ctx.signal })
			: probeJson<TgiInfoResponse>(opts));
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
		const opts = { url: `${base}/info`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<TgiInfoResponse>({ ...opts, signal: ctx.signal })
			: probeJson<TgiInfoResponse>(opts));
		if (!result.ok || typeof result.data?.model_id !== "string") return [];
		return [result.data.model_id];
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "tgi",
			baseUrlForEndpoint: withV1,
		});
	},
};

export default tgiRuntime;
