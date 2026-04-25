import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { synthesizeGoogleModel } from "../protocol/google.js";

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
	tier: "cloud",
	apiFamily: "google-generative-ai",
	auth: "api-key",
	credentialsEnvVar: "GOOGLE_API_KEY",
	defaultCapabilities,
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null) {
		return synthesizeGoogleModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		});
	},
};

export default googleRuntime;
