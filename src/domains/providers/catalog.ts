import { createEngineAi, supportsEngineXhigh } from "../../engine/ai.js";
import type { Api, KnownProvider, Model } from "../../engine/types.js";
import { mergeCapabilities } from "./capabilities.js";
import type { CapabilityFlags } from "./types/capability-flags.js";
import type { EndpointDescriptor } from "./types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "./types/knowledge-base.js";

const engineAi = createEngineAi();

const CATALOG_PROVIDER_BY_RUNTIME_ID = new Map<string, KnownProvider>([
	["anthropic", "anthropic"],
	["bedrock", "amazon-bedrock"],
	["deepseek", "deepseek"],
	["google", "google"],
	["groq", "groq"],
	["mistral", "mistral"],
	["openai", "openai"],
	["openai-codex", "openai-codex"],
	["openrouter", "openrouter"],
]);

export function catalogProviderForRuntime(runtimeId: string): KnownProvider | undefined {
	return CATALOG_PROVIDER_BY_RUNTIME_ID.get(runtimeId);
}

export function listCatalogModelsForRuntime(runtimeId: string): Model<Api>[] {
	const provider = catalogProviderForRuntime(runtimeId);
	if (!provider) return [];
	try {
		return engineAi.listModels(provider) as unknown as Model<Api>[];
	} catch {
		return [];
	}
}

export function getCatalogModelForRuntime(runtimeId: string, wireModelId: string): Model<Api> | undefined {
	const provider = catalogProviderForRuntime(runtimeId);
	if (!provider) return undefined;
	try {
		return engineAi.getModel(provider, wireModelId) as unknown as Model<Api> | undefined;
	} catch {
		return undefined;
	}
}

export function capabilitiesFromCatalogModel(
	defaultCapabilities: CapabilityFlags,
	model: Model<Api> | undefined,
): CapabilityFlags {
	if (!model) return defaultCapabilities;
	return {
		...defaultCapabilities,
		reasoning: model.reasoning,
		vision: model.input.includes("image"),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function catalogSupportsXhighForRuntime(runtimeId: string, wireModelId: string): boolean | undefined {
	const model = getCatalogModelForRuntime(runtimeId, wireModelId);
	return model ? supportsEngineXhigh(model) : undefined;
}

export interface CatalogBackedSynthesisInput {
	endpoint: EndpointDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	runtimeId: string;
	provider: string;
	api: Api;
	defaultBaseUrl: string;
}

export function synthesizeCatalogBackedModel(input: CatalogBackedSynthesisInput): Model<Api> {
	const builtin = getCatalogModelForRuntime(input.runtimeId, input.wireModelId);
	const caps = mergeCapabilities(
		capabilitiesFromCatalogModel(input.defaultCapabilities, builtin),
		input.kb?.entry.capabilities ?? null,
		null,
		input.endpoint.capabilities ?? null,
	);
	const pricing = input.endpoint.pricing;
	const builtinHeaders = builtin?.headers;
	const endpointHeaders = input.endpoint.auth?.headers;
	const headers = endpointHeaders ? { ...(builtinHeaders ?? {}), ...endpointHeaders } : builtinHeaders;
	const model: Model<Api> = {
		...(builtin ?? {}),
		id: input.wireModelId,
		name: `${input.wireModelId} (${input.endpoint.id})`,
		api: input.api,
		provider: input.provider,
		baseUrl: input.endpoint.url ?? builtin?.baseUrl ?? input.defaultBaseUrl,
		reasoning: caps.reasoning,
		input: caps.vision ? (builtin?.input.includes("image") ? builtin.input : ["text", "image"]) : ["text"],
		cost: {
			input: pricing?.input ?? builtin?.cost.input ?? 0,
			output: pricing?.output ?? builtin?.cost.output ?? 0,
			cacheRead: pricing?.cacheRead ?? builtin?.cost.cacheRead ?? 0,
			cacheWrite: pricing?.cacheWrite ?? builtin?.cost.cacheWrite ?? 0,
		},
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
	};
	if (headers) model.headers = headers;
	return model;
}
