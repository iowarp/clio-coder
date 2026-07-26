import { randomBytes } from "node:crypto";
import type { ActionClass } from "../safety/action-classifier.js";
import type { ScopeSpec } from "../safety/scope.js";
import { createAdmissionQueue } from "./admission-queue.js";
import {
	acquireCapacityLease,
	type CapacityLease,
	type CapacityLimits,
	heartbeatCapacityLease,
	releaseCapacityLease,
	renameCapacityLeaseAssignment,
} from "./capacity-lease.js";
import { transferDispatchReservationToLease } from "./reservation-store.js";

/**
 * Dispatch admission gate. Given a worker's requested scope and the
 * orchestrator's active scope, decide whether the dispatch may proceed. The
 * actual subset predicate is injected so this module stays pure and testable
 * without importing the safety domain's runtime wiring.
 *
 * Rules:
 *   1. worker scope must be a subset of orchestrator scope.
 *   2. every requestedAction must appear in requestedScope.allowedActions.
 *   3. otherwise admit.
 */

export interface AdmissionRequest {
	requestedScope: ScopeSpec;
	orchestratorScope: ScopeSpec;
	requestedActions: ReadonlyArray<ActionClass>;
	agentId: string;
}

export interface AdmissionVerdict {
	admitted: boolean;
	reason: string;
}

export interface CapacityAdmissionController {
	admit(input: {
		assignmentId: string;
		nodeId: string;
		deadlineAt: number;
		priority?: number;
		planId?: string;
		planOrder?: number;
		reservation?: { ownerId: string; memberId: string };
	}): Promise<{ lease: CapacityLease; queuedAt: number; admittedAt: number }>;
	cancel(assignmentId: string): boolean;
	rename(leaseId: string, assignmentId: string): CapacityLease;
	release(leaseId: string): boolean;
	releaseAssignment(assignmentId: string): boolean;
	stop(): void;
}

export function createCapacityAdmissionController(options: {
	limits: () => CapacityLimits;
	now?: () => number;
	maxQueueSize?: number;
	queueCeilingMs?: number;
	heartbeatMs?: number;
}): CapacityAdmissionController {
	const now = options.now ?? Date.now;
	const leases = new Map<string, CapacityLease>();
	const pending = new Map<string, string>();
	const acquired = new Map<string, CapacityLease>();
	const queue = createAdmissionQueue<() => CapacityLease>({
		maxSize: options.maxQueueSize ?? 256,
		finiteCeilingMs: options.queueCeilingMs ?? 60_000,
		now,
	});
	const pump = (): void => {
		for (;;) {
			let admittedLease: CapacityLease | null = null;
			const admitted = queue.admitNext(now(), (request) => {
				try {
					admittedLease = request.value();
					return true;
				} catch (error) {
					if (error instanceof Error && /capacity reached/.test(error.message)) return false;
					queue.fail(request.requestId, error instanceof Error ? error : new Error(String(error)));
					return false;
				}
			});
			if (!admitted || !admittedLease) return;
			acquired.set(admitted.assignmentId, admittedLease);
			pending.delete(admitted.assignmentId);
		}
	};
	const pumpTimer = setInterval(pump, 10);
	const heartbeatTimer = setInterval(() => {
		for (const lease of leases.values()) {
			const renewed = heartbeatCapacityLease(lease.leaseId);
			if (renewed) leases.set(renewed.leaseId, renewed);
		}
	}, options.heartbeatMs ?? 10_000);
	pumpTimer.unref();
	heartbeatTimer.unref();
	return {
		async admit(input) {
			const queuedAt = now();
			const requestId = `admit-${queuedAt.toString(36)}-${randomBytes(5).toString("hex")}`;
			pending.set(input.assignmentId, requestId);
			const outcomePromise = queue.enqueue({
				requestId,
				assignmentId: input.assignmentId,
				priority: input.priority ?? 0,
				queuedAt,
				deadlineAt: input.deadlineAt,
				planId: input.planId ?? null,
				planOrder: input.planOrder ?? null,
				value: () =>
					input.reservation
						? transferDispatchReservationToLease({
								ownerId: input.reservation.ownerId,
								memberId: input.reservation.memberId,
								assignmentId: input.assignmentId,
								nodeId: input.nodeId,
								limits: options.limits(),
								nowMs: now(),
							})
						: acquireCapacityLease({
								assignmentId: input.assignmentId,
								nodeId: input.nodeId,
								limits: options.limits(),
								nowMs: now(),
							}),
			});
			pump();
			const outcome = await outcomePromise;
			pending.delete(input.assignmentId);
			if (outcome.state !== "admitted") throw new Error(`dispatch: admission ${outcome.state}`);
			const lease = acquired.get(input.assignmentId);
			if (!lease) throw new Error("dispatch: admitted request has no capacity lease");
			acquired.delete(input.assignmentId);
			leases.set(lease.leaseId, lease);
			return { lease, queuedAt, admittedAt: outcome.admittedAt };
		},
		cancel(assignmentId) {
			const requestId = pending.get(assignmentId);
			return requestId ? queue.cancel(requestId) : false;
		},
		rename(leaseId, assignmentId) {
			const lease = renameCapacityLeaseAssignment(leaseId, assignmentId);
			leases.set(leaseId, lease);
			return lease;
		},
		release(leaseId) {
			leases.delete(leaseId);
			const released = releaseCapacityLease(leaseId);
			pump();
			return released;
		},
		releaseAssignment(assignmentId) {
			const lease = [...leases.values()].find((entry) => entry.assignmentId === assignmentId);
			return lease ? this.release(lease.leaseId) : false;
		},
		stop() {
			clearInterval(pumpTimer);
			clearInterval(heartbeatTimer);
			for (const [assignmentId, requestId] of pending) {
				queue.cancel(requestId);
				pending.delete(assignmentId);
			}
		},
	};
}

export function admit(
	req: AdmissionRequest,
	subsetFn: (worker: ScopeSpec, orch: ScopeSpec) => boolean,
): AdmissionVerdict {
	if (!subsetFn(req.requestedScope, req.orchestratorScope)) {
		return { admitted: false, reason: `scope ${req.agentId} is not a subset` };
	}
	for (const action of req.requestedActions) {
		if (!req.requestedScope.allowedActions.has(action)) {
			return { admitted: false, reason: `action ${action} not in requestedScope.allowedActions` };
		}
	}
	return { admitted: true, reason: "ok" };
}
