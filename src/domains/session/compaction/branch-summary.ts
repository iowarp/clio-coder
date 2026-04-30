/**
 * Branch summary builders (Phase 12 slice 12c).
 *
 * Deterministic text assembly for the compaction prompt. The summarization
 * model is asked to read a serialized conversation and emit a structured
 * checkpoint; serializing the conversation ourselves (rather than handing
 * over raw messages) prevents the model from treating the prompt as an
 * ongoing conversation to continue.
 *
 * Ports pi-coding-agent's `serializeConversation` + the split-turn helpers
 * in compaction.ts, adapted to Clio's SessionEntry union.
 */

import type { MessageEntry, SessionEntry } from "../entries.js";

/** Tool-result bodies are truncated to this char count inside summaries. */
export const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Return a contiguous slice of entries intended to become the historical
 * portion of a branch summary. The `[startIndex, endIndex)` window is the
 * range of entries the model will summarize; callers provide the cut point
 * (from `findCutPoint`) and whether the cut splits a turn.
 */
export function collectEntriesForBranchSummary(
	entries: ReadonlyArray<SessionEntry>,
	startIndex: number,
	endIndex: number,
): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (!entry) continue;
		out.push(entry);
	}
	return out;
}

export interface PreparedBranchEntries {
	/** Entries up to (exclusive) the first-kept index. These get summarized. */
	pre: SessionEntry[];
	/** Entries at and after the first-kept index. These remain verbatim. */
	post: SessionEntry[];
}

/**
 * Partition entries around the cut. `pre` is what the model summarizes;
 * `post` is what the replayed context keeps verbatim. A future slice may
 * extend this to surface a separate `turnPrefix` bucket when the cut is
 * mid-turn, matching pi-coding-agent's split-turn handling.
 */
export function prepareBranchEntries(
	entries: ReadonlyArray<SessionEntry>,
	firstKeptEntryIndex: number,
): PreparedBranchEntries {
	const clamped = Math.max(0, Math.min(firstKeptEntryIndex, entries.length));
	return {
		pre: entries.slice(0, clamped),
		post: entries.slice(clamped),
	};
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters truncated]`;
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

function stringifyPreview(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function contentBlocks(payload: unknown): ReadonlyArray<Record<string, unknown>> {
	const content = payloadObject(payload)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object");
}

/**
 * Flatten a MessageEntry payload into plain text. Accepts three payload
 * shapes in use today:
 *   - `string` (raw text line, defensive; chat-loop writes objects today)
 *   - `{ text: string }` (chat-loop user/assistant writes)
 *   - `{ content: [{ type: "text", text }...] }` (future rich payloads)
 * Returns "" for unrecognized shapes so the serializer silently drops them
 * rather than embedding JSON noise in the summary prompt.
 */
function messageText(entry: MessageEntry): string {
	const payload = entry.payload;
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Record<string, unknown>;
	if (typeof p.text === "string") return p.text;
	const parts = contentBlocks(payload)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string);
	if (parts.length > 0) return parts.join("\n");
	return "";
}

function assistantThinkingText(entry: MessageEntry): string {
	const payload = entry.payload;
	const explicit = payloadObject(payload)?.thinking;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	return contentBlocks(payload)
		.filter((block) => block.type === "thinking" && typeof block.thinking === "string")
		.map((block) => block.thinking as string)
		.join("\n");
}

function assistantToolCallsText(entry: MessageEntry): string {
	const calls = contentBlocks(entry.payload)
		.filter((block) => block.type === "toolCall")
		.map((block) => {
			const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
			const args = block.arguments ?? block.args ?? block.input;
			const suffix = args === undefined ? "" : `(${stringifyPreview(args)})`;
			return `${name}${suffix}`;
		});
	return calls.join("; ");
}

function toolCallText(entry: MessageEntry): string {
	const obj = payloadObject(entry.payload);
	if (!obj) return messageText(entry);
	const name = typeof obj.name === "string" ? obj.name : typeof obj.toolName === "string" ? obj.toolName : "tool";
	const args = obj.args ?? obj.arguments ?? obj.input;
	if (args !== undefined) return `${name}(${stringifyPreview(args)})`;
	return messageText(entry) || name;
}

function toolResultText(entry: MessageEntry): string {
	const obj = payloadObject(entry.payload);
	const result = obj?.result ?? obj?.output ?? obj?.out ?? obj?.content;
	if (Array.isArray(payloadObject(result)?.content)) {
		const parts = contentBlocks(result)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string);
		if (parts.length > 0) return parts.join("\n");
	}
	const textResult = payloadObject(result)?.text;
	if (typeof textResult === "string") return textResult;
	const text = messageText(entry);
	if (text.length > 0) return text;
	return stringifyPreview(result ?? entry.payload);
}

/**
 * Walk entries in order and emit `[Role]: body` sections suitable for
 * embedding inside a `<conversation>...</conversation>` block. Output is
 * stable for a given input. Tests rely on this determinism.
 *
 * Non-context-bearing kinds (modelChange, thinkingLevelChange, fileEntry,
 * sessionInfo, protectedArtifact, custom) are skipped: they never contribute
 * to the replayed LLM context, so summarizing them would waste tokens on
 * bookkeeping.
 */
export function serializeConversation(entries: ReadonlyArray<SessionEntry>): string {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "message") {
			const text = messageText(entry).trim();
			switch (entry.role) {
				case "user":
					if (text.length === 0) break;
					parts.push(`[User]: ${text}`);
					break;
				case "assistant": {
					const thinking = assistantThinkingText(entry).trim();
					const calls = assistantToolCallsText(entry).trim();
					if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking}`);
					if (text.length > 0) parts.push(`[Assistant]: ${text}`);
					if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls}`);
					break;
				}
				case "tool_call":
					parts.push(`[Assistant tool calls]: ${toolCallText(entry).trim()}`);
					break;
				case "tool_result":
					parts.push(`[Tool result]: ${truncate(toolResultText(entry).trim(), TOOL_RESULT_MAX_CHARS)}`);
					break;
				case "system":
					if (text.length === 0) break;
					parts.push(`[System]: ${text}`);
					break;
				case "checkpoint":
					// Checkpoint markers are bookkeeping; do not inject into summaries.
					break;
			}
			continue;
		}
		if (entry.kind === "bashExecution") {
			parts.push(`[Bash]: $ ${entry.command}\n${truncate(entry.output, TOOL_RESULT_MAX_CHARS)}`);
			continue;
		}
		if (entry.kind === "branchSummary") {
			parts.push(`[Branch summary]: ${entry.summary}`);
			continue;
		}
		if (entry.kind === "compactionSummary") {
			parts.push(`[Prior summary]: ${entry.summary}`);
		}
		// custom, modelChange, thinkingLevelChange, fileEntry, sessionInfo,
		// protectedArtifact do not project into the serialized conversation.
	}
	return parts.join("\n\n");
}
