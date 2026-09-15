/**
 * Protocol floors for the wire methods that are not universal.
 *
 * The `ping` handshake records the server protocol and version. Notification,
 * pane-control, layout, and worktree methods require the protocol floors below.
 * Older servers answer `invalid_request`, so callers check support and take
 * the documented fallback before making those calls.
 *
 * The floors are protocol introductions checked against herdr's changelog and
 * then re-verified with `herdr api schema --json` on the released artifacts
 * themselves: 0.7.5 (protocol 17) and the pinned 0.8.2, whose hash-verified
 * binary speaks protocol 20, not 21. Both schemas carry pane.focus,
 * layout.export, and layout.set_split_ratio as method constants, so the whole
 * dock tier floors at 17 alongside notification.show and pane.zoom. (An
 * earlier attestation put these at 21 after reading a stray dev build that
 * self-reported "0.8.2" while speaking protocol 21; on the real pin that
 * floor gated the dock tier off entirely.) Worktrees arrived in protocol 10.
 * 17 is the oldest schema actually read, not the oldest that might work.
 * Lower one only after checking the schema of the release you are lowering
 * it to.
 */

import type { MuxServerInfo } from "./types.js";

/** Wire methods with explicit protocol floors. Basic discovery methods are unconditional. */
export type MuxGatedMethod =
	| "notification.show"
	| "pane.rename"
	| "pane.focus"
	| "pane.zoom"
	| "layout.export"
	| "layout.set_split_ratio"
	| "worktree.list"
	| "worktree.create"
	| "worktree.open"
	| "worktree.remove";

export const MUX_METHOD_MIN_PROTOCOL: Readonly<Record<MuxGatedMethod, number>> = {
	"notification.show": 17,
	"pane.rename": 17,
	"pane.focus": 17,
	"pane.zoom": 17,
	"layout.export": 17,
	"layout.set_split_ratio": 17,
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
