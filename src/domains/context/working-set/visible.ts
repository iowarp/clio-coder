/**
 * The entries the model can currently see.
 *
 * A policy that is shown the whole active path will happily "evict" results
 * that a compaction summary already removed from the replay. Those items price
 * as real savings, so the event records tokens it never freed, the structural
 * age rung stops early believing it reached target, and the summary stage runs
 * again for nothing. This helper applies the same two cuts the replay builder
 * applies (`selectReplayEntries` in chat-renderer.ts): the active path, then
 * everything from the latest compaction's `firstKeptTurnId` onward. The
 * `compactionSummary` entry itself is left out; it is never a candidate and the
 * policy has no use for it.
 *
 * The fold (`WorkingSetView`) deliberately keeps running over the full active
 * path so refs evicted before a later compaction stay known as evicted.
 */

import type { SessionEntry } from "../../session/entries.js";
import { filterEntriesToActivePath } from "../../session/tree/active-path.js";

export function selectVisibleEntries(entries: ReadonlyArray<SessionEntry>, activeLeafTurnId?: string): SessionEntry[] {
	const active = filterEntriesToActivePath(entries, activeLeafTurnId);
	let compactionIndex = -1;
	for (let i = active.length - 1; i >= 0; i -= 1) {
		if (active[i]?.kind === "compactionSummary") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return active;
	const compaction = active[compactionIndex];
	if (compaction?.kind !== "compactionSummary") return active;
	const firstKeptIndex =
		compaction.firstKeptTurnId.length > 0 ? active.findIndex((entry) => entry.turnId === compaction.firstKeptTurnId) : -1;
	const kept =
		firstKeptIndex >= 0 && firstKeptIndex < compactionIndex ? active.slice(firstKeptIndex, compactionIndex) : [];
	return [...kept, ...active.slice(compactionIndex + 1)];
}
