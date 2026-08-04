/** Pure failover-envelope admission for one recovery attempt. */

import type { RetryDecision } from "./failure-classification.js";
import {
	type ApprovedAssignmentRoute,
	approvedRouteCandidates,
	assertApprovedRecoveryCapability,
} from "./route-approval.js";
import type { RouteCandidate } from "./route-decision.js";
import type { DispatchFailoverCandidate, DispatchFailoverMode } from "./validation.js";

export function sameFailoverCandidate(left: DispatchFailoverCandidate, right: DispatchFailoverCandidate): boolean {
	return (
		left.agentId === right.agentId &&
		left.target === right.target &&
		left.model === right.model &&
		left.node === right.node
	);
}

export function retryDecisionWithinFailover(decision: RetryDecision, failover: DispatchFailoverMode): RetryDecision {
	return failover === "none" ? { ...decision, excludedRouteParts: [], qualityEscalation: null } : decision;
}

export function approvedEnvelopeRejection(approval: ApprovedAssignmentRoute, candidate: RouteCandidate): string | null {
	try {
		assertApprovedRecoveryCapability(approval, candidate);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function selectApprovedRecoveryCandidates(input: {
	current: DispatchFailoverCandidate;
	allowed: ReadonlyArray<DispatchFailoverCandidate>;
	approval: ApprovedAssignmentRoute | null;
	decision: RetryDecision;
}): DispatchFailoverCandidate[] {
	if (!input.allowed.some((candidate) => sameFailoverCandidate(candidate, input.current))) {
		throw new Error("dispatch: approved failover envelope does not contain the current route");
	}
	const active = input.approval === null ? [] : approvedRouteCandidates(input.approval);
	if (input.approval !== null) {
		if (!active.some((candidate) => sameFailoverCandidate(candidate, input.current))) {
			throw new Error("dispatch: active approval does not contain the current route");
		}
		if (input.allowed.some((candidate) => !active.some((approved) => sameFailoverCandidate(approved, candidate)))) {
			throw new Error("dispatch: failover envelope exceeds the active route approval");
		}
	}
	if (input.decision.excludedRouteParts.every((part) => part === "runtime")) return [{ ...input.current }];
	const canChangeAgent =
		input.decision.qualityEscalation?.kind === "model-quality" &&
		input.decision.qualityEscalation.allowAgentChange &&
		input.approval !== null;
	const candidates = input.allowed.filter((candidate) => {
		if (sameFailoverCandidate(candidate, input.current)) return false;
		if (
			candidate.agentId !== input.current.agentId &&
			(!canChangeAgent || !active.some((entry) => sameFailoverCandidate(entry, candidate)))
		)
			return false;
		return input.decision.excludedRouteParts.some((part) => {
			if (part === "agent") return candidate.agentId !== input.current.agentId;
			if (part === "target") return candidate.target !== input.current.target;
			if (part === "model") return candidate.model !== input.current.model;
			if (part === "node") return candidate.node !== input.current.node;
			return false;
		});
	});
	if (candidates.length === 0) throw new Error("dispatch: approved failover envelope has no eligible next candidate");
	return candidates.map((candidate) => ({ ...candidate }));
}
