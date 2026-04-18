import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type {
	ProbeContext,
	ProbeResult,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
} from "../../types/runtime-descriptor.js";
import { endpointBase, synthLocalModel, withAsIs, withV1 } from "./local-synth.js";
import { probeOpenAIModels, probeUrl } from "./probe-helpers.js";

export interface OpenAICompatSpec {
	id: string;
	displayName: string;
	provider: string;
	auth: RuntimeAuth;
	defaultCapabilities: CapabilityFlags;
	healthPath?: string;
	modelsPath?: string;
	apiFamily?: RuntimeApiFamily;
	baseUrlStyle?: "v1" | "asIs";
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
		synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
			return synthLocalModel({
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
