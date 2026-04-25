import type { Api, Model } from "@mariozechner/pi-ai";

import { listCatalogModelsForRuntime, synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, RuntimeDescriptor } from "../../types/runtime-descriptor.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	thinkingFormat: "openai-codex",
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 272000,
	maxTokens: 16384,
};

const openaiCodexRuntime: RuntimeDescriptor = {
	id: "openai-codex",
	displayName: "OpenAI Codex",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-codex-responses",
	auth: "oauth",
	defaultCapabilities,
	async probeModels(_endpoint: EndpointDescriptor, _ctx: ProbeContext): Promise<string[]> {
		return listCatalogModelsForRuntime("openai-codex").map((model) => model.id);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "openai-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			defaultBaseUrl: "https://chatgpt.com/backend-api",
		});
	},
};

export default openaiCodexRuntime;
