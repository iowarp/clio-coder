import type { ThinkingLevel } from "../domains/providers/types/capability-flags.js";

/**
 * How much scaffolding a prompt should give the model that runs it. `small`
 * is a model that needs explicit steps and short context (a local 8B), and
 * `frontier` one that does best with terse intent and room to plan. Hooks and
 * prompt templates read it; nothing in the system prompt does, so a tier never
 * changes a cached prefix (WTF-P 0.8.3 C1).
 */
export type ModelTier = "small" | "standard" | "frontier";

export const MODEL_TIERS: ReadonlyArray<ModelTier> = ["small", "standard", "frontier"];

export function isModelTier(value: unknown): value is ModelTier {
	return typeof value === "string" && (MODEL_TIERS as ReadonlyArray<string>).includes(value);
}

/** What is known about a model before anyone has asked how capable it is. */
export interface ModelTierFacts {
	/** The wire model id, which often carries a parameter count (`qwen3-8b`, `llama-3.1-70b`). */
	modelId: string;
	/** The effective context window in tokens; zero when unknown. */
	contextWindow: number;
	/** The runtime descriptor's tier: `cloud`, `subscription`, `local-native` or `protocol`. */
	runtimeTier?: string;
	/** The model is in the Pi catalog for its runtime, so a provider publishes it as a product. */
	inCatalog: boolean;
}

/** Below this many tokens a model is small whatever else is known. */
const SMALL_CONTEXT_WINDOW = 32_768;
/** Below this many billion parameters an id's own size hint makes a model small. */
const SMALL_PARAMETERS_B = 20;
/** A catalog cloud model needs at least this window to count as frontier. */
const FRONTIER_CONTEXT_WINDOW = 128_000;
/** Ids that name a provider's reduced variant: fast and cheap, not its strongest. */
const REDUCED_VARIANT = /(?:^|[^a-z])(?:mini|nano|haiku|lite|small|tiny)(?![a-z])/;
/** `8b`, `1.5b`, `70b`; the char before the digits may not be a letter, so `a9b` (active experts) is skipped. */
const PARAMETER_HINT = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g;

/** The largest `<n>b` size an id names, which for a mixture-of-experts id (`74b-a9b`) is the total. */
function parameterHintB(modelId: string): number | null {
	let largest: number | null = null;
	for (const match of modelId.toLowerCase().matchAll(PARAMETER_HINT)) {
		const value = Number(match[1]);
		if (Number.isFinite(value) && value > 0 && (largest === null || value > largest)) largest = value;
	}
	return largest;
}

/**
 * The tier a model gets when the operator has not set `models.<id>.tier`.
 * The rules apply in order and the first that fires decides:
 *
 * 1. A known context window under 32,768 tokens is `small`: a scaffolded
 *    prompt plus the work does not fit beside a frontier-sized plan.
 * 2. A parameter count in the id decides next: under 20B is `small`, 20B and
 *    up is `standard`. A size hint never makes a model `frontier`, because
 *    ids that carry one are open weights operators serve themselves.
 * 3. A cloud or subscription model in the Pi catalog with a window of at
 *    least 128,000 tokens is `frontier`, unless its id names a reduced
 *    variant (mini, nano, haiku, lite, small, tiny), which stays `standard`.
 * 4. Everything else is `standard`: a local-native or protocol route with no
 *    size hint, an unknown window, a model the catalog does not list.
 */
export function defaultModelTier(facts: ModelTierFacts): ModelTier {
	if (facts.contextWindow > 0 && facts.contextWindow < SMALL_CONTEXT_WINDOW) return "small";
	const parameters = parameterHintB(facts.modelId);
	if (parameters !== null) return parameters < SMALL_PARAMETERS_B ? "small" : "standard";
	const hosted = facts.runtimeTier === "cloud" || facts.runtimeTier === "subscription";
	if (hosted && facts.inCatalog && facts.contextWindow >= FRONTIER_CONTEXT_WINDOW)
		return REDUCED_VARIANT.test(facts.modelId.toLowerCase()) ? "standard" : "frontier";
	return "standard";
}

