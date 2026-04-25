import type { Api, Model } from "@mariozechner/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 128000,
	maxTokens: 8192,
};

const openrouterRuntime: RuntimeDescriptor = {
	id: "openrouter",
	displayName: "OpenRouter",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "OPENROUTER_API_KEY",
	defaultCapabilities,
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "openrouter",
			api: "openai-completions",
			provider: "openrouter",
			defaultBaseUrl: "https://openrouter.ai/api/v1",
		});
	},
};

export default openrouterRuntime;
