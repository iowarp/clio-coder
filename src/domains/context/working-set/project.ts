/**
 * Apply a `WorkingSetView` to a ledger slice as an in-memory projection.
 *
 * This is the whole point of the layer: the ledger keeps every byte the tools
 * produced, and the model sees a narrower view of it. Nothing here writes, and
 * nothing here decides what leaves; `fold.ts` says what is out and this module
 * renders that decision onto the entries the replay builder consumes.
 *
 * Pure and idempotent. Projecting an already-projected slice reproduces it
 * byte for byte, because the marker comes from the ledger entry rather than
 * from the body being replaced. Entries the view does not name are returned by
 * reference, and a named entry is a shallow copy with a new payload: nothing
 * below the payload is ever mutated, so a deep clone of the body about to be
 * replaced would only cost the pricing loop the body's size.
 *
 * Callers may pass raw ledger entries: only entries whose `turnId` is a key in
 * `view.evicted` change, and the view was already narrowed to the active path
 * by the fold, so an eviction recorded on an abandoned branch cannot reach a
 * live one (issue #94).
 */

import type { MessageEntry, SessionEntry } from "../../session/entries.js";
import type { EvictedState, WorkingSetView } from "./contract.js";
import { hasThinking, isRecord, toolResultPayload, withoutThinkingBlocks } from "./payload.js";

/**
 * Replace the observation body with its marker. Tool pairing (`toolCallId`,
 * `toolName`) and `details` survive untouched, so replay still matches the
 * result to its call and the renderer still knows what the call was; only the
 * text the model reads changes. The `workingSet` stamp on `details` is how a
 * reader tells a marker from a genuinely tiny tool result.
 */
function projectToolResult(entry: MessageEntry, state: EvictedState): MessageEntry {
	const next = { ...entry };
	const { obj, result } = toolResultPayload(next.payload);
	const details = isRecord(result) && isRecord(result.details) ? result.details : {};
	next.payload = {
		...obj,
		result: {
			content: [{ type: "text", text: state.marker }],
			details: {
				...details,
				workingSet: { evicted: true, reason: state.reason, ref: entry.turnId },
			},
		},
		output: undefined,
		out: undefined,
		content: undefined,
	};
	return next;
}

/**
 * Drop reasoning from a closed turn. No marker replaces it: thinking is
 * model-internal, the Anthropic API discards it after every turn anyway, and a
 * marker would spend tokens to say that something the model cannot act on is
 * gone. Both persisted shapes go: `thinking` content blocks and the
 * payload-level string the local engine adapters write.
 *
 * A turn that was nothing but reasoning keeps it. Projected, it would reach
 * the provider as an assistant message with no content, or vanish from the
 * replay and leave two user messages adjacent; either is worse than the
 * tokens. `planEviction` then prices such a turn at zero and records nothing.
 */
function projectAssistant(entry: MessageEntry): MessageEntry {
	const obj = isRecord(entry.payload) ? entry.payload : null;
	if (obj === null || !hasThinking(obj)) return entry;
	const content = withoutThinkingBlocks(obj.content);
	if (!hasVisibleContent(obj, content)) return entry;
	const next = { ...entry };
	next.payload = {
		...obj,
		...(content !== undefined ? { content } : {}),
		thinking: undefined,
	};
	return next;
}

/** What the replay builder would still send: a payload-level text or at least one surviving block. */
function hasVisibleContent(obj: Record<string, unknown>, content: unknown[] | undefined): boolean {
	if (typeof obj.text === "string" && obj.text.length > 0) return true;
	return content !== undefined && content.length > 0;
}

/**
 * Usage recorded before the projection existed described a longer prompt than
 * the model will now receive. `calculateContextTokens` anchors on the newest
 * assistant usage it trusts, so leaving those anchors in place would report the
 * pre-eviction size forever and the pressure estimator would never see the
 * space the eviction freed. Mirrors `invalidateUsage()` in
 * mask-observations.ts, bounded to the entries that precede the event.
 */
function invalidateUsage(entry: SessionEntry): SessionEntry {
	if (entry.kind !== "message" || entry.role !== "assistant") return entry;
	const obj = isRecord(entry.payload) ? entry.payload : null;
	if (obj === null || obj.contextUsageInvalidated === true) return entry;
	const next = { ...entry };
	next.payload = { ...obj, contextUsageInvalidated: true };
	return next;
}

/**
 * Index of the newest eviction event within this slice. An event the slice does
 * not contain (a caller that truncated before it) is treated as later than
 * everything here: every usage anchor in the slice predates the projection.
 */
function eventIndex(entries: ReadonlyArray<SessionEntry>, lastEvictionTurnId: string | null): number {
	if (lastEvictionTurnId === null) return entries.length;
	const index = entries.findIndex((entry) => entry.turnId === lastEvictionTurnId);
	return index < 0 ? entries.length : index;
}

export function projectWorkingSet(entries: ReadonlyArray<SessionEntry>, view: WorkingSetView): SessionEntry[] {
	if (view.evicted.size === 0 && view.evictionEvents === 0) return [...entries];
	const cutoff = view.evictionEvents > 0 ? eventIndex(entries, view.lastEvictionTurnId) : -1;
	const out: SessionEntry[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		let next = entry;
		if (entry.kind === "message") {
			const state = view.evicted.get(entry.turnId);
			if (state !== undefined) {
				if (entry.role === "tool_result") next = projectToolResult(entry, state);
				else if (entry.role === "assistant") next = projectAssistant(entry);
			}
		}
		if (index < cutoff) next = invalidateUsage(next);
		out.push(next);
	}
	return out;
}
