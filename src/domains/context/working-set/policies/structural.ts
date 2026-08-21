/**
 * `structural-v1`: evict what the session has structurally finished with.
 *
 * The age rule asks how old a result is. This one asks what happened to it
 * since: was the file rewritten, did a later read cover the same lines, did the
 * failure get resolved, has the listing been walked. Those are facts the ledger
 * already records, and they are the facts a human would use to decide what is
 * still worth carrying. Age is the last rung, not the first, and it only runs
 * when the structural rungs did not free enough.
 *
 * Rule order is the policy. Each rung emits candidates newest-first, every
 * candidate passes `isProtected`, and no unit is claimed twice, so a read that
 * is both stale and superseded is evicted for the reason that came first and
 * carries the ref that explains it. Rungs 1 to 5 are unconditional: redundant
 * content is free to drop, whatever the pressure. Rung 6 is the only one that
 * looks at token counts, and it stops the moment the projection reaches
 * `target`.
 *
 * Deterministic by construction: the index is a pure function of the entries,
 * every loop runs in index order, and nothing here reads a clock, a size
 * ranking, or a recency score.
 */

import type { EvictionCandidate, EvictionReason, PolicyInput, WorkingSetPolicy } from "../contract.js";
import { tokensFreedByEviction } from "../engine.js";
import { protectionCutoffIndex } from "../horizon.js";
import { buildPathIndex, type PathIndex, type PathObservation, type PathRange } from "../path-index.js";
import { hasThinking } from "../payload.js";
import { findLaterSuccess, isProtected } from "../protect.js";

/** Ops that observe content rather than change it. */
const READ_CLASS = new Set<PathObservation["op"]>(["read", "grep", "find", "ls", "code_nav"]);
const MUTATING = new Set<PathObservation["op"]>(["write", "edit"]);

function rangeEnd(range: PathRange): number {
	return range.limit === null ? Number.POSITIVE_INFINITY : range.offset + range.limit;
}

function isFullRead(range: PathRange | null): boolean {
	return range !== null && range.offset === 0 && range.limit === null;
}

/**
 * Does the later read make the earlier one redundant? A full read covers
 * everything, including a `tail` read whose coverage is unknown. Any other read
 * covers only an identical or containing range, and an unknown range covers
 * nothing, which is what keeps partial reads from evicting each other.
 */
function covers(later: PathRange | null, earlier: PathRange | null): boolean {
	if (isFullRead(later)) return true;
	if (later === null || earlier === null) return false;
	return later.offset <= earlier.offset && rangeEnd(later) >= rangeEnd(earlier);
}

/**
 * The mutation that invalidated this observation: the first successful one
 * after it. A failed edit (`oldText not found`, permission denied) changed
 * nothing, and the read it was aimed at is exactly what the model needs to fix
 * the edit.
 */
function firstMutationAfter(observation: PathObservation, index: PathIndex): PathObservation | null {
	for (const other of index.byPath.get(observation.path) ?? []) {
		if (other.entryIndex > observation.entryIndex && MUTATING.has(other.op) && !other.isError) return other;
	}
	return null;
}

/** The most recent later read of the same file that covers this one's lines. */
function lastCoveringRead(observation: PathObservation, index: PathIndex): PathObservation | null {
	let found: PathObservation | null = null;
	for (const other of index.byPath.get(observation.path) ?? []) {
		if (other.entryIndex <= observation.entryIndex || other.op !== "read" || other.isError) continue;
		if (covers(other.range, observation.range)) found = other;
	}
	return found;
}

/** Every surfaced path went on to be read. A path nobody read is an unread path. */
function isListingConsumed(observation: PathObservation, index: PathIndex): boolean {
	if (observation.surfaced.length === 0) return false;
	for (const path of observation.surfaced) {
		const readLater = (index.byPath.get(path) ?? []).some(
			(other) => other.op === "read" && !other.isError && other.entryIndex > observation.entryIndex,
		);
		if (!readLater) return false;
	}
	return true;
}

