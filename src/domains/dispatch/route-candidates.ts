/** Production failover helpers for an already approved route envelope. */

import type { DispatchRequest } from "./contract.js";
import type { DispatchFailoverCandidate } from "./validation.js";

/** Maximum number of approved production tuples carried by a plan envelope. */
export const ROUTE_CANDIDATE_LIMIT = 3;

/** Whether one enveloped candidate can accept new work right now. */
export interface RouteAvailability {
	candidate: DispatchFailoverCandidate;
	/** Null when the candidate can take new work. */
	unavailable: string | null;
}

/** Hard route-boundary rejections shared by shadow and active resolution. */
export function routeBoundaryRejections(
	request: DispatchRequest,
	tuple: { targetId: string; modelId: string; nodeId: string },
	exact: boolean,
): Record<string, string> {
	const rejections: Record<string, string> = {};
	if (
		exact &&
		((request.target !== undefined && request.target !== tuple.targetId) ||
			(request.model !== undefined && request.model !== tuple.modelId) ||
			(request.node !== undefined && request.node !== tuple.nodeId))
	) {
		rejections["manual-pins"] = "tuple differs from an exact request pin";
	}
	if (
		request.failover === "approved" &&
		request.allowedCandidates !== undefined &&
		!(request.allowedCandidates ?? []).some(
			(candidate) =>
				candidate.agentId === request.agentId &&
				candidate.target === tuple.targetId &&
				candidate.model === tuple.modelId &&
				candidate.node === tuple.nodeId,
		)
	) {
		rejections["approved-envelope"] = "tuple is outside the approved envelope";
	}
	return rejections;
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
