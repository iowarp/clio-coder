import type { Api, AssistantMessage, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../core/context-floor.js";
import { ceilChars, estimateAgentMessageTokens, toolSchemaChars } from "../../domains/session/context-accounting.js";
import { normalizeContext, resolvedRequestContext } from "../context.js";

/**
 * Pi clamps max_tokens to the remaining window on every simple stream, with its
 * own safety margin. Clio's clamp below reads that margin off Pi's clamp rather
 * than copying it, so a Pi change moves both. Only the margin comes from Pi: the
 * input is sized by {@link estimateInputTokensFromContext}, because Pi's
 * estimator anchors on the last assistant usage, which is stale after
 * observation masking or working-set eviction (the `contextUsageInvalidated`
 * stamp), and it throws on an assistant message that carries no usage. A worker
 * request carries its guard's own count instead ({@link PinnedInputTokens}).
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
 * The output reserve a request needs to be sendable at all on a small window: a
 * usable 4,096-token response plus the margin Pi's clamp subtracts, so the wire
 * still allocates that response (ContextFold A5).
 */
export const ADMISSIBLE_OUTPUT_RESERVE = 4_096 + CONTEXT_BUDGET_SAFETY_TOKENS;

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
 * uses it as the requested value when the caller passes no explicit maxTokens.
 * The value is always clamped down to the model's cap and the remaining context window, so a model that
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
	return Math.min(Math.floor(value), windowOutputBound(servingWindow));
}

/** Largest share of the serving window a profile recommendation or the product default may claim for output. */
const MAX_RECOMMENDED_OUTPUT_SHARE = 0.5;

function windowOutputBound(servingWindow: number | undefined): number {
	return servingWindow !== undefined && Number.isFinite(servingWindow) && servingWindow > 0
		? Math.max(1, Math.floor(servingWindow * MAX_RECOMMENDED_OUTPUT_SHARE))
		: Number.POSITIVE_INFINITY;
}

function clampsOutputAtWire(api: string): boolean {
	return api === "openai-completions" || api === "ollama-native";
}

/**
 * The output reserve one request is admitted against, at that request's own
 * input size: the model's capability cap, the configured budget, the profile
 * recommendation and the serving window, through {@link resolveReservedOutputTokens}.
 * The main loop's admission and the worker pressure guard both resolve through
 * it, so a worker on the parent's model and window reserves what the parent's
 * fit check assumed (D1-5). The reserve depends on the input for wire-clamped
 * transports, so a caller tests `input + reserve(input) <= window` rather than
 * deriving a fixed ceiling from one reserve (D5).
 */
export function requestOutputReserve(
	model: { api?: string } | null | undefined,
	maxOutputTokens: number | null | undefined,
	contextWindow: number,
	inputTokens: number,
): number {
	return resolveReservedOutputTokens(
		maxOutputTokens,
		{ api: model?.api ?? "", contextWindow, inputTokens },
		recommendedOutputTokens(model, contextWindow),
	);
}

/**
 * The output ceiling a reserve starts from. A configured chat.maxOutputTokens
 * is the operator's choice and is held as is, up to the model's cap, even when
 * the window cannot hold it, so admission refuses it by name instead of
 * shrinking it silently. Without one, the profile recommendation or the product
 * default may claim at most half the serving window: a 40K window capped by
 * --max-context-tokens would otherwise reserve 32768 and refuse every request
 * (bt-13).
 */
function outputCeiling(
	maxOutputTokens: number | null | undefined,
	recommendedTokens: number | undefined,
	window?: number,
) {
	const limit =
		typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
			? maxOutputTokens
			: Number.POSITIVE_INFINITY;
	if (globalDefaultMaxOutputTokens > 0) return Math.min(limit, globalDefaultMaxOutputTokens);
	return Math.min(limit, recommendedTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, windowOutputBound(window));
}

/** The operator's chat.maxOutputTokens, or null when unset. */
export function configuredMaxOutputTokens(): number | null {
	return globalDefaultMaxOutputTokens > 0 ? globalDefaultMaxOutputTokens : null;
}

/**
 * Tokens a preflight context check should hold back for the response: the
 * smaller of the model's advertised output limit and the configured output
 * budget, falling back to the product default when no budget is configured.
 * The default never claims more than half of the request's window.
 * The safety margin is not added to the full allowance: at request time
 * {@link remainingContextMaxTokens} subtracts it from the window and degrades
 * the output budget gracefully, so a hard preflight reservation of
 * limit + safety would compact earlier than the engine actually needs. For the
 * transports that degrade, the reserve still covers a usable floor plus that
 * margin, so the degraded allocation can never shrink to nothing.
 */
export function resolveReservedOutputTokens(
	maxOutputTokens?: number | null,
	request?: { api: string; contextWindow: number; inputTokens: number },
	recommendedTokens?: number,
): number {
	const ceiling = outputCeiling(maxOutputTokens, recommendedTokens, request?.contextWindow);
	// These Clio transports already reduce the wire ceiling to remaining room.
	// Preflight must use that same allocation, rather than demanding room for
	// the entire configured maximum (which may equal the context window).
	// Other transports retain their existing reservation contract.
	return request && clampsOutputAtWire(request.api) ? admissionReserve(ceiling, request) : ceiling;
}

/** Smallest share of the serving window a wire-clamped request must still leave for the response. */
const MIN_ADMITTED_OUTPUT_SHARE = 1 / 8;

/**
 * The reserve a wire-clamped request is admitted against. The wire shrinks
 * max_tokens to the room left after input and the safety margin, which alone
 * would admit a near-full request with a one-token response. The reserve is
 * therefore never below a usable floor plus the margin the wire subtracts, so
 * `input + reserve <= window` holds exactly when the wire allocation is at
 * least that floor. A larger wire allocation is reserved as is.
 */
