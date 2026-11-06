/**
 * A compaction summary asked inside the live Anthropic request prefix (T4).
 *
 * The portable summarizer sends its own system prompt and a serialized slice of history, so the provider cache the
 * session built holds none of it. On Anthropic the main turn's prefix (system blocks, tool declarations, messages) is
 * a cache entry the summary can read at a tenth of the input price: this module rebuilds the request the next turn
 * would send, confirms it still extends the last request the turn actually sent while that entry lives, and appends
 * the compaction instruction as the one new user message. Tool choice, thinking and every request option stay those
 * of the last request, because Anthropic drops the cached messages when tool choice or thinking changes.
 *
 * Whether the request is worth sending is the caller's call; `inputCost` prices it in base-input tokens so the
 * caller can weigh it against the portable request.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { engineMainStreamSimple } from "./api-registry.js";
import { estimateInputTokensFromContext } from "./apis/output-budget.js";
import { type CacheKeepaliveRequest, cacheLifetimeSeconds } from "./cache-keepalive.js";
import { normalizeContext } from "./context.js";

/** Anthropic's documented price multipliers on base input, used when the catalog row carries no cache prices. */
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;
/** A request sent this close to the entry's expiry may reach the provider after it lapses. */
const EXPIRY_MARGIN_MS = 30_000;

/** The last main-turn request a runtime sent, as the keepalive also follows it, with its provider prompt size. */
export interface MainRequestRecord {
	request: CacheKeepaliveRequest;
	sentAt: number;
	/** Prompt tokens the provider reported for it, cached or not; null until it settles or when it failed. */
	promptTokens: number | null;
}

export type InPrefixRefusal =
	| "not-anthropic"
	| "no-request"
	| "prompt-unknown"
	| "expired"
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

function weights(model: Model<Api>): { read: number; write: number } {
	const { input, cacheRead, cacheWrite } = model.cost;
	return input > 0 && cacheRead > 0 && cacheWrite > 0
		? { read: cacheRead / input, write: cacheWrite / input }
		: { read: CACHE_READ_WEIGHT, write: CACHE_WRITE_WEIGHT };
}

/**
 * Rebuild the live request and check it can be served from the last request's cache entry. A refusal names why;
 * any refusal means the portable summary is the only honest route.
 */
export async function prepareInPrefixSummary(
	agent: Agent,
	last: MainRequestRecord | undefined,
	signal?: AbortSignal,
	now = Date.now(),
): Promise<InPrefixSummary | InPrefixRefusal> {
	const model = agent.state.model;
	if (model.api !== "anthropic-messages") return "not-anthropic";
	if (!last || last.request.model.id !== model.id || last.request.model.provider !== model.provider) return "no-request";
	if (last.promptTokens === null || last.promptTokens <= 0) return "prompt-unknown";
	const lifetime = cacheLifetimeSeconds(last.request.model, last.request.options);
	if (lifetime === undefined || now - last.sentAt > lifetime * 1000 - EXPIRY_MARGIN_MS) return "expired";
	// A forced or suppressed tool choice keys a different message cache than the auto request sent here.
	const choice = last.request.options?.toolChoice;
	if (choice !== undefined && choice !== "auto") return "tool-choice";

	let messages = structuredClone(agent.state.messages);
	if (agent.transformContext) messages = await agent.transformContext(messages, signal);
	const live = normalizeContext({ messages: await agent.convertToLlm(messages) }).messages;
	signal?.throwIfAborted();
	// A tool call without its result is a request Anthropic rejects (#423).
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
	const { read, write } = weights(last.request.model);
	return {
		model: { id: last.request.model.id, provider: last.request.model.provider },
		inputCost: (tail) => read * cached + write * appended(tail),
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
