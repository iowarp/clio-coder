import { CLIO_MIN_MAX_OUTPUT_TOKENS } from "./context-floor.js";

/** The two model facts an output bound reads; a non-positive value means unknown. */
export interface OutputBoundModel {
	contextWindow: number;
	maxTokens: number;
}

/**
 * The output a request asks for when the caller names none: the configured
 * budget (0 means unset), then the profile's recommendation, then the model's
 * advertised cap, and the product floor for a model that advertises none.
 */
export function defaultOutputLimit(
	model: OutputBoundModel,
	configuredMaxOutputTokens: number,
	recommendedTokens: number | undefined,
): number {
	if (configuredMaxOutputTokens > 0) return configuredMaxOutputTokens;
	return recommendedTokens ?? (model.maxTokens > 0 ? model.maxTokens : CLIO_MIN_MAX_OUTPUT_TOKENS);
}

/**
 * The most one response on a route may produce before the remaining window
 * clamps it: the request's default output limit, never above the model's cap
 * or its window. The wire's request ceiling (engine/apis/output-budget.ts) and
 * dispatch's admission cost estimate both read {@link defaultOutputLimit}, so
 * the estimate prices the bound the wire asks for.
 */
export function routeOutputBound(
	model: OutputBoundModel,
	configuredMaxOutputTokens: number,
	recommendedTokens?: number,
): number {
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const modelLimit = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const bound = Math.min(
		defaultOutputLimit(model, configuredMaxOutputTokens, recommendedTokens),
		modelLimit,
		contextWindow,
	);
	return Number.isFinite(bound) ? Math.max(1, Math.floor(bound)) : CLIO_MIN_MAX_OUTPUT_TOKENS;
}
