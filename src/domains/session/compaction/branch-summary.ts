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
	if (Array.isArray(p.content)) {
		const parts: string[] = [];
		for (const block of p.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
		return parts.join("\n");
	}
	return "";
}

/**
 * Walk entries in order and emit `[Role]: body` sections suitable for
 * embedding inside a `<conversation>...</conversation>` block. Output is
 * stable for a given input. Tests rely on this determinism.
 *
 * Non-context-bearing kinds (modelChange, thinkingLevelChange, fileEntry,
 * sessionInfo, custom) are skipped: they never contribute to the replayed
 * LLM context, so summarizing them would waste tokens on bookkeeping.
 */
export function serializeConversation(entries: ReadonlyArray<SessionEntry>): string {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "message") {
			const text = messageText(entry).trim();
			if (text.length === 0) continue;
			switch (entry.role) {
				case "user":
					parts.push(`[User]: ${text}`);
					break;
				case "assistant":
					parts.push(`[Assistant]: ${text}`);
					break;
				case "tool_call":
					parts.push(`[Assistant tool call]: ${text}`);
					break;
				case "tool_result":
					parts.push(`[Tool result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`);
					break;
				case "system":
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
		// custom, modelChange, thinkingLevelChange, fileEntry, sessionInfo
		// do not project into the serialized conversation.
	}
	return parts.join("\n\n");
}
