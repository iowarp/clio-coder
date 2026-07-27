/** Production failover helpers for an already approved route envelope. */

import type { DispatchFailoverCandidate } from "./validation.js";

/** Maximum number of approved production tuples carried by a plan envelope. */
export const ROUTE_CANDIDATE_LIMIT = 3;

/** Whether one enveloped candidate can accept new work right now. */
export interface RouteAvailability {
	candidate: DispatchFailoverCandidate;
	/** Null when the candidate can take new work. */
	unavailable: string | null;
}

/**
 * Return the first currently available approved tuple. Candidate construction,
 * hard filtering, and ranking belong to joint-route-resolver. This helper has
 * no policy beyond preserving the already sealed envelope order.
 */
export function firstAvailableRouteCandidate(
	probes: ReadonlyArray<RouteAvailability>,
): DispatchFailoverCandidate | null {
	const available = probes.find((probe) => probe.unavailable === null);
	return available ? { ...available.candidate } : null;
}
