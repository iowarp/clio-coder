import type { Api, Model } from "@mariozechner/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";

export interface BedrockSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
}

export function synthesizeBedrockModel(input: BedrockSynthesisInput): Model<Api> {
	return synthesizeCatalogBackedModel({
		endpoint: input.endpoint,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		runtimeId: "bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		defaultBaseUrl: "",
	});
}
