import type { Api, Model } from "@earendil-works/pi-ai";

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
