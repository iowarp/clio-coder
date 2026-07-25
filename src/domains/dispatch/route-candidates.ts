/**
 * Bounded, deterministic route candidate enumeration.
 *
 * Plan approval freezes a route envelope, never a bare tuple: an approved
 * exact route and automatic failover are semantically opposed, so a planned
 * task is either an exact pin with no failover or a bounded list the operator
 * actually saw. This module decides which alternates are offered and in what
 * order. It applies hard constraints only, never scoring or preference, and is
 * the seed of the P1 router.
 *
 * Pure by construction: no engine references, no dispatch-extension state, no
 * I/O. The caller resolves each proposed tuple through the same admission
 * chain a real dispatch would use and reports the verdict as a probe.
 */

import type { DispatchFailoverCandidate } from "./validation.js";

/**
 * Envelope width. Three is the resolved route plus one alternate target and
 * one alternate node, which covers the target-* and node-* failure classes
 * without asking an operator to approve a list they cannot read.
 */
export const ROUTE_CANDIDATE_LIMIT = 3;

export interface RouteUniverse {
	agentId: string;
	/** The route this request resolves to today. Always the first candidate. */
	resolved: DispatchFailoverCandidate;
	/** Alternate targets with their wire model, in configured preference order. */
	targets: ReadonlyArray<{ id: string; model: string }>;
	/** Alternate node ids, in fleet preference order. */
	nodes: ReadonlyArray<string>;
}

export interface RouteCandidateProbe {
	candidate: DispatchFailoverCandidate;
	/** Null when the tuple passed every hard filter; otherwise why it did not. */
	rejection: string | null;
}

export function sameRouteCandidate(left: DispatchFailoverCandidate, right: DispatchFailoverCandidate): boolean {
	return (
		left.agentId === right.agentId &&
		left.target === right.target &&
		left.model === right.model &&
		left.node === right.node
	);
}

/**
 * The ordered tuples worth probing. Alternate targets on the resolved node come
 * before alternate nodes on the resolved target: a target failure is the more
 * common one, and keeping the node fixed changes the smallest amount of the
 * route. Order is fully determined by the input, so equal inputs always
 * produce equal envelopes and therefore equal plan hashes.
 */
export function routeCandidateOrder(universe: RouteUniverse): ReadonlyArray<DispatchFailoverCandidate> {
	const ordered: DispatchFailoverCandidate[] = [{ ...universe.resolved }];
	const add = (candidate: DispatchFailoverCandidate): void => {
		if (ordered.some((entry) => sameRouteCandidate(entry, candidate))) return;
		ordered.push(candidate);
	};
	for (const target of universe.targets) {
		add({ agentId: universe.agentId, target: target.id, model: target.model, node: universe.resolved.node });
	}
	for (const node of universe.nodes) {
		add({ agentId: universe.agentId, target: universe.resolved.target, model: universe.resolved.model, node });
	}
	return ordered;
}

/**
 * Keep the resolved route plus every alternate that passed its hard filters,
 * in probe order, bounded by `limit`. The resolved route is always present:
 * an envelope that excluded the route the plan resolved would refuse its own
 * first attempt at `assertRouteWithinApprovedEnvelope`.
 */
export function selectRouteCandidates(
	resolved: DispatchFailoverCandidate,
	probes: ReadonlyArray<RouteCandidateProbe>,
	limit: number = ROUTE_CANDIDATE_LIMIT,
): ReadonlyArray<DispatchFailoverCandidate> {
	const selected: DispatchFailoverCandidate[] = [{ ...resolved }];
	for (const probe of probes) {
		if (selected.length >= Math.max(1, limit)) break;
		if (probe.rejection !== null) continue;
		if (selected.some((entry) => sameRouteCandidate(entry, probe.candidate))) continue;
		selected.push({ ...probe.candidate });
	}
	return selected;
}

/** Whether one enveloped candidate can accept new work right now. */
export interface RouteAvailability {
	candidate: DispatchFailoverCandidate;
	/** Null when the candidate can take new work; otherwise why it cannot. */
	unavailable: string | null;
}

/**
 * The first envelope member that can accept new work, in approval order.
 *
 * Availability is a hard filter applied at launch, not a preference: a target
 * cooling down after a failure is unusable for a *new* assignment even though
 * the plan approved it, and the envelope exists precisely so the next member
 * can carry the work instead of the dispatch dying. Order is the approved
 * order, so equal inputs always pick the same route. Null means every member
 * is unavailable and the caller reports the resolved route's own reason.
 */
export function firstAvailableRouteCandidate(
	probes: ReadonlyArray<RouteAvailability>,
): DispatchFailoverCandidate | null {
	const available = probes.find((probe) => probe.unavailable === null);
	return available ? { ...available.candidate } : null;
}
