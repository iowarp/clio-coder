import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { mergeCapabilities } from "../../capabilities.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: true,
	thinkingFormat: "anthropic-extended",
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 200000,
	maxTokens: 8192,
};

const anthropicRuntime: RuntimeDescriptor = {
	id: "anthropic",
	displayName: "Anthropic",
	kind: "http",
	apiFamily: "anthropic-messages",
	auth: "api-key",
	credentialsEnvVar: "ANTHROPIC_API_KEY",
	defaultCapabilities,
	synthesizeModel(
		endpoint: EndpointDescriptor,
		wireModelId: string,
		kb: KnowledgeBaseHit | null,
	): Model<Api> {
		const caps = mergeCapabilities(
			defaultCapabilities,
			kb?.entry.capabilities ?? null,
			null,
			endpoint.capabilities ?? null,
		);
		const headers = endpoint.auth?.headers;
		const pricing = endpoint.pricing;
		const model: Model<"anthropic-messages"> = {
			id: wireModelId,
			name: `${wireModelId} (${endpoint.id})`,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: endpoint.url ?? "https://api.anthropic.com",
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

export default anthropicRuntime;
