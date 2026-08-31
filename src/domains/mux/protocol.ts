/**
 * Protocol floors for the wire methods that are not universal.
 *
 * Phase 1 recorded `protocol` and `version` from the `ping` handshake and gated
 * nothing on them, because every method phase 1 used exists across the whole
 * protocol range Clio cares about. Phase 3 adds two that do not, and Phase 4
 * adds the worktree family: a herdr old
 * enough to predate them answers `invalid_request`, and the honest response is
 * to take the documented fallback rather than to log a failure per call.
 *
 * The floors are protocol introductions checked against herdr's changelog and
 * then re-verified with `herdr api schema --json` from PATH 0.7.5/protocol 17
 * and pinned 0.8.2/protocol 21. Worktrees arrived in protocol 10; notification
 * and agent focus arrived in 17. Lower one only after checking the schema of
 * the release you are lowering it to.
 */

import type { MuxServerInfo } from "./types.js";

/** Wire methods this file gates. Phase 1 methods are unconditional and absent here. */
export type MuxGatedMethod =
	| "notification.show"
	| "agent.focus"
	| "worktree.list"
	| "worktree.create"
	| "worktree.open"
	| "worktree.remove";

export const MUX_METHOD_MIN_PROTOCOL: Readonly<Record<MuxGatedMethod, number>> = {
	"notification.show": 17,
	"agent.focus": 17,
	"worktree.list": 10,
	"worktree.create": 10,
	"worktree.open": 10,
	"worktree.remove": 10,
};

/**
 * Whether the server that answered detection is new enough for `method`.
 *
 * A missing server record means detection never completed a handshake, which is
 * the `none` rung: nothing is supported because nothing is there.
 */
export function muxSupportsMethod(server: MuxServerInfo | null, method: MuxGatedMethod): boolean {
	if (server === null) return false;
	return server.protocol >= MUX_METHOD_MIN_PROTOCOL[method];
}
