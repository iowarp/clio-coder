/** Plan and consume active read-only route authority through the shared resolver. */

import type { RoutingActivationSettings } from "../../core/defaults.js";
import type { AgentCapabilityClass } from "../agents/spec.js";
import { activeRoutingEnabled, applyActiveRouteSelection, assertActiveRouteIdentity } from "./assignment.js";
import type { DispatchPlanTaskResolution, DispatchRequest } from "./contract.js";
import {
	type ApprovedAssignmentRoute,
	assertApprovedAssignmentRoute,
	assertApprovedRecoveryCapability,
} from "./route-approval.js";
import type { RouteCandidate, RouteDecisionV1 } from "./route-decision.js";
import type { RouteObservationHandle } from "./route-observer.js";
import type { DispatchFailoverMode, JobSpec } from "./validation.js";

interface ActivationInputs {
	request: DispatchRequest;
	settings: RoutingActivationSettings | undefined;
	capabilityClass: AgentCapabilityClass | null;
	failover: DispatchFailoverMode;
}

export function routeValidationProjection(
	request: DispatchRequest,
	allowUnenvelopedApproval = false,
): { jobSpec: JobSpec; restore(validated: JobSpec): DispatchRequest } {
	const { systemPrompt, reservation, routeApproval, routeAttemptDecision, assignmentDeadlineAt, ...raw } = request;
	const awaitingEnvelope =
		allowUnenvelopedApproval && raw.failover === "approved" && raw.allowedCandidates === undefined;
	return {
		jobSpec: awaitingEnvelope ? { ...raw, failover: "none" } : raw,
		restore: (validated) => ({
			...request,
			...validated,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			...(reservation !== undefined ? { reservation } : {}),
			...(routeApproval !== undefined ? { routeApproval } : {}),
			...(routeAttemptDecision !== undefined ? { routeAttemptDecision } : {}),
			...(assignmentDeadlineAt !== undefined ? { assignmentDeadlineAt } : {}),
			...(awaitingEnvelope ? { failover: "approved" as const } : {}),
		}),
	};
}

function enabled(input: ActivationInputs): boolean {
	return (
		input.settings !== undefined &&
		input.capabilityClass !== null &&
		activeRoutingEnabled({
			settings: input.settings,
			role: input.request.executionRole,
			posture: input.request.routingIntent?.posture ?? "balanced",
			capabilityClass: input.capabilityClass,
			failover: input.failover,
		})
	);
}

export function planActiveRoute(
	input: ActivationInputs & {
		fixed: DispatchPlanTaskResolution;
		maxAttempts: number;
		resolveDecision(): RouteDecisionV1;
		preview(request: DispatchRequest): DispatchPlanTaskResolution;
	},
): DispatchPlanTaskResolution {
	if (input.request.lineage !== undefined || !enabled(input)) return input.fixed;
	const started = process.hrtime.bigint();
	const decision = input.resolveDecision();
	decision.decisionDurationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
	const selectedRequest = applyActiveRouteSelection(input.request, decision);
	const selected = input.preview(selectedRequest);
	let perAttemptUpperBoundUsd = selected.costUpperBoundUsd;
	for (const candidate of decision.approvedFallbacks) {
		const alternate = input.preview({
			...selectedRequest,
			target: candidate.targetId,
			model: candidate.modelId,
			node: candidate.nodeId,
			workerRuntime: candidate.runtimeId,
		});
		perAttemptUpperBoundUsd = Math.max(perAttemptUpperBoundUsd, alternate.costUpperBoundUsd);
	}
	const approval: ApprovedAssignmentRoute = {
		version: 1,
		decision,
		totalCostUpperBoundUsd: perAttemptUpperBoundUsd * input.maxAttempts,
		deadlineMs: input.request.routingIntent?.deadlineMs ?? 60_000,
		maxAttempts: input.maxAttempts,
	};
	assertApprovedAssignmentRoute(approval);
	const maxCostUsd = input.request.routingIntent?.maxCostUsd;
	if (maxCostUsd !== null && maxCostUsd !== undefined && approval.totalCostUpperBoundUsd > maxCostUsd) {
		throw new Error("dispatch: active route aggregate cost bound exceeds routing.maxCostUsd");
	}
	return { ...selected, routeApproval: approval };
}

export function consumeActiveRouteApproval<T>(
	input: ActivationInputs & {
		requestedAt: string;
		observe(request: DispatchRequest, decision: RouteDecisionV1): T;
	},
): { request: DispatchRequest; observation: T } | null {
	const approval = input.request.routeApproval;
	if (enabled(input) && approval === undefined) {
		throw new Error("dispatch: active routing requires a registry-authenticated route approval");
	}
	if (approval === undefined) return null;
	assertApprovedAssignmentRoute(approval);
	const decision = input.request.lineage === undefined ? approval.decision : input.request.routeAttemptDecision;
	if (decision === undefined) {
		throw new Error("dispatch: active recovery requires a resolver-authenticated attempt decision");
	}
	const request = applyActiveRouteSelection(input.request, decision);
	if (input.request.lineage === undefined) {
		request.assignmentDeadlineAt = Date.parse(input.requestedAt) + approval.deadlineMs;
	}
	return { request, observation: input.observe(request, decision) };
}

export function approvedRouteObservation(input: {
	request: DispatchRequest;
	active: RouteObservationHandle | null;
	actual(): RouteCandidate;
	shadow(): RouteObservationHandle;
}): RouteObservationHandle {
	if (input.active === null && input.request.routeApproval === undefined) return input.shadow();
	const actual = input.actual();
	if (input.active !== null) {
		assertActiveRouteIdentity(input.active.decision, actual);
		return input.active;
	}
	assertApprovedRecoveryCapability(input.request.routeApproval as ApprovedAssignmentRoute, actual);
	return input.shadow();
}
