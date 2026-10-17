import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import { tryWithStateFileLockSync, withStateFileLockSection } from "../../core/state-file-lock.js";
import { endpointLabel } from "../providers/endpoint-capacity.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { ScopeSpec } from "../safety/scope.js";
import { AdmissionCanceledError, AdmissionTimedOutError } from "./admission-error.js";
import { createAdmissionQueue } from "./admission-queue.js";
import {
	acquireCapacityLeaseUnsafe,
	type CapacityLease,
	type CapacityLimits,
	capacityLeaseUsageUnsafe,
	capacityStateLockPath,
	describeEndpointCapacityHolders,
	type EndpointCapacityHolders,
	releaseCapacityLease,
	renameCapacityLeaseAssignment,
	renewCapacityLeasesUnsafe,
} from "./capacity-lease.js";
import { transferDispatchReservationToLeaseUnsafe } from "./reservation-store.js";

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
		deadlineAt?: number;
		priority?: number;
		planId?: string;
		planOrder?: number;
		reservation?: { ownerId: string; memberId: string };
		/** Cancels this request alone; requests sharing its assignment keep waiting. */
		signal?: AbortSignal;
	}): Promise<{ lease: CapacityLease; queuedAt: number; admittedAt: number }>;
	/** Cancel every queued request of the assignment. */
	cancel(assignmentId: string): boolean;
	rename(leaseId: string, assignmentId: string): CapacityLease;
	release(leaseId: string): boolean;
	releaseAssignment(assignmentId: string): boolean;
	/** Requests this process admitted for a plan and has not settled yet. */
	activePlanCount(planId: string): number;
	/**
	 * The loss detail once a renewal found this lease gone from the shared store
	 * and the owner was told, null otherwise. A run that starts after that
	 * notice checks here, since the owner's sweep could not see it yet.
	 */
	lostLeaseDetail(leaseId: string): string | null;
	/**
	 * Process-local shutdown drain. New admissions fail closed and everything
	 * still queued is canceled. This never touches the durable machine-wide
	 * drain, which belongs to the operator and outlives one process.
	 */
	drain(): void;
	/** Drain, abort lock waits, and settle in-flight admission and renewal work. Never rejects. */
	stop(): Promise<void>;
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
export function foregroundEndpointBlock(input: {
	endpointKey?: string;
	limits: CapacityLimits;
	usage: {
		endpoints: Readonly<Record<string, number>>;
		endpointHolders?: Readonly<Record<string, EndpointCapacityHolders>>;
	};
}): string | null {
	if (input.endpointKey === undefined) return null;
	const limit = input.limits.endpoints[input.endpointKey];
	const active = input.usage.endpoints[input.endpointKey] ?? 0;
	const holders = input.usage.endpointHolders?.[input.endpointKey];
	if (limit === undefined || active < limit || !holders || holders.foregroundStreams < 1) return null;
	return [
		`dispatch: admission denied: endpoint '${endpointLabel(input.endpointKey)}' cannot open a worker slot`,
		` while ${describeEndpointCapacityHolders(holders)} (${active}/${limit} slots).`,
		" The foreground agent cannot release its slot until this tool call returns, so waiting here would deadlock.",
		" Point workers at a second endpoint or raise this target's maxConcurrentRequests to the server's actual slot count.",
	].join("");
}

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
		endpointHolders?: Readonly<Record<string, EndpointCapacityHolders>>;
	};
}): string {
	if (input.state === "canceled") return "dispatch: admission canceled before a capacity slot opened";
	if (input.endpointKey !== undefined) {
		const endpointLimit = input.limits.endpoints[input.endpointKey];
		const endpointActive = input.usage.endpoints[input.endpointKey] ?? 0;
		if (endpointLimit !== undefined && endpointActive >= endpointLimit) {
			const holders = input.usage.endpointHolders?.[input.endpointKey];
			const occupancy =
				holders === undefined
					? "the supplied capacity snapshot does not attribute the occupied slots"
					: describeEndpointCapacityHolders(holders);
			const queued = input.queueDepth > 0 ? `, ${input.queueDepth} more queued` : "";
			return [
				`dispatch: admission timed out after ${Math.round(input.waitedMs)}ms waiting for an endpoint slot`,
				` on '${endpointLabel(input.endpointKey)}' (${endpointActive}/${endpointLimit} slots${queued}): ${occupancy}.`,
				" Wait for the running request to settle or dispatch this work again.",
			].join("");
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

/**
 * A request whose deadline ran out before any admission pass read the shared
 * state for it, so there is no occupancy to report. Why no pass ran (a held
 * lock, a busy loop) is not known here and is not guessed at.
 */
function describeUnobservedTimeout(input: { waitedMs: number; overdueAtQueueMs: number }): string {
	if (input.overdueAtQueueMs >= 0)
		return [
			`dispatch: the admission deadline had already passed ${Math.round(input.overdueAtQueueMs)}ms`,
			" before this request reached the queue, so it never waited on capacity.",
			" The budget went to work before admission, not to a busy fleet.",
		].join("");
	return [
		`dispatch: admission timed out after ${Math.round(input.waitedMs)}ms waiting for a worker slot;`,
		" no capacity snapshot was obtained before the deadline.",
	].join("");
}

type AdmissionUsage = {
	global: number;
	nodes: Readonly<Record<string, number>>;
	endpoints: Readonly<Record<string, number>>;
	endpointHolders?: Readonly<Record<string, EndpointCapacityHolders>>;
};

export function createCapacityAdmissionController(options: {
	limits: () => CapacityLimits;
	/** Live lease counts for the timeout message; defaults to the durable state file. */
	usage?: () => AdmissionUsage;
	now?: () => number;
	maxQueueSize?: number;
	heartbeatMs?: number;
	/** Reserved concurrent peak for a plan; one plan never exceeds it. */
	reservedPlanPeak?: (planId: string) => number | undefined;
	/** Report a renewal transaction that failed; the next heartbeat retries it. */
	onRenewalError?: (error: Error) => void;
	/**
	 * A renewal found this lease gone from the shared store, so its slot may
	 * already belong to someone else. The owner stops the run holding it.
	 */
	onLeaseLost?: (lease: CapacityLease, detail: string) => void;
}): CapacityAdmissionController {
	const now = options.now ?? Date.now;
	const leases = new Map<string, CapacityLease>();
	/** Queued request ids by assignment; fleet members share their root's assignment and wait together. */
	const pending = new Map<string, Set<string>>();
	const forgetPending = (assignmentId: string, requestId: string): void => {
		const ids = pending.get(assignmentId);
		if (ids === undefined) return;
		ids.delete(requestId);
		if (ids.size === 0) pending.delete(assignmentId);
	};
	/**
	 * Queued requests by request id. The foreground check runs once per request,
	 * on the first pass that sees it, as it used to at entry; `usage` is the
	 * latest snapshot a pass took while it waited, for its timeout message.
	 */
	const requests = new Map<string, { endpointKey?: string; foregroundChecked: boolean; usage: AdmissionUsage | null }>();
	/**
	 * Granted leases awaiting their admit() continuation, by request id: one
	 * pass can grant several requests that share an assignment (fleet members
	 * share their root's lease) before any continuation runs.
	 */
	const acquired = new Map<string, CapacityLease>();
	/** Leases this process still runs work under that the shared store no longer holds. */
	const lost = new Set<string>();
	/**
	 * Lost leases whose owner has been told, with the detail it was given. Kept
	 * past release so a run still launching under the lease is stopped on entry;
	 * one entry per confirmed loss.
	 */
	const lostNotified = new Map<string, string>();
	/** The last renewal transaction failed; cleared by a successful one or once no lease is held. */
	let renewalFault: Error | null = null;
	let draining = false;
	let stopped = false;
	const stopSignal = new AbortController();
	const queue = createAdmissionQueue<() => CapacityLease>({
		maxSize: options.maxQueueSize ?? 256,
		now,
		...(options.reservedPlanPeak !== undefined ? { reservedPlanPeak: options.reservedPlanPeak } : {}),
	});
	const notify = (fn: () => void): void => {
		try {
			fn();
		} catch {
			// The owner's handler is best effort; the controller has already recorded the fault.
		}
	};
	// Admission passes and renewals share one in-process chain, so this process
	// never has two of its own transactions backing off against each other on
	// the shared lock. Each section is synchronous: nothing else in this process
	// runs while it holds the lock, which keeps a grant and its queue removal
	// one step that cancellation cannot split. With nothing in flight the
	// section starts at once, so an uncontended admission still runs its pass
	// inside admit() as the synchronous gate did.
	let transactions: Promise<unknown> = Promise.resolve();
	/** Transactions waiting for or holding the lock; each one leaves in the step it ends. */
	let inFlight = 0;
	const transact = <T>(section: () => T): Promise<T> => {
		let open = true;
		const leave = (): void => {
			if (!open) return;
			open = false;
			inFlight -= 1;
		};
		const guarded = (): T => {
			try {
				return section();
			} finally {
				leave();
			}
		};
		const start = (): Promise<T> =>
			withStateFileLockSection(capacityStateLockPath(), guarded, { signal: stopSignal.signal });
		const run = inFlight === 0 ? start() : transactions.then(start);
		inFlight += 1;
		transactions = run.then(leave, leave);
		return run;
	};
	/**
	 * Local grants fail closed while this process cannot vouch for the leases it
	 * holds. An unrenewed lease may be reclaimed by a sibling, and a lost lease
	 * is a running worker the shared store no longer counts; admitting more here
	 * in either state could put the machine past its cap.
	 */
	const ownershipFault = (): Error | null => {
		if (lost.size > 0)
			return new Error(
				`dispatch: admission denied: ${lost.size} capacity ${lost.size === 1 ? "lease" : "leases"} this process still runs work under ${lost.size === 1 ? "is" : "are"} no longer in the shared admission store; new work is refused until ${lost.size === 1 ? "that run settles" : "those runs settle"}`,
			);
		if (renewalFault !== null)
			return new Error(
				`dispatch: admission denied: this process could not renew its capacity leases (${renewalFault.message}); new work is refused until a renewal succeeds or those runs settle`,
			);
		return null;
	};
	/**
	 * Refuse every newly queued request whose endpoint is held by a foreground
	 * stream, before any grant in this pass. It walks every queued request, so
	 * one held back by its plan's peak is still refused rather than left to wait
	 * on a slot that cannot open.
	 */
	const refuseForegroundDeadlocks = (): void => {
		const usage = options.usage?.() ?? capacityLeaseUsageUnsafe({ nowMs: now() });
		let limits: CapacityLimits | null = null;
		for (const [requestId, request] of requests) {
			request.usage = usage;
			if (request.foregroundChecked) continue;
			request.foregroundChecked = true;
			limits ??= options.limits();
			const block = foregroundEndpointBlock({
				...(request.endpointKey !== undefined ? { endpointKey: request.endpointKey } : {}),
				limits,
				usage,
			});
			if (block !== null) queue.fail(requestId, new Error(block));
		}
	};
	/** One admission pass under the held lock. */
	const admitUnderLock = (): boolean => {
		if (draining) return false;
		refuseForegroundDeadlocks();
		const fault = ownershipFault();
		let progressed = false;
		for (;;) {
			let admittedLease: CapacityLease | null = null;
			const admitted = queue.admitNext(now(), (request) => {
				if (fault !== null) {
					queue.fail(request.requestId, fault);
					return false;
				}
				try {
					admittedLease = request.value();
					return true;
				} catch (error) {
					// Saturation at any capacity dimension is transient and keeps its
					// assignment in the one bounded admission queue. Unavailable capacity,
					// draining, corrupt state, and every other error still fail immediately.
					if (error instanceof Error && /capacity reached/.test(error.message)) return false;
					queue.fail(request.requestId, error instanceof Error ? error : new Error(String(error)));
					return false;
				}
			});
			if (!admitted || !admittedLease) break;
			acquired.set(admitted.requestId, admittedLease);
			forgetPending(admitted.assignmentId, admitted.requestId);
			progressed = true;
		}
		return progressed;
	};
	// Every admission attempt takes the cross-process admission lock, so a
	// request blocked behind someone else's lease backs off instead of hammering
	// the lock and starving lease heartbeats and reservation writes.
	let pumpBackoffMs = PUMP_MIN_MS;
	let pumpTimer: ReturnType<typeof setTimeout> | null = null;
	let pumpRun: Promise<void> | null = null;
	let pumping = false;
	let pumpAgain = false;
	const schedulePump = (): void => {
		if (stopped || queue.size() === 0 || pumpTimer !== null) return;
		pumpTimer = setTimeout(() => {
			pumpTimer = null;
			pump();
		}, pumpBackoffMs);
		pumpTimer.unref();
	};
	/** The lock itself could not be taken; fail the candidates a pass would have tried. */
	const failCandidates = (error: unknown): void => {
		// Each candidate used to take the lock in turn and fail the same way, one
		// acquisition budget apiece; fail the same candidates once.
		const failure = error instanceof Error ? error : new Error(String(error));
		queue.admitNext(now(), (request) => {
			queue.fail(request.requestId, failure);
			return false;
		});
	};
	const pump = (): void => {
		if (stopped) return;
		if (pumping) {
			pumpAgain = true;
			return;
		}
		if (inFlight === 0 && queue.size() > 0) {
			// Uncontended, the pass runs here and now, as the synchronous gate did,
			// so admission order relative to the callers' own continuations is
			// unchanged. Only a held lock sends the pass to the owned async pump.
			let attempt: ReturnType<typeof tryWithStateFileLockSync<boolean>>;
			try {
				attempt = tryWithStateFileLockSync(capacityStateLockPath(), admitUnderLock);
			} catch (error) {
				failCandidates(error);
				attempt = { held: true, value: false };
			}
			if (attempt.held) {
				pumpBackoffMs = attempt.value ? PUMP_MIN_MS : Math.min(PUMP_MAX_MS, pumpBackoffMs * 2);
				schedulePump();
				return;
			}
		}
		pumping = true;
		pumpRun = (async () => {
			try {
				do {
					pumpAgain = false;
					if (queue.size() === 0) break;
					let progressed = false;
					try {
						progressed = await transact(admitUnderLock);
					} catch (error) {
						if (stopSignal.signal.aborted) return;
						failCandidates(error);
					}
					pumpBackoffMs = progressed ? PUMP_MIN_MS : Math.min(PUMP_MAX_MS, pumpBackoffMs * 2);
				} while (pumpAgain && !stopped);
			} finally {
				// The loop's exit test and this release run in one synchronous step
				// with no await between them, so a wake can never land after the
				// decision to stop and before the slot opens.
				pumping = false;
				schedulePump();
			}
		})();
	};
	/** Capacity just changed, so retry immediately rather than after a backoff. */
	const pumpNow = (): void => {
		pumpBackoffMs = PUMP_MIN_MS;
		pump();
	};
	let heartbeatRun: Promise<void> | null = null;
	/**
	 * Renew every owned lease in one transaction; a tick that finds one still
	 * running skips. A failed transaction leaves ownership unknown, not lost: a
	 * sibling never reclaims a live owner whose birth token matches, and where
	 * tokens are synthetic and expiry does decide, the next renewal that
	 * succeeds finds the lease missing. So a failure refuses every queued local request
	 * and is retried at the next tick, and only a lease confirmed missing stops
	 * its run.
	 */
	const heartbeat = (): void => {
		if (stopped || heartbeatRun !== null) return;
		const owned = [...leases.keys()].filter((leaseId) => !lost.has(leaseId));
		if (owned.length === 0) {
			renewalFault = null;
			return;
		}
		heartbeatRun = transact(() => {
			const { renewed, missing } = renewCapacityLeasesUnsafe(owned, now());
			// Applied under the lock: a lease released before this section is gone
			// from both maps, and one released after it must not be resurrected.
			for (const lease of renewed) if (leases.has(lease.leaseId)) leases.set(lease.leaseId, lease);
			const newlyLost: CapacityLease[] = [];
			for (const leaseId of missing) {
				const lease = leases.get(leaseId);
				if (lease === undefined) continue;
				lost.add(leaseId);
				newlyLost.push(lease);
			}
			return newlyLost;
		})
			.then(
				(newlyLost) => {
					const recovered = renewalFault !== null;
					renewalFault = null;
					if (recovered) pumpNow();
					for (const lease of newlyLost) {
						// Released in the gap since the section: nothing runs under it to stop.
						if (!lost.has(lease.leaseId)) continue;
						const detail = `capacity lost: lease '${lease.leaseId}' for assignment '${lease.assignmentId}' is no longer in the shared admission store, so its slot may already run another worker`;
						lostNotified.set(lease.leaseId, detail);
						notify(() => options.onLeaseLost?.(lease, detail));
					}
					// The loss gate refuses every queued local request; apply it now, not at the next backoff.
					if (newlyLost.length > 0) pumpNow();
				},
				(error: unknown) => {
					if (stopSignal.signal.aborted) return;
					const failure = error instanceof Error ? error : new Error(String(error));
					renewalFault = failure;
					notify(() => options.onRenewalError?.(failure));
				},
			)
			.finally(() => {
				heartbeatRun = null;
			});
	};
	const heartbeatTimer = setInterval(heartbeat, options.heartbeatMs ?? 10_000);
	heartbeatTimer.unref();
	const controller: CapacityAdmissionController = {
		async admit(input) {
			if (draining) throw new Error("dispatch: admission denied: this process is shutting down");
			const queuedAt = now();
			const startedAt = performance.now();
			const requestId = `admit-${queuedAt.toString(36)}-${randomBytes(5).toString("hex")}`;
			input.signal?.throwIfAborted();
			const ids = pending.get(input.assignmentId) ?? new Set<string>();
			ids.add(requestId);
			pending.set(input.assignmentId, ids);
			const onAbort = (): void => {
				queue.cancel(requestId);
			};
			input.signal?.addEventListener("abort", onAbort, { once: true });
			requests.set(requestId, {
				...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
				foregroundChecked: false,
				usage: null,
			});
			try {
				const outcomePromise = queue.enqueue({
					requestId,
					assignmentId: input.assignmentId,
					priority: input.priority ?? 0,
					queuedAt,
					...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
					planId: input.planId ?? null,
					planOrder: input.planOrder ?? null,
					// Runs inside admitUnderLock, which already holds the shared lock.
					value: () =>
						input.reservation
							? transferDispatchReservationToLeaseUnsafe({
									ownerId: input.reservation.ownerId,
									memberId: input.reservation.memberId,
									assignmentId: input.assignmentId,
									nodeId: input.nodeId,
									...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
									limits: options.limits(),
									nowMs: now(),
								})
							: acquireCapacityLeaseUnsafe({
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
					if (outcome.state === "canceled") throw new AdmissionCanceledError();
					const waitedMs = performance.now() - startedAt;
					const overdueAtQueueMs = input.deadlineAt === undefined ? 0 : queuedAt - input.deadlineAt;
					// The latest snapshot a pass took; a diagnostic never waits on the lock again.
					const usage = options.usage?.() ?? requests.get(requestId)?.usage ?? null;
					throw new AdmissionTimedOutError(
						usage === null
							? describeUnobservedTimeout({ waitedMs, overdueAtQueueMs })
							: describeAdmissionFailure({
									state: outcome.state,
									nodeId: input.nodeId,
									...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
									waitedMs,
									overdueAtQueueMs,
									queueDepth: queue.size(),
									limits: options.limits(),
									usage,
								}),
					);
				}
				const lease = acquired.get(requestId);
				if (!lease) throw new Error("dispatch: admitted request has no capacity lease");
				acquired.delete(requestId);
				leases.set(lease.leaseId, lease);
				if (draining) {
					// Granted in the step before drain began; hand it back rather
					// than start work in a process that is shutting down.
					controller.release(lease.leaseId);
					throw new AdmissionCanceledError();
				}
				return { lease, queuedAt, admittedAt: outcome.admittedAt };
			} finally {
				input.signal?.removeEventListener("abort", onAbort);
				requests.delete(requestId);
				// Runs on rejection too: a queue-full, duplicate, or failed request
				// must not leave its assignment marked pending, or a later cancel
				// would target a request id that no longer exists.
				forgetPending(input.assignmentId, requestId);
			}
		},
		cancel(assignmentId) {
			const ids = pending.get(assignmentId);
			if (ids === undefined) return false;
			pending.delete(assignmentId);
			let canceled = false;
			for (const requestId of ids) canceled = queue.cancel(requestId) || canceled;
			return canceled;
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
			lost.delete(leaseId);
			// The fault is about leases this process holds; with none left there
			// is nothing to vouch for.
			if (leases.size === 0) renewalFault = null;
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
		lostLeaseDetail(leaseId) {
			return lostNotified.get(leaseId) ?? null;
		},
		drain() {
			draining = true;
			pending.clear();
			// Every request in flight, not only the latest per assignment: requests
			// that share an assignment would otherwise outlive shutdown in the queue.
			for (const requestId of [...requests.keys()]) queue.cancel(requestId);
		},
		stop() {
			controller.drain();
			stopped = true;
			stopSignal.abort(new AdmissionCanceledError());
			if (pumpTimer !== null) {
				clearTimeout(pumpTimer);
				pumpTimer = null;
			}
			clearInterval(heartbeatTimer);
			return Promise.allSettled([pumpRun, heartbeatRun, transactions]).then(() => undefined);
		},
	};
	return controller;
}

const MAX_NAMED_EXCESS_ROOTS = 4;

function listNamed(values: ReadonlyArray<string>, max: number): string {
	if (values.length === 0) return "none";
	if (values.length <= max) return values.join(", ");
	return `${values.slice(0, max).join(", ")} and ${values.length - max} more`;
}

/**
 * Name what a worker scope holds that the orchestrator scope does not, with the
 * change that removes it. Mirrors the checks in safety `isSubset` so the text
 * names the same field the predicate refused on; the predicate stays the
 * authority, this only explains its verdict.
 */
function describeScopeExcess(worker: ScopeSpec, orchestrator: ScopeSpec): string {
	const problems: string[] = [];
	const extraActions = [...worker.allowedActions].filter((action) => !orchestrator.allowedActions.has(action)).sort();
	if (extraActions.length > 0) {
		problems.push(
			`it needs action class ${extraActions.join(", ")}, which the orchestrator scope lacks (orchestrator allows ${[...orchestrator.allowedActions].sort().join(", ")}); choose an agent or tool profile without those tools`,
		);
	}
	const orchestratorRoots = orchestrator.allowedWriteRoots.map((root) => resolvePathBoundary(process.cwd(), root));
	const outsideRoots = worker.allowedWriteRoots.filter(
		(root) => !writeRootsCover(orchestratorRoots, resolvePathBoundary(process.cwd(), root)),
	);
	if (outsideRoots.length > 0) {
		problems.push(
			`write root ${listNamed(outsideRoots, MAX_NAMED_EXCESS_ROOTS)} lies outside the orchestrator write roots (${listNamed(orchestratorRoots, MAX_NAMED_EXCESS_ROOTS)}); declare intent.write_roots inside the workspace, or leave write_roots empty`,
		);
	}
	if (worker.allowNetwork && !orchestrator.allowNetwork) {
		problems.push("it needs network access, which the orchestrator scope denies; choose an agent without network tools");
	}
	if (worker.allowDispatch && !orchestrator.allowDispatch) {
		problems.push(
			"it may dispatch further workers, which the orchestrator scope denies; choose an agent without the dispatch tool",
		);
	}
	return problems.length > 0 ? problems.join("; ") : "the subset predicate refused it without naming a field";
}

export function admit(
	req: AdmissionRequest,
	subsetFn: (worker: ScopeSpec, orch: ScopeSpec) => boolean,
): AdmissionVerdict {
	if (!subsetFn(req.requestedScope, req.orchestratorScope)) {
		return {
			admitted: false,
			reason: `scope ${req.agentId} is not a subset of the orchestrator scope: ${describeScopeExcess(req.requestedScope, req.orchestratorScope)}`,
		};
	}
	for (const action of req.requestedActions) {
		if (!req.requestedScope.allowedActions.has(action)) {
			return { admitted: false, reason: `action ${action} not in requestedScope.allowedActions` };
		}
	}
	return { admitted: true, reason: "ok" };
}
