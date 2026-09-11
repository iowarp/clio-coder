import { createEngineAi, getEngineSupportedThinkingLevels } from "../../engine/ai.js";
import type { Api, KnownProvider, Model } from "../../engine/types.js";
import { mergeCapabilities } from "./capabilities.js";
import type { CapabilityFlags, ThinkingLevel } from "./types/capability-flags.js";
import type { CostProvenance } from "./types/cost-provenance.js";
import type { KnowledgeBaseHit } from "./types/knowledge-base.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

const engineAi = createEngineAi();

const CATALOG_PROVIDER_BY_RUNTIME_ID = new Map<string, KnownProvider>([
	["anthropic", "anthropic"],
	["anthropic-max", "anthropic"],
	["claude-code", "anthropic"],
	["claude-sdk", "anthropic"],
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
		return engineAi.listModels(provider);
	} catch {
		return [];
	}
}

export interface EffectivePricing {
	rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
	provenance: CostProvenance;
}

/** Resolve rates and provenance together so callers cannot price from a different source. */
export function resolveEffectivePricing(
	target: TargetDescriptor,
	runtimeId: string,
	wireModelId: string,
): EffectivePricing {
	if (target.pricing) {
		const rates = {
			input: target.pricing.input,
			output: target.pricing.output,
			cacheRead: target.pricing.cacheRead ?? 0,
			cacheWrite: target.pricing.cacheWrite ?? 0,
		};
		return {
			rates,
			provenance: Object.values(rates).every((rate) => rate === 0) ? "known_free" : "known",
		};
	}
	const catalogModel = getCatalogModelForRuntime(runtimeId, wireModelId);
	if (!catalogModel) return { rates: null, provenance: "unknown" };
	return {
		rates: {
			input: catalogModel.cost.input,
			output: catalogModel.cost.output,
			cacheRead: catalogModel.cost.cacheRead,
			cacheWrite: catalogModel.cost.cacheWrite,
		},
		provenance: "estimated",
	};
}

/** Resolve pricing truth from the same fallback chain used for model synthesis. */
export function resolveCostProvenance(
	target: TargetDescriptor,
	runtimeId: string,
	wireModelId: string,
): CostProvenance {
	return resolveEffectivePricing(target, runtimeId, wireModelId).provenance;
}

export function getCatalogModelForRuntime(runtimeId: string, wireModelId: string): Model<Api> | undefined {
	const provider = catalogProviderForRuntime(runtimeId);
	if (!provider) return undefined;
	try {
		return engineAi.getModel(provider, wireModelId);
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

export function catalogThinkingLevelsForRuntime(
	runtimeId: string,
	wireModelId: string,
): ReadonlyArray<ThinkingLevel> | undefined {
	const model = getCatalogModelForRuntime(runtimeId, wireModelId);
	return model ? (getEngineSupportedThinkingLevels(model) as ThinkingLevel[]) : undefined;
}

export interface CatalogBackedSynthesisInput {
	target: TargetDescriptor;
	wireModelId: string;
	kb: KnowledgeBaseHit | null;
	defaultCapabilities: CapabilityFlags;
	runtimeId: string;
	provider: string;
	api: Api;
	/** Use the catalog transport and its endpoint when no explicit target URL is configured. */
	preferCatalogTransport?: boolean;
	defaultBaseUrl: string;
	defaultHeaders?: Record<string, string>;
}

export function synthesizeCatalogBackedModel(input: CatalogBackedSynthesisInput): Model<Api> {
	const builtin = getCatalogModelForRuntime(input.runtimeId, input.wireModelId);
	const caps = mergeCapabilities(
		capabilitiesFromCatalogModel(input.defaultCapabilities, builtin),
		input.kb?.entry.capabilities ?? null,
		null,
		input.target.capabilities ?? null,
	);
	const api = input.preferCatalogTransport && input.target.url === undefined ? (builtin?.api ?? input.api) : input.api;
	// A catalog endpoint, compatibility flags, and effort map describe one API.
	// Explicit endpoints keep the runtime's API contract, even when a catalog
	// model has moved to another transport (for example OpenRouter Claude).
	const sameTransport = builtin?.api === api;
	const catalogFields = { ...builtin };
	if (input.preferCatalogTransport && !sameTransport) {
		delete catalogFields.compat;
		delete catalogFields.thinkingLevelMap;
	}
	const pricing = input.target.pricing;
	const targetHeaders = input.target.auth?.headers;
	const model: Model<Api> & { clioCoder?: { cache: NonNullable<TargetDescriptor["cache"]> } } = {
		...catalogFields,
		id: input.wireModelId,
		name: `${input.wireModelId} (${input.target.id})`,
		api,
		provider: input.provider,
		baseUrl:
			input.target.url ??
			(input.preferCatalogTransport && !sameTransport ? undefined : builtin?.baseUrl) ??
			input.defaultBaseUrl,
		reasoning: caps.reasoning,
		input: caps.vision ? (builtin?.input.includes("image") ? builtin.input : ["text", "image"]) : ["text"],
		// Catalog tiers belong to the catalog rates. An explicit target price
		// replaces that schedule, using the same defaults as resolveEffectivePricing.
		cost: pricing
			? {
					input: pricing.input,
					output: pricing.output,
					cacheRead: pricing.cacheRead ?? 0,
					cacheWrite: pricing.cacheWrite ?? 0,
				}
			: structuredClone(builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
		...(input.target.cache === undefined ? {} : { clioCoder: { cache: structuredClone(input.target.cache) } }),
	};
	const headers = { ...(input.defaultHeaders ?? {}), ...(builtin?.headers ?? {}), ...(targetHeaders ?? {}) };
	if (Object.keys(headers).length > 0) {
		model.headers = headers;
	}
	return model;
}
