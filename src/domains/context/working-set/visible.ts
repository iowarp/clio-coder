/**
 * The entries the model can currently see.
 *
 * A policy that is shown the whole active path will happily "evict" results
 * that a compaction summary already removed from the replay. Those items price
 * as real savings, so the event records tokens it never freed, the structural
 * age rung stops early believing it reached target, and the summary stage runs
 * again for nothing. So the policy input and the replay builder share one cut:
 * `compactionCut` is the single definition of "after the latest compaction",
 * and `selectReplayEntries` in chat-renderer.ts builds on it rather than
 * keeping a second copy that has to agree.
 *
 * The fold (`WorkingSetView`) deliberately keeps running over the full active
 * path so refs evicted before a later compaction stay known as evicted.
 */

import type { SessionEntry } from "../../session/entries.js";
import { filterEntriesToActivePath } from "../../session/tree/active-path.js";

export interface CompactionCut {
	/** Index of the latest `compactionSummary` in the slice; -1 when there is none. */
	compactionIndex: number;
	/**
	 * What the model sees after the cut, without the compaction entry itself:
	 * the kept tail from `firstKeptTurnId` up to the summary, then everything
	 * after it. The whole slice when there is no compaction.
	 */
	visible: SessionEntry[];
}

/** Apply the latest compaction's cut to a slice that is already on one path, in ledger order. */
export function compactionCut(entries: ReadonlyArray<SessionEntry>): CompactionCut {
	let compactionIndex = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i]?.kind === "compactionSummary") {
			compactionIndex = i;
			break;
		}
	}
	const compaction = entries[compactionIndex];
	if (compaction?.kind !== "compactionSummary") return { compactionIndex: -1, visible: [...entries] };
	const firstKeptIndex =
		compaction.firstKeptTurnId.length > 0
			? entries.findIndex((entry) => entry.turnId === compaction.firstKeptTurnId)
			: -1;
	const kept =
		firstKeptIndex >= 0 && firstKeptIndex < compactionIndex ? entries.slice(firstKeptIndex, compactionIndex) : [];
	return { compactionIndex, visible: [...kept, ...entries.slice(compactionIndex + 1)] };
}

/** Active path, then the compaction cut: the slice a policy may select from. */
export function selectVisibleEntries(entries: ReadonlyArray<SessionEntry>, activeLeafTurnId?: string): SessionEntry[] {
	return compactionCut(filterEntriesToActivePath(entries, activeLeafTurnId)).visible;
}
