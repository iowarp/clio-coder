/**
 * Bounded persistence of an ordered continuity group (CONTRACTS.md §5, §6).
 *
 * Everything is injected: append, an exact payload-comparing readback, the
 * barrier, removed-state and origin checks, and a bounded retry schedule. This
 * module performs no execution of its own and knows nothing about models,
 * runtimes or replay. No failure is logged by recursively persisting more
 * records; a blocked group is reported to its caller and stops there.
 *
 * Rules that drive the shape:
 *
 *   - An accepted append is never repeated because a later barrier failed. A
 *     failed barrier is retried with the same ids, within a finite bound.
 *   - A throwing append proves neither success nor absence. Only an
 *     authoritative `absent` readback licenses a re-append, under the original
 *     id; `conflicting` and `unresolved`, including a readback that itself
 *     throws, stop the group, because malformed or contradictory data cannot
 *     prove absence.
 *   - Removed state and origin are rechecked at every boundary that can be
 *     crossed by a wait or an await, not only at the ends of the group.
 *   - The supplied clock is treated as monotonic within one call. A reading
 *     that stops being a number, or that jumps backwards between two
 *     boundaries, makes the window unjudgeable rather than optimistic.
 *   - `durable` means the barrier reported success. Under §1's filesystem
 *     ceiling that is not a power-loss guarantee, and only a usable clock that
 *     stayed inside the window confirms it: persistence is not permission for
 *     dependent execution.
 */

import {
	type ContinuityAcceptedProgress,
	type ContinuityAnomaly,
	type ContinuityAppendable,
	type ContinuityPersistBlockedReason,
	type ContinuityPersistencePorts,
	type ContinuityPersistRequest,
	type ContinuityPersistResult,
	type ContinuityReconcileResult,
	type ContinuityRetrySchedule,
	HANDOFF_MAX_FLUSH_RETRIES,
} from "./contract.js";
import { canonicalJson } from "./validate.js";

/** The digest a progress token carries, so an id can never stand in for a payload. */
export function continuityRecordDigest(entry: ContinuityAppendable): string {
	return canonicalJson(entry);
}

function blocked(
	reason: ContinuityPersistBlockedReason,
	accepted: ReadonlyArray<ContinuityAcceptedProgress>,
	barrierAttempts: number,
	anomalies: ReadonlyArray<ContinuityAnomaly>,
): ContinuityPersistResult {
	return { status: "uncertain", reason, accepted: [...accepted], barrierAttempts, anomalies };
}

