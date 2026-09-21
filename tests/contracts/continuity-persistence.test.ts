import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ContinuityAppendable,
	ContinuityPersistencePorts,
	ContinuityPersistRequest,
	ContinuityReadback,
	ContinuityRetrySchedule,
} from "../../src/domains/session/continuity/contract.js";
import {
	continuityRecordDigest,
	persistContinuityGroup,
	reconcileContinuityEntry,
} from "../../src/domains/session/continuity/persistence.js";

const DEADLINE = 10_000;

function record(turnId: string, extra: Record<string, unknown> = {}): ContinuityAppendable {
	return { kind: "handoffTransaction", turnId, schemaVersion: 1, ...extra };
}

const PREPARED = record("e-prep", { phase: "prepared" });
const COMMIT: ContinuityAppendable = { kind: "continuityCommit", turnId: "e-commit", outcome: "summarized" };

interface Harness {
	ports: ContinuityPersistencePorts;
	retry: ContinuityRetrySchedule;
	calls: {
		append: ContinuityAppendable[];
		readExact: ContinuityAppendable[];
		flush: number;
		checkpoint: string[];
		removedChecks: number;
		originChecks: number;
		waits: number[];
	};
	setClock(ms: number): void;
}

interface HarnessOptions {
	appendBehavior?: (entry: ContinuityAppendable, attempt: number) => void;
	readback?: (entry: ContinuityAppendable, attempt: number) => ContinuityReadback;
	flush?: (attempt: number) => void;
	checkpoint?: (attempt: number, reason: string) => void;
	removed?: (check: number) => boolean;
	originCurrent?: (check: number) => boolean;
	wait?: (attempt: number) => Promise<void>;
	omitFlush?: boolean;
	omitCheckpoint?: boolean;
	limit?: number;
	deadlineAtMs?: number;
	startClock?: number;
}

function harness(options: HarnessOptions = {}): Harness {
	const calls: Harness["calls"] = {
		append: [],
		readExact: [],
		flush: 0,
		checkpoint: [],
		removedChecks: 0,
		originChecks: 0,
		waits: [],
	};
	let clock = options.startClock ?? 0;
	const appendsById = new Map<string, number>();
	const readsById = new Map<string, number>();

	const ports: ContinuityPersistencePorts = {
		append(entry) {
			calls.append.push(entry);
			const attempt = (appendsById.get(entry.turnId) ?? 0) + 1;
			appendsById.set(entry.turnId, attempt);
			options.appendBehavior?.(entry, attempt);
		},
		readExact(entry) {
			calls.readExact.push(entry);
			const attempt = (readsById.get(entry.turnId) ?? 0) + 1;
			readsById.set(entry.turnId, attempt);
			return options.readback?.(entry, attempt) ?? { status: "absent" };
		},
		isStateRemoved() {
			calls.removedChecks += 1;
			return options.removed?.(calls.removedChecks) ?? false;
		},
		isOriginCurrent() {
			calls.originChecks += 1;
			return options.originCurrent?.(calls.originChecks) ?? true;
		},
	};
	if (!options.omitFlush) {
		ports.flushAppends = () => {
			calls.flush += 1;
			options.flush?.(calls.flush);
		};
	}
	if (!options.omitCheckpoint) {
		ports.checkpoint = async (reason: string) => {
			calls.checkpoint.push(reason);
			options.checkpoint?.(calls.checkpoint.length, reason);
		};
	}

	const retry: ContinuityRetrySchedule = {
		limit: options.limit ?? 3,
		deadlineAtMs: options.deadlineAtMs ?? DEADLINE,
		now: () => clock,
		wait: async (attempt: number) => {
			calls.waits.push(attempt);
			if (options.wait) return options.wait(attempt);
			clock += 100;
		},
	};

	return {
		ports,
		retry,
		calls,
		setClock(ms: number) {
			clock = ms;
		},
	};
}

function flushGroup(entries = [PREPARED]): ContinuityPersistRequest {
	return { entries, barrier: { kind: "flush" } };
}

function checkpointGroup(entries = [PREPARED, COMMIT]): ContinuityPersistRequest {
	return { entries, barrier: { kind: "checkpoint", reason: "continuity-commit" } };
}

