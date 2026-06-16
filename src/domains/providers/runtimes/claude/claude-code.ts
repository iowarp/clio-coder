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

const claudeCodeRuntime: RuntimeDescriptor = {
	id: "claude-code",
	displayName: "Claude Code CLI",
	kind: "subprocess",
	tier: "subscription",
	apiFamily: "claude-code-subprocess",
	auth: "claude-cli",
	authNotice: CLAUDE_CODE_AUTH_NOTICE,
	knownModels: [...CLAUDE_CODE_MODELS],
	binaryName: "claude",
	headlessCommand: "claude -p --output-format stream-json",
	outputParser: "claude-code-stream-json",
	defaultCapabilities: claudeCodeCapabilities,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeClaudeDelegatedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: claudeCodeCapabilities,
			runtimeId: "claude-code",
			apiFamily: "claude-code-subprocess",
		});
	},
};

export default claudeCodeRuntime;
