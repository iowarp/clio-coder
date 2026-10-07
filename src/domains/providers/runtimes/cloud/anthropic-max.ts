import type { Api, Model } from "../../../../engine/types.js";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

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

/**
 * Claude Pro/Max subscription runtime (OAuth).
 *
 * Mirrors the `openai-codex` subscription runtime for Anthropic: an
 * `anthropic-messages` HTTP runtime whose credential is an OAuth access token
 * minted from a Claude Pro/Max subscription rather than an API key. pi-ai owns
 * the entire mechanism — `anthropicOAuthProvider` runs the login/refresh flow,
 * and the anthropic provider auto-detects the OAuth token (`sk-ant-oat...`) to
 * switch to Bearer auth, attach the required `oauth-2025-04-20` beta, and apply
 * the Claude Code identity. Clio only has to register the runtime and route the
 * credential.
 *
 * Clio registers this OAuth flow as `anthropic-max`. Pi's HTTP provider remains
 * `anthropic`, but the subscription credential must never share the API-key
 * runtime's storage slot.
 *
 * It has no live model listing. Its models are pi-ai's Anthropic catalog, and
 * every surface labels them as the catalog rather than as a provider answer.
 */
const anthropicMaxRuntime: RuntimeDescriptor = {
	id: "anthropic-max",
	displayName: "Anthropic (Claude Pro/Max)",
	kind: "http",
	tier: "cloud",
	apiFamily: "anthropic-messages",
	auth: "oauth",
	authNotice:
		"Connects with your Claude Pro/Max subscription via OAuth (the same path Claude Code uses). " +
		"Using subscription credentials outside Anthropic's first-party apps may not align with their " +
		"terms of service; enable at your own discretion.",
	defaultCapabilities,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "anthropic-max",
			api: "anthropic-messages",
			provider: "anthropic",
			defaultBaseUrl: "https://api.anthropic.com",
		});
	},
};

export default anthropicMaxRuntime;
