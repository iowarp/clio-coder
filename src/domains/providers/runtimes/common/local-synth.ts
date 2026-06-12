import type { AnthropicMessagesCompat, Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";

import { mergeCapabilities } from "../../capabilities.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import { extractLocalModelQuirks, type LocalModelQuirks } from "../../types/local-model-quirks.js";
import type { RuntimeApiFamily } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

export type LocalModelLifecycle = "user-managed" | "clio-managed";

export interface ClioLocalModelMetadata {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: LocalModelLifecycle;
		gateway?: boolean;
		family?: string;
		quirks?: LocalModelQuirks;
	};
}

export interface LocalSynthesisInput {
	endpoint: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	apiFamily: RuntimeApiFamily;
	provider: string;
	baseUrlForEndpoint: (endpointUrl: string) => string;
}

export function endpointLifecycle(endpoint: TargetDescriptor): LocalModelLifecycle {
	return endpoint.lifecycle ?? "user-managed";
}

function openAIThinkingFormat(
	caps: CapabilityFlags,
): OpenAICompletionsCompat["thinkingFormat"] | "harmony" | undefined {
	switch (caps.thinkingFormat) {
		case "qwen-chat-template":
		case "openrouter":
		case "zai":
			return caps.thinkingFormat;
		case "deepseek-r1":
			return "deepseek";
		case "harmony":
			return "harmony";
		default:
			return undefined;
	}
}

function localOpenAICompat(caps: CapabilityFlags): OpenAICompletionsCompat {
	const compat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
	};
	const thinkingFormat = openAIThinkingFormat(caps);
	if (thinkingFormat) (compat as unknown as { thinkingFormat?: string }).thinkingFormat = thinkingFormat;
	return compat;
}

function localAnthropicCompat(): AnthropicMessagesCompat {
	return {
		supportsEagerToolInputStreaming: false,
		supportsLongCacheRetention: false,
	};
}

export function synthLocalModel(input: LocalSynthesisInput): Model<Api> {
	const { endpoint, wireModelId, kb, defaultCapabilities, apiFamily, provider } = input;
	const caps = mergeCapabilities(
		defaultCapabilities,
		kb?.entry.capabilities ?? null,
		null,
		endpoint.capabilities ?? null,
	);
	const rawUrl = endpoint.url ?? "";
	const baseUrl = rawUrl.length > 0 ? input.baseUrlForEndpoint(rawUrl) : "";
	const pricing = endpoint.pricing;
	const headers = endpoint.auth?.headers;
	const quirks = extractLocalModelQuirks(kb?.entry.quirks);
	const model: Model<Api> & ClioLocalModelMetadata = {
		id: wireModelId,
		name: `${wireModelId} (${endpoint.id})`,
		api: apiFamily,
		provider,
		baseUrl,
		reasoning: caps.reasoning,
		input: caps.vision ? ["text", "image"] : ["text"],
		cost: {
			input: pricing?.input ?? 0,
			output: pricing?.output ?? 0,
			cacheRead: pricing?.cacheRead ?? 0,
			cacheWrite: pricing?.cacheWrite ?? 0,
		},
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
		clio: {
			targetId: endpoint.id,
			runtimeId: endpoint.runtime,
			lifecycle: endpointLifecycle(endpoint),
			...(endpoint.gateway === true ? { gateway: true } : {}),
			...(kb?.entry.family ? { family: kb.entry.family } : {}),
			...(quirks ? { quirks } : {}),
		},
	};
	if (headers) model.headers = headers;
	if (apiFamily === "openai-completions") {
		(model as Model<"openai-completions">).compat = localOpenAICompat(caps);
	}
	if (apiFamily === "anthropic-messages") {
		(model as Model<"anthropic-messages">).compat = localAnthropicCompat();
	}
	return model;
}

export function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export const withV1 = (url: string): string => `${stripTrailingSlash(url)}/v1`;
export const withAsIs = (url: string): string => stripTrailingSlash(url);

export function endpointBase(endpoint: TargetDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}
