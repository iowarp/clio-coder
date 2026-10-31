import type { PricedBy } from "../../core/telemetry/schemas.js";
import { createEngineAi, getEngineSupportedThinkingLevels } from "../../engine/ai.js";
import type { Api, KnownProvider, Model, Usage } from "../../engine/types.js";
import { hintCapabilities, mergeCapabilities } from "./capabilities.js";
import { acceptsImageInput } from "./image-input.js";
import type { CapabilityFlags, ThinkingLevel } from "./types/capability-flags.js";
import type { KnowledgeBaseHit } from "./types/knowledge-base.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

const engineAi = createEngineAi();

// Inception /v1/models, 2026-10-20: Pi has no Inception catalog.
const MERCURY_3: Model<"openai-completions"> = {
	id: "mercury-3",
	name: "Inception: Mercury 3",
	api: "openai-completions",
	provider: "inception",
	baseUrl: "https://api.inceptionlabs.ai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 131072,
};

const MERCURY_DECIDE: Model<"openai-completions"> = {
	...MERCURY_3,
	id: "mercury-decide",
	name: "Inception: Mercury Decide",
	cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65536,
	maxTokens: 0,
};

interface ClioCatalogRow {
	model: Model<Api>;
	capabilities?: Partial<CapabilityFlags>;
}

const CLIO_CATALOG_ROWS = new Map<string, ClioCatalogRow>([
	["inception/mercury-3", { model: MERCURY_3 }],
	[
		"inception/mercury-decide",
		{
			model: MERCURY_DECIDE,
			capabilities: { chat: false, tools: false, fim: false, structuredOutputs: "none", decisions: true },
		},
	],
]);

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

/** The rates a target prices calls at and who stands behind them; `none` has no rates (#434). */
export interface EffectivePricing {
	rates: Model<Api>["cost"] | null;
	pricedBy: Exclude<PricedBy, "provider">;
}

