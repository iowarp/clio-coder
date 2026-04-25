import type { Api, Model } from "@mariozechner/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
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
	return synthesizeCatalogBackedModel({
		endpoint: input.endpoint,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		runtimeId: "anthropic",
		api: "anthropic-messages",
		provider: input.provider,
		defaultBaseUrl: input.defaultBaseUrl,
	});
}
