import type { Api, Model } from "@earendil-works/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "mistral",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 128000,
	maxTokens: 8192,
};

const mistralRuntime: RuntimeDescriptor = {
	id: "mistral",
	displayName: "Mistral AI",
	kind: "http",
	tier: "cloud",
	apiFamily: "mistral-conversations",
	auth: "api-key",
	credentialsEnvVar: "MISTRAL_API_KEY",
	defaultCapabilities,
	synthesizeModel(endpoint: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "mistral",
			api: "mistral-conversations",
			provider: "mistral",
			defaultBaseUrl: "https://api.mistral.ai",
		});
	},
};

export default mistralRuntime;
