/**
 * Fold the working-set ledger records on the active path into a view.
 *
 * Pure over entries. The active path is selected here, through
 * `filterEntriesToActivePath`, so every consumer (live projection, recall,
 * overlay, replay-lite) shares the same #94 discipline: after a `/tree` switch
 * the raw file still holds abandoned turns, and an eviction recorded on an
 * abandoned branch must not project onto the live one. Forks inherit the view
 * of their shared prefix for the same reason compaction summaries do.
 */

import type { SessionEntry } from "../../session/entries.js";
import { filterEntriesToActivePath } from "../../session/tree/active-path.js";
import type { EvictedState, WorkingSetRef, WorkingSetView } from "./contract.js";

/** Ref keys index `WorkingSetView.evicted`. Today a key is the entry turnId. */
export function refKey(ref: WorkingSetRef): string {
	return ref.entry;
}

export function parseRefKey(key: string): WorkingSetRef | null {
	const trimmed = key.trim();
	if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
	return { entry: trimmed };
}

export function foldWorkingSet(entries: ReadonlyArray<SessionEntry>, activeLeafTurnId?: string): WorkingSetView {
	const active = filterEntriesToActivePath(entries, activeLeafTurnId);
	const evicted = new Map<string, EvictedState>();
	let evictionEvents = 0;
	let itemsEvicted = 0;
	let recalls = 0;
	let lastPolicyId: string | null = null;
	let lastEvictionTurnId: string | null = null;
	for (const entry of active) {
		if (entry.kind === "contextEviction") {
			evictionEvents += 1;
			lastPolicyId = entry.policyId;
			lastEvictionTurnId = entry.turnId;
			for (const item of entry.evicted) {
				itemsEvicted += 1;
				evicted.set(refKey(item.ref), {
					reason: item.reason,
					marker: item.marker,
					...(item.by === undefined ? {} : { by: item.by }),
					tokensFreed: item.tokensFreed,
					evictedAtTurnId: entry.turnId,
					policyId: entry.policyId,
				});
			}
			continue;
		}
		// A recall does not un-evict. The recalled body rides the recall tool
		// result at the tail of the working set, which is where the model asked
		// for it and where it costs no cold prefix; readmitting it at the
		// original position would duplicate the bytes and invalidate the cache
		// for everything after it. The marker stays, byte-stable, and a second
		// recall of the same ref is the churn signal.
		if (entry.kind === "contextRecall") recalls += 1;
	}
	return { evicted, evictionEvents, itemsEvicted, recalls, lastPolicyId, lastEvictionTurnId };
}
