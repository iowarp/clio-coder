/**
 * Cut-point detection for compaction (Phase 12 slice 12c).
 *
 * Walks an entry list newest-to-oldest, accumulating estimated tokens, and
 * reports where to slice so the suffix carries at least `keepRecentTokens`
 * tokens of recent context. Ports pi-coding-agent's `findCutPoint` +
 * `findTurnStartIndex` (pi-mono/packages/coding-agent/src/core/compaction/
 * compaction.ts) against Clio's SessionEntry union.
 *
 * Invariant: the returned cut never lands on a `tool_result` message. Tool
 * results must stay attached to the tool call that produced them, otherwise
 * the replayed context shows a result with no originating call.
 */

import type { SessionEntry } from "../entries.js";
import { estimateTokens } from "./tokens.js";

export interface CutPointResult {
	/** Index of the first entry to keep (start of the retained suffix). */
	firstKeptEntryIndex: number;
	/**
	 * When the cut falls mid-turn (cut point is not a user turn start), the
	 * index of the user message that started the turn being split. -1 when
	 * the cut already lands on a turn boundary.
	 */
	turnStartIndex: number;
	/** True when the cut splits a turn; `turnStartIndex` is valid in that case. */
	isSplitTurn: boolean;
}

export interface FindCutPointOptions {
	/** Inclusive lower bound on the search window. Defaults to 0. */
	startIndex?: number;
	/** Exclusive upper bound on the search window. Defaults to entries.length. */
	endIndex?: number;
}

/**
 * Scan backwards from `entryIndex` until we hit the user (or bashExecution)
 * message that opened the current turn. Returns -1 when no such start is
 * found inside the supplied window. `branchSummary` entries count as turn
 * starts because they replace the upstream history at a fork point.
 */
export function findTurnStartIndex(entries: ReadonlyArray<SessionEntry>, entryIndex: number, startIndex = 0): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.kind === "branchSummary") return i;
		if (entry.kind === "bashExecution") return i;
		if (entry.kind === "message" && entry.role === "user") return i;
	}
	return -1;
}

/** Entries we can cut at. `tool_result` is the only role we must NOT cut at. */
function isValidCutPoint(entry: SessionEntry): boolean {
	switch (entry.kind) {
		case "message":
			return entry.role !== "tool_result";
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "modelChange":
		case "thinkingLevelChange":
		case "fileEntry":
		case "sessionInfo":
			return false;
	}
}

function findValidCutPoints(entries: ReadonlyArray<SessionEntry>, startIndex: number, endIndex: number): number[] {
	const cuts: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (isValidCutPoint(entry)) cuts.push(i);
	}
	return cuts;
}

/**
 * Find the cut point that keeps at least `keepRecentTokens` tokens in the
 * retained suffix. Never cuts at a `tool_result`. When walking forward from
 * the chosen cut would swallow non-message bookkeeping entries (modelChange,
 * thinkingLevelChange, fileEntry, sessionInfo), the cut is widened so those
 * entries ride along with the suffix instead of being summarized.
 *
 * Small-session fallback: when the walker exhausts `entries` without ever
 * accumulating `keepRecentTokens`, the pi-coding-agent reference left
 * `cutIndex` at the oldest valid cut, which made `compact()` produce an
 * empty `pre` slice and the chat-loop report "nothing to compact" on
 * populated sessions below the keep-recent window. Clio's manual `/compact`
 * expects to summarize whatever older history exists, so when no suffix
 * crosses the threshold the cut falls back to the newest turn start (user
 * message, bashExecution, or branchSummary). Sessions with only a single
 * turn still land the cut at index 0. `pre` stays empty and the caller
 * surfaces the honest "nothing to compact" notice.
 */
export function findCutPoint(
	entries: ReadonlyArray<SessionEntry>,
	keepRecentTokens: number,
	opts: FindCutPointOptions = {},
): CutPointResult {
	const startIndex = opts.startIndex ?? 0;
	const endIndex = opts.endIndex ?? entries.length;
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulated = 0;
	let cutIndex = -1;
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (!entry) continue;
		accumulated += estimateTokens(entry);
		if (accumulated >= keepRecentTokens) {
			for (const candidate of cutPoints) {
				if (candidate >= i) {
					cutIndex = candidate;
					break;
				}
			}
			break;
		}
	}

	if (cutIndex === -1) {
		// Walker never crossed keepRecentTokens, or crossed but found no valid
		// cut at/after the stop index (all valid cuts precede the tool_result
		// tail). Prefer the newest turn start so older turns still feed the
		// summary prompt. Absent any turn start, fall back to the oldest valid
		// cut. That matches the pre-fix behavior, so pre stays empty and the
		// orchestrator reports nothing to compact.
		const lastTurnStart = findTurnStartIndex(entries, endIndex - 1, startIndex);
		cutIndex = lastTurnStart !== -1 ? lastTurnStart : (cutPoints[0] ?? startIndex);
	}

	// Scan backwards from cutIndex to fold bookkeeping entries into the suffix.
	while (cutIndex > startIndex) {
		const prev = entries[cutIndex - 1];
		if (!prev) break;
		if (prev.kind === "compactionSummary") break;
		if (
			prev.kind === "message" ||
			prev.kind === "bashExecution" ||
			prev.kind === "custom" ||
			prev.kind === "branchSummary"
		) {
			break;
		}
		cutIndex--;
	}

	const cutEntry = entries[cutIndex];
	const cutIsUserTurn = !!cutEntry && cutEntry.kind === "message" && cutEntry.role === "user";
	const turnStartIndex = cutIsUserTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !cutIsUserTurn && turnStartIndex !== -1,
	};
}
