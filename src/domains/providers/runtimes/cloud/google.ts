import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { mergeCapabilities } from "../../capabilities.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 2000000,
	maxTokens: 8192,
};

const googleRuntime: RuntimeDescriptor = {
	id: "google",
	displayName: "Google Generative AI",
	kind: "http",
	apiFamily: "google-generative-ai",
	auth: "api-key",
	credentialsEnvVar: "GOOGLE_API_KEY",
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
		const model: Model<"google-generative-ai"> = {
			id: wireModelId,
			name: `${wireModelId} (${endpoint.id})`,
			api: "google-generative-ai",
			provider: "google",
			baseUrl: endpoint.url ?? "https://generativelanguage.googleapis.com",
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

export default googleRuntime;
