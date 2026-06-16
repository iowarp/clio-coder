import type { Api, Model } from "@earendil-works/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeApiFamily } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

export const CLAUDE_CODE_AUTH_NOTICE =
	"Uses your existing Claude Code login from the installed `claude` command. Clio stores no Claude Code credentials.";

export const CLAUDE_CODE_MODELS: ReadonlyArray<string> = [
	"sonnet",
	"opus",
	"haiku",
	"claude-sonnet-4-5",
	"claude-opus-4-5",
	"claude-haiku-4-5",
	"claude-3-7-sonnet-latest",
];

export const claudeCodeCapabilities: CapabilityFlags = {
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

export function synthesizeClaudeDelegatedModel(input: {
	target: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	runtimeId: string;
	apiFamily: RuntimeApiFamily;
}): Model<Api> {
	return synthesizeCatalogBackedModel({
		target: input.target,
		wireModelId: input.wireModelId,
		kb: input.kb,
		defaultCapabilities: input.defaultCapabilities,
		runtimeId: input.runtimeId,
		api: input.apiFamily,
		provider: "anthropic",
		defaultBaseUrl: "claude-code://local",
	});
}
