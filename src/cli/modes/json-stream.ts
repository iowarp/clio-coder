/**
 * Projection from chat-loop events to the headless `--json` wire stream.
 *
 * The stream is append-oriented: it carries each piece of content exactly
 * once, as an increment while it streams and as one completed message when it
 * lands. It never repeats the growing snapshot of an in-progress message,
 * because that is quadratic in a long turn. One tool-heavy headless turn wrote
 * 802 MB of stdout, 99.3% of it `message_update` snapshots of a message
 * whose final form is 44 KB.
 *
 * The rules, in one place:
 *   - `message_update` is dropped. Its increments are already published as
 *     `text_delta` / `thinking_delta`, and its `message` is the partial form of
 *     the `message_end` that follows.
 *   - `text_delta` / `thinking_delta` carry the increment, not the growing
 *     partial text.
 *   - `message_end` keeps the message's accounting (role, model, usage, stop
 *     reason, tool calls) and replaces the assistant `text` and `thinking`
 *     blocks the deltas already carried with a marker naming their length.
 *     Without this the stream carried every assistant token twice: measured on
 *     one run, 41,094 bytes of deltas alongside 24,600 bytes of `message_end`
 *     re-stating the same thinking and text. `user` and `toolResult` messages
 *     pass through whole, because nothing else on the stream carries them.
 *   - `agent_end` carries its segment's usage and message count, not a second
 *     copy of every message already streamed.
 *   - `turn_end` keeps its assistant message (stop reason and usage live
 *     there) and drops `toolResults`, each of which already crossed the wire
 *     as a `tool_execution_end`.
 *   - Every other event passes through unchanged.
 */

import type { AgentMessage } from "../../engine/types.js";
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
	if (event.type === "message_end") {
		return { ...event, message: withoutStreamedContent(event.message) };
	}
	if (event.type === "agent_end") return segmentSummary(event.type, event.messages);
	if (event.type === "turn_end") {
		return { type: event.type, message: withoutStreamedContent(event.message) };
	}
	return event;
}

/**
 * Replace the content blocks a reader has already received as deltas.
 *
 * Only an assistant message streams: its `text` and `thinking` blocks arrive
 * incrementally as `text_delta` and `thinking_delta` keyed by the same
 * `contentIndex` this array is indexed by, so a reader reassembles them itself.
 * `toolCall` blocks never stream and are kept whole. A `user` or `toolResult`
 * message is returned untouched, because no delta ever carried it.
 */
function withoutStreamedContent<T>(message: T): T {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const content = message.content.map((block: unknown) => {
		if (!isRecord(block)) return block;
		if (block.type === "text" && typeof block.text === "string") {
			const { text: _text, ...rest } = block;
			return { ...rest, streamed: true, textLength: block.text.length };
		}
		if (block.type === "thinking" && typeof block.thinking === "string") {
			const { thinking: _thinking, ...rest } = block;
			return { ...rest, streamed: true, thinkingLength: block.thinking.length };
		}
		return block;
	});
	return { ...message, content } as T;
}

/**
 * Projection for the dispatch `--json` stream, whose events come off a worker
 * rather than out of the chat loop.
 *
 * The two streams name streaming increments differently by design: a worker
 * publishes them as `message_update` deltas already slimmed of their
 * cumulative snapshots at the worker stdout seam, and the chat loop publishes
 * them as `text_delta`. They make the same promise about content crossing
 * once, and `agent_end` was breaking it here: it carried the segment's entire
 * transcript, every message of which had already crossed as its own
 * `message_end`. It now carries the same segment summary the main-agent stream
 * carries, which is also what lets a reader check the per-segment and
 * per-message accounts of one run against each other.
 */
export function projectDispatchJsonEvent(event: unknown): unknown {
	if (!isRecord(event) || event.type !== "agent_end" || !Array.isArray(event.messages)) return event;
	const { messages: _messages, ...rest } = event;
	return { ...rest, ...segmentSummary("agent_end", event.messages as AgentMessage[]) };
}

function segmentSummary(type: string, messages: ReadonlyArray<AgentMessage>): Record<string, unknown> {
	const usage = sumRunUsage(messages);
	return {
		type,
		messageCount: messages.length,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
