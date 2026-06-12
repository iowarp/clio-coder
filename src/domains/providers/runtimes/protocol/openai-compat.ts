import type { Api, Model } from "@earendil-works/pi-ai";

import { probeOpenAICompatReasoning } from "../../probe/reasoning.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
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
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { synthLocalModel, targetBaseUrl, withAsIs, withV1 } from "../common/local-synth.js";
import { probeOpenAIModelCatalog, probeOpenAIModels, probeUrl } from "../common/probe-helpers.js";

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
	target: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	apiFamily?: RuntimeApiFamily;
	provider: string;
	baseUrlForTarget?: (targetUrl: string) => string;
}

export function synthesizeOpenAICompatModel(input: OpenAICompatSynthesisInput): Model<Api> {
	return synthLocalModel({
		target: input.target,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		apiFamily: input.apiFamily ?? "openai-completions",
		provider: input.provider,
		baseUrlForTarget: input.baseUrlForTarget ?? withV1,
	});
}

export function makeOpenAICompatRuntime(spec: OpenAICompatSpec): RuntimeDescriptor {
	const apiFamily = spec.apiFamily ?? "openai-completions";
	const baseUrlForTarget = spec.baseUrlStyle === "asIs" ? withAsIs : withV1;
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
		async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
			const base = targetBaseUrl(target);
			if (!base) return { ok: false, error: "target has no url" };
			const health = await probeUrl(`${base}${healthPath}`, ctx);
			if (!health.ok) return health;
			const catalog = await probeOpenAIModelCatalog(base, ctx, modelsPath);
			const result: ProbeResult = { ...health };
			if (catalog.models.length > 0) result.models = catalog.models;
			if (Object.keys(catalog.modelStates).length > 0) result.modelStates = catalog.modelStates;
			if (Object.keys(catalog.modelCapabilities).length > 0) {
				result.modelCapabilities = catalog.modelCapabilities;
				const selected = target.defaultModel?.trim();
				const selectedCaps = selected ? catalog.modelCapabilities[selected] : undefined;
				if (selected && selectedCaps) {
					result.discoveredCapabilities = selectedCaps;
					result.capabilityModelId = selected;
				}
			}
			return result;
		},
		async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
			const base = targetBaseUrl(target);
			if (!base) return [];
			return probeOpenAIModels(base, ctx, modelsPath);
		},
		async probeReasoning(target: TargetDescriptor, modelId: string, ctx: ProbeContext): Promise<ReasoningProbeResult> {
			const base = targetBaseUrl(target);
			if (!base) return { reasoning: false, latencyMs: 0, error: "target has no url" };
			const apiKeyEnv = target.auth?.apiKeyEnvVar;
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
		synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
			return synthesizeOpenAICompatModel({
				target,
				wireModelId,
				kb,
				defaultCapabilities: spec.defaultCapabilities,
				apiFamily,
				provider: spec.provider,
				baseUrlForTarget,
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