/**
 * The model a hook call or a template rendering runs for, as hooks receive it
 * on `MiddlewareHookInput.model` and api 2 extension hooks on `event.model`.
 * A dispatched worker's calls carry the worker's own model.
 */
export interface ModelRunInfo {
	/** Wire model id. */
	id: string;
	/** Target id the model is served through. */
	target: string;
	/** Effective context window in tokens, or null when nothing reported one. */
	contextWindow: number | null;
	/** The thinking level the requests actually carry after the model's limits. */
	thinkingLevel: ThinkingLevel;
	/** False only when the route turns prompt caching off (`cache.retention: none`). */
	promptCaching: boolean;
	tier: ModelTier;
}

interface ModelRunFacts {
	targetId: string;
	wireModelId: string;
	effectiveThinkingLevel: ThinkingLevel;
	modelTier?: ModelTier;
	promptCaching?: boolean;
}

function modelRunInfo(facts: ModelRunFacts, contextWindow: number): ModelRunInfo {
	return {
		id: facts.wireModelId,
		target: facts.targetId,
		contextWindow: contextWindow > 0 ? contextWindow : null,
		thinkingLevel: facts.effectiveThinkingLevel,
		promptCaching: facts.promptCaching ?? true,
		// A resolution always carries its tier; only a hand-built one falls back to the id and window alone.
		tier: facts.modelTier ?? defaultModelTier({ modelId: facts.wireModelId, contextWindow, inCatalog: false }),
	};
}

/** A resolved runtime target's model, as the session's own hooks receive it. */
export function runtimeModelInfo(
	resolved: ModelRunFacts & { contextWindowDetails: { effectiveContextWindow: number } },
): ModelRunInfo {
	return modelRunInfo(resolved, resolved.contextWindowDetails.effectiveContextWindow);
}

/**
 * `runtimeModelInfo` as a hook-input field, empty for a runtime whose resolution carries no window details. The
 * session reads those details optionally wherever else it uses them, because a runtime built by hand has none,
 * and a hook that receives no model is better than a tool call or a turn that throws while building its input.
 */
export function runtimeModelField(
	resolved: (ModelRunFacts & { contextWindowDetails?: { effectiveContextWindow: number } }) | undefined,
): { model?: ModelRunInfo } {
	const details = resolved?.contextWindowDetails;
	return resolved === undefined || details === undefined
		? {}
		: { model: modelRunInfo(resolved, details.effectiveContextWindow) };
}

/** A worker's model, read from the runtime snapshot its spec carries. */
export function snapshotModelInfo(snapshot: ModelRunFacts & { capabilities: { contextWindow: number } }): ModelRunInfo {
	return modelRunInfo(snapshot, snapshot.capabilities.contextWindow);
}

// The names of `VALID_THINKING_LEVELS`, repeated so the worker protocol's parser value-imports no domain module.
const THINKING_LEVEL_NAMES: ReadonlyArray<string> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A `ModelRunInfo` read back from a worker's frame, or null when any field is malformed. */
export function parseModelRunInfo(value: unknown): ModelRunInfo | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const { id, target, contextWindow, thinkingLevel, promptCaching, tier } = record;
	if (typeof id !== "string" || id.length === 0 || id.length > 512) return null;
	if (typeof target !== "string" || target.length === 0 || target.length > 512) return null;
	if (
		contextWindow !== null &&
		(typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
	)
		return null;
	if (typeof thinkingLevel !== "string" || !THINKING_LEVEL_NAMES.includes(thinkingLevel)) return null;
	if (typeof promptCaching !== "boolean" || !isModelTier(tier)) return null;
	return { id, target, contextWindow, thinkingLevel: thinkingLevel as ThinkingLevel, promptCaching, tier };
}
