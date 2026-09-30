import type { Api, Model } from "../../../../engine/types.js";

import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import {
	CLAUDE_CODE_AUTH_NOTICE,
	CLAUDE_CODE_MODELS,
	claudeCodeCapabilities,
	synthesizeClaudeDelegatedModel,
} from "./common.js";

const claudeSdkRuntime: RuntimeDescriptor = {
	id: "claude-sdk",
	displayName: "Claude Agent SDK",
	kind: "sdk",
	tier: "subscription",
	apiFamily: "claude-agent-sdk",
	auth: "claude-cli",
	authNotice: CLAUDE_CODE_AUTH_NOTICE,
	knownModels: [...CLAUDE_CODE_MODELS],
	binaryName: "claude",
	headlessCommand: "@anthropic-ai/claude-agent-sdk query()",
	outputParser: "claude-agent-sdk-messages",
	defaultCapabilities: claudeCodeCapabilities,
	// canUseTool admits every SDK tool call through the shared evaluator, but the
	// callback cannot park a call for a later decision.
	enforcement: {
		perCallMediation: true,
		toolNarrowing: "exact",
		scopeEnforcement: true,
		grantPauseResume: false,
		cancellation: true,
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeClaudeDelegatedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: claudeCodeCapabilities,
			runtimeId: "claude-sdk",
			apiFamily: "claude-agent-sdk",
		});
	},
};

export default claudeSdkRuntime;
