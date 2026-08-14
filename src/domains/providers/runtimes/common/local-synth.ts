import type { AnthropicMessagesCompat, Api, Model, OpenAICompletionsCompat } from "../../../../engine/types.js";

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
		/**
		 * Present only when settings set the target's lifecycle explicitly. An
		 * explicit "user-managed" forces the residency layer to observe-only;
		 * absent means the operator made no choice and Clio manages by default.
		 */
		lifecycle?: LocalModelLifecycle;
		gateway?: boolean;
		family?: string;
		quirks?: LocalModelQuirks;
		chatTemplateKwargsUnsupported?: boolean;
	};
}

export interface LocalSynthesisInput {
	target: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	apiFamily: RuntimeApiFamily;
	provider: string;
	baseUrlForTarget: (targetUrl: string) => string;
}

/** The target's explicit lifecycle choice; undefined when settings leave it unset. */
export function targetLifecycle(target: TargetDescriptor): LocalModelLifecycle | undefined {
	return target.lifecycle;
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
	const { target, wireModelId, kb, defaultCapabilities, apiFamily, provider } = input;
	const caps = mergeCapabilities(defaultCapabilities, kb?.entry.capabilities ?? null, null, target.capabilities ?? null);
	const rawUrl = target.url ?? "";
	const baseUrl = rawUrl.length > 0 ? input.baseUrlForTarget(rawUrl) : "";
	const pricing = target.pricing;
	const headers = target.auth?.headers;
	const quirks = extractLocalModelQuirks(kb?.entry.quirks);
	const model: Model<Api> & ClioLocalModelMetadata = {
		id: wireModelId,
		name: `${wireModelId} (${target.id})`,
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
			targetId: target.id,
			runtimeId: target.runtime,
			...(target.lifecycle ? { lifecycle: target.lifecycle } : {}),
			...(target.gateway === true ? { gateway: true } : {}),
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

/**
 * Drop a redundant trailing `/v1` from a target URL.
 *
 * Every OpenAI-compatible client documents its base URL as the `/v1` mount
 * point, so `http://host:8080/v1` is what users type and what `clio-coder configure`
 * accepts. Clio's own request paths already carry `/v1`, so the two compose
 * into `/v1/v1/chat/completions` and the server answers 404. Reducing the URL
 * to the server root here makes `http://host:8080` and `http://host:8080/v1`
 * the same target.
 *
 * A gateway mounted at a path that ends in `/v1`, such as
 * `https://gateway.example.com/openai/v1`, is unharmed: stripping the suffix
 * and appending it again is the identity on that path.
 */
function stripRedundantV1(url: string): string {
	return url.endsWith("/v1") ? url.slice(0, -"/v1".length) : url;
}

export const withV1 = (url: string): string => `${stripRedundantV1(stripTrailingSlash(url))}/v1`;
export const withAsIs = (url: string): string => stripTrailingSlash(url);

export function targetBaseUrl(target: TargetDescriptor): string | null {
	return target.url ? stripTrailingSlash(target.url) : null;
}

/**
 * The server root, for runtimes whose own request paths carry `/v1`.
 *
 * Their probes ask for `/health`, `/props`, and `/v1/models` relative to this
 * value, so a target naming the `/v1` mount point has to be reduced to the root
 * or each of those lands one segment too deep. llama.cpp aliases `/v1/health`
 * and nothing else, which is why the health check passed and every other read
 * silently returned nothing.
 */
export function targetRootUrl(target: TargetDescriptor): string | null {
	return target.url ? stripRedundantV1(stripTrailingSlash(target.url)) : null;
}