function readback(entry: ContinuityAppendable, ports: ContinuityPersistencePorts) {
	try {
		return ports.readExact(entry);
	} catch (error) {
		// A readback that throws read nothing authoritative. It is unresolved,
		// never absence.
		return { status: "unresolved" as const, detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Establish what actually happened to one record whose append was ambiguous.
 *
 * This is a **read-only** classification. The expected record goes to the port
 * so the comparison is on payload, not on the id: a stored record with the same
 * id and different bytes is `conflicting`, and re-appending over it would
 * create a second contradictory copy. Writing is deliberately left to
 * `persistContinuityGroup`, which re-checks removed state, origin and the
 * deadline before it re-appends; a reconciler that wrote on its own would
 * bypass exactly the guards a readback can invalidate.
 */
export function reconcileContinuityEntry(
	entry: ContinuityAppendable,
	ports: ContinuityPersistencePorts,
): ContinuityReconcileResult {
	const result = readback(entry, ports);
	if (result.status === "matching") return { status: "accepted" };
	if (result.status === "conflicting") {
		return { status: "conflicting", ...(result.detail === undefined ? {} : { detail: result.detail }) };
	}
	if (result.status === "unresolved") {
		return { status: "unresolved", ...(result.detail === undefined ? {} : { detail: result.detail }) };
	}
	return { status: "absent" };
}

/** A schedule that cannot bound the work is refused rather than run. */
function invalidSchedule(retry: ContinuityRetrySchedule): string | null {
	if (!Number.isSafeInteger(retry.limit) || retry.limit < 0 || retry.limit > HANDOFF_MAX_FLUSH_RETRIES) {
		return `retry limit ${retry.limit} is not an integer in 0..${HANDOFF_MAX_FLUSH_RETRIES}`;
	}
	if (!Number.isFinite(retry.deadlineAtMs)) return "retry deadline is not finite";
	const now = retry.now();
	if (!Number.isFinite(now)) return "retry clock is not finite";
	return null;
}

/**
 * A clock reading that is usable for this operation.
 *
 * The supplied clock is read many times across appends, awaits and a barrier.
 * Finiteness alone is not enough: a clock that jumps backwards mid-operation
 * cannot be used to judge a deadline either, and neither can one that stops
 * being a number. The guard is monotonic within one call and answers `null` the
 * moment it stops being usable; every caller then treats the window as
 * unconfirmed rather than assuming the optimistic reading.
 */
interface ClockGuard {
	read(): number | null;
}

function createClockGuard(retry: ContinuityRetrySchedule): ClockGuard {
	let observed = Number.NEGATIVE_INFINITY;
	let broken = false;
	return {
		read(): number | null {
			if (broken) return null;
			const now = retry.now();
			if (!Number.isFinite(now) || now < observed) {
				broken = true;
				return null;
			}
			observed = now;
			return now;
		},
	};
}

type BarrierOutcome =
	| { ok: true; attempts: number; confirmedWithinDeadline: boolean }
	| { ok: false; attempts: number; reason: ContinuityPersistBlockedReason; detail: string };

async function runBarrier(
	request: ContinuityPersistRequest,
	ports: ContinuityPersistencePorts,
	retry: ContinuityRetrySchedule,
	clock: ClockGuard,
): Promise<BarrierOutcome> {
	const flushing = request.barrier.kind === "flush";
	const port = flushing ? ports.flushAppends : ports.checkpoint;
	if (!port) {
		// A SessionContract without the barrier is an unsupported persistence
		// port. Treating a missing barrier as success would report durability
		// that was never attempted.
		return {
			ok: false,
			attempts: 0,
			reason: "unsupported_barrier_port",
			detail: `${request.barrier.kind} port is not available`,
		};
	}

	let attempts = 0;
	let detail = "";
	for (let round = 0; round <= retry.limit; round += 1) {
		// Read before every attempt, round 0 included: the appends that just ran
		// can have taken the clock past the deadline or broken it outright. A late
		// barrier still runs, because it can establish persistence for records
		// already accepted; what it cannot do is confirm the window.
		let before = clock.read();
		if (round > 0) {
			if (before === null || before >= retry.deadlineAtMs) break;
			try {
				await retry.wait(round);
			} catch (error) {
				return {
					ok: false,
					attempts,
					reason: "barrier_failed",
					detail: `retry wait rejected: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			// The wait is an await, so every fact can have changed across it,
			// including the clock going backwards or stopping being a number.
			before = clock.read();
			if (before === null) {
				return { ok: false, attempts, reason: "invalid_retry_schedule", detail: "retry clock became unusable" };
			}
			if (ports.isStateRemoved()) return { ok: false, attempts, reason: "state_removed", detail: "state removed" };
			if (!ports.isOriginCurrent()) return { ok: false, attempts, reason: "origin_changed", detail: "origin changed" };
			if (before >= retry.deadlineAtMs) break;
		}
		attempts += 1;
		try {
			if (request.barrier.kind === "flush") {
				(port as () => void)();
			} else {
				await (port as (reason: string) => Promise<void>)(request.barrier.reason);
			}
			// The barrier itself can be an await. Confirmation needs a clock that
			// is still usable afterwards and still inside the window.
			const after = clock.read();
			return {
				ok: true,
				attempts,
				confirmedWithinDeadline: before !== null && after !== null && after < retry.deadlineAtMs,
			};
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error);
		}
	}
	return { ok: false, attempts, reason: "barrier_failed", detail: detail || "deadline reached before the barrier ran" };
}

/**
 * Append an ordered group and run one barrier after the complete group.
 *
 * `alreadyAccepted` resumes a partial attempt at this exact group, matched by
 * payload digest so an id cannot carry a different record than the one that was
 * accepted. A previously accepted entry is skipped, never re-appended: only a
 * failing append inside this call reconciles.
 */
export async function persistContinuityGroup(
	request: ContinuityPersistRequest,
	ports: ContinuityPersistencePorts,
	retry: ContinuityRetrySchedule,
): Promise<ContinuityPersistResult> {
	const anomalies: ContinuityAnomaly[] = [];
	const accepted: ContinuityAcceptedProgress[] = [];

	// One record per id, compared by payload before anything is written.
	const wanted = new Map<string, string>();
	for (const entry of request.entries) {
		const digest = continuityRecordDigest(entry);
		const previous = wanted.get(entry.turnId);
		if (previous !== undefined && previous !== digest) {
			anomalies.push({
				kind: "duplicate_conflict",
				entryId: entry.turnId,
				detail: "the group contains two different records under one entry id",
			});
			return blocked("duplicate_group_entry", accepted, 0, anomalies);
		}
		wanted.set(entry.turnId, digest);
	}

	// Progress must belong to this request: an id whose recorded digest is not
	// the record this group carries is a different group. Repeats of one id are
	// folded, so duplicated progress cannot stand in for a record that is still
	// missing.
	const acceptedIds = new Set<string>();
	for (const progress of request.alreadyAccepted ?? []) {
		const expected = wanted.get(progress.entryId);
		if (expected === undefined || expected !== progress.payloadDigest) {
			anomalies.push({
				kind: "duplicate_conflict",
				entryId: progress.entryId,
				detail: "reported progress does not match this group's record for that id",
			});
			return blocked("progress_mismatch", [], 0, anomalies);
		}
		if (acceptedIds.has(progress.entryId)) continue;
		acceptedIds.add(progress.entryId);
		accepted.push({ entryId: progress.entryId, payloadDigest: progress.payloadDigest });
	}

	// Validated progress is established before the schedule is judged, so a
	// refusal that writes nothing still hands back what an earlier attempt
	// really got accepted. Losing it would invite a caller to append it twice.
	const scheduleProblem = invalidSchedule(retry);
	if (scheduleProblem) {
		anomalies.push({ kind: "malformed_record", entryId: null, detail: scheduleProblem });
		return blocked("invalid_retry_schedule", accepted, 0, anomalies);
	}

	// One monotonic clock reading for the whole call. Every boundary goes
	// through it, so a clock that jumps backwards between two of them is caught
	// rather than believed.
	const clock = createClockGuard(retry);

	const remaining = () => request.entries.filter((entry) => !acceptedIds.has(entry.turnId));
	// A group whose window has already closed is not started. A late barrier can
	// still establish persistence for work already accepted, but new records are
	// not written into an expired transaction.
	const startedAt = clock.read();
	if (startedAt === null) {
		anomalies.push({ kind: "malformed_record", entryId: null, detail: "the retry clock is not usable" });
		return blocked("invalid_retry_schedule", accepted, 0, anomalies);
	}
	if (startedAt >= retry.deadlineAtMs && remaining().length > 0) {
		anomalies.push({
			kind: "malformed_record",
			entryId: null,
			detail: "the deadline passed before the group was written",
		});
		return blocked("deadline_expired", accepted, 0, anomalies);
	}
	if (ports.isStateRemoved()) return blocked("state_removed", accepted, 0, anomalies);
	if (!ports.isOriginCurrent()) return blocked("origin_changed", accepted, 0, anomalies);

	/** Every guard a write must clear, rechecked immediately before it. */
	const writeBlocked = (): ContinuityPersistBlockedReason | null => {
		const now = clock.read();
		if (now === null) return "invalid_retry_schedule";
		if (now >= retry.deadlineAtMs) return "deadline_expired";
		if (ports.isStateRemoved()) return "state_removed";
		if (!ports.isOriginCurrent()) return "origin_changed";
		return null;
	};

	for (const entry of request.entries) {
		if (acceptedIds.has(entry.turnId)) continue;
		// Rechecked per record: a slow append can cross the deadline, and a long
		// group can straddle a removal or a branch switch.
		const guard = writeBlocked();
		if (guard) {
			anomalies.push({ kind: "malformed_record", entryId: entry.turnId, detail: `write refused: ${guard}` });
			return blocked(guard, accepted, 0, anomalies);
		}

		const digest = continuityRecordDigest(entry);
		const accept = (): void => {
			accepted.push({ entryId: entry.turnId, payloadDigest: digest });
			acceptedIds.add(entry.turnId);
		};
		try {
			ports.append(entry);
			accept();
			continue;
		} catch (error) {
			anomalies.push({
				kind: "malformed_record",
				entryId: entry.turnId,
				detail: `append threw: ${error instanceof Error ? error.message : String(error)}`,
			});
		}

		const reconciled = reconcileContinuityEntry(entry, ports);
		if (reconciled.status === "accepted") {
			accept();
			continue;
		}
		if (reconciled.status === "conflicting") {
			anomalies.push({
				kind: "duplicate_conflict",
				entryId: entry.turnId,
				detail: reconciled.detail ?? "stored record has this id and different payload",
			});
			return blocked("append_conflicting", accepted, 0, anomalies);
		}
		if (reconciled.status === "unresolved") {
			return blocked("append_unresolved", accepted, 0, anomalies);
		}

		// Proven absent, so the original id may be written once more. The readback
		// itself can have observed or caused a removal, so the guards run again
		// before the re-append.
		const reguard = writeBlocked();
		if (reguard) {
			anomalies.push({ kind: "malformed_record", entryId: entry.turnId, detail: `reappend refused: ${reguard}` });
			return blocked(reguard, accepted, 0, anomalies);
		}
		try {
			ports.append(entry);
			accept();
		} catch (error) {
			const second = reconcileContinuityEntry(entry, ports);
			if (second.status === "accepted") {
				accept();
				continue;
			}
			anomalies.push({
				kind: "malformed_record",
				entryId: entry.turnId,
				detail: `reappend threw: ${error instanceof Error ? error.message : String(error)}`,
			});
			return blocked(
				second.status === "absent" ? "append_absent_after_retry" : "append_unresolved",
				accepted,
				0,
				anomalies,
			);
		}
	}

	if (ports.isStateRemoved()) return blocked("state_removed", accepted, 0, anomalies);
	if (!ports.isOriginCurrent()) return blocked("origin_changed", accepted, 0, anomalies);

	const barrier = await runBarrier(request, ports, retry, clock);
	if (!barrier.ok) {
		anomalies.push({
			kind: "malformed_record",
			entryId: null,
			detail: `${request.barrier.kind} barrier did not complete: ${barrier.detail}`,
		});
		return blocked(barrier.reason, accepted, barrier.attempts, anomalies);
	}

	// Both checks run again: an asynchronous checkpoint can resolve after the
	// state root was removed or the origin moved, and resolution alone never
	// licenses execution or recreation of deleted state.
	if (ports.isStateRemoved()) return blocked("state_removed", accepted, barrier.attempts, anomalies);
	if (!ports.isOriginCurrent()) return blocked("origin_changed", accepted, barrier.attempts, anomalies);

	return {
		status: "durable",
		accepted,
		barrierAttempts: barrier.attempts,
		confirmedWithinDeadline: barrier.confirmedWithinDeadline,
	};
}
