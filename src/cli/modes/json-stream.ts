/**
 * Projection from chat-loop events to the headless `--json` wire stream.
 *
 * The stream is append-oriented: it carries each piece of content exactly
 * once, as an increment while it streams and as one completed message when it
 * lands. It never repeats the growing snapshot of an in-progress message,
 * because that is quadratic in a long turn. One tool-heavy SciCode sub-step
 * wrote 802 MB of stdout, 99.3% of it `message_update` snapshots of a message
 * whose final form is 44 KB.
 *
 * The rules, in one place:
 *   - `message_update` is dropped. Its increments are already published as
 *     `text_delta` / `thinking_delta`, and its `message` is the partial form of
 *     the `message_end` that follows.
 *   - `text_delta` / `thinking_delta` carry the increment, not the growing
 *     partial text.
 *   - `agent_end` carries its segment's usage and message count, not a second
 *     copy of every message already streamed.
 *   - `turn_end` keeps its assistant message (stop reason and usage live
 *     there) and drops `toolResults`, each of which already crossed the wire
 *     as a `tool_execution_end`.
 *   - Every other event passes through unchanged.
 */

import type { ChatLoopEvent } from "../../interactive/chat-loop.js";
import { sumRunUsage } from "../../interactive/chat-loop-messages.js";

export function projectHeadlessJsonEvent(event: ChatLoopEvent): unknown | null {
	if (event.type === "message_update") return null;
	if (event.type === "text_delta") {
		return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
	}
	if (event.type === "thinking_delta") {
		return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
	}
	if (event.type === "agent_end") {
		const usage = sumRunUsage(event.messages);
		return {
			type: event.type,
			messageCount: event.messages.length,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				reasoning: usage.reasoning,
				totalTokens: usage.tokens,
				costUsd: usage.costUsd,
				apiCalls: usage.apiCalls,
				measured: usage.hadUsage,
			},
		};
	}
	if (event.type === "turn_end") {
		return { type: event.type, message: event.message };
	}
	return event;
}
