import type { CapabilityFlags } from "../../types/capability-flags.js";
import { makeOpenAICompatRuntime } from "../common/local-factory.js";

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
	id: "aphrodite",
	displayName: "Aphrodite Engine",
	provider: "aphrodite",
	auth: "api-key",
	defaultCapabilities,
});
