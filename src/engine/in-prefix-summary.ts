/**
 * A compaction summary asked inside the live request prefix the provider already caches (T4).
 *
 * The portable summarizer sends its own system prompt and a serialized slice of history, so the provider cache the
 * session built holds none of it. This module rebuilds the request the next turn would send, confirms it still
 * extends the last request the turn actually sent while that request's cache entry can still serve it, and appends
 * the compaction instruction as the one new user message. Tool choice, thinking and every request option stay those
 * of the last request: a change there moves the prompt bytes (llama.cpp chat templates, OpenAI `prompt_cache_key`)
 * or, on Anthropic, drops the cached messages.
 *
 * Two kinds of cache qualify. A hosted cache (Anthropic, OpenAI Responses) keeps a prefix for a known lifetime and
 * bills a read at a fraction of input. A slot cache (llama-server's `cache_prompt`, also behind LiteLLM) declares no
 * lifetime and bills nothing: it keeps the last prompt's KV state until another request takes the slot. It is trusted
 * only on a route the caller knows bills nothing (a local-native runtime, or a target declaring `pricing: free` or zero
 * rates) whose last request just reported reusing a prefix. Zero catalog rates alone prove nothing: an unpriced
 * gateway such as LiteLLM can front a paid backend whose cache neither behaves like a slot nor is free.
 *
 * Whether the request is worth sending is the caller's call; `inputCost` prices it in base-input tokens (prefill
 * tokens on a slot cache) so the caller can weigh it against the portable request.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { engineMainStreamSimple } from "./api-registry.js";
import { estimateInputTokensFromContext } from "./apis/output-budget.js";
import { type CacheKeepaliveRequest, cacheLifetimeSeconds } from "./cache-keepalive.js";
import { normalizeContext } from "./context.js";

/** Anthropic's documented price multipliers on base input, used when the catalog row carries no cache prices. */
const ANTHROPIC_CACHE_READ_WEIGHT = 0.1;
const ANTHROPIC_CACHE_WRITE_WEIGHT = 1.25;
/** OpenAI's smallest documented cached-input discount (half price); newer models discount more. No write premium. */
const OPENAI_CACHE_READ_WEIGHT = 0.5;
/**
 * A slot cache reuses a prefix only up to its last saved checkpoint, then prefills the rest again. Measured through
 * LiteLLM on llama-server (mini/qwen3.8-27b-iq4r-v4, 2026-11-06): an unchanged prefix reused 10,240 of 12,454 prompt
 * tokens and 49,152 of 53,054, so up to this many cached tokens are counted as prefilled again.
 */
const SLOT_RESTORE_SLACK_TOKENS = 4096;
/** A request sent this close to the entry's expiry may reach the provider after it lapses. */
const EXPIRY_MARGIN_MS = 30_000;

/** The last main-turn request a runtime sent, as the keepalive also follows it, with its provider prompt size. */
export interface MainRequestRecord {
	request: CacheKeepaliveRequest;
	sentAt: number;
	/** Prompt tokens the provider reported for it, cached or not; null until it settles or when it failed. */
	promptTokens: number | null;
	/** Of those, the tokens the provider reported reading from its prefix cache; null until it settles. */
	cachedTokens: number | null;
}

export type InPrefixRefusal =
	| "unsupported-api"
	| "no-request"
	| "prompt-unknown"
	| "expired"
	| "lifetime-unknown"
	| "no-cache-reuse"
	| "tool-choice"
	| "pending-tools"
	| "prefix-moved";

export interface InPrefixSummary {
	/** The route the request goes to; a compaction resolved to any other model cannot use it. */
	model: { id: string; provider: string };
	/** Base-input-equivalent tokens this request costs before output, with `tail` as the appended message. */
	inputCost(tail: string): number;
	/** Estimated input tokens of the whole request, for the window fit check. */
	inputTokens(tail: string): number;
	stream(
		tail: string,
		options: { maxTokens?: number; signal?: AbortSignal; fetch?: typeof globalThis.fetch },
	): AssistantMessageEventStream;
}

