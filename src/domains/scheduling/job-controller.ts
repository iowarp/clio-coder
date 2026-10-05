import { randomUUID } from "node:crypto";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import {
	clipJobText,
	JOB_HISTORY_LIMIT,
	JOB_SESSION_LIMIT,
	jobEvidence,
	jobHasUnresolvedCleanup,
	jobIsComplete,
	jobSpecHash,
	matchesJobPredicate,
	normalizeJobOwner,
	normalizeJobSpec,
	sameJobOwner,
} from "./job-model.js";
import { createJobStore } from "./job-store.js";
import type {
	JobAdmission,
	JobController,
	JobControllerOptions,
	JobEvidence,
	JobExecutionContext,
	JobOwner,
	JobRecord,
	JobRunResult,
} from "./job-types.js";

interface LiveExecution {
	abort: AbortController;
	kind: "run" | "delivery";
	id: string;
	generation: number;
	started: boolean;
	timeoutAt: number;
	forced: JobEvidence["outcome"] | null;
	promise: Promise<void>;
}
const POLL_MS = 250;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const copy = <T>(value: T): T => structuredClone(value);

export function createJobController(options: JobControllerOptions): JobController {
	const now = options.now ?? Date.now;
	const spanNow = options.monotonicNow ?? options.now ?? (() => performance.now());
	const store = options.store ?? createJobStore();
	const instanceId = randomUUID();
	const processOwner = { pid: process.pid, birthToken: processBirthToken(), instanceId };
	const records = new Map<string, JobRecord>();
	const live = new Map<string, LiveExecution>();
	const retryAt = new Map<string, number>();
	const creating = new Set<Promise<unknown>>();
	const lifetime = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let pumping = false;
	let cleanupBlocked = false;

	function report(error: unknown): void {
		try {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			/* Observers cannot turn a persisted transition into a failed launch (#411). */
		}
	}
	function publish(job: JobRecord): void {
		try {
			options.onChange?.({ job: copy(job), complete: jobIsComplete(job) });
		} catch (error) {
			report(error);
		}
	}
	function owned(job: JobRecord): boolean {
		return job.process.instanceId === instanceId;
	}
	function commit(job: JobRecord, edit: (draft: JobRecord) => void): JobRecord {
		const draft = copy(job);
		edit(draft);
		draft.revision = job.revision + 1;
		draft.updatedAt = now();
		draft.persistenceError = null;
		try {
			store.write(draft, job.revision);
		} catch (error) {
			// Keep the durable revision. Failed settlement is never retried as an execution (#411).
			job.persistenceError = clipJobText(errorText(error));
			job.pendingReason = "persistence failed; execution suspended";
			records.set(job.id, job);
			publish(job);
			throw error;
		}
		records.set(job.id, draft);
		publish(draft);
		return draft;
	}
	function current(id: string): JobRecord {
		const job = records.get(id);
		if (!job) throw new Error("job: unknown job");
		return job;
	}
	function scoped(id: string, owner: JobOwner): JobRecord {
		const job = current(id);
		if (!sameJobOwner(job.owner, normalizeJobOwner(owner)))
			throw new Error("job: job belongs to another session or workspace");
		return job;
	}
	function dropDelivery(job: JobRecord, reason: string): void {
		if (job.delivery?.state === "pending") {
			job.delivery.state = "dropped";
			job.delivery.reason = reason;
			job.delivery.endedAt = now();
		}
	}
	function abortLive(id: string, reason: string, outcome: JobEvidence["outcome"]): void {
		const execution = live.get(id);
		if (!execution || execution.abort.signal.aborted) return;
		execution.forced = outcome;
		execution.abort.abort(new Error(reason));
	}
	function terminal(id: string, reason: "canceled" | "deadline" | "stopped"): JobRecord {
		const job = current(id);
		if (jobHasUnresolvedCleanup(job)) return job;
		let result: JobRecord;
		try {
			result = commit(job, (draft) => {
				draft.state = "terminal";
				draft.reason = reason;
				draft.pending = null;
				draft.nextDueAt = null;
				draft.pendingReason = null;
				dropDelivery(draft, reason);
				draft.cancelRequested = reason !== "stopped" && live.has(id);
				if (reason !== "stopped") draft.generation += 1;
			});
		} finally {
			// A failed cancel receipt must not leave effects running (#411).
			if (reason !== "stopped") abortLive(id, reason, reason === "deadline" ? "timed_out" : "canceled");
		}
		return result;
	}
	function pauseForNavigation(id: string, reason: string): void {
		const job = current(id);
		if (jobHasUnresolvedCleanup(job)) return;
		try {
			commit(job, (draft) => {
				if (draft.state !== "terminal") draft.state = "paused";
				draft.generation += 1;
				draft.pending = null;
				draft.nextDueAt = null;
				draft.pendingReason = clipJobText(reason);
				dropDelivery(draft, reason);
				if (live.has(id) && (draft.spec.runner.kind === "main" || live.get(id)?.kind === "delivery"))
					draft.cancelRequested = true;
			});
		} finally {
			if (job.spec.runner.kind === "main" || live.get(id)?.kind === "delivery") abortLive(id, reason, "canceled");
		}
	}
	function schedule(): void {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		if (closed || options.automatic === false) return;
		let due = Number.POSITIVE_INFINITY;
		for (const job of records.values()) {
			if (!owned(job) || jobHasUnresolvedCleanup(job)) continue;
			const execution = live.get(job.id);
			if (execution && !execution.abort.signal.aborted) due = Math.min(due, now() + execution.timeoutAt - spanNow());
			if (!jobIsComplete(job) && job.spec.deadlineAt !== null && job.reason !== "deadline")
				due = Math.min(due, job.spec.deadlineAt);
			if (job.persistenceError !== null) continue;
			if (job.state === "active" && job.nextDueAt !== null) due = Math.min(due, job.nextDueAt);
			if (job.state !== "paused" && !execution && (job.pending !== null || job.delivery?.state === "pending"))
				due = Math.min(due, retryAt.get(job.id) ?? now());
		}
		if (!Number.isFinite(due)) return;
		timer = setTimeout(tick, Math.max(1, Math.min(2_147_483_647, due - now())));
		timer.unref();
	}
	function failAdmission(
		id: string,
		admission: Exclude<JobAdmission, { status: "ready" }>,
		kind: LiveExecution["kind"],
	): void {
		const job = current(id);
		if (admission.status === "wait" && job.pendingReason === clipJobText(admission.reason)) return;
		commit(job, (draft) => {
			draft.pendingReason = clipJobText(admission.reason);
			if (admission.status === "denied") {
				if (kind === "delivery" && draft.delivery) {
					draft.delivery.state = "failed";
					draft.delivery.endedAt = now();
					draft.delivery.reason = clipJobText(admission.reason);
				} else {
					draft.state = "paused";
					draft.nextDueAt = null;
				}
			}
		});
	}
	function canStart(job: JobRecord, execution: LiveExecution): boolean {
		return (
			!closed &&
			!execution.abort.signal.aborted &&
			spanNow() < execution.timeoutAt &&
			job.persistenceError === null &&
			job.generation === execution.generation &&
			options.ports.isCurrent(job.owner) &&
			(job.spec.deadlineAt === null || now() < job.spec.deadlineAt) &&
			(execution.kind === "delivery"
				? job.state !== "paused" && job.delivery?.state === "pending"
				: job.state === "active" && job.pending !== null)
		);
	}
	function startExecution(id: string, execution: LiveExecution): boolean {
		if (execution.started) throw new Error("job: execution start acknowledged twice");
		const job = current(id);
		if (!canStart(job, execution)) return false;
		commit(job, (draft) => {
			draft.pendingReason = null;
			if (execution.kind === "delivery") {
				if (!draft.delivery) throw new Error("job: delivery disappeared");
				draft.delivery.state = "running";
				draft.delivery.startedAt = now();
			} else {
				if (!draft.pending) throw new Error("job: occurrence disappeared");
				draft.active = { ...draft.pending, state: "running", startedAt: now() };
				draft.pending = null;
				draft.starts += 1;
				if (draft.spec.count !== null && draft.starts >= draft.spec.count) draft.nextDueAt = null;
			}
		});
		execution.started = true;
		execution.timeoutAt = spanNow() + job.spec.timeoutMs;
		schedule();
		return true;
	}
	function blockUnresolvedCleanup(job: JobRecord): void {
		job.state = "paused";
		job.reason = "failure";
		job.nextDueAt = null;
		job.pending = null;
		job.pendingReason = "cleanup unresolved; termination unconfirmed; replacement execution and resume are blocked";
		dropDelivery(job, job.pendingReason);
	}
	function settle(id: string, execution: LiveExecution, result: JobRunResult): void {
		let job = current(id);
		if (result.cleanupUnresolved === true) cleanupBlocked = true;
		// A completion microtask may run before an already-due timer callback (#411).
		if (!execution.abort.signal.aborted && job.spec.deadlineAt !== null && now() >= job.spec.deadlineAt) {
			job = terminal(id, "deadline");
		} else if (!execution.abort.signal.aborted && spanNow() >= execution.timeoutAt) {
			abortLive(id, "execution timeout", "timed_out");
		}
		if (!execution.started) {
			if (job.persistenceError !== null) return;
			if (execution.abort.signal.aborted || job.generation !== execution.generation) {
				commit(job, (draft) => {
					draft.cancelRequested = false;
					if (execution.kind === "delivery" && draft.delivery?.state === "pending")
						dropDelivery(draft, errorText(execution.abort.signal.reason ?? "scope changed"));
				});
			} else if (result.outcome === "deferred") {
				failAdmission(id, { status: "wait", reason: result.summary ?? "host unavailable" }, execution.kind);
			} else {
				failAdmission(
					id,
					{ status: "denied", reason: result.summary ?? "runner did not acknowledge execution start" },
					execution.kind,
				);
			}
			return;
		}
		const normalized =
			result.outcome === "deferred"
				? {
						outcome: "failed" as const,
						summary: "runner deferred after acknowledging execution",
						...(result.cleanupUnresolved === true ? { cleanupUnresolved: true } : {}),
						errorClass: "execution" as const,
					}
				: result;
		const evidence = jobEvidence(normalized, execution.forced ?? undefined);
		const previous = job.history.at(-1)?.evidence;
		if (
			execution.kind === "run" &&
			job.spec.runner.kind === "command" &&
			evidence.outcome === "succeeded" &&
			previous &&
			evidence.jsonComplete &&
			!evidence.truncated &&
			!previous.truncated &&
			["succeeded", "noop"].includes(previous.outcome) &&
			previous.summary === evidence.summary &&
			previous.jsonComplete === evidence.jsonComplete &&
			JSON.stringify(previous.json) === JSON.stringify(evidence.json)
		)
			evidence.outcome = "noop";
		commit(job, (draft) => {
			if (!evidence.cleanupUnresolved) draft.cancelRequested = false;
			draft.costUsd = draft.costUsd === null || evidence.costUsd === null ? null : draft.costUsd + evidence.costUsd;
			if (execution.kind === "delivery") {
				if (!draft.delivery || draft.delivery.id !== execution.id) throw new Error("job: mismatched delivery settlement");
				draft.delivery.evidence = evidence;
				draft.delivery.endedAt = now();
				draft.delivery.state = evidence.cleanupUnresolved
					? "failed"
					: execution.forced !== null
						? "dropped"
						: ["succeeded", "noop"].includes(evidence.outcome)
							? "delivered"
							: "failed";
				draft.delivery.reason = evidence.summary || execution.forced;
				if (draft.reason === "condition") draft.state = "terminal";
				draft.pendingReason = null;
				if (evidence.cleanupUnresolved) blockUnresolvedCleanup(draft);
				return;
			}
			if (!draft.active || draft.active.id !== execution.id) throw new Error("job: mismatched occurrence settlement");
			const occurrence = { ...draft.active, state: "terminal" as const, endedAt: now(), evidence };
			draft.history = [...draft.history, occurrence].slice(-JOB_HISTORY_LIMIT);
			draft.active = null;
			// Evidence and counters cross one durable commit barrier (#411).
			draft.settled += 1;
			if (evidence.cleanupUnresolved) {
				blockUnresolvedCleanup(draft);
				return;
			}
			if (draft.state === "active") draft.pendingReason = null;
			if (draft.state === "terminal" || draft.generation !== execution.generation) return;
			const matched =
				draft.spec.until !== null &&
				["succeeded", "noop"].includes(evidence.outcome) &&
				evidence.jsonComplete &&
				matchesJobPredicate(draft.spec.until, evidence.json);
			if (matched) {
				draft.reason = "condition";
				if (draft.state !== "paused") draft.state = "terminal";
				draft.nextDueAt = null;
				draft.pending = null;
				draft.delivery = {
					id: `${draft.id}:delivery:${draft.starts}`,
					occurrenceId: occurrence.id,
					kind: draft.spec.onMatch.kind,
					state: "pending",
					createdAt: now(),
					startedAt: null,
					endedAt: null,
					reason: null,
					evidence: null,
				};
			} else if (draft.spec.count !== null && draft.starts >= draft.spec.count) {
				draft.state = "terminal";
				draft.reason = "count";
				draft.pending = null;
				draft.nextDueAt = null;
			} else if (evidence.errorClass === "permission") {
				draft.state = "paused";
				draft.nextDueAt = null;
				draft.pending = null;
				draft.pendingReason = evidence.summary;
			} else if (evidence.errorClass === "infrastructure" || evidence.outcome === "timed_out") {
				draft.consecutiveFailures += 1;
				draft.pending = null;
				if (draft.consecutiveFailures >= 3) {
					draft.state = "paused";
					draft.nextDueAt = null;
					draft.pendingReason = "three consecutive infrastructure failures";
				} else if (draft.state === "active") {
					const retryAfter =
						typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs)
							? Math.max(0, result.retryAfterMs)
							: 0;
					draft.nextDueAt =
						now() +
						Math.max(draft.spec.intervalMs, Math.min(300_000, 1000 * 2 ** (draft.consecutiveFailures - 1)), retryAfter);
				}
			} else draft.consecutiveFailures = 0;
		});
	}
	function launch(id: string, kind: LiveExecution["kind"]): void {
		const job = current(id);
		// A bounded cleanup return cannot release its process capacity (#411).
		if (
			kind === "run" &&
			job.spec.runner.kind === "command" &&
			(cleanupBlocked || [...records.values()].some((row) => owned(row) && jobHasUnresolvedCleanup(row)))
		) {
			failAdmission(
				id,
				{ status: "denied", reason: "command capacity blocked by unresolved cleanup; termination unconfirmed" },
				kind,
			);
			return;
		}
		const main = kind === "delivery" ? job.delivery?.kind === "main_turn" : job.spec.runner.kind === "main";
		const occupied = [...live.entries()].filter(([otherId, other]) => {
			const row = current(otherId);
			return main
				? sameJobOwner(row.owner, job.owner) &&
						(other.kind === "delivery" ? row.delivery?.kind === "main_turn" : row.spec.runner.kind === "main")
				: kind === "run" && other.kind === "run" && row.spec.runner.kind === "command";
		}).length;
		if (occupied >= (main ? 1 : 2)) {
			failAdmission(
				id,
				{ status: "wait", reason: main ? "main job turn is occupied" : "command job capacity is occupied" },
				kind,
			);
			retryAt.set(id, now() + POLL_MS);
			return;
		}
		const executionId = kind === "delivery" ? job.delivery?.id : job.pending?.id;
		if (!executionId) return;
		const execution: LiveExecution = {
			abort: new AbortController(),
			kind,
			id: executionId,
			generation: job.generation,
			started: false,
			timeoutAt: spanNow() + job.spec.timeoutMs,
			forced: null,
			promise: Promise.resolve(),
		};
		live.set(id, execution);
		execution.promise = (async () => {
			try {
				const admission = await options.ports.admit({ job: copy(job), phase: kind, signal: execution.abort.signal });
				if (!canStart(current(id), execution)) {
					settle(id, execution, { outcome: "deferred", summary: "scope unavailable after admission" });
					return;
				}
				if (admission.status !== "ready") {
					failAdmission(id, admission, kind);
					return;
				}
				const context: JobExecutionContext = {
					job: copy(current(id)),
					executionId,
					signal: execution.abort.signal,
					start: () => startExecution(id, execution),
				};
				const result = await (kind === "delivery" ? options.ports.deliver(context) : options.ports.run(context));
				settle(id, execution, result);
			} catch (error) {
				try {
					settle(id, execution, { outcome: "failed", summary: errorText(error), errorClass: "infrastructure" });
				} catch (settleError) {
					report(settleError);
				}
				report(error);
			} finally {
				live.delete(id);
				retryAt.set(id, now() + POLL_MS);
				schedule();
			}
		})();
	}
	function tick(): void {
		if (closed || pumping) return;
		pumping = true;
		try {
			for (const initial of records.values()) {
				if (!owned(initial) || jobHasUnresolvedCleanup(initial)) continue;
				const id = initial.id;
				try {
					let job = current(id);
					const execution = live.get(id);
					if (
						!jobIsComplete(job) &&
						job.spec.deadlineAt !== null &&
						now() >= job.spec.deadlineAt &&
						job.reason !== "deadline"
					) {
						terminal(id, "deadline");
						continue;
					}
					if (execution && spanNow() >= execution.timeoutAt && !execution.abort.signal.aborted) {
						try {
							commit(job, (draft) => {
								draft.cancelRequested = true;
								draft.pendingReason = "execution timeout; awaiting settlement";
							});
						} finally {
							abortLive(id, "execution timeout", "timed_out");
						}
						job = current(id);
					}
					if (job.persistenceError !== null) continue;
					if ((job.state === "active" || job.delivery?.state === "pending") && !options.ports.isCurrent(job.owner)) {
						pauseForNavigation(id, "owning session is no longer current");
						continue;
					}
					if (job.state === "active" && job.nextDueAt !== null && job.nextDueAt <= now()) {
						job = commit(job, (draft) => {
							const due = draft.nextDueAt as number;
							const newest = due + Math.floor((now() - due) / draft.spec.intervalMs) * draft.spec.intervalMs;
							draft.nextDueAt = newest + draft.spec.intervalMs;
							if (draft.spec.count === null || draft.starts < draft.spec.count) {
								// A reserved pending occurrence keeps its identity until admission settles (#411).
								if (!draft.pending)
									draft.pending = {
										id: `${id}:occurrence:${randomUUID()}`,
										scheduledAt: newest,
										startedAt: null,
										endedAt: null,
										state: "pending",
										evidence: null,
									};
								else if (!execution || execution.started) draft.pending.scheduledAt = newest;
							}
						});
					}
					if (execution || job.state === "paused" || now() < (retryAt.get(id) ?? 0)) continue;
					if (job.delivery?.state === "pending") launch(id, "delivery");
					else if (job.state === "active" && job.pending) launch(id, "run");
				} catch (error) {
					report(error);
				}
			}
		} finally {
			pumping = false;
			schedule();
		}
	}
	function recover(ownerInput: JobOwner): JobRecord[] {
		if (closed) throw new Error("job: controller closed");
		const owner = normalizeJobOwner(ownerInput);
		for (const stored of store.list(owner)) {
			const cached = records.get(stored.id);
			if (cached && owned(cached)) continue;
			records.set(stored.id, stored);
			if (stored.process.instanceId === instanceId || jobIsComplete(stored)) continue;
			const alive =
				processAlive(stored.process.pid) &&
				(stored.process.birthToken === null ||
					processBirthToken(stored.process.pid) === null ||
					stored.process.birthToken === processBirthToken(stored.process.pid));
			if (alive) continue;
			commit(stored, (draft) => {
				draft.process = { ...processOwner };
				draft.generation += 1;
				draft.cancelRequested = false;
				draft.pending = null;
				draft.nextDueAt = null;
				draft.pendingReason = "owner exited; explicit resume required";
				if (jobHasUnresolvedCleanup(draft)) {
					blockUnresolvedCleanup(draft);
					return;
				}
				if (draft.active) {
					draft.history = [
						...draft.history,
						{
							...draft.active,
							state: "terminal" as const,
							endedAt: now(),
							evidence: jobEvidence({ outcome: "failed", summary: "execution interrupted; outcome unknown" }, "interrupted"),
						},
					].slice(-JOB_HISTORY_LIMIT);
					draft.active = null;
					draft.settled += 1;
				}
				if (draft.delivery?.state === "running") {
					draft.delivery.state = "failed";
					draft.delivery.endedAt = now();
					draft.delivery.reason = "delivery interrupted; not replayed";
					draft.delivery.evidence = jobEvidence({ outcome: "failed", summary: draft.delivery.reason }, "interrupted");
				} else dropDelivery(draft, "session owner exited; wake not replayed");
				if (draft.state !== "terminal") draft.state = "paused";
			});
		}
		schedule();
		return [...records.values()].filter((row) => sameJobOwner(row.owner, owner)).map(copy);
	}
	async function authorization(job: JobRecord, phase: "create" | "resume"): Promise<void> {
		if (closed || !options.ports.isCurrent(job.owner)) throw new Error("job: owner is not current");
		const abort = new AbortController();
		const onClose = (): void => abort.abort(lifetime.signal.reason);
		lifetime.signal.addEventListener("abort", onClose, { once: true });
		const remaining =
			job.spec.deadlineAt === null ? job.spec.timeoutMs : Math.min(job.spec.timeoutMs, job.spec.deadlineAt - now());
		if (remaining <= 0) {
			lifetime.signal.removeEventListener("abort", onClose);
			throw new Error("job: deadline expired");
		}
		const timeout = setTimeout(
			() => abort.abort(new Error("job: admission timeout")),
			Math.min(remaining, 2_147_483_647),
		);
		timeout.unref();
		try {
			const admission = await options.ports.admit({ job: copy(job), phase, signal: abort.signal });
			abort.signal.throwIfAborted();
			if (closed || !options.ports.isCurrent(job.owner)) throw new Error("job: owner changed during admission");
			if (job.spec.deadlineAt !== null && now() >= job.spec.deadlineAt) throw new Error("job: deadline expired");
			if (admission.status !== "ready") throw new Error(`job: ${admission.reason}`);
		} finally {
			clearTimeout(timeout);
			lifetime.signal.removeEventListener("abort", onClose);
		}
	}
	function track<T>(operation: Promise<T>): Promise<T> {
		creating.add(operation);
		void operation.then(
			() => creating.delete(operation),
			() => creating.delete(operation),
		);
		return operation;
	}
	const api: JobController = {
		create(input, ownerInput) {
			return track(
				(async () => {
					if (closed) throw new Error("job: controller closed");
					const owner = normalizeJobOwner(ownerInput);
					recover(owner);
					const createdAt = now();
					const spec = normalizeJobSpec(input, createdAt);
					const job: JobRecord = {
						version: 1,
						id: `job-${randomUUID()}`,
						revision: 0,
						spec,
						specHash: jobSpecHash(spec),
						owner,
						generation: 0,
						process: { ...processOwner },
						createdAt,
						updatedAt: createdAt,
						state: "active",
						reason: null,
						cancelRequested: false,
						nextDueAt: createdAt + spec.intervalMs,
						starts: 0,
						settled: 0,
						consecutiveFailures: 0,
						pendingReason: null,
						active: null,
						pending: null,
						history: [],
						delivery: null,
						costUsd: 0,
						persistenceError: null,
					};
					await authorization(job, "create");
					// Creation time is the immutable spec epoch; first due never precedes admission (#411).
					job.nextDueAt = now() + spec.intervalMs;
					store.write(job, null);
					const sessionRows = [...records.values()].filter((row) => sameJobOwner(row.owner, owner));
					if (sessionRows.length >= JOB_SESSION_LIMIT) {
						const oldest = sessionRows.filter(jobIsComplete).sort((a, b) => a.updatedAt - b.updatedAt)[0];
						if (oldest) {
							records.delete(oldest.id);
							retryAt.delete(oldest.id);
						}
					}
					records.set(job.id, job);
					publish(job);
					schedule();
					return copy(job);
				})(),
			);
		},
		control(id, action, ownerInput) {
			return track(
				(async () => {
					if (closed) throw new Error("job: controller closed");
					const owner = normalizeJobOwner(ownerInput);
					let job = scoped(id, owner);
					if (jobHasUnresolvedCleanup(job)) {
						if (action === "resume") throw new Error("job: cleanup unresolved; termination unconfirmed; resume is blocked");
						return copy(job);
					}
					if (!owned(job)) throw new Error("job: another live host owns this job; recover only after it exits");
					if (action === "cancel" || action === "stop") {
						if (jobIsComplete(job)) return copy(job);
						job = terminal(id, action === "cancel" ? "canceled" : "stopped");
					} else if (action === "pause") {
						if (jobIsComplete(job) || (job.state === "terminal" && job.reason !== "condition")) return copy(job);
						job = commit(job, (draft) => {
							draft.state = "paused";
							draft.pending = null;
							draft.nextDueAt = null;
							draft.pendingReason = "paused by owner";
						});
					} else if (action === "resume") {
						if (jobIsComplete(job) || (job.reason !== null && job.reason !== "condition"))
							throw new Error("job: terminal recurrence cannot resume");
						if (live.has(id)) throw new Error("job: wait for active execution to settle before resume");
						if (job.persistenceError !== null)
							throw new Error("job: persistence failed; recover in a fresh host before resuming");
						if (job.spec.count !== null && job.starts >= job.spec.count && job.delivery?.state !== "pending")
							throw new Error("job: count exhausted");
						const revision = job.revision;
						await authorization({ ...copy(job), owner }, "resume");
						job = current(id);
						if (job.revision !== revision || live.has(id)) throw new Error("job: job changed during resume admission");
						job = commit(job, (draft) => {
							draft.owner = owner;
							draft.generation += 1;
							draft.state = draft.reason === "condition" ? "terminal" : "active";
							draft.nextDueAt = draft.state === "active" ? now() + draft.spec.intervalMs : null;
							draft.pending = null;
							draft.pendingReason = null;
							draft.consecutiveFailures = 0;
						});
					} else throw new Error("job: unsupported control action");
					schedule();
					return copy(job);
				})(),
			);
		},
		list(ownerInput) {
			const owner = normalizeJobOwner(ownerInput);
			return [...records.values()].filter((job) => sameJobOwner(job.owner, owner)).map(copy);
		},
		get(id, owner) {
			return records.has(id) ? copy(scoped(id, owner)) : null;
		},
		recover,
		async retire(ownerInput, reason = "session navigation") {
			const owner = normalizeJobOwner(ownerInput);
			const pending: Promise<void>[] = [];
			for (const job of records.values()) {
				if (
					!owned(job) ||
					!sameJobOwner(job.owner, owner) ||
					job.owner.generation !== owner.generation ||
					jobIsComplete(job)
				)
					continue;
				try {
					pauseForNavigation(job.id, reason);
				} catch (error) {
					report(error);
				}
				const execution = live.get(job.id);
				if (execution?.abort.signal.aborted) pending.push(execution.promise);
			}
			schedule();
			await Promise.all(pending);
		},
		async close() {
			closed = true;
			lifetime.abort(new Error("job: host exited"));
			if (timer !== null) clearTimeout(timer);
			timer = null;
			for (const job of records.values()) {
				if (!owned(job) || jobIsComplete(job)) continue;
				try {
					terminal(job.id, "canceled");
				} catch (error) {
					report(error);
				}
			}
			await Promise.all([...live.values()].map((execution) => execution.promise));
			await Promise.allSettled([...creating]);
		},
		tick,
	};
	return api;
}