describe("continuity persistence: the ordinary group", () => {
	it("appends the group in order and runs one flush barrier after it", async () => {
		const h = harness();
		const result = await persistContinuityGroup(flushGroup([PREPARED, COMMIT]), h.ports, h.retry);
		strictEqual(result.status, "durable");
		if (result.status !== "durable") return;
		deepStrictEqual(
			h.calls.append.map((entry) => entry.turnId),
			["e-prep", "e-commit"],
			"appends happen in the group's order",
		);
		strictEqual(h.calls.flush, 1, "one barrier after the complete group, not one per record");
		strictEqual(h.calls.readExact.length, 0, "a clean append needs no readback");
		strictEqual(result.barrierAttempts, 1);
		strictEqual(result.confirmedWithinDeadline, true);
		deepStrictEqual(
			result.accepted.map((progress) => progress.entryId),
			["e-prep", "e-commit"],
		);
		strictEqual(result.accepted[0]?.payloadDigest, continuityRecordDigest(PREPARED));
	});

	it("runs the checkpoint barrier with its reason for a commit group", async () => {
		const h = harness();
		const result = await persistContinuityGroup(checkpointGroup(), h.ports, h.retry);
		strictEqual(result.status, "durable");
		deepStrictEqual(h.calls.checkpoint, ["continuity-commit"]);
		strictEqual(h.calls.flush, 0);
	});
});

describe("continuity persistence: an accepted append is never repeated", () => {
	it("retries only the barrier when a flush fails, and appends once", async () => {
		const h = harness({
			flush: () => {
				throw new Error("fsync failed");
			},
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "barrier_failed");
		strictEqual(h.calls.append.length, 1, "the accepted append is never repeated for a failed barrier");
		strictEqual(h.calls.flush, 4, "one attempt plus the three bounded retries");
		strictEqual(result.barrierAttempts, 4);
		deepStrictEqual(
			result.accepted.map((progress) => progress.entryId),
			["e-prep"],
			"accepted ids are returned so a caller can resume without rewriting them",
		);
	});

	it("resumes a partial group without re-appending what was already accepted", async () => {
		const h = harness();
		const request: ContinuityPersistRequest = {
			...checkpointGroup(),
			alreadyAccepted: [{ entryId: "e-prep", payloadDigest: continuityRecordDigest(PREPARED) }],
		};
		const result = await persistContinuityGroup(request, h.ports, h.retry);
		strictEqual(result.status, "durable");
		deepStrictEqual(
			h.calls.append.map((entry) => entry.turnId),
			["e-commit"],
			"only the remainder is appended",
		);
		strictEqual(h.calls.readExact.length, 0, "a skipped record is not re-read or re-appended");
	});

	it("refuses progress whose payload is not this group's record", async () => {
		const h = harness();
		const request: ContinuityPersistRequest = {
			...checkpointGroup(),
			alreadyAccepted: [
				{ entryId: "e-prep", payloadDigest: continuityRecordDigest(record("e-prep", { phase: "reducing" })) },
			],
		};
		const result = await persistContinuityGroup(request, h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "progress_mismatch", "an id cannot stand in for a different record");
		strictEqual(h.calls.append.length, 0, "nothing is written for a group that does not match its progress");
	});

	it("keeps validated progress on a refusal that writes nothing", async () => {
		const progress = { entryId: "e-prep", payloadDigest: continuityRecordDigest(PREPARED) };
		const h = harness({ limit: Number.POSITIVE_INFINITY });
		const result = await persistContinuityGroup({ ...checkpointGroup(), alreadyAccepted: [progress] }, h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "invalid_retry_schedule");
		deepStrictEqual(
			result.accepted,
			[progress],
			"a refusal that changes no payload must hand back what was already accepted",
		);
		strictEqual(h.calls.append.length, 0);
	});

	it("does not let duplicated progress stand in for a record that is still missing", async () => {
		const progress = { entryId: "e-prep", payloadDigest: continuityRecordDigest(PREPARED) };
		const h = harness({ startClock: DEADLINE });
		const result = await persistContinuityGroup(
			{ ...checkpointGroup(), alreadyAccepted: [progress, progress] },
			h.ports,
			h.retry,
		);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "deadline_expired", "the commit is still missing, so the expired window applies");
		deepStrictEqual(result.accepted, [progress], "repeated progress is folded to one record");
		strictEqual(h.calls.append.length, 0);
	});

	it("refuses a group carrying two different records under one entry id", async () => {
		const h = harness();
		const conflicting = flushGroup([PREPARED, record("e-prep", { phase: "reducing" })]);
		const result = await persistContinuityGroup(conflicting, h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "duplicate_group_entry");
		strictEqual(h.calls.append.length, 0, "the conflict is caught before anything is written");
	});
});

