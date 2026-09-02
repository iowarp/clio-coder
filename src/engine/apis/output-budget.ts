import type { Api, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../core/context-floor.js";
import { ceilChars, estimateAgentMessageTokens, toolSchemaChars } from "../../domains/session/context-accounting.js";

const CONTEXT_BUDGET_SAFETY_TOKENS = 1024;
/**
 * Output budget when nothing more specific applies. It is the product floor,
 * not a conservative guess: a turn that writes a source file or a wiki page
 * routinely needs tens of thousands of tokens, and every runtime Clio targets
 * serves at least this much.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = CLIO_MIN_MAX_OUTPUT_TOKENS;

/**
 * Process-wide default output budget requested per turn, sourced from
 * chat.maxOutputTokens at session start (see
 * {@link setGlobalDefaultMaxOutputTokens}). 0 means unset: callers fall back to
 * the model's advertised cap as before.
 */
let globalDefaultMaxOutputTokens = 0;

/**
 * Install the global default output budget. {@link remainingContextMaxTokens}
 * uses it as the requested value when the caller passes no explicit maxTokens
 * and no more-specific tool-turn limit applies. The value is always clamped
 * down to the model's cap and the remaining context window, so a model that
 * supports less still gets less. Non-positive values disable the default.
 */
export function setGlobalDefaultMaxOutputTokens(value: number): void {
	globalDefaultMaxOutputTokens = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Tokens a preflight context check should hold back for the response: the
 * smaller of the model's advertised output limit and the default output
 * budget. The safety margin is deliberately not added here; at request time
 * {@link remainingContextMaxTokens} subtracts it from the window and degrades
 * the output budget gracefully, so a hard preflight reservation of
 * limit + safety would compact earlier than the engine actually needs.
 */
export function resolveReservedOutputTokens(maxOutputTokens?: number | null): number {
	const limit =
		typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
			? maxOutputTokens
			: DEFAULT_MAX_OUTPUT_TOKENS;
	return Math.min(limit, DEFAULT_MAX_OUTPUT_TOKENS);
}

export function estimateInputTokensFromContext(context: Context): number {
	const system = context.systemPrompt ? ceilChars(context.systemPrompt.length) : 0;
	const messages = context.messages.reduce((sum, msg) => sum + estimateAgentMessageTokens(msg), 0);
	const tools = (context.tools ?? []).reduce((sum, tool) => sum + ceilChars(toolSchemaChars(tool)), 0);
	return system + messages + tools;
}

export function remainingContextMaxTokens(
	model: Pick<Model<Api>, "contextWindow" | "maxTokens">,
	context: Context,
	options: Pick<StreamOptions, "maxTokens"> | undefined,
	limits?: { contextWindow?: number; maxOutputTokens?: number },
): number {
	const safety = CONTEXT_BUDGET_SAFETY_TOKENS;
	const inputTokens = estimateInputTokensFromContext(context);
	const configuredContextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const loadedContextWindow =
		limits?.contextWindow !== undefined && limits.contextWindow > 0 ? limits.contextWindow : Number.POSITIVE_INFINITY;
	const contextWindow = Math.min(configuredContextWindow, loadedContextWindow);
	const budget = Number.isFinite(contextWindow)
		? Math.max(1, contextWindow - inputTokens - safety)
		: Number.POSITIVE_INFINITY;
	const modelLimit = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	// Precedence for the requested ceiling when the caller gave no explicit
	// maxTokens: a more-specific tool-turn limit, then the global default, then
	// the model's advertised cap. A model that advertises no cap uses the product
	// floor instead of requesting its entire remaining context window. Math.min
	// below clamps the result down to every known boundary, so frontier providers
	// with a known cap never receive a larger max_tokens value.
	const defaultLimit =
		limits?.maxOutputTokens !== undefined && limits.maxOutputTokens > 0
			? limits.maxOutputTokens
			: globalDefaultMaxOutputTokens > 0
				? globalDefaultMaxOutputTokens
				: model.maxTokens > 0
					? modelLimit
					: DEFAULT_MAX_OUTPUT_TOKENS;
	const requested = options?.maxTokens ?? defaultLimit;
	const resolved = Math.min(requested, modelLimit, budget);
	return Number.isFinite(resolved) ? resolved : DEFAULT_MAX_OUTPUT_TOKENS;
}
