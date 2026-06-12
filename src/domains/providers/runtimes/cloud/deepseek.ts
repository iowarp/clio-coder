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
	thinkingFormat: "deepseek-r1",
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 128000,
	maxTokens: 65536,
};

const deepseekRuntime: RuntimeDescriptor = {
	id: "deepseek",
	displayName: "DeepSeek",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "DEEPSEEK_API_KEY",
	defaultCapabilities,
	async probeModels(_endpoint: TargetDescriptor, _ctx: ProbeContext): Promise<string[]> {
		return listCatalogModelsForRuntime("deepseek").map((model) => model.id);
	},
	synthesizeModel(endpoint: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "deepseek",
			api: "openai-completions",
			provider: "deepseek",
			defaultBaseUrl: "https://api.deepseek.com",
		});
	},
};

export default deepseekRuntime;
