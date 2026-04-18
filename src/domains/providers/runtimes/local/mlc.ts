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
	contextWindow: 4096,
	maxTokens: 2048,
};

export default makeOpenAICompatRuntime({
	id: "mlc",
	displayName: "MLC-LLM",
	provider: "mlc",
	auth: "none",
	defaultCapabilities,
});
