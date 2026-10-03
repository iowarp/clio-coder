import type { Api, AssistantMessage, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { CLIO_MIN_CONTEXT_WINDOW, CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../core/context-floor.js";
import { ceilChars, estimateAgentMessageTokens, toolSchemaChars } from "../../domains/session/context-accounting.js";
import { normalizeContext, resolvedRequestContext } from "../context.js";

/**
 * Pi clamps max_tokens to the remaining window on every simple stream, with its
 * own safety margin. The number-based preflight below has no context to hand
 * Pi, so it reads that margin off Pi's clamp rather than copying it, which keeps
 * the reservation equal to what reaches the wire.
 */
const MARGIN_PROBE_WINDOW = 1_000_000;
const CONTEXT_BUDGET_SAFETY_TOKENS =
	MARGIN_PROBE_WINDOW -
	clampMaxTokensToContext(
		{ contextWindow: MARGIN_PROBE_WINDOW } as Model<Api>,
		normalizeContext({ messages: [] }),
		MARGIN_PROBE_WINDOW,
	);

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
 * The output budget a model's profile suggests, read off the model metadata local synthesis
 * attaches. It ranks below every value the operator or the request set and above the model's
 * own cap, and the callers still clamp it to that cap and the remaining window.
 */
export function recommendedOutputTokens(model: unknown, servingWindow?: number): number | undefined {
	const value = (model as { clioCoder?: { quirks?: { outputTokens?: unknown } } } | null | undefined)?.clioCoder?.quirks
		?.outputTokens;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	// A profile is written against the model's native window, but the runtime may
	// serve far less: qwen3.8-27b recommends 131072 and LM Studio loads it at
	// 131072, which leaves no room for input (D5). Bound the recommendation by the
	// window actually served.
	const bound =
		servingWindow !== undefined && Number.isFinite(servingWindow) && servingWindow > 0
			? Math.max(1, Math.floor(servingWindow * MAX_RECOMMENDED_OUTPUT_SHARE))
			: Number.POSITIVE_INFINITY;
	return Math.min(Math.floor(value), bound);
}

/** Largest share of the serving window a profile recommendation may claim for output. */
const MAX_RECOMMENDED_OUTPUT_SHARE = 0.5;

/**
 * Largest share of the serving window the worker pressure guard reserves for
 * output, the product ratio of {@link CLIO_MIN_MAX_OUTPUT_TOKENS} to
 * {@link CLIO_MIN_CONTEXT_WINDOW}.
 */
const MAX_PRESSURE_OUTPUT_SHARE = CLIO_MIN_MAX_OUTPUT_TOKENS / CLIO_MIN_CONTEXT_WINDOW;

function clampsOutputAtWire(api: string): boolean {
	return api === "openai-completions" || api === "ollama-native";
}

/**
 * Output reserve for the worker pressure ceiling. The preflight reserve from
 * {@link resolveReservedOutputTokens} is already clamped to the room left after
 * the current input, so feeding it to a ceiling of `window - reserve` collapses
 * the ceiling to roughly the input itself and exhausts a worker with most of its
 * window free (D5). Transports that shrink max_tokens to the remaining room get
 * the unclamped budget bounded by a fixed share of the serving window instead.
 */
export function resolvePressureOutputReserve(
	maxOutputTokens: number | null | undefined,
	request: { api: string; contextWindow: number },
	recommendedTokens?: number,
): number {
	const ceiling = resolveReservedOutputTokens(maxOutputTokens, undefined, recommendedTokens);
	if (!clampsOutputAtWire(request.api) || !Number.isFinite(request.contextWindow) || request.contextWindow <= 0) {
		return ceiling;
	}
	return Math.min(ceiling, Math.floor(request.contextWindow * MAX_PRESSURE_OUTPUT_SHARE));
}

/**
 * Tokens a preflight context check should hold back for the response: the
 * smaller of the model's advertised output limit and the configured output
 * budget, falling back to the product default when no budget is configured.
 * The safety margin is deliberately not added here; at request time
 * {@link remainingContextMaxTokens} subtracts it from the window and degrades
 * the output budget gracefully, so a hard preflight reservation of
 * limit + safety would compact earlier than the engine actually needs.
 */
export function resolveReservedOutputTokens(
	maxOutputTokens?: number | null,
	request?: { api: string; contextWindow: number; inputTokens: number },
	recommendedTokens?: number,
): number {
	const requested =
		globalDefaultMaxOutputTokens > 0 ? globalDefaultMaxOutputTokens : (recommendedTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
	const limit =
		typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
			? maxOutputTokens
			: Number.POSITIVE_INFINITY;
	const ceiling = Math.min(limit, requested);
	// These Clio transports already reduce the wire ceiling to remaining room.
	// Preflight must use that same allocation, rather than demanding room for
	// the entire configured maximum (which may equal the context window).
	// Other transports retain their existing reservation contract.
	return request && clampsOutputAtWire(request.api)
		? clampOutputToRemainingContext(ceiling, request.contextWindow, request.inputTokens)
		: ceiling;
}

function clampOutputToRemainingContext(ceiling: number, contextWindow: number, inputTokens: number): number {
	const available =
		contextWindow > 0 && Number.isFinite(contextWindow)
			? Math.max(1, contextWindow - inputTokens - CONTEXT_BUDGET_SAFETY_TOKENS)
			: Number.POSITIVE_INFINITY;
	return Math.min(ceiling, available);
}

export function estimateInputTokensFromContext(input: Context): number {
	const context = resolvedRequestContext(input);
	const system = context.systemPrompt ? ceilChars(context.systemPrompt.length) : 0;
	const messages = context.messages.reduce((sum, msg) => sum + estimateAgentMessageTokens(msg), 0);
	const tools = (context.tools ?? []).reduce((sum, tool) => sum + ceilChars(toolSchemaChars(tool)), 0);
	return system + messages + tools;
}

export function remainingContextMaxTokens(
	model: Pick<Model<Api>, "contextWindow" | "maxTokens"> & { clioCoder?: unknown },
	context: Context,
	options: Pick<StreamOptions, "maxTokens"> | undefined,
): number {
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const modelLimit = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	// Precedence for the requested ceiling when the caller gave no explicit
	// maxTokens: the global default, then the profile's recommendation, then the
	// model's advertised cap. A model that advertises no cap uses the product
	// floor instead of requesting its entire remaining context window. Math.min
	// below clamps the result down to every known boundary, so frontier providers
	// with a known cap never receive a larger max_tokens value.
	const defaultLimit =
		globalDefaultMaxOutputTokens > 0
			? globalDefaultMaxOutputTokens
			: (recommendedOutputTokens(model, contextWindow) ?? (model.maxTokens > 0 ? modelLimit : DEFAULT_MAX_OUTPUT_TOKENS));
	const requested = options?.maxTokens ?? defaultLimit;
	const resolved = clampMaxTokensToContext(
		{ contextWindow } as Model<Api>,
		normalizeContext(context),
		Math.min(requested, modelLimit),
	);
	return Number.isFinite(resolved) ? resolved : DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Reasoning tokens inferred from visible thinking text, for servers that report none. */
export function estimateReasoningTokens(content: AssistantMessage["content"]): number {
	return estimateTextTokens(content.map((block) => (block.type === "thinking" ? block.thinking : "")).join(""));
}
