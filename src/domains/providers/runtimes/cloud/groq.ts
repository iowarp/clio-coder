import type { Api, Model } from "@earendil-works/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

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

const groqRuntime: RuntimeDescriptor = {
	id: "groq",
	displayName: "Groq",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "GROQ_API_KEY",
	defaultCapabilities,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "groq",
			api: "openai-completions",
			provider: "groq",
			defaultBaseUrl: "https://api.groq.com/openai/v1",
		});
	},
};

export default groqRuntime;
