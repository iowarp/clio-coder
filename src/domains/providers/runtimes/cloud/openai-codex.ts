import type { Api, Model } from "@earendil-works/pi-ai";

import { listCatalogModelsForRuntime, synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

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
	async probeModels(_target: TargetDescriptor, _ctx: ProbeContext): Promise<string[]> {
		return listCatalogModelsForRuntime("openai-codex").map((model) => model.id);
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
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
