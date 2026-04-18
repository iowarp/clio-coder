import type { Api, Model } from "@mariozechner/pi-ai";

import { mergeCapabilities } from "../../capabilities.js";
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
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "OPENROUTER_API_KEY",
	defaultCapabilities,
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const caps = mergeCapabilities(
			defaultCapabilities,
			kb?.entry.capabilities ?? null,
			null,
			endpoint.capabilities ?? null,
		);
		const headers = endpoint.auth?.headers;
		const pricing = endpoint.pricing;
		const model: Model<"openai-completions"> = {
			id: wireModelId,
			name: `${wireModelId} (${endpoint.id})`,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: endpoint.url ?? "https://openrouter.ai/api/v1",
			reasoning: caps.reasoning,
			input: caps.vision ? ["text", "image"] : ["text"],
			cost: {
				input: pricing?.input ?? 0,
				output: pricing?.output ?? 0,
				cacheRead: pricing?.cacheRead ?? 0,
				cacheWrite: pricing?.cacheWrite ?? 0,
			},
			contextWindow: caps.contextWindow,
			maxTokens: caps.maxTokens,
		};
		if (headers) model.headers = headers;
		return model as Model<Api>;
	},
};

export default openrouterRuntime;
