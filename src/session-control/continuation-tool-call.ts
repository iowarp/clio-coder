import type { TurnToolCall } from "../core/turn-origin.js";
import { redactToolArgs } from "../domains/safety/redaction.js";
import { effectiveToolCall } from "../tools/surface.js";

/** Longest string an argument keeps; the rest is replaced by its length. */
const ARG_STRING_CHARS = 400;
/** Most entries an argument array keeps. */
const ARG_ARRAY_ENTRIES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound redacted arguments the way display projections do: long strings and arrays are cut, with a note of what was. */
function clipArgs(value: unknown): unknown {
	if (typeof value === "string")
		return value.length > ARG_STRING_CHARS ? `${value.slice(0, ARG_STRING_CHARS)}… (${value.length} chars)` : value;
	if (Array.isArray(value)) {
		const kept = value.slice(0, ARG_ARRAY_ENTRIES).map(clipArgs);
		return value.length > ARG_ARRAY_ENTRIES ? [...kept, `… (${value.length - ARG_ARRAY_ENTRIES} more)`] : kept;
	}
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clipArgs(entry)]));
}

/**
 * The last tool call a stopped turn made, for the continuation that follows it
 * (WTF-P 0.8.3 B6): the tool as hooks name it (a gateway call is its
 * capability), its arguments redacted and clipped, and how it settled. A call
 * the turn stopped before it returned is `unfinished`. Null when the turn made
 * no call. `messages` are the stopped turn's own.
 */
export function lastToolCallOf(messages: ReadonlyArray<unknown>): TurnToolCall | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown };
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const call = [...message.content]
			.reverse()
			.find(
				(block): block is { type: "toolCall"; id?: unknown; name: string; arguments?: unknown } =>
					isRecord(block) && block.type === "toolCall" && typeof block.name === "string",
			);
		if (call === undefined) continue;
		const result = messages
			.slice(index + 1)
			.find(
				(entry): entry is { isError?: unknown; details?: unknown } =>
					isRecord(entry) && entry.role === "toolResult" && entry.toolCallId === call.id,
			);
		const effective = effectiveToolCall(call.name, call.arguments, result?.details);
		const args = effective.args === undefined ? undefined : clipArgs(redactToolArgs(effective.args));
		return {
			tool: effective.toolName,
			...(isRecord(args) ? { args } : {}),
			outcome: result === undefined ? "unfinished" : result.isError === true ? "error" : "ok",
		};
	}
	return null;
}
