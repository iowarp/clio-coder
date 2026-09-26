/**
 * Pressure checkpoints: where the working set is asked whether it should
 * shrink, and the band that keeps two consecutive checkpoints from both
 * firing.
 *
 * Live, a checkpoint is every model request. The chat loop runs one before
 * submitting an operator turn (`runAutoCompact` from `submit` in
 * chat-loop.ts) and one between tool batches (`postToolContinuationGuard`,
 * reached from pi's `prepareNextTurnWithContext`). In ledger terms those are
 * the two shapes `isPressureCheckpointBefore` recognizes: a turn start, and an
 * assistant message that follows a tool result. The replay runner asks this
 * predicate before every entry it appends, so the harness fires exactly where
 * the product fires; a runner that checked only at turn starts measured a
 * product that has not existed since the continuation guard shipped.
 *
 * The rearm band is the hysteresis. An event batches the projection down to
 * `target`; every step after it adds a tool result, and a policy whose
 * structural rungs are unconditional would happily fire again on the very next
 * request to take one more stale read out. Each event cold-starts the prefix
 * cache from the earliest evicted position, so an event per step is the most
 * expensive way to save the fewest tokens. `withinRearmBand` says whether the
 * projection has grown by `rearmFraction` of the window since the last event;
 * until it has, an automatic checkpoint does nothing, the overflow path excepted.
 * Both callers price the projection the same way (`projectedWorkingSetTokens`
 * in engine.ts), so the band compares like with like: the recorded
 * `tokensAfter` of the last event and the same slice priced now.
 */

import type { SessionEntry } from "../../session/entries.js";
import { isTurnStart } from "./horizon.js";

/** The nearest message entry at or before `index`, skipping sidecars. */
function lastMessageBefore(entries: ReadonlyArray<SessionEntry>, index: number): SessionEntry | undefined {
	for (let i = index; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.kind === "message") return entry;
	}
	return undefined;
}

/**
 * Whether the live engine runs a pressure check immediately before `entries[index]`
 * is produced. True at a turn start (the pre-submit check) and before an
 * assistant message that answers a tool result (the continuation guard). The
 * first assistant message of a turn is covered by the turn start; a checkpoint
 * is never counted twice for one request.
 */
export function isPressureCheckpointBefore(entries: ReadonlyArray<SessionEntry>, index: number): boolean {
	const entry = entries[index];
	if (entry === undefined) return false;
	if (isTurnStart(entry)) return true;
	if (entry.kind !== "message" || entry.role !== "assistant") return false;
	const previous = lastMessageBefore(entries, index - 1);
	return previous?.kind === "message" && previous.role === "tool_result";
}

/**
 * For every entry, the number of checkpoints at or before it. An event fired
 * at the checkpoint before entry `i` carries index `positions[i]`, and a
 * reference made by entry `j` is retained through that event exactly when
 * `positions[i] > positions[j]`: the same arithmetic the turn-indexed metrics
 * used, at request granularity.
 */
export function checkpointPositions(entries: ReadonlyArray<SessionEntry>): number[] {
	const positions: number[] = new Array(entries.length);
	let count = 0;
	for (let i = 0; i < entries.length; i += 1) {
		if (isPressureCheckpointBefore(entries, i)) count += 1;
		positions[i] = count;
	}
	return positions;
}

export interface RearmBandInput {
	/** Projected working-set tokens now, priced like `tokensAfter` was. */
	projectedTokens: number;
	contextWindow: number;
	/** `context.workingSet.rearmFraction`. */
	rearmFraction: number;
	/** `tokensAfter` of the newest eviction event on the active path, null when none or when a summary followed it. */
	lastEvictionTokensAfter: number | null;
}

/**
 * True while the projection has not yet grown by `rearmFraction` of the window
 * since the last eviction event. A zero fraction disables the band. A summary
 * after the event resets it (the fold reports null), because the summary moved
 * the baseline and the old `tokensAfter` no longer describes the prompt.
 */
export function withinRearmBand(input: RearmBandInput): boolean {
	if (input.lastEvictionTokensAfter === null) return false;
	if (!(input.rearmFraction > 0) || !(input.contextWindow > 0)) return false;
	const grown = input.projectedTokens - input.lastEvictionTokensAfter;
	return grown < input.rearmFraction * input.contextWindow;
}
