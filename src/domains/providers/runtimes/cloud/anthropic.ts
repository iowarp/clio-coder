import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { synthesizeAnthropicMessagesModel } from "../protocol/anthropic-messages.js";

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
	tier: "cloud",
	apiFamily: "anthropic-messages",
	auth: "api-key",
	credentialsEnvVar: "ANTHROPIC_API_KEY",
	defaultCapabilities,
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null) {
		return synthesizeAnthropicMessagesModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			provider: "anthropic",
			defaultBaseUrl: "https://api.anthropic.com",
		});
	},
};

export default anthropicRuntime;
