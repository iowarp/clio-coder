import type { CapabilityFlags } from "../../types/capability-flags.js";
import { makeAnthropicCompatRuntime } from "../protocol/anthropic-compat.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 8192,
	maxTokens: 4096,
};

export default makeAnthropicCompatRuntime({
	id: "lemonade-anthropic",
	displayName: "Lemonade (Anthropic-compat)",
	provider: "lemonade",
	auth: "api-key",
	tier: "local-native",
	defaultCapabilities,
	hidden: true,
});
