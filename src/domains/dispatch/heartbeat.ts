/**
 * Pure heartbeat watchdog classifier (Phase 6 slice 3).
 *
 * Maps a last-seen heartbeat timestamp to one of three states. The dispatch
 * domain drives this on each scheduler tick; the orchestrator uses `stale` to
 * surface a warning in the UI and `dead` to reap a subprocess whose event
 * stream has gone quiet for too long.
 *
 * No I/O, no clocks of its own. Callers pass `now` to keep the function pure
 * and easy to test.
 */

export interface HeartbeatSpec {
	windowMs: number;
	graceMs: number;
}

export type HeartbeatStatus = "alive" | "stale" | "dead";

export const DEFAULT_HEARTBEAT_SPEC: HeartbeatSpec = { windowMs: 5000, graceMs: 10000 };

export function classifyHeartbeat(heartbeatAt: number, now: number, spec: HeartbeatSpec): HeartbeatStatus {
	const age = now - heartbeatAt;
	if (age <= spec.windowMs) return "alive";
	if (age <= spec.windowMs + spec.graceMs) return "stale";
	return "dead";
}
