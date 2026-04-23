import type { CapabilityFlags } from "../../types/capability-flags.js";
import { makeOpenAICompatRuntime } from "../protocol/openai-compat.js";

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
	contextWindow: 8192,
	maxTokens: 4096,
};

export default makeOpenAICompatRuntime({
	id: "vllm",
	displayName: "vLLM",
	provider: "vllm",
	auth: "api-key",
	tier: "local-native",
	defaultCapabilities,
	healthPath: "/health",
});
