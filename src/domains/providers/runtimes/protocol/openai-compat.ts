import type { Api, Model } from "@mariozechner/pi-ai";

import { probeOpenAICompatReasoning } from "../../probe/reasoning.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type {
	ProbeContext,
	ProbeResult,
	ReasoningProbeResult,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeTier,
} from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withAsIs, withV1 } from "../common/local-synth.js";
import { probeOpenAIModels, probeUrl } from "../common/probe-helpers.js";

export interface OpenAICompatSpec {
	id: string;
	displayName: string;
	provider: string;
	auth: RuntimeAuth;
	tier: RuntimeTier;
	defaultCapabilities: CapabilityFlags;
	healthPath?: string;
	modelsPath?: string;
	apiFamily?: RuntimeApiFamily;
	baseUrlStyle?: "v1" | "asIs";
}

export interface OpenAICompatSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	apiFamily?: RuntimeApiFamily;
	provider: string;
	baseUrlForEndpoint?: (endpointUrl: string) => string;
}

export function synthesizeOpenAICompatModel(input: OpenAICompatSynthesisInput): Model<Api> {
	return synthLocalModel({
		endpoint: input.endpoint,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		apiFamily: input.apiFamily ?? "openai-completions",
		provider: input.provider,
		baseUrlForEndpoint: input.baseUrlForEndpoint ?? withV1,
	});
}

export function makeOpenAICompatRuntime(spec: OpenAICompatSpec): RuntimeDescriptor {
	const apiFamily = spec.apiFamily ?? "openai-completions";
	const baseUrlForEndpoint = spec.baseUrlStyle === "asIs" ? withAsIs : withV1;
	const healthPath = spec.healthPath ?? "/v1/models";
	const modelsPath = spec.modelsPath ?? "/v1/models";
	return {
		id: spec.id,
		displayName: spec.displayName,
		kind: "http",
		tier: spec.tier,
		apiFamily,
		auth: spec.auth,
		defaultCapabilities: spec.defaultCapabilities,
		async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
			const base = endpointBase(endpoint);
			if (!base) return { ok: false, error: "endpoint has no url" };
			return probeUrl(`${base}${healthPath}`, ctx);
		},
		async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
			const base = endpointBase(endpoint);
			if (!base) return [];
			if (modelsPath === "/v1/models") return probeOpenAIModels(base, ctx);
			return probeOpenAIModels(base, ctx);
		},
		async probeReasoning(
			endpoint: EndpointDescriptor,
			modelId: string,
			ctx: ProbeContext,
		): Promise<ReasoningProbeResult> {
			const base = endpointBase(endpoint);
			if (!base) return { reasoning: false, latencyMs: 0, error: "endpoint has no url" };
			const apiKeyEnv = endpoint.auth?.apiKeyEnvVar;
			const apiKey = apiKeyEnv && ctx.credentialsPresent.has(apiKeyEnv) ? process.env[apiKeyEnv] : undefined;
			const probeOpts: Parameters<typeof probeOpenAICompatReasoning>[0] = {
				baseUrl: base,
				modelId,
				timeoutMs: Math.max(ctx.httpTimeoutMs, 8000),
			};
			if (apiKey) probeOpts.apiKey = apiKey;
			if (ctx.signal) probeOpts.signal = ctx.signal;
			return probeOpenAICompatReasoning(probeOpts);
		},
		synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
			return synthesizeOpenAICompatModel({
				endpoint,
				wireModelId,
				kb,
				defaultCapabilities: spec.defaultCapabilities,
				apiFamily,
				provider: spec.provider,
				baseUrlForEndpoint,
			});
		},
	};
}

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

export default makeOpenAICompatRuntime({
	id: "openai-compat",
	displayName: "Generic OpenAI-compatible",
	provider: "openai-compat",
	auth: "api-key",
	tier: "protocol",
	defaultCapabilities,
});
