import type { Api, Model } from "@mariozechner/pi-ai";

import { mergeCapabilities } from "../../capabilities.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";

export interface AnthropicMessagesSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	provider: string;
	defaultBaseUrl: string;
}

export function synthesizeAnthropicMessagesModel(input: AnthropicMessagesSynthesisInput): Model<Api> {
	const caps = mergeCapabilities(
		input.defaultCapabilities,
		input.kb?.entry.capabilities ?? null,
		null,
		input.endpoint.capabilities ?? null,
	);
	const pricing = input.endpoint.pricing;
	const model: Model<"anthropic-messages"> = {
		id: input.wireModelId,
		name: `${input.wireModelId} (${input.endpoint.id})`,
		api: "anthropic-messages",
		provider: input.provider,
		baseUrl: input.endpoint.url ?? input.defaultBaseUrl,
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
	if (input.endpoint.auth?.headers) model.headers = input.endpoint.auth.headers;
	return model as Model<Api>;
}
