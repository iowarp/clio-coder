import type { Api, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { ceilChars, estimateAgentMessageTokens, toolSchemaChars } from "../../domains/session/context-accounting.js";

const CONTEXT_BUDGET_SAFETY_TOKENS = 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Process-wide default output budget requested per turn, sourced from
 * settings.defaults.maxTokens at session start (see
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
 * Output ceiling applied to a llama.cpp tool-bearing turn when the caller did
 * not request an explicit limit. It bounds a genuinely runaway local
 * generation without muzzling real work: a single tool call that writes a
 * sizable file (a full HTML page, a multi-function source module) needs far
 * more than a few thousand tokens of argument, and the tool-call argument
 * counts against this same response budget. Narration loops where a local
 * model keeps saying it will call a tool without emitting one are caught
 * separately by assessToolProseLoop, so this number only has to be large
 * enough to let legitimate large outputs through.
 */
export const LOCAL_TOOL_TURN_MAX_OUTPUT_TOKENS = 16384;

/**
 * Tokens a preflight context check should hold back for the response: the
 * smaller of the model's advertised output limit and the default output
 * budget. The safety margin is deliberately not added here; at request time
 * {@link remainingContextMaxTokens} subtracts it from the window and degrades
 * the output budget gracefully, so a hard preflight reservation of
 * limit + safety would block small-window targets the engine can still serve.
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
	// the model's advertised cap. Math.min below clamps the result down to the
	// model cap and the remaining context budget regardless, so the global
	// default never lets a small model overshoot what it supports.
	const defaultLimit =
		limits?.maxOutputTokens !== undefined && limits.maxOutputTokens > 0
			? limits.maxOutputTokens
			: globalDefaultMaxOutputTokens > 0
				? globalDefaultMaxOutputTokens
				: modelLimit;
	const requested = options?.maxTokens ?? defaultLimit;
	const resolved = Math.min(requested, modelLimit, budget);
	return Number.isFinite(resolved) ? resolved : DEFAULT_MAX_OUTPUT_TOKENS;
}
