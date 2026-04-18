import type { SessionMeta } from "../contract.js";
import { enrichForkMeta } from "../history.js";
import { type SessionManagerState, startSession } from "../manager.js";

/**
 * Single-point fork-from-parent-turn orchestration. Closes the caller's
 * prior state writer, starts a fresh session inheriting cwd/model/provider
 * from the parent meta, then stamps parent pointers atomically via
 * enrichForkMeta. Returns the new SessionManagerState so the caller can
 * install it as current.
 *
 * Used by SessionContract.fork (current session) and the /fork message
 * picker path that lands in slice 12b-3. Kept out of extension.ts so the
 * bundle wiring stays thin.
 */
export interface ForkInput {
	/** The state we are forking from. Must carry a live writer. */
	from: SessionManagerState;
	/** Id of the parent turn (pinned via /fork message-picker). */
	parentTurnId: string;
	/** Optional cwd override; defaults to the parent session's cwd. */
	cwd?: string;
}

export interface ForkResult {
	next: SessionManagerState;
	parentMeta: SessionMeta;
}

/**
 * Fork the given state into a new session. Closes the prior writer
 * best-effort so the on-disk endedAt marker is written; the caller is
 * responsible for replacing its own state pointer with `result.next`.
 */
export function forkFromState(input: ForkInput): ForkResult {
	const parentMeta = input.from.meta;
	// Best-effort close of the prior writer before switching. Fire-and-forget:
	// close() persists tree.json and meta.json atomically; waiting would tie
	// every fork to disk latency.
	void input.from.writer.close();

	const cwd = input.cwd ?? parentMeta.cwd;
	const next = startSession({
		cwd,
		model: parentMeta.model,
		provider: parentMeta.provider,
	});
	enrichForkMeta(next.meta, parentMeta.id, input.parentTurnId);
	return { next, parentMeta };
}
