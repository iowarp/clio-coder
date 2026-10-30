/**
 * Hosted prompt-cache keepalive: which requests can be replayed to refresh their cache entry, how long that entry
 * lives, what a refresh costs against the miss it prevents, and the replay itself (#423). Scheduling and admission
 * belong to the caller (`src/session-control/turn-keepalive.ts`).
 */

import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { calculateEngineCost } from "./ai.js";
import { engineMainStreamSimple } from "./api-registry.js";
import { effectiveCacheRetention } from "./provider-diagnostics.js";

/** A main-turn request exactly as the turn sent it, which a keepalive replays to refresh its cache entry. */
export interface CacheKeepaliveRequest {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

export type CacheKeepaliveRefusal = "retention-none" | "lifetime-unknown" | "output-uncapped" | "budget-thinking";

export type CacheKeepaliveRoute =
	| { ok: true; ttlMs: number; delayMs: number; outputTokens: number }
	| { ok: false; reason: CacheKeepaliveRefusal };

/** The parts of a provider reply the keepalive reads; an assistant message satisfies it. */
export interface CacheKeepaliveReply {
	stopReason: string;
	errorMessage?: string;
	usage: Usage;
}

/**
 * OpenAI documents that a cached prefix stays active for 5 to 10 minutes of inactivity, and for 24 hours under
 * extended retention. Pi 1.4's catalog declares no lifetime for OpenAI models, so the keepalive assumes the floor.
 */
const OPENAI_IN_MEMORY_CACHE_SECONDS = 300;
const OPENAI_EXTENDED_CACHE_SECONDS = 24 * 60 * 60;
/** Pi raises a smaller Responses output cap to 16, the API's minimum. */
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/** A refresh is worth sending only when it is expected to save at least this much. */
export const CACHE_KEEPALIVE_MIN_SAVINGS_USD = 0.05;

/** Refresh at 90% of the lifetime, keeping at least ten seconds of margin. */
function refreshDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

function route(ttlSeconds: number | undefined, outputTokens: number): CacheKeepaliveRoute {
	const ttlMs = ttlSeconds === undefined ? undefined : ttlSeconds * 1000;
	const delayMs = ttlMs === undefined ? undefined : refreshDelayMs(ttlMs);
	return ttlMs === undefined || delayMs === undefined
		? { ok: false, reason: "lifetime-unknown" }
		: { ok: true, ttlMs, delayMs, outputTokens };
}

/** The lifetime of a cached prefix on this route under `retention`, in seconds, or undefined when none is known. */
function lifetimeSeconds(model: Model<Api>, retention: "short" | "long"): number | undefined {
	const declared = model.promptCache?.[retention];
	switch (model.api) {
		case "openai-responses": {
			const compat = (model as Model<"openai-responses">).compat;
			const extended = retention === "long" && compat?.supportsLongCacheRetention !== false;
			return declared ?? (extended ? OPENAI_EXTENDED_CACHE_SECONDS : OPENAI_IN_MEMORY_CACHE_SECONDS);
		}
		case "openai-codex-responses":
			// Measured on gpt-6-luna, 2026-10-30 (#423): the backend rejects prompt_cache_retention ("Unsupported
			// parameter"), so Codex has no retention path and declares no lifetime; OpenAI's documented floor holds.
			return OPENAI_IN_MEMORY_CACHE_SECONDS;
		default:
			return declared;
	}
}

/**
 * How long a cached prefix lives on `model`'s route for a main-turn request with `options`, in seconds. Undefined
 * when caching is off for the request or the route declares no lifetime. The keepalive and the per-call cache
 * telemetry read the same answer, so idle expiry is judged against the lifetime a refresh would have kept (#423).
 */
export function cacheLifetimeSeconds(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention = effectiveCacheRetention(model, options, "main") ?? "short";
	return retention === "none" ? undefined : lifetimeSeconds(model, retention);
}

/** Whether a keepalive can replay `request` with a bounded output, and how long its cache entry lives. */
export function cacheKeepaliveRoute(request: CacheKeepaliveRequest): CacheKeepaliveRoute {
	const { model, options } = request;
	const retention = effectiveCacheRetention(model, options, "main") ?? "short";
	if (retention === "none") return { ok: false, reason: "retention-none" };
	const lifetime = lifetimeSeconds(model, retention);
	switch (model.api) {
		case "anthropic-messages":
			// Budget thinking needs max_tokens above its budget, so a one-token replay is rejected; adaptive has none.
			if (options?.reasoning && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking !== true)
				return { ok: false, reason: "budget-thinking" };
			return route(lifetime, 1);
		case "openai-responses":
			if ((model as Model<"openai-responses">).compat?.supportsMaxOutputTokens === false)
				return { ok: false, reason: "output-uncapped" };
			return route(lifetime, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
		case "openai-codex-responses":
			// Codex accepts max_output_tokens (the 16-token-capped request's unmodified follow-up read 1280 of its
			// 1408 prompt tokens from cache, 2026-10-30); Pi's adapter sends no cap, so the replay adds it to the body.
			return route(lifetime, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
		default:
			return route(lifetime, 1);
	}
}

export interface CacheKeepaliveEconomics {
	/** A cache read of the prompt plus the capped output. */
	warmUsd: number;
	/** What the next request pays extra when the entry has expired. */
	missUsd: number;
	expectedSavingsUsd: number;
	/** False when the prompt size or the route's prices are unknown. */
	available: boolean;
}

function priced(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateEngineCost(model, usage).total;
}

/**
 * Price one refresh against the miss it prevents. The caller supplies the chance that a real request arrives after
 * the entry would have expired; a turn waiting on its own tools will send one.
 */
export function cacheKeepaliveEconomics(
	model: Model<Api>,
	promptTokens: number,
	outputTokens: number,
	continuationProbability: number,
): CacheKeepaliveEconomics {
	const hit = priced(model, { cacheRead: promptTokens });
	const miss = priced(model, model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens });
	const warmUsd = priced(model, { cacheRead: promptTokens, output: outputTokens });
	const missUsd = Math.max(0, miss - hit);
	return {
		warmUsd,
		missUsd,
		expectedSavingsUsd: continuationProbability * missUsd - warmUsd,
		available: promptTokens > 0 && (hit > 0 || miss > 0),
	};
}

/** Prompt tokens a finished request processed, cached or not. */
export function cacheKeepalivePromptTokens(message: CacheKeepaliveReply): number {
	const usage = message.usage;
	return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

/** The replayed request's options: the route's output cap, no retries and the keepalive's own signal. */
export function cacheKeepaliveOptions(
	request: CacheKeepaliveRequest,
	outputTokens: number,
	signal: AbortSignal,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { ...request.options, maxTokens: outputTokens, maxRetries: 0, signal };
	if (request.model.api !== "openai-codex-responses") return options;
	// Pi's Codex adapter ignores maxTokens; the cap goes on the body after the turn's own payload edits.
	const onPayload = request.options?.onPayload;
	return {
		...options,
		onPayload: async (payload, model) => {
			const base = (await onPayload?.(payload, model)) ?? payload;
			return base !== null && typeof base === "object" && !Array.isArray(base)
				? { ...(base as Record<string, unknown>), max_output_tokens: outputTokens }
				: base;
		},
	};
}

/**
 * Replay `request` through the main-turn engine path with the route's output cap and no retries. Resolves with the
 * provider's message; a failure is an error message, never a throw, because a refresh must not break the turn.
 */
export async function replayCacheKeepalive(
	request: CacheKeepaliveRequest,
	outputTokens: number,
	signal: AbortSignal,
): Promise<CacheKeepaliveReply> {
	return engineMainStreamSimple(
		request.model,
		request.context,
		cacheKeepaliveOptions(request, outputTokens, signal),
	).result();
}
