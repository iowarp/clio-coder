/**
 * `age-horizon`: today's selection, recorded instead of destroyed.
 *
 * The rule is exactly what `maskStaleObservations` applied before this layer
 * existed. Every tool-result body older than the protected recent-turn horizon
 * leaves the working set, and every assistant message older than the horizon
 * loses its thinking blocks. Same turn-start definition, same cutoff, same
 * skip conditions. The difference is that the bodies stay in the ledger and
 * come back with `context(scope="recall", ref=...)`.
 *
 * It ships as the default so slice 1 changes one thing at a time: the ledger
 * stops being rewritten, while what the model sees on the next request stays
 * what it saw before. `structural-v1` replaces the age rule with typed
 * structural ones once replay-lite shows it ahead on retention.
 *
 * Age is not a quality signal, which is the whole reason for slice 2: a file
 * read twenty turns ago and never touched since is more useful than a
 * directory listing from two turns ago. Nothing here scores candidates by size
 * or recency beyond that ordering; the only token input is the
 * `minEvictableTokens` floor, below which the marker costs more than the body.
 */

import type { SessionEntry } from "../../../session/entries.js";
import type { EvictionCandidate, PolicyInput, WorkingSetPolicy } from "../contract.js";
import { hasLegacyCompactionMarker, hasThinking } from "../payload.js";

/**
 * What starts a turn, in the sense the protection horizon counts. A local `!`
 * bash execution and a branch summary both open a new stretch of work the same
 * way an operator message does.
 */
function isTurnStart(entry: SessionEntry): boolean {
	if (entry.kind === "bashExecution" || entry.kind === "branchSummary") return true;
	return entry.kind === "message" && entry.role === "user";
}

/**
 * Index of the first protected entry: walk back until `protectLastTurns` turn
 * starts have been seen. Entries before it are candidates, entries from it on
 * are the recent window nothing touches.
 */
function recentTurnCutoff(entries: ReadonlyArray<SessionEntry>, protectLastTurns: number): number {
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

export const ageHorizonPolicy: WorkingSetPolicy = {
	id: "age-horizon",
	select(input: PolicyInput): ReadonlyArray<EvictionCandidate> {
		const { entries, view, settings, estimateTokens } = input;
		const cutoff = recentTurnCutoff(entries, settings.protectLastTurns);
		const candidates: EvictionCandidate[] = [];
		// Newest-safe-first: the entry closest to the protection horizon is the
		// least likely to be re-read, and a caller that stops early has then
		// evicted the oldest nothing and the newest something.
		for (let i = cutoff - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry === undefined || entry.kind !== "message") continue;
			if (view.evicted.has(entry.turnId)) continue;
			if (entry.role === "tool_result") {
				if (hasLegacyCompactionMarker(entry.payload)) continue;
				if (estimateTokens(entry) < settings.minEvictableTokens) continue;
				candidates.push({ ref: { entry: entry.turnId }, reason: "age_horizon" });
				continue;
			}
			// Thinking has no size floor: dropping it costs no marker, so even a
			// short stretch of reasoning is free to remove.
			if (entry.role === "assistant" && hasThinking(entry.payload)) {
				candidates.push({ ref: { entry: entry.turnId }, reason: "thinking_turn_closed" });
			}
		}
		return candidates;
	},
};
