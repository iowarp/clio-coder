/** Strict plan-time authority for one actively routed assignment. */

import { isExecutionRole } from "./execution-role.js";
import { type RouteDecisionV1, sameRouteIdentity } from "./route-decision.js";
import { ROUTE_POLICY_VERSION } from "./route-policy.js";
import type { DispatchFailoverCandidate } from "./validation.js";

export const APPROVED_ASSIGNMENT_ROUTE_VERSION = 1;

export interface ApprovedAssignmentRoute {
	version: 1;
	/** The same resolver artifact later sealed on every attempt receipt. */
	decision: RouteDecisionV1;
	/** Aggregate ceiling for the root attempt and every permitted retry. */
	totalCostUpperBoundUsd: number;
	/** One assignment-wide duration measured from root admission request. */
	deadlineMs: number;
	/** Root attempt included. */
	maxAttempts: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routeCandidate(value: unknown): boolean {
	if (!record(value) || !isExecutionRole(value.executionRole)) return false;
	return [
		"agentId",
		"specFingerprint",
		"targetId",
		"modelId",
		"runtimeId",
		"nodeId",
		"toolSignature",
		"promptCompositionHash",
		"endpointIdentityHash",
		"settingsFingerprint",
	].every((field) => typeof value[field] === "string" && value[field].length > 0);
}

export function isApprovedAssignmentRoute(value: unknown): value is ApprovedAssignmentRoute {
	if (!record(value) || value.version !== APPROVED_ASSIGNMENT_ROUTE_VERSION || !record(value.decision)) return false;
	const decision = value.decision;
	if (
		decision.mode !== "active" ||
		!routeCandidate(decision.selected) ||
		!routeCandidate(decision.executedRoute) ||
		!Array.isArray(decision.approvedFallbacks) ||
		!decision.approvedFallbacks.every(routeCandidate) ||
		!Array.isArray(decision.candidateEvaluations) ||
		!decision.candidateEvaluations.every(
			(evaluation) =>
				record(evaluation) &&
				routeCandidate(evaluation.candidate) &&
				record(evaluation.activeReadiness) &&
				typeof evaluation.activeReadiness.ready === "boolean" &&
				Array.isArray(evaluation.activeReadiness.gaps) &&
				evaluation.activeReadiness.gaps.every((gap) => typeof gap === "string") &&
				Number.isInteger(evaluation.activeReadiness.labelsNeeded),
		) ||
		decision.policyVersion !== ROUTE_POLICY_VERSION ||
		typeof decision.decisionHash !== "string" ||
		!/^[0-9a-f]{64}$/u.test(decision.decisionHash)
	) {
		return false;
	}
	try {
		assertApprovedAssignmentRoute(value as unknown as ApprovedAssignmentRoute);
		return true;
	} catch {
		return false;
	}
}

export function assertApprovedAssignmentRoute(value: ApprovedAssignmentRoute): void {
	if (value.version !== APPROVED_ASSIGNMENT_ROUTE_VERSION) {
		throw new Error("dispatch: unsupported active route approval version");
	}
	if (value.decision.mode !== "active" || !sameRouteIdentity(value.decision.selected, value.decision.executedRoute)) {
		throw new Error("dispatch: active route approval must seal one selected and executed identity");
	}
	for (const candidate of [value.decision.selected, ...value.decision.approvedFallbacks]) {
		const evaluation = value.decision.candidateEvaluations.find((entry) => sameRouteIdentity(entry.candidate, candidate));
		if (evaluation === undefined || evaluation.rejection !== null || !evaluation.activeReadiness.ready) {
			throw new Error("dispatch: active route approval contains a rejected or readiness-ineligible route");
		}
	}
	if (!Number.isFinite(value.totalCostUpperBoundUsd) || value.totalCostUpperBoundUsd < 0) {
		throw new Error("dispatch: active route approval total cost bound is invalid");
	}
	if (!Number.isInteger(value.deadlineMs) || value.deadlineMs <= 0) {
		throw new Error("dispatch: active route approval deadline is invalid");
	}
	if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1) {
		throw new Error("dispatch: active route approval attempt bound is invalid");
	}
}

export function cloneApprovedAssignmentRoute(value: ApprovedAssignmentRoute): ApprovedAssignmentRoute {
	assertApprovedAssignmentRoute(value);
	return structuredClone(value);
}

export function approvedRouteCandidates(value: ApprovedAssignmentRoute): DispatchFailoverCandidate[] {
	assertApprovedAssignmentRoute(value);
	return [value.decision.selected, ...value.decision.approvedFallbacks].map((candidate) => ({
		agentId: candidate.agentId,
		target: candidate.targetId,
		model: candidate.modelId,
		node: candidate.nodeId,
	}));
}

/** Recheck every capability dimension that must survive a recovery-role prompt change. */
export function assertApprovedRecoveryCapability(
	approval: ApprovedAssignmentRoute,
	actual: RouteDecisionV1["selected"],
): void {
	assertApprovedAssignmentRoute(approval);
	const approved = [approval.decision.selected, ...approval.decision.approvedFallbacks].find(
		(candidate) =>
			candidate.agentId === actual.agentId &&
			candidate.targetId === actual.targetId &&
			candidate.modelId === actual.modelId &&
			candidate.runtimeId === actual.runtimeId &&
			candidate.nodeId === actual.nodeId,
	);
	if (
		approved === undefined ||
		approved.specFingerprint !== actual.specFingerprint ||
		approved.thinkingLevel !== actual.thinkingLevel ||
		approved.toolSignature !== actual.toolSignature ||
		approved.endpointIdentityHash !== actual.endpointIdentityHash ||
		approved.settingsFingerprint !== actual.settingsFingerprint
	) {
		throw new Error("dispatch: recovery route capability drifted outside the active approval");
	}
}
