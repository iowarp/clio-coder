export interface AdmissionQueueRequest<T> {
	requestId: string;
	assignmentId: string;
	priority: number;
	queuedAt: number;
	deadlineAt: number;
	planId: string | null;
	planOrder: number | null;
	value: T;
}
export type AdmissionQueueOutcome<T> =
	| { state: "admitted"; request: AdmissionQueueRequest<T>; admittedAt: number; queueWaitMs: number }
	| { state: "canceled" | "timed_out"; request: AdmissionQueueRequest<T> };

/** Pure, total queue ordering: priority first, plan order where comparable, FIFO, request id. */
export function compareAdmissionRequests<T>(a: AdmissionQueueRequest<T>, b: AdmissionQueueRequest<T>): number {
	if (a.priority !== b.priority) return b.priority - a.priority;
	if (
		a.planId !== null &&
		a.planId === b.planId &&
		a.planOrder !== null &&
		b.planOrder !== null &&
		a.planOrder !== b.planOrder
	)
		return a.planOrder - b.planOrder;
	if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt;
	return a.requestId.localeCompare(b.requestId);
}
export function orderAdmissionRequests<T>(
	requests: ReadonlyArray<AdmissionQueueRequest<T>>,
): AdmissionQueueRequest<T>[] {
	return [...requests].sort(compareAdmissionRequests);
}

export interface AdmissionQueue<T> {
	enqueue(request: AdmissionQueueRequest<T>): Promise<AdmissionQueueOutcome<T>>;
	cancel(requestId: string): boolean;
	fail(requestId: string, error: Error): boolean;
	admitNext(nowMs?: number, canAdmit?: (request: AdmissionQueueRequest<T>) => boolean): AdmissionQueueRequest<T> | null;
	/** Return an assignment's plan slot once its work has settled. */
	complete(assignmentId: string): void;
	size(): number;
	/** Assignments admitted and not yet completed, by plan. */
	activePlanCount(planId: string): number;
}
export function createAdmissionQueue<T>(options: {
	maxSize: number;
	finiteCeilingMs: number;
	/** Reserved concurrent peak for a plan, resolved when the plan is seen. */
	reservedPlanPeak?: (planId: string) => number | undefined;
	now?: () => number;
	onRelease?: (request: AdmissionQueueRequest<T>, reason: "canceled" | "timed_out") => void;
}): AdmissionQueue<T> {
	if (!Number.isInteger(options.maxSize) || options.maxSize < 1)
		throw new Error("admission queue maxSize must be a positive integer");
	if (!Number.isFinite(options.finiteCeilingMs) || options.finiteCeilingMs <= 0)
		throw new Error("admission queue ceiling must be finite and positive");
	const now = options.now ?? Date.now;
	// A plan slot belongs to an assignment, not to an attempt: a retry re-enters
	// the queue with the slot it already holds and must not be blocked by itself.
	const activePlans = new Map<string, Set<string>>();
	const entries = new Map<
		string,
		{
			request: AdmissionQueueRequest<T>;
			resolve: (outcome: AdmissionQueueOutcome<T>) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const remove = (requestId: string, state: "canceled" | "timed_out"): boolean => {
		const entry = entries.get(requestId);
		if (!entry) return false;
		entries.delete(requestId);
		clearTimeout(entry.timer);
		options.onRelease?.(entry.request, state);
		entry.resolve({ state, request: entry.request });
		return true;
	};
	return {
		enqueue(request) {
			if (entries.size >= options.maxSize)
				return Promise.reject(new Error(`dispatch: admission queue full (${entries.size}/${options.maxSize})`));
			if (entries.has(request.requestId))
				return Promise.reject(new Error(`dispatch: duplicate queued request '${request.requestId}'`));
			const effectiveDeadline = Math.min(request.deadlineAt, request.queuedAt + options.finiteCeilingMs);
			if (!Number.isFinite(effectiveDeadline))
				return Promise.reject(new Error("dispatch: queued request requires a finite deadline"));
			return new Promise((resolve, reject) => {
				const bounded = { ...request, deadlineAt: effectiveDeadline };
				const timer = setTimeout(() => remove(request.requestId, "timed_out"), Math.max(0, effectiveDeadline - now()));
				entries.set(request.requestId, { request: bounded, resolve, reject, timer });
			});
		},
		cancel(requestId) {
			return remove(requestId, "canceled");
		},
		fail(requestId, error) {
			const entry = entries.get(requestId);
			if (!entry) return false;
			entries.delete(requestId);
			clearTimeout(entry.timer);
			entry.reject(error);
			return true;
		},
		admitNext(nowMs = now(), canAdmit = () => true) {
			for (const request of orderAdmissionRequests([...entries.values()].map((entry) => entry.request))) {
				if (request.deadlineAt <= nowMs) {
					remove(request.requestId, "timed_out");
					continue;
				}
				const entry = entries.get(request.requestId);
				if (!entry) continue;
				if (request.planId !== null) {
					const active = activePlans.get(request.planId);
					const peak = options.reservedPlanPeak?.(request.planId);
					if (peak !== undefined && active !== undefined && !active.has(request.assignmentId) && active.size >= peak)
						continue;
				}
				if (!canAdmit(request)) continue;
				entries.delete(request.requestId);
				clearTimeout(entry.timer);
				if (request.planId !== null) {
					const active = activePlans.get(request.planId) ?? new Set<string>();
					active.add(request.assignmentId);
					activePlans.set(request.planId, active);
				}
				entry.resolve({
					state: "admitted",
					request,
					admittedAt: nowMs,
					queueWaitMs: Math.max(0, nowMs - request.queuedAt),
				});
				return request;
			}
			return null;
		},
		complete(assignmentId) {
			for (const [planId, active] of activePlans) {
				if (!active.delete(assignmentId)) continue;
				if (active.size === 0) activePlans.delete(planId);
				return;
			}
		},
		size: () => entries.size,
		activePlanCount: (planId) => activePlans.get(planId)?.size ?? 0,
	};
}