function admissionReserve(ceiling: number, request: { contextWindow: number; inputTokens: number }): number {
	const window = request.contextWindow;
	if (!(window > 0) || !Number.isFinite(window)) return ceiling;
	const floor = usableOutputFloor(ceiling, window);
	const wire = clampOutputToRemainingContext(ceiling, window, request.inputTokens);
	return Math.max(floor + CONTEXT_BUDGET_SAFETY_TOKENS, wire);
}

/** The smallest response a request is worth sending with: a share of the window, never above what was asked for. */
function usableOutputFloor(ceiling: number, contextWindow: number): number {
	return Math.min(ceiling, Math.max(1, Math.floor(contextWindow * MIN_ADMITTED_OUTPUT_SHARE)));
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

/**
 * A request's input as its caller already counted and admitted it. A worker's
 * context guard sets `clioInputTokens` to the figure its fit check passed, so
 * admission sizes the request it fitted rather than recounting it another way
 * (A2c). The main loop sets it on every main request to the figure its
 * admission read from the published view: the A4 count after an overflow fit,
 * the live estimate otherwise.
 */
export interface PinnedInputTokens {
	clioInputTokens?: number;
}

function requestInputTokens(context: Context, options: PinnedInputTokens | undefined): number {
	const pinned = options?.clioInputTokens;
	return typeof pinned === "number" && Number.isFinite(pinned) && pinned > 0
		? pinned
		: estimateInputTokensFromContext(context);
}

/**
 * The provider-bound copy of a request whose input the caller already counted,
 * re-anchored so Pi's clamp reads that same count. Pi sizes the input from the
 * newest assistant usage plus the messages after it, and a worker's projection
 * changes the prefix under that usage without invalidating it, so a guard
 * eviction left Pi clamping against the request before the eviction. The anchor
 * Pi would pick gets usage equal to the count less Pi's own estimate of the
 * trailing messages. Usage never reaches the wire, and the originals are not
 * touched. A request with no assistant to anchor on keeps Pi's own estimate.
 */
export function anchorContextAtInputTokens(context: Context, inputTokens: number): Context {
	if (!(inputTokens > 0) || !Number.isFinite(inputTokens)) return context;
	let latest = Number.NEGATIVE_INFINITY;
	let anchor: AssistantMessage | undefined;
	let trailing = 0;
	// Pi's rule (`getLastAssistantUsageInfo`): a usable answer no newer prefix message precedes.
	for (const message of normalizeContext(context).messages) {
		if (
			message.role === "assistant" &&
			message.timestamp >= latest &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			anchor = message;
			trailing = 0;
		} else trailing += estimateMessageTokens(message);
		latest = Math.max(latest, message.timestamp);
	}
	if (anchor === undefined) return context;
	const tokens = Math.max(1, Math.round(inputTokens) - trailing);
	const usage = { ...anchor.usage, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens };
	return {
		...context,
		messages: context.messages.map((message) => (message === anchor ? { ...anchor, usage } : message)),
	};
}

export function remainingContextMaxTokens(
	model: Pick<Model<Api>, "contextWindow" | "maxTokens"> & { clioCoder?: unknown },
	context: Context,
	options: (Pick<StreamOptions, "maxTokens"> & PinnedInputTokens) | undefined,
): number {
	const inputTokens = requestInputTokens(context, options);
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const resolved = clampOutputToRemainingContext(requestedOutputCeiling(model, options), contextWindow, inputTokens);
	return Number.isFinite(resolved) ? resolved : DEFAULT_MAX_OUTPUT_TOKENS;
}

function requestedOutputCeiling(
	model: Pick<Model<Api>, "contextWindow" | "maxTokens"> & { clioCoder?: unknown },
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
	return Math.min(requested, modelLimit);
}

/** Opens the overflow error Clio raises itself, before any provider call, so recovery can say who refused. */
export const LOCAL_CONTEXT_OVERFLOW_PREFIX = "Context window exceeded before the provider call";

/**
 * Why a request must not go out: the output budget it would actually carry
 * falls below the usable floor preflight admission reserves. `sentMaxTokens`
 * is the final wire value, after Pi's own clamp of the provider-bound
 * `context`, and `options` are the caller's options before
 * {@link remainingContextMaxTokens} filled them in. A request with a token or
 * two of output budget ends at `stopReason=length` having said nothing, so it
 * is refused before the call as a context overflow, which the session answers
 * with a forced fit and one retry. Null when the request may be sent.
 */
export function outputBudgetShortfall(
	model: Pick<Model<Api>, "contextWindow" | "maxTokens"> & { clioCoder?: unknown },
	context: Context,
	options: (Pick<StreamOptions, "maxTokens"> & PinnedInputTokens) | undefined,
): string | null {
	const contextWindow = model.contextWindow;
	if (!(contextWindow > 0) || !Number.isFinite(contextWindow)) return null;
	const ceiling = requestedOutputCeiling(model, options);
	if (!Number.isFinite(ceiling)) return null;
	const clio = remainingContextMaxTokens(model, context, options);
	const sent = clampMaxTokensToContext(model as Model<Api>, normalizeContext(context), clio);
	const floor = usableOutputFloor(ceiling, contextWindow);
	if (sent >= floor) return null;
	return `${LOCAL_CONTEXT_OVERFLOW_PREFIX}: the request would leave ${sent} output tokens of a ${contextWindow}-token window (estimated input ${requestInputTokens(context, options)}), below the usable minimum of ${floor}.`;
}

/** Reasoning tokens inferred from visible thinking text, for servers that report none. */
export function estimateReasoningTokens(content: AssistantMessage["content"]): number {
	return estimateTextTokens(content.map((block) => (block.type === "thinking" ? block.thinking : "")).join(""));
}