describe("continuity persistence: an ambiguous append", () => {
	it("re-appends under the original id only after proving absence", async () => {
		const h = harness({
			appendBehavior: (_entry, attempt) => {
				if (attempt === 1) throw new Error("write failed before the record landed");
			},
			readback: () => ({ status: "absent" }),
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "durable");
		strictEqual(h.calls.readExact.length, 1, "absence is established from the ledger, not assumed");
		strictEqual(h.calls.append.length, 2);
		strictEqual(h.calls.append[1]?.turnId, "e-prep", "the re-append uses the original id");
		deepStrictEqual(h.calls.append[0], h.calls.append[1], "and the original bytes");
	});

	it("accepts a throwing append whose record actually landed, without writing again", async () => {
		const h = harness({
			appendBehavior: (_entry, attempt) => {
				if (attempt === 1) throw new Error("threw after the write completed");
			},
			readback: () => ({ status: "matching" }),
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "durable");
		strictEqual(h.calls.append.length, 1, "a completed write is not duplicated by its own exception");
		strictEqual(h.calls.flush, 1);
	});

	it("stops on a conflicting or unresolved readback instead of guessing", async () => {
		for (const [status, reason] of [
			["conflicting", "append_conflicting"],
			["unresolved", "append_unresolved"],
		] as const) {
			const h = harness({
				appendBehavior: (_entry, attempt) => {
					if (attempt === 1) throw new Error("ambiguous");
				},
				readback: () => ({ status, detail: "malformed line in the ledger" }),
			});
			const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
			strictEqual(result.status, "uncertain", status);
			if (result.status !== "uncertain") continue;
			strictEqual(result.reason, reason);
			strictEqual(h.calls.append.length, 1, "malformed or contradictory data never licenses a re-append");
			strictEqual(h.calls.flush, 0, "a blocked group runs no barrier");
		}
	});

	it("treats a throwing readback as unresolved, on both looks", async () => {
		const h = harness({
			appendBehavior: () => {
				throw new Error("ambiguous");
			},
			readback: () => {
				throw new Error("ledger unreadable");
			},
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "append_unresolved");
		strictEqual(h.calls.append.length, 1, "a readback that cannot read proves nothing");
	});

	it("reports absence when the re-append also fails", async () => {
		const h = harness({
			appendBehavior: () => {
				throw new Error("disk full");
			},
			readback: () => ({ status: "absent" }),
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "append_absent_after_retry");
		strictEqual(h.calls.append.length, 2, "exactly one re-append, then it stops");
	});

	it("does not re-append after a readback that removed the state or moved the origin", async () => {
		let observed = false;
		const h = harness({
			appendBehavior: (_entry, attempt) => {
				if (attempt === 1) throw new Error("ambiguous");
			},
			readback: () => {
				observed = true;
				return { status: "absent" };
			},
			removed: () => observed,
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "state_removed");
		strictEqual(h.calls.append.length, 1, "the guards run again between the readback and the re-append");
		strictEqual(h.calls.flush, 0);
	});

	it("does not re-append once the deadline passed during the readback", async () => {
		const h = harness({
			appendBehavior: (_entry, attempt) => {
				if (attempt === 1) throw new Error("ambiguous");
			},
			readback: () => {
				h.setClock(DEADLINE);
				return { status: "absent" };
			},
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "deadline_expired");
		strictEqual(h.calls.append.length, 1);
	});

	it("stops before the next record when a slow append crossed the deadline", async () => {
		const h = harness({
			appendBehavior: (entry) => {
				if (entry.turnId === "e-prep") h.setClock(DEADLINE);
			},
		});
		const result = await persistContinuityGroup(checkpointGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "deadline_expired");
		deepStrictEqual(
			h.calls.append.map((entry) => entry.turnId),
			["e-prep"],
			"the deadline is rechecked before each record, not only at the start",
		);
		deepStrictEqual(
			result.accepted.map((progress) => progress.entryId),
			["e-prep"],
			"what was accepted is still reported",
		);
	});

	it("classifies one entry read-only, writing nothing on its own", () => {
		const matching = harness({ readback: () => ({ status: "matching" }) });
		deepStrictEqual(reconcileContinuityEntry(PREPARED, matching.ports), { status: "accepted" });
		strictEqual(matching.calls.append.length, 0);
		strictEqual(matching.calls.flush, 0);

		// Absence is reported, never acted on: only the guarded group writer
		// re-appends, after rechecking removal, origin and the deadline.
		const absent = harness({ readback: () => ({ status: "absent" }) });
		deepStrictEqual(reconcileContinuityEntry(PREPARED, absent.ports), { status: "absent" });
		strictEqual(absent.calls.append.length, 0, "the reconciler is not a writer");
	});
});

describe("continuity persistence: bounded schedules and barriers", () => {
	it("refuses a schedule that cannot bound the work", async () => {
		const schedules = [
			{ limit: Number.POSITIVE_INFINITY },
			{ limit: Number.NaN },
			{ limit: 1.5 },
			{ limit: -1 },
			{ limit: 4 },
			{ deadlineAtMs: Number.POSITIVE_INFINITY },
			{ deadlineAtMs: Number.NaN },
		];
		for (const schedule of schedules) {
			const h = harness(schedule);
			const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
			strictEqual(result.status, "uncertain", JSON.stringify(schedule));
			if (result.status !== "uncertain") continue;
			strictEqual(result.reason, "invalid_retry_schedule");
			strictEqual(h.calls.append.length, 0, "nothing is written under an unbounded schedule");
		}

		const badClock = harness({ startClock: Number.NaN });
		const result = await persistContinuityGroup(flushGroup(), badClock.ports, badClock.retry);
		strictEqual(result.status, "uncertain");
		if (result.status === "uncertain") strictEqual(result.reason, "invalid_retry_schedule");
	});

	it("does not start a group whose window has already closed", async () => {
		const h = harness({ startClock: DEADLINE });
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "deadline_expired");
		strictEqual(h.calls.append.length, 0);
		strictEqual(h.calls.flush, 0);
	});

	it("stops retrying the barrier when the deadline arrives", async () => {
		const h = harness({
			flush: () => {
				throw new Error("fsync failed");
			},
			wait: async () => {
				h.setClock(DEADLINE);
			},
			startClock: 0,
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "barrier_failed");
		strictEqual(h.calls.flush, 1, "the deadline cuts the bounded retries short");
		strictEqual(h.calls.waits.length, 1);
	});

	it("does not confirm the window for a barrier that only succeeded after the deadline", async () => {
		const h = harness({
			flush: (attempt) => {
				if (attempt === 1) throw new Error("fsync failed");
				h.setClock(DEADLINE + 1);
			},
			wait: async () => {
				h.setClock(DEADLINE - 1);
			},
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "durable");
		if (result.status !== "durable") return;
		strictEqual(result.confirmedWithinDeadline, false, "persistence is not permission for dependent execution");
		strictEqual(result.barrierAttempts, 2);
	});

	it("stops writing when the clock jumps backwards between two records", async () => {
		const rolled = harness({
			startClock: 5_000,
			appendBehavior: (entry) => {
				if (entry.turnId === "e-prep") rolled.setClock(1_000);
			},
		});
		const result = await persistContinuityGroup(checkpointGroup(), rolled.ports, rolled.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "invalid_retry_schedule", "a backward clock cannot judge a deadline either");
		deepStrictEqual(
			rolled.calls.append.map((entry) => entry.turnId),
			["e-prep"],
			"the record already accepted stays accepted; nothing further is written",
		);
		strictEqual(rolled.calls.checkpoint.length, 0);

		// The same shape with a forward clock completes, so the check is about the
		// rollback rather than about the append itself.
		const forward = harness({ startClock: 5_000 });
		strictEqual((await persistContinuityGroup(checkpointGroup(), forward.ports, forward.retry)).status, "durable");
	});

	it("runs the barrier but confirms nothing when the clock broke after the last append", async () => {
		const rolled = harness({
			startClock: 5_000,
			appendBehavior: () => {
				rolled.setClock(1_000);
			},
		});
		const result = await persistContinuityGroup(flushGroup(), rolled.ports, rolled.retry);
		strictEqual(result.status, "durable", "the accepted record still deserves its barrier");
		if (result.status !== "durable") return;
		strictEqual(result.confirmedWithinDeadline, false, "but the window cannot be confirmed from a broken clock");
		strictEqual(rolled.calls.flush, 1);
	});

	it("does not confirm the window when a checkpoint await leaves the clock unusable", async () => {
		const h = harness({
			checkpoint: () => {
				h.setClock(Number.NaN);
			},
		});
		const result = await persistContinuityGroup(checkpointGroup(), h.ports, h.retry);
		strictEqual(result.status, "durable", "the barrier did report success, so the records are persisted");
		if (result.status !== "durable") return;
		strictEqual(
			result.confirmedWithinDeadline,
			false,
			"a clock that broke across the barrier confirms nothing about the window",
		);
		strictEqual(h.calls.checkpoint.length, 1);
	});

	it("refuses to keep retrying once the clock itself becomes unusable", async () => {
		const h = harness({
			flush: () => {
				throw new Error("fsync failed");
			},
			wait: async () => {
				h.setClock(Number.NaN);
			},
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "invalid_retry_schedule", "a clock validated once is revalidated at each boundary");
		strictEqual(h.calls.flush, 1);
	});

	it("treats a rejected wait as a blocked barrier rather than an unhandled rejection", async () => {
		const h = harness({
			flush: () => {
				throw new Error("fsync failed");
			},
			wait: async () => {
				throw new Error("scheduler shut down");
			},
		});
		const result = await persistContinuityGroup(flushGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "barrier_failed");
		ok(result.anomalies.some((anomaly) => anomaly.detail.includes("retry wait rejected")));
		strictEqual(h.calls.append.length, 1);
	});

	it("calls a missing barrier port an unsupported port, never a success", async () => {
		const noFlush = harness({ omitFlush: true });
		const flushed = await persistContinuityGroup(flushGroup(), noFlush.ports, noFlush.retry);
		strictEqual(flushed.status, "uncertain");
		if (flushed.status === "uncertain") {
			strictEqual(flushed.reason, "unsupported_barrier_port");
			strictEqual(flushed.barrierAttempts, 0);
			deepStrictEqual(
				flushed.accepted.map((progress) => progress.entryId),
				["e-prep"],
				"the records that were accepted are still reported",
			);
		}

		const noCheckpoint = harness({ omitCheckpoint: true });
		const checkpointed = await persistContinuityGroup(checkpointGroup(), noCheckpoint.ports, noCheckpoint.retry);
		strictEqual(checkpointed.status, "uncertain");
		if (checkpointed.status === "uncertain") strictEqual(checkpointed.reason, "unsupported_barrier_port");
	});
});

describe("continuity persistence: removed state and origin", () => {
	it("writes nothing when the state root is already removed or the origin moved", async () => {
		const removed = harness({ removed: () => true });
		const first = await persistContinuityGroup(flushGroup(), removed.ports, removed.retry);
		strictEqual(first.status, "uncertain");
		if (first.status === "uncertain") strictEqual(first.reason, "state_removed");
		strictEqual(removed.calls.append.length, 0);

		const moved = harness({ originCurrent: () => false });
		const second = await persistContinuityGroup(flushGroup(), moved.ports, moved.retry);
		strictEqual(second.status, "uncertain");
		if (second.status === "uncertain") strictEqual(second.reason, "origin_changed");
		strictEqual(moved.calls.append.length, 0);
	});

	it("stops mid-group when the origin changes between records", async () => {
		// Checks run: 1 pre-group, then one per record before its append.
		const h = harness({ originCurrent: (check) => check < 3 });
		const result = await persistContinuityGroup(checkpointGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "origin_changed");
		deepStrictEqual(
			h.calls.append.map((entry) => entry.turnId),
			["e-prep"],
			"the record already accepted stays accepted; the rest is not written",
		);
		strictEqual(h.calls.checkpoint.length, 0);
	});

	it("does not run another barrier attempt when a retry wait removed the state", async () => {
		let removed = false;
		const h = harness({
			checkpoint: () => {
				throw new Error("checkpoint failed");
			},
			removed: () => removed,
			wait: async () => {
				removed = true;
			},
		});
		const result = await persistContinuityGroup(checkpointGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "state_removed");
		strictEqual(h.calls.checkpoint.length, 1, "a removal during the wait stops the next checkpoint");
		strictEqual(h.calls.waits.length, 1);
	});

	it("reports a removal that only became visible after a successful barrier", async () => {
		let checkpointed = false;
		const h = harness({
			checkpoint: () => {
				checkpointed = true;
			},
			removed: () => checkpointed,
		});
		const result = await persistContinuityGroup(checkpointGroup(), h.ports, h.retry);
		strictEqual(result.status, "uncertain");
		if (result.status !== "uncertain") return;
		strictEqual(result.reason, "state_removed", "a resolved checkpoint never licenses recreating deleted state");
		strictEqual(h.calls.checkpoint.length, 1);
	});
});
