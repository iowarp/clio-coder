import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { synthesizeBedrockModel } from "../protocol/bedrock.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: true,
	thinkingFormat: "anthropic-extended",
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 200000,
	maxTokens: 8192,
};

const bedrockRuntime: RuntimeDescriptor = {
	id: "bedrock",
	displayName: "Amazon Bedrock",
	kind: "http",
	tier: "cloud",
	apiFamily: "bedrock-converse-stream",
	auth: "aws-sdk",
	defaultCapabilities,
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null) {
		return synthesizeBedrockModel({ endpoint, wireModelId, kb, defaultCapabilities });
	},
};

export default bedrockRuntime;