function tailMessage(text: string): Context["messages"][number] {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** What one token costs on the route, in base-input tokens: a cache read, a fresh token, and the reuse shortfall. */
interface PrefixPricing {
	read: number;
	write: number;
	slack: number;
}

function hostedPricing(model: Model<Api>): PrefixPricing {
	const anthropic = model.api === "anthropic-messages";
	const { input, cacheRead, cacheWrite } = model.cost;
	if (input > 0 && cacheRead > 0) {
		const write = cacheWrite > 0 ? cacheWrite / input : anthropic ? ANTHROPIC_CACHE_WRITE_WEIGHT : 1;
		return { read: cacheRead / input, write, slack: 0 };
	}
	return anthropic
		? { read: ANTHROPIC_CACHE_READ_WEIGHT, write: ANTHROPIC_CACHE_WRITE_WEIGHT, slack: 0 }
		: { read: OPENAI_CACHE_READ_WEIGHT, write: 1, slack: 0 };
}

/** What the caller knows about the route beyond the model row. */
export interface InPrefixRoute {
	/**
	 * The route's billing resolved free: a local-native runtime, or a target declaring `pricing: free` or zero rates.
	 * An unpriced gateway is not free; its pricing is unknown.
	 */
	free: boolean;
}

/** Routes whose request is the whole transcript re-sent, so an appended message extends the cached prefix. */
const PREFIX_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-responses", "openai-completions"]);

/**
 * Rebuild the live request and check it can be served from the last request's cache entry. A refusal names why;
 * any refusal means the portable summary is the only honest route.
 */
export async function prepareInPrefixSummary(
	agent: Agent,
	last: MainRequestRecord | undefined,
	route: InPrefixRoute,
	signal?: AbortSignal,
	now = Date.now(),
): Promise<InPrefixSummary | InPrefixRefusal> {
	const model = agent.state.model;
	if (!PREFIX_APIS.has(model.api)) return "unsupported-api";
	if (!last || last.request.model.id !== model.id || last.request.model.provider !== model.provider) return "no-request";
	if (last.promptTokens === null || last.promptTokens <= 0) return "prompt-unknown";
	const lifetime = cacheLifetimeSeconds(last.request.model, last.request.options);
	let pricing: PrefixPricing;
	if (lifetime !== undefined) {
		if (now - last.sentAt > lifetime * 1000 - EXPIRY_MARGIN_MS) return "expired";
		pricing = hostedPricing(last.request.model);
	} else {
		// Without a declared lifetime only a route known to bill nothing is read as a slot cache; any other route
		// (priced, or an unpriced gateway in front of an unknown backend) may have dropped the entry and bill the miss.
		if (!route.free) return "lifetime-unknown";
		// A slot cache has no clock: the last request reading from it is the evidence that it holds this prefix.
		if (!last.cachedTokens || last.cachedTokens <= 0) return "no-cache-reuse";
		pricing = { read: 0, write: 1, slack: Math.min(last.promptTokens, SLOT_RESTORE_SLACK_TOKENS) };
	}
	// A forced or suppressed tool choice keys a different message cache than the auto request sent here.
	const choice = last.request.options?.toolChoice;
	if (choice !== undefined && choice !== "auto") return "tool-choice";

	let messages = structuredClone(agent.state.messages);
	if (agent.transformContext) messages = await agent.transformContext(messages, signal);
	const live = normalizeContext({ messages: await agent.convertToLlm(messages) }).messages;
	signal?.throwIfAborted();
	// A tool call without its result is a request Anthropic and OpenAI reject (#423).
	const pending = new Set<string>();
	for (const message of live) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
		} else if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	if (pending.size > 0) return "pending-tools";
	// The cache serves only a byte-identical prefix. Anything the last request carried that the live transcript no
	// longer starts with (a recompiled prompt, an eviction, a locked synthesis round) is a miss, not a discount.
	const sent = normalizeContext(last.request.context).messages;
	if (
		sent.length > live.length ||
		sent.some((message, index) => JSON.stringify(message) !== JSON.stringify(live[index]))
	)
		return "prefix-moved";

	// The turn's credential may have been refreshed since; the stored one is only a fallback.
	const apiKey = (await agent.getApiKey?.(model.provider)) ?? last.request.options?.apiKey;
	signal?.throwIfAborted();
	const cached = last.promptTokens;
	const context = (tail: string): Context => ({ messages: [...live, tailMessage(tail)] });
	const appended = (tail: string): number =>
		estimateInputTokensFromContext({ messages: [...live.slice(sent.length), tailMessage(tail)] });
	const { read, write, slack } = pricing;
	return {
		model: { id: last.request.model.id, provider: last.request.model.provider },
		inputCost: (tail) => read * cached + slack + write * appended(tail),
		inputTokens: (tail) => cached + appended(tail),
		stream: (tail, options) => {
			// The turn's signal, output cap and transport hooks belong to that turn; everything that shapes the
			// prompt bytes is kept.
			const { signal: _turn, maxTokens: _cap, fetch: _fetch, apiKey: _key, ...shape } = last.request.options ?? {};
			const requested: SimpleStreamOptions = {
				...shape,
				...(apiKey !== undefined ? { apiKey } : {}),
				...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
				...(options.signal !== undefined ? { signal: options.signal } : {}),
				...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
			};
			return engineMainStreamSimple(last.request.model, context(tail), requested);
		},
	};
}
