import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withAsIs } from "../common/local-synth.js";
import { probeOpenAIModels, probeUrl } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 8192,
	maxTokens: 4096,
};

const lemonadeAnthropicRuntime: RuntimeDescriptor = {
	id: "lemonade-anthropic",
	displayName: "Lemonade (Anthropic-compat)",
	kind: "http",
	tier: "local-native",
	apiFamily: "anthropic-messages",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointBase(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		return probeUrl(`${base}/v1/messages`, ctx, "HEAD");
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = endpointBase(endpoint);
		if (!base) return [];
		return probeOpenAIModels(base, ctx);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "anthropic-messages",
			provider: "lemonade",
			baseUrlForEndpoint: withAsIs,
		});
	},
};

export default lemonadeAnthropicRuntime;