export function calculatePricingCostUsd(
	rates:
		| (Pick<Model<Api>["cost"], "input" | "output" | "tiers"> &
				Partial<Pick<Model<Api>["cost"], "cacheRead" | "cacheWrite">>)
		| null,
	usage: Pick<Usage, "input" | "output"> & Partial<Pick<Usage, "cacheRead" | "cacheWrite" | "cacheWrite1h">>,
): number {
	if (rates === null) return 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const inputTokens = usage.input + cacheRead + cacheWrite;
	let selected = rates;
	let threshold = -1;
	for (const tier of rates.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			selected = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	const longWrite = usage.cacheWrite1h ?? 0;
	return (
		(usage.input * selected.input +
			usage.output * selected.output +
			cacheRead * (selected.cacheRead ?? 0) +
			(cacheWrite - longWrite) * (selected.cacheWrite ?? 0) +
			longWrite * selected.input * 2) /
		1_000_000
	);
}

/**
 * C1 / #423: tier boundaries price the whole input, including cache reads/writes.
 * Prefer Pi's tier schedule. These fallbacks cover synthesized flat-price rows:
 * https://platform.claude.com/docs/en/about-claude/pricing (Haiku 5.5, 100K)
 * https://developers.openai.com/api/docs/pricing (GPT-6 family, 272K), 2026-10-20.
 */
export function compactionBudget(
	contextWindow: number,
	threshold: number,
	maxTokens = 200_000,
	model?: Pick<Model<Api>, "id" | "cost"> | null,
): { ceilingTokens: number; threshold: number; fractionScale: number; budgetWindow: number; triggerWindow: number } {
	const boundaries = (model?.cost?.tiers ?? [])
		.filter((tier) => tier.inputTokensAbove > 0 && tier.input > (model?.cost?.input ?? 0))
		.map((tier) => tier.inputTokensAbove);
	const id = model?.id?.split("/").at(-1) ?? "";
	if (boundaries.length === 0) {
		if (/^claude-haiku-5-5(?:$|-)/.test(id)) boundaries.push(100_000);
		else if (/^gpt-6(?:\.\d+)?-(?:astra|sol|luna)(?:$|-)/.test(id)) boundaries.push(272_000);
	}
	// A 2% estimation margin stays below the price boundary; it is not a fit guarantee.
	const tierCeiling = boundaries.length > 0 ? Math.floor(Math.min(...boundaries) * 0.98) : Infinity;
	const ceilingTokens = Math.min(maxTokens, tierCeiling);
	// Working-set fractions use min(window, ceiling); the trigger keeps min(threshold × window, ceiling).
	const knownWindow = Number.isFinite(contextWindow) && contextWindow > 0;
	const fractionScale = knownWindow ? Math.min(1, ceilingTokens / contextWindow) : 1;
	return {
		ceilingTokens,
		threshold: knownWindow ? Math.min(threshold, fractionScale) : 1,
		fractionScale,
		budgetWindow: knownWindow ? contextWindow * fractionScale : ceilingTokens,
		// #423: this denominator drives reduction only, never request-fit admission.
		triggerWindow: knownWindow ? contextWindow : ceilingTokens,
	};
}

/** The runtime facts pricing reads: its id for the catalog, its tier for locality. */
export type PricingRuntime = Pick<RuntimeDescriptor, "id" | "tier">;

const FREE_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Resolve rates and who priced them together so callers cannot price from a different source. */
export function resolveEffectivePricing(
	target: TargetDescriptor,
	runtime: PricingRuntime,
	wireModelId: string,
): EffectivePricing {
	if (target.pricing && target.pricing !== "free") {
		const rates = {
			input: target.pricing.input,
			output: target.pricing.output,
			cacheRead: target.pricing.cacheRead ?? 0,
			cacheWrite: target.pricing.cacheWrite ?? 0,
		};
		return {
			rates,
			pricedBy: Object.values(rates).every((rate) => rate === 0) ? "free" : "target-rates",
		};
	}
	if (target.pricing === "free") return { rates: { ...FREE_RATES }, pricedBy: "free" };
	// A runtime that is local by kind (LM Studio, llama.cpp, Ollama, vLLM, SGLang,
	// Lemonade) bills nothing: 109 of 142 campaign receipts read "unknown" only
	// because those targets declare no price. Proxies such as LiteLLM are protocol
	// tier and can front paid cloud models, so they stay unknown until priced.
	if (runtime.tier === "local-native") return { rates: { ...FREE_RATES }, pricedBy: "free" };
	const catalogModel = getCatalogModelForRuntime(runtime.id, wireModelId);
	if (!catalogModel) return { rates: null, pricedBy: "none" };
	return {
		rates: structuredClone(catalogModel.cost),
		pricedBy: "catalog",
	};
}

export function getCatalogModelForRuntime(runtimeId: string, wireModelId: string): Model<Api> | undefined {
	const clioRow = CLIO_CATALOG_ROWS.get(`${runtimeId}/${wireModelId}`);
	if (clioRow) return structuredClone(clioRow.model);
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
	runtimeId?: string,
): CapabilityFlags {
	if (!model) return defaultCapabilities;
	return {
		...defaultCapabilities,
		reasoning: model.reasoning,
		vision: model.input.includes("image"),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(CLIO_CATALOG_ROWS.get(`${runtimeId ?? model.provider}/${model.id}`)?.capabilities ?? {}),
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
	/**
	 * Wire quirks the runtime knows about its own endpoint, merged over whatever
	 * the catalog entry declares. Needed where a provider is OpenAI-compatible
	 * in shape but not in vocabulary — Inception rejects the `developer` role,
	 * so without this every request carrying a system prompt is a 400.
	 */
	compat?: Model<"openai-completions">["compat"];
	/** Default request-body params for every call to this runtime; per-request keys still win. */
	samplingParams?: Record<string, unknown>;
	/**
	 * Cache retention for the session's own turn requests when neither the
	 * target nor CLIO_CODER_ANTHROPIC_CACHE_RETENTION names one. Workers and
	 * side calls keep the provider default (#422).
	 */
	mainThreadCacheRetention?: "long";
}

export function synthesizeCatalogBackedModel(input: CatalogBackedSynthesisInput): Model<Api> {
	const builtin = getCatalogModelForRuntime(input.runtimeId, input.wireModelId);
	const caps = mergeCapabilities(
		capabilitiesFromCatalogModel(input.defaultCapabilities, builtin, input.runtimeId),
		hintCapabilities(input.kb?.entry),
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
	const pricing = input.target.pricing === "free" ? FREE_RATES : input.target.pricing;
	const targetHeaders = input.target.auth?.headers;
	const model: Model<Api> & {
		clioCoder?: { cache?: NonNullable<TargetDescriptor["cache"]>; mainThreadCacheRetention?: "long" };
	} = {
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
		input: acceptsImageInput({ runtimeId: input.runtimeId, vision: caps.vision })
			? builtin?.input.includes("image")
				? builtin.input
				: ["text", "image"]
			: ["text"],
		// Catalog tiers belong to the catalog rates. An explicit target price
		// replaces that schedule, using the same defaults as resolveEffectivePricing.
		cost: pricing
			? {
					input: pricing.input,
					output: pricing.output,
					cacheRead: pricing.cacheRead ?? 0,
					cacheWrite: pricing.cacheWrite ?? 0,
				}
			: structuredClone(builtin?.cost ?? FREE_RATES),
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
		...(input.target.cache === undefined && input.mainThreadCacheRetention === undefined
			? {}
			: {
					clioCoder: {
						...(input.target.cache === undefined ? {} : { cache: structuredClone(input.target.cache) }),
						...(input.mainThreadCacheRetention === undefined
							? {}
							: { mainThreadCacheRetention: input.mainThreadCacheRetention }),
					},
				}),
	};
	const headers = { ...(input.defaultHeaders ?? {}), ...(builtin?.headers ?? {}), ...(targetHeaders ?? {}) };
	if (Object.keys(headers).length > 0) {
		model.headers = headers;
	}
	if (input.compat && api === "openai-completions") {
		const merged = { ...(model.compat as object | undefined), ...input.compat };
		(model as Model<"openai-completions">).compat = merged;
	}
	if (input.samplingParams) {
		model.samplingParams = { ...input.samplingParams, ...(model.samplingParams ?? {}) };
	}
	return model;
}
