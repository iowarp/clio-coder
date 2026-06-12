import type { Api, Model } from "@earendil-works/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

export interface BedrockSynthesisInput {
	target: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
}

export function synthesizeBedrockModel(input: BedrockSynthesisInput): Model<Api> {
	return synthesizeCatalogBackedModel({
		target: input.target,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		runtimeId: "bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		defaultBaseUrl: "",
	});
}
