import type { Api, Model } from "@mariozechner/pi-ai";

import { mergeCapabilities } from "../../capabilities.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeApiFamily } from "../../types/runtime-descriptor.js";

export interface LocalSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	apiFamily: RuntimeApiFamily;
	provider: string;
	baseUrlForEndpoint: (endpointUrl: string) => string;
}

export function synthLocalModel(input: LocalSynthesisInput): Model<Api> {
	const { endpoint, wireModelId, kb, defaultCapabilities, apiFamily, provider } = input;
	const caps = mergeCapabilities(
		defaultCapabilities,
		kb?.entry.capabilities ?? null,
		null,
		endpoint.capabilities ?? null,
	);
	const rawUrl = endpoint.url ?? "";
	const baseUrl = rawUrl.length > 0 ? input.baseUrlForEndpoint(rawUrl) : "";
	const pricing = endpoint.pricing;
	const headers = endpoint.auth?.headers;
	const model: Model<Api> = {
		id: wireModelId,
		name: `${wireModelId} (${endpoint.id})`,
		api: apiFamily,
		provider,
		baseUrl,
		reasoning: caps.reasoning,
		input: caps.vision ? ["text", "image"] : ["text"],
		cost: {
			input: pricing?.input ?? 0,
			output: pricing?.output ?? 0,
			cacheRead: pricing?.cacheRead ?? 0,
			cacheWrite: pricing?.cacheWrite ?? 0,
		},
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
	};
	if (headers) model.headers = headers;
	return model;
}

export function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export const withV1 = (url: string): string => `${stripTrailingSlash(url)}/v1`;
export const withAsIs = (url: string): string => stripTrailingSlash(url);

export function endpointBase(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}
