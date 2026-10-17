/**
 * Canonical readers for message ledger payloads.
 *
 * The ledger accepts several payload shapes: a bare string (defensive and
 * legacy), `{ text }` (what chat writes today), and `{ content: [...] }`
 * blocks (rich and imported payloads). Readers that each handled a subset
 * disagreed: compaction kept the text of a text-block user message while the
 * observation source dropped it from the exact-material envelope, and a
 * string assistant payload became empty content that still claimed coverage.
 * Both now read through these helpers.
 *
 * `projectMessage` is the reasoning-free projection: thinking blocks and
 * fields never appear in it, and a shape it does not fully understand is
 * reported incomplete instead of projected partially.
 */

import type { MessageEntry } from "./entries.js";

export function payloadObject(payload: unknown): Record<string, unknown> | null {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

export function contentBlocks(payload: unknown): ReadonlyArray<Record<string, unknown>> {
	const content = payloadObject(payload)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object");
}

/**
 * Plain text of a message payload in every supported shape. Text blocks join
 * with newlines; non-text blocks contribute nothing. "" for an unrecognized
 * shape, so a serializer drops it rather than embedding JSON noise.
 */
export function messageText(entry: MessageEntry): string {
	const payload = entry.payload;
	if (typeof payload === "string") return payload;
	const record = payloadObject(payload);
	if (record === null) return "";
	if (typeof record.text === "string") return record.text;
	return contentBlocks(payload)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** The operator's own words for a user message: `operatorText` when composed text carries reminders. */
export function operatorMessageText(entry: MessageEntry): string {
	const operator = payloadObject(entry.payload)?.operatorText;
	return typeof operator === "string" && operator.trim().length > 0 ? operator : messageText(entry);
}

export function toolCallArguments(record: Record<string, unknown>): unknown {
	return record.args ?? record.arguments ?? record.input;
}

export function toolResultValue(record: Record<string, unknown>): unknown {
	return record.result ?? record.output ?? record.out ?? record.content;
}

export interface MessageProjection {
	/** What the message contributed to the conversation, without private reasoning. */
	readonly material: Record<string, unknown>;
	/** Exact operator text of a user message, or null for any other role. */
	readonly exact: string | null;
	/** Tool calls this message opened. */
	readonly calls: readonly string[];
	/** The call a tool result resolves, or null. */
	readonly resolves: string | null;
	/** False when the payload holds anything this projection cannot carry exactly. */
	readonly complete: boolean;
}

const REASONING_BLOCKS: ReadonlySet<unknown> = new Set(["thinking", "redacted_thinking", "reasoning"]);
/**
 * Provider continuity payloads carried on otherwise visible blocks: Gemini's
 * encrypted thought signature on a tool call or text block, the reasoning
 * signature on a thinking block. They are opaque reasoning state, not
 * conversation, and would also inflate every unit that carries them.
 */
const REASONING_FIELDS: ReadonlySet<string> = new Set(["thoughtSignature", "textSignature", "thinkingSignature"]);

function withoutReasoningFields(block: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(block).filter(([key]) => !REASONING_FIELDS.has(key)));
}

/** Null for bookkeeping roles that never reach the model. */
export function projectMessage(entry: MessageEntry): MessageProjection | null {
	const payload = entry.payload;
	const record = payloadObject(payload);
	const blocks = contentBlocks(payload);
	const unsupported = typeof payload !== "string" && record === null;
	const attachments =
		(Array.isArray(record?.images) && record.images.length > 0) ||
		(Array.isArray(record?.attachments) && record.attachments.length > 0);
	switch (entry.role) {
		case "checkpoint":
			return null;
		case "user":
		case "system": {
			const text = messageText(entry);
			const exact = entry.role === "user" ? operatorMessageText(entry) : null;
			const operatorText = typeof record?.operatorText === "string" ? record.operatorText : undefined;
			return {
				material: { text, ...(operatorText !== undefined ? { operatorText } : {}) },
				exact: exact !== null && exact.length > 0 ? exact : null,
				calls: [],
				resolves: null,
				complete:
					!unsupported &&
					!attachments &&
					(text.length > 0 || (exact?.length ?? 0) > 0) &&
					blocks.every((block) => block.type === "text"),
			};
		}
		case "assistant": {
			if (typeof payload === "string")
				return { material: { text: payload }, exact: null, calls: [], resolves: null, complete: payload.length > 0 };
			const content = blocks.filter((block) => !REASONING_BLOCKS.has(block.type)).map(withoutReasoningFields);
			const calls: string[] = [];
			let complete = !unsupported && !attachments;
			for (const block of content) {
				if (block.type === "toolCall") {
					if (typeof block.id === "string") calls.push(block.id);
					else complete = false;
				} else if (block.type !== "text") complete = false;
			}
			const text = typeof record?.text === "string" ? record.text : undefined;
			// A payload with neither form says nothing this projection can vouch for.
			if (text === undefined && !Array.isArray(record?.content)) complete = false;
			return {
				material: { ...(text !== undefined ? { text } : {}), content },
				exact: null,
				calls,
				resolves: null,
				complete,
			};
		}
		case "tool_call": {
			const id = typeof record?.toolCallId === "string" ? record.toolCallId : null;
			const args = record === null ? undefined : toolCallArguments(record);
			return {
				material: { toolCallId: record?.toolCallId, name: record?.name ?? record?.toolName, args },
				exact: null,
				calls: id === null ? [] : [id],
				resolves: null,
				complete: id !== null && args !== undefined,
			};
		}
		case "tool_result": {
			const id = typeof record?.toolCallId === "string" ? record.toolCallId : null;
			const result = record === null ? undefined : toolResultValue(record);
			const resultBlocks = Array.isArray(payloadObject(result)?.content)
				? (payloadObject(result)?.content as unknown[])
				: [];
			return {
				material: {
					toolCallId: record?.toolCallId,
					toolName: record?.toolName,
					result,
					isError: record?.isError,
					outcome: record?.outcome,
				},
				exact: null,
				calls: [],
				resolves: id,
				complete:
					id !== null && result !== undefined && resultBlocks.every((block) => payloadObject(block)?.type === "text"),
			};
		}
		default:
			return { material: {}, exact: null, calls: [], resolves: null, complete: false };
	}
}
