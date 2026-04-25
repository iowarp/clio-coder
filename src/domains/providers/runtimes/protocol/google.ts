import type { Api, Model } from "@mariozechner/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";

export interface GoogleSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	defaultBaseUrl: string;
}

export function synthesizeGoogleModel(input: GoogleSynthesisInput): Model<Api> {
	return synthesizeCatalogBackedModel({
		endpoint: input.endpoint,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		runtimeId: "google",
		api: "google-generative-ai",
		provider: "google",
		defaultBaseUrl: input.defaultBaseUrl,
	});
}