export const structuralPolicy: WorkingSetPolicy = {
	id: "structural-v1",
	select(input: PolicyInput): ReadonlyArray<EvictionCandidate> {
		const { entries, view, settings, pressure, estimateTokens } = input;
		const index = buildPathIndex(entries, { cwd: input.cwd });
		const cutoffIndex = protectionCutoffIndex(entries, settings.protectLastTurns);
		const candidates: EvictionCandidate[] = [];
		const claimed = new Set<string>();
		let freed = 0;

		const entryIndexOf = new Map<string, number>();
		for (let i = 0; i < entries.length; i += 1) {
			const entry = entries[i];
			if (entry !== undefined) entryIndexOf.set(entry.turnId, i);
		}

		const emit = (turnId: string, reason: EvictionReason, by?: string): boolean => {
			if (claimed.has(turnId) || view.evicted.has(turnId)) return false;
			const entryIndex = entryIndexOf.get(turnId);
			if (entryIndex === undefined) return false;
			const entry = entries[entryIndex];
			if (entry === undefined) return false;
			if (isProtected(entry, { entryIndex, cutoffIndex, input, index })) return false;
			const candidate: EvictionCandidate = { ref: { entry: turnId }, reason, ...(by === undefined ? {} : { by }) };
			claimed.add(turnId);
			candidates.push(candidate);
			freed += tokensFreedByEviction(estimateTokens, entry, candidate);
			return true;
		};

		// Newest-first within every rung, for the cost reason in charter 4.6:
		// evicting the youngest safe unit keeps the cold region after the
		// eviction point small, so the turn that pays for the event pays least.
		const newestFirst = [...index.observations].reverse();

		// 1. The file changed under it. Whatever the body said is now a claim
		//    about a file that no longer exists in that form.
		for (const observation of newestFirst) {
			if (!READ_CLASS.has(observation.op) || observation.path.length === 0) continue;
			const mutation = firstMutationAfter(observation, index);
			if (mutation !== null) emit(observation.ref.entry, "stale_after_mutation", mutation.ref.entry);
		}

		// 2. The agent asked for the same lines again. It already decided this
		//    content was worth re-fetching, and the newer copy is the live one.
		for (const observation of newestFirst) {
			if (observation.op !== "read" || observation.path.length === 0) continue;
			const superseding = lastCoveringRead(observation, index);
			if (superseding !== null) emit(observation.ref.entry, "superseded_read", superseding.ref.entry);
		}

		// 3. The failure was resolved. The marker keeps its first line, because
		//    a failure that happened is evidence even once it is fixed.
		for (const observation of newestFirst) {
			if (!observation.isError) continue;
			const success = findLaterSuccess(observation, index);
			if (success !== null) emit(observation.ref.entry, "failure_resolved", success.ref.entry);
		}

		// 4. The listing has been walked. One surfaced path still unread and it
		//    stays: that is the path the agent comes back to.
		for (const observation of newestFirst) {
			if (isListingConsumed(observation, index)) emit(observation.ref.entry, "listing_consumed");
		}

		// 5. Reasoning from a closed turn, the same rule age-horizon applies.
		for (let i = cutoffIndex - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry?.kind !== "message" || entry.role !== "assistant") continue;
			if (hasThinking(entry.payload)) emit(entry.turnId, "thinking_turn_closed");
		}

		// 6. Age, and only under pressure. Everything above is redundancy the
		//    session can lose for free; this rung loses content that is still
		//    good, so it runs only when the projection is still over threshold
		//    and stops the moment it reaches target.
		const window = pressure.contextWindow;
		if (window <= 0) return candidates;
		let projected = pressure.tokens - freed;
		if (projected <= pressure.threshold * window) return candidates;
		const targetTokens = pressure.target * window;
		for (let i = cutoffIndex - 1; i >= 0 && projected > targetTokens; i -= 1) {
			const entry = entries[i];
			if (entry?.kind !== "message" || entry.role !== "tool_result") continue;
			const before = freed;
			if (emit(entry.turnId, "age_horizon")) projected -= freed - before;
		}
		return candidates;
	},
};
