import { createHash } from "node:crypto";
import type { PinnedPromptPrefix } from "./anthropic-system-split.js";

type Payload = Record<string, unknown>;

function record(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicit marks a request may place beside the implicit breakpoint: four cache writes, one of them implicit. */
const MAX_EXPLICIT_BREAKPOINTS = 3;

function breakpoints(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((total, child) => total + breakpoints(child), 0);
	if (!record(value)) return 0;
	return Number(Object.hasOwn(value, "prompt_cache_breakpoint")) + breakpoints(value.content);
}

function leadingText(item: Payload): string | null {
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content) || item.content.length !== 1) return null;
	const part = item.content[0];
	return record(part) && part.type === "input_text" && typeof part.text === "string" ? part.text : null;
}

/**
 * Keep the install prefix reusable on the public Responses API when the rest of the system prompt changes (PV-3,
 * C-08). From GPT-5.6 the backend looks its cache up at breakpoints only, and the leading developer message is one
 * block, so another project's handbook or a catalog change after the pinned layer missed the whole block. The
 * message's text becomes two `input_text` parts cut at the pinned boundary, the first carrying an explicit
 * breakpoint; the parts concatenate to the same text, and the implicit breakpoint at the latest message stays.
 *
 * Only for a model in the explicit prompt-cache regime (the caller checks Pi's compat flag). Unchanged when the
 * first input item is not the system prompt starting with the pinned layer, when caching is off (Pi sends
 * `mode: "explicit"` with no breakpoint for retention none, and a mark would turn writes back on), or when the
 * request already holds its explicit marks.
 *
 * Under long retention the pinned mark asks for the 12-hour lifetime (OI-7): Pi maps long to `ttl: "30m"`, the API's
 * default, on these models, so long changed nothing. Only the install-wide span is written at the 12-hour rate
 * (2.5x input against 1.25x); the conversation after it keeps the request's 30 minutes.
 */
export function splitOpenAISystem(payload: unknown, prefix: PinnedPromptPrefix, longRetention = false): unknown {
	if (!record(payload) || !Array.isArray(payload.input) || !Number.isSafeInteger(prefix.chars) || prefix.chars <= 0) {
		return payload;
	}
	if (record(payload.prompt_cache_options) && payload.prompt_cache_options.mode === "explicit") return payload;
	if (breakpoints(payload.input) >= MAX_EXPLICIT_BREAKPOINTS) return payload;
	const first = payload.input[0];
	if (!record(first) || (first.role !== "developer" && first.role !== "system")) return payload;
	const text = leadingText(first);
	if (text === null || text.length <= prefix.chars) return payload;
	const pinned = text.slice(0, prefix.chars);
	if (createHash("sha256").update(pinned).digest("hex") !== prefix.hash) return payload;
	const { content: _content, ...message } = first;
	return {
		...payload,
		input: [
			{
				...message,
				content: [
					{
						type: "input_text",
						text: pinned,
						prompt_cache_breakpoint: { mode: "explicit", ...(longRetention ? { ttl: "12h" } : {}) },
					},
					{ type: "input_text", text: text.slice(prefix.chars) },
				],
			},
			...payload.input.slice(1),
		],
	};
}
