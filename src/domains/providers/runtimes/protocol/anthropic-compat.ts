import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type {
	ProbeContext,
	ProbeResult,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeTier,
} from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withAsIs } from "../common/local-synth.js";
import { probeOpenAIModels, probeUrl } from "../common/probe-helpers.js";

export interface AnthropicCompatSpec {
	id: string;
	displayName: string;
	provider: string;
	auth: RuntimeAuth;
	tier: RuntimeTier;
	defaultCapabilities: CapabilityFlags;
	hidden?: boolean;
	messagesPath?: string;
	modelsPath?: string;
}

export interface AnthropicCompatSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	provider: string;
	baseUrlForEndpoint?: (endpointUrl: string) => string;
}

export function synthesizeAnthropicCompatModel(input: AnthropicCompatSynthesisInput): Model<Api> {
	return synthLocalModel({
		endpoint: input.endpoint,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		apiFamily: "anthropic-messages",
		provider: input.provider,
		baseUrlForEndpoint: input.baseUrlForEndpoint ?? withAsIs,
	});
}

export function makeAnthropicCompatRuntime(spec: AnthropicCompatSpec): RuntimeDescriptor {
	const messagesPath = spec.messagesPath ?? "/v1/messages";
	const modelsPath = spec.modelsPath ?? "/v1/models";
	return {
		id: spec.id,
		displayName: spec.displayName,
		kind: "http",
		tier: spec.tier,
		apiFamily: "anthropic-messages",
		auth: spec.auth,
		defaultCapabilities: spec.defaultCapabilities,
		...(spec.hidden === true ? { hidden: true } : {}),
		async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
			const base = endpointBase(endpoint);
			if (!base) return { ok: false, error: "endpoint has no url" };
			return probeUrl(`${base}${messagesPath}`, ctx, "HEAD");
		},
		async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
			const base = endpointBase(endpoint);
			if (!base) return [];
			return probeOpenAIModels(base, ctx, modelsPath);
		},
		synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
			return synthesizeAnthropicCompatModel({
				endpoint,
				wireModelId,
				kb,
				defaultCapabilities: spec.defaultCapabilities,
				provider: spec.provider,
			});
		},
	};
}

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

export default makeAnthropicCompatRuntime({
	id: "anthropic-compat",
	displayName: "Generic Anthropic-compatible",
	provider: "anthropic-compat",
	auth: "api-key",
	tier: "protocol",
	defaultCapabilities,
});
