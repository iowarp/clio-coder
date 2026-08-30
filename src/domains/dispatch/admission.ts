import { randomBytes } from "node:crypto";
import { endpointLabel } from "../providers/endpoint-capacity.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { ScopeSpec } from "../safety/scope.js";
import { createAdmissionQueue } from "./admission-queue.js";
import {
	acquireCapacityLease,
	type CapacityLease,
	type CapacityLimits,
	capacityLeaseUsage,
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
		endpointKey?: string;
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
	/** Requests this process admitted for a plan and has not settled yet. */
	activePlanCount(planId: string): number;
	/**
	 * Process-local shutdown drain. New admissions fail closed and everything
	 * still queued is canceled. This never touches the durable machine-wide
	 * drain, which belongs to the operator and outlives one process.
	 */
	drain(): void;
	stop(): void;
}

/**
 * Guards the window between admission and the assignment owning its lease. Until
 * the lease carries a durable assignment id, a failure on the way to launch must
 * hand the slot back; once the assignment owns it, settlement releases it and an
 * early release would drop capacity the run still holds. Releasing is idempotent.
 */
export interface LeaseSlotGuard {
	transferToAssignment(): void;
	release(): void;
}
export function createLeaseSlotGuard(
	controller: Pick<CapacityAdmissionController, "release">,
	leaseId: string,
	ownedByAssignment: boolean,
): LeaseSlotGuard {
	let held = true;
	let owned = ownedByAssignment;
	return {
		transferToAssignment: () => {
			owned = true;
		},
		release: () => {
			if (!held || owned) return;
			held = false;
			controller.release(leaseId);
		},
	};
}

/** Retry cadence while queued requests are blocked behind live capacity. */
const PUMP_MIN_MS = 10;
const PUMP_MAX_MS = 500;

/**
 * Say what the request waited on and what would let the next one through. The
 * bare outcome state ("admission timed_out") was 39 bytes of nothing: a model
 * that reads it learns neither that the wall it hit was concurrency nor that
 * waiting or dispatching fewer runs is the way past it, so it retries the same
 * shape and burns the deadline again.
 */
function describeAdmissionFailure(input: {
	state: "canceled" | "timed_out";
	nodeId: string;
	endpointKey?: string;
	waitedMs: number;
	overdueAtQueueMs: number;
	queueDepth: number;
	limits: CapacityLimits;
	usage: {
		global: number;
		nodes: Readonly<Record<string, number>>;
		endpoints: Readonly<Record<string, number>>;
	};
}): string {
	if (input.state === "canceled") return "dispatch: admission canceled before a capacity slot opened";
	if (input.endpointKey !== undefined) {
		const endpointLimit = input.limits.endpoints[input.endpointKey];
		const endpointActive = input.usage.endpoints[input.endpointKey] ?? 0;
		if (endpointLimit !== undefined && endpointActive >= endpointLimit) {
			return `dispatch: admission denied: endpoint '${endpointLabel(input.endpointKey)}' capacity reached (${endpointActive}/${endpointLimit} slots): the orchestrator's own turn holds one; collect in-flight runs or point workers at a second server`;
		}
	}
	const nodeLimit = input.limits.nodes[input.nodeId];
	const nodeActive = input.usage.nodes[input.nodeId] ?? 0;
	const where =
		nodeLimit === undefined
			? `${input.usage.global}/${input.limits.global} worker slots in use`
			: `${nodeActive}/${nodeLimit} worker slots in use on '${input.nodeId}', ${input.usage.global}/${input.limits.global} globally`;
	const queued = input.queueDepth > 0 ? `, ${input.queueDepth} more queued` : "";
	// A request whose deadline expired before it was queued never waited on
	// capacity, and saying it did sends the reader to the wrong place. A live
	// dispatch reported "timed out after 1ms waiting for a worker slot (0/4
	// worker slots in use)" for a tool call that had already run 76 seconds:
	// the fleet was idle, and all three remedies below were wrong.
	if (input.overdueAtQueueMs >= 0) {
		return [
			`dispatch: the admission deadline had already passed ${Math.round(input.overdueAtQueueMs)}ms`,
			" before this request reached the queue, so it never waited on capacity",
			` (${where}${queued}).`,
			" The budget went to work before admission, not to a busy fleet.",
		].join("");
	}
	return [
		`dispatch: admission timed out after ${Math.round(input.waitedMs)}ms waiting for a worker slot`,
		` (${where}${queued}).`,
		" Wait for running work to settle, dispatch fewer runs at once, or raise budget.concurrency.",
	].join("");
}

