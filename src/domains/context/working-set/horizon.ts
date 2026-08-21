/**
 * The protection horizon: where the recent, untouchable window begins.
 *
 * Both policies and every protection predicate answer "is this entry inside the
 * last `protectLastTurns` turns" the same way, so the arithmetic lives here
 * once. It is the same cutoff `maskStaleObservations` used before this layer
 * existed, which is what keeps `age-horizon` selection-identical to the
 * destructive stage it replaced.
 *
 * `path-index.ts` keeps its own copy of `isTurnStart` on purpose: it is
 * cherry-picked on its own for the replay reference graph, so it stays free of
 * intra-layer imports beyond the payload readers.
 */

import type { SessionEntry } from "../../session/entries.js";

/**
 * What starts a turn, in the sense the protection horizon counts. A local `!`
 * bash execution and a branch summary both open a new stretch of work the same
 * way an operator message does.
 */
export function isTurnStart(entry: SessionEntry): boolean {
	if (entry.kind === "bashExecution" || entry.kind === "branchSummary") return true;
	return entry.kind === "message" && entry.role === "user";
}

/**
 * Index of the first protected entry: walk back until `protectLastTurns` turn
 * starts have been seen. Entries before it are candidates, entries from it on
 * are the recent window nothing touches.
 */
export function protectionCutoffIndex(entries: ReadonlyArray<SessionEntry>, protectLastTurns: number): number {
	const horizon = Math.max(1, Math.floor(protectLastTurns));
	let seen = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || !isTurnStart(entry)) continue;
		seen += 1;
		if (seen >= horizon) return i;
	}
	return 0;
}
