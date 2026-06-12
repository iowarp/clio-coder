import type { Api, Model } from "@earendil-works/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

export interface AnthropicMessagesSynthesisInput {
	target: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	provider: string;
	defaultBaseUrl: string;
}

export function synthesizeAnthropicMessagesModel(input: AnthropicMessagesSynthesisInput): Model<Api> {
	return synthesizeCatalogBackedModel({
		target: input.target,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		runtimeId: "anthropic",
		api: "anthropic-messages",
		provider: input.provider,
		defaultBaseUrl: input.defaultBaseUrl,
	});
}
