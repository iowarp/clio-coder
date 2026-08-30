/**
 * Pure heartbeat watchdog classifier (Phase 6 slice 3).
 *
 * Maps a last-seen monotonic stamp to one of three states. The dispatch domain
 * drives this on each scheduler tick; the orchestrator uses `stale` to surface
 * a warning in the UI and `dead` to reap a subprocess whose event stream has
 * gone quiet for too long.
 *
 * No I/O, no clocks of its own. Callers pass both monotonic values to keep the
 * function pure and easy to test.
 */

export interface HeartbeatSpec {
	windowMs: number;
	graceMs: number;
}

export type HeartbeatStatus = "alive" | "stale" | "dead";

/**
 * Mutable heartbeat facts shared by a transport and the dispatch watchdog.
 * `current` is an absolute wall-clock instant for display and persistence.
 * `monotonic` is from this process's monotonic clock and is the only value
 * liveness code may compare with a later clock read.
 *
 * The monotonic field is optional only for injected legacy test handles. Real
 * transports always provide it. Treating an old handle's `current` as its
 * monotonic stamp preserves the structural test seam without reintroducing a
 * subtraction between two wall-clock reads in the product path.
 */
export interface HeartbeatStamp {
	current: number;
	monotonic?: number;
}

export const DEFAULT_HEARTBEAT_SPEC: HeartbeatSpec = { windowMs: 5000, graceMs: 10000 };

export function heartbeatMonotonicAt(heartbeat: HeartbeatStamp): number {
	return heartbeat.monotonic ?? heartbeat.current;
}

export function classifyHeartbeat(
	heartbeatMonotonicAt: number,
	monotonicNow: number,
	spec: HeartbeatSpec,
): HeartbeatStatus {
	const age = monotonicNow - heartbeatMonotonicAt;
	if (age <= spec.windowMs) return "alive";
	if (age <= spec.windowMs + spec.graceMs) return "stale";
	return "dead";
}