export function createCapacityAdmissionController(options: {
	limits: () => CapacityLimits;
	/** Live lease counts for the timeout message; defaults to the durable state file. */
	usage?: () => {
		global: number;
		nodes: Readonly<Record<string, number>>;
		endpoints: Readonly<Record<string, number>>;
	};
	now?: () => number;
	maxQueueSize?: number;
	queueCeilingMs?: number;
	heartbeatMs?: number;
	/** Reserved concurrent peak for a plan; one plan never exceeds it. */
	reservedPlanPeak?: (planId: string) => number | undefined;
}): CapacityAdmissionController {
	const now = options.now ?? Date.now;
	const leases = new Map<string, CapacityLease>();
	const pending = new Map<string, string>();
	const acquired = new Map<string, CapacityLease>();
	let draining = false;
	const queue = createAdmissionQueue<() => CapacityLease>({
		maxSize: options.maxQueueSize ?? 256,
		finiteCeilingMs: options.queueCeilingMs ?? 60_000,
		now,
		...(options.reservedPlanPeak !== undefined ? { reservedPlanPeak: options.reservedPlanPeak } : {}),
	});
	// Every admission attempt takes the cross-process admission lock, so a
	// request blocked behind someone else's lease backs off instead of hammering
	// the lock and starving lease heartbeats and reservation writes.
	let pumpBackoffMs = PUMP_MIN_MS;
	let pumpTimer: ReturnType<typeof setTimeout> | null = null;
	const pump = (): void => {
		let progressed = false;
		for (;;) {
			let admittedLease: CapacityLease | null = null;
			const admitted = queue.admitNext(now(), (request) => {
				try {
					admittedLease = request.value();
					return true;
				} catch (error) {
					// Endpoint saturation is a named refusal because waiting would keep a
					// model request queued behind the same inference scheduler. Existing
					// node and global admission retain their bounded wait behavior.
					if (error instanceof Error && /endpoint '.*' capacity reached/u.test(error.message)) {
						queue.fail(request.requestId, error);
						return false;
					}
					// Node and global capacity can wait. Anything else fails the request.
					if (error instanceof Error && /capacity reached/.test(error.message)) return false;
					queue.fail(request.requestId, error instanceof Error ? error : new Error(String(error)));
					return false;
				}
			});
			if (!admitted || !admittedLease) break;
			acquired.set(admitted.assignmentId, admittedLease);
			pending.delete(admitted.assignmentId);
			progressed = true;
		}
		pumpBackoffMs = progressed ? PUMP_MIN_MS : Math.min(PUMP_MAX_MS, pumpBackoffMs * 2);
		if (queue.size() > 0 && pumpTimer === null) {
			pumpTimer = setTimeout(() => {
				pumpTimer = null;
				pump();
			}, pumpBackoffMs);
			pumpTimer.unref();
		}
	};
	/** Capacity just changed, so retry immediately rather than after a backoff. */
	const pumpNow = (): void => {
		pumpBackoffMs = PUMP_MIN_MS;
		pump();
	};
	const heartbeatTimer = setInterval(() => {
		for (const lease of leases.values()) {
			const renewed = heartbeatCapacityLease(lease.leaseId);
			if (renewed) leases.set(renewed.leaseId, renewed);
		}
	}, options.heartbeatMs ?? 10_000);
	heartbeatTimer.unref();
	const controller: CapacityAdmissionController = {
		async admit(input) {
			if (draining) throw new Error("dispatch: admission denied: this process is shutting down");
			const queuedAt = now();
			const requestId = `admit-${queuedAt.toString(36)}-${randomBytes(5).toString("hex")}`;
			pending.set(input.assignmentId, requestId);
			try {
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
									...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
									limits: options.limits(),
									nowMs: now(),
								})
							: acquireCapacityLease({
									assignmentId: input.assignmentId,
									nodeId: input.nodeId,
									...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
									limits: options.limits(),
									nowMs: now(),
								}),
				});
				pumpNow();
				const outcome = await outcomePromise;
				if (outcome.state !== "admitted") {
					throw new Error(
						describeAdmissionFailure({
							state: outcome.state,
							nodeId: input.nodeId,
							...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
							waitedMs: now() - queuedAt,
							overdueAtQueueMs: queuedAt - input.deadlineAt,
							queueDepth: queue.size(),
							limits: options.limits(),
							usage: options.usage?.() ?? capacityLeaseUsage({ nowMs: now() }),
						}),
					);
				}
				const lease = acquired.get(input.assignmentId);
				if (!lease) throw new Error("dispatch: admitted request has no capacity lease");
				acquired.delete(input.assignmentId);
				leases.set(lease.leaseId, lease);
				return { lease, queuedAt, admittedAt: outcome.admittedAt };
			} finally {
				// Runs on rejection too: a queue-full, duplicate, or failed request
				// must not leave its assignment marked pending, or a later cancel
				// would target a request id that no longer exists.
				if (pending.get(input.assignmentId) === requestId) pending.delete(input.assignmentId);
			}
		},
		cancel(assignmentId) {
			const requestId = pending.get(assignmentId);
			if (requestId === undefined) return false;
			pending.delete(assignmentId);
			return queue.cancel(requestId);
		},
		rename(leaseId, assignmentId) {
			const previous = leases.get(leaseId)?.assignmentId;
			const lease = renameCapacityLeaseAssignment(leaseId, assignmentId);
			leases.set(leaseId, lease);
			// The plan slot follows the assignment id the lease now carries.
			if (previous !== undefined && previous !== assignmentId) queue.complete(previous);
			return lease;
		},
		release(leaseId) {
			const assignmentId = leases.get(leaseId)?.assignmentId;
			leases.delete(leaseId);
			const released = releaseCapacityLease(leaseId);
			if (assignmentId !== undefined) queue.complete(assignmentId);
			pumpNow();
			return released;
		},
		releaseAssignment(assignmentId) {
			const lease = [...leases.values()].find((entry) => entry.assignmentId === assignmentId);
			if (!lease) {
				queue.complete(assignmentId);
				return false;
			}
			return controller.release(lease.leaseId);
		},
		activePlanCount(planId) {
			return queue.activePlanCount(planId);
		},
		drain() {
			draining = true;
			for (const [assignmentId, requestId] of [...pending]) {
				pending.delete(assignmentId);
				queue.cancel(requestId);
			}
		},
		stop() {
			controller.drain();
			if (pumpTimer !== null) {
				clearTimeout(pumpTimer);
				pumpTimer = null;
			}
			clearInterval(heartbeatTimer);
		},
	};
	return controller;
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
