import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
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
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null) {
		return synthesizeAnthropicMessagesModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			provider: "anthropic",
			defaultBaseUrl: "https://api.anthropic.com",
			// A 5-minute entry expires across most pauses between turns, where the cache keepalive stands down, and
			// re-writes the whole prefix at 1.25x input. A 1-hour write costs 2x on new tokens only, so one such pause
			// after the prompt reaches 5/8 of its final size pays for a session's 1-hour writes. Workers stay at 5 minutes.
			mainThreadCacheRetention: "long",
			// Pi 1.5.1 message threads reshape every Anthropic request and are not driven live yet; enable after a live check.
			compat: { supportsMessageThreads: false },
		});
	},
};

export default anthropicRuntime;
