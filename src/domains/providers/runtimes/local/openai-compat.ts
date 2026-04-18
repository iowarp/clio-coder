import type { CapabilityFlags } from "../../types/capability-flags.js";
import { makeOpenAICompatRuntime } from "../common/local-factory.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: false,
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
	id: "openai-compat",
	displayName: "Generic OpenAI-compatible",
	provider: "openai-compat",
	auth: "api-key",
	defaultCapabilities,
});
