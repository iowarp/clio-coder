import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { DomainContext } from "../../src/core/domain-loader.js";
import type {
	AcceptedNote,
	ContinuityAppendable,
	ContinuityPersistencePorts,
	ContinuityRetrySchedule,
	HandoffIdentity,
	HandoffPolicy,
} from "../../src/domains/session/continuity/contract.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";
import {
	continuityRecordDigest,
	persistContinuityGroup,
	reconcileContinuityEntry,
} from "../../src/domains/session/continuity/persistence.js";
import {
	createContinuityPersistencePorts,
	readContinuityRecordExact,
} from "../../src/domains/session/continuity/ports.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { sessionPaths } from "../../src/engine/session.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * The 02A persistence protocol bound to Clio's real writer, against real files.
 *
 * Every readback here goes through the actual ledger on disk. Nothing in this
 * file executes a recovery: the protocol persists records and reports what it
 * established, and the separation between "persisted" and "permitted inside the
 * deadline" is one of the things being checked.
 */

const AT = "2026-09-21T09:00:00.000Z";
const PREPARED_AT = 1_000_000;

function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`fixture note rejected: ${result.reason}`);
	return result.accepted;
}

const NOTE = admit("finish the reducer; the failing case is an empty tool batch");

function policy(): HandoffPolicy {
	return {
		preparedAtMs: PREPARED_AT,
		automaticDeadlineAtMs: PREPARED_AT + 600_000,
		maxAttempts: 2,
		maxSummaryCallsPerAttempt: 2,
		additionalSummaryRetriesPerCall: 0,
		maxSummaryStreamInvocations: 4,
		flushRetryLimit: 3,
	};
}

function identity(sessionId: string, over: Partial<HandoffIdentity> = {}): HandoffIdentity {
	return {
		handoffId: "h1",
		preparedEntryId: "h1-prep",
		commitId: "h1-commit",
		commitEntryId: "h1-commit-entry",
		originSessionId: sessionId,
		branchAnchorTurnId: "u1",
		initiatingTurnId: "u1",
		toolCallId: "tc-1",
		sourceRevision: "lb-1-00000000000000ff",
		...over,
	};
}

function preparedRecord(sessionId: string): ContinuityAppendable {
	return {
		kind: "handoffTransaction",
		turnId: "h1-prep",
		parentTurnId: "u1",
		timestamp: AT,
		schemaVersion: 1,
		identity: identity(sessionId),
		transition: { entryId: "h1-prep", prevEntryId: null, sequence: 0, attempt: 0 },
		event: { phase: "prepared", accepted: NOTE, policy: policy() },
	};
}

function schedule(over: Partial<ContinuityRetrySchedule> = {}): ContinuityRetrySchedule {
	let now = PREPARED_AT;
	return {
		limit: 3,
		deadlineAtMs: PREPARED_AT + 600_000,
		now: () => {
			now += 1;
			return now;
		},
		wait: async () => {},
		...over,
	};
}

describe("continuity persistence bound to the real session writer", () => {
	let scratch: IsolatedClioEnv;
	let contract: SessionContract;
	let sessionId: string;
	let cwdHash: string;
	let currentPath: string;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-continuity-binding-");
		contract = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
		const meta = contract.create({ cwd: scratch.dir });
		sessionId = meta.id;
		cwdHash = meta.cwdHash;
		contract.append({ id: "u1", parentId: null, at: AT, kind: "user", payload: { text: "start" } });
		currentPath = sessionPaths(meta).current;
	});

	afterEach(async () => {
		try {
			await contract.close();
		} finally {
			scratch.restore();
		}
	});

	const ports = (over: Partial<ContinuityPersistencePorts> = {}): ContinuityPersistencePorts => ({
		...createContinuityPersistencePorts({ session: contract, origin: { sessionId, cwdHash } }),
		...over,
	});

	it("appends a reserved record and reads it back by exact payload", async () => {
		const record = preparedRecord(sessionId);
		const result = await persistContinuityGroup({ entries: [record], barrier: { kind: "flush" } }, ports(), schedule());
		strictEqual(result.status, "durable");
		ok(result.status === "durable" && result.confirmedWithinDeadline);
		deepStrictEqual(readContinuityRecordExact({ sessionId, cwdHash }, record), { status: "matching" });
		// The reserved identity and timestamp are what landed, not manager-minted
		// replacements: recovery rebuilds a missing commit under the id its
		// prepare reserved, so a substituted id would break reconstruction.
		const stored = readFileSync(currentPath, "utf8")
			.split("\n")
			.filter((line) => line.includes("h1-prep"));
		strictEqual(stored.length, 1);
		const parsed = JSON.parse(stored[0] ?? "{}") as { turnId: string; timestamp: string };
		strictEqual(parsed.turnId, "h1-prep");
		strictEqual(parsed.timestamp, AT);
	});

	it("does not advance the selected message leaf", async () => {
		await persistContinuityGroup(
			{ entries: [preparedRecord(sessionId)], barrier: { kind: "flush" } },
			ports(),
			schedule(),
		);
		// The next ordinary turn still parents onto the message leaf. A rich entry
		// that moved `currentTurnId` would make this throw.
		contract.append({ id: "u2", parentId: "u1", at: AT, kind: "user", payload: { text: "next" } });
		strictEqual(contract.tree().leafId, "u2");
	});

	it("retries a failed barrier without appending the record twice", async () => {
		const record = preparedRecord(sessionId);
		let flushes = 0;
		const result = await persistContinuityGroup(
			{ entries: [record], barrier: { kind: "flush" } },
			ports({
				flushAppends: () => {
					flushes += 1;
					if (flushes < 3) throw new Error("injected fsync failure");
				},
			}),
			schedule(),
		);
		strictEqual(result.status, "durable");
		strictEqual(result.status === "durable" ? result.barrierAttempts : -1, 3);
		// One append, three barrier attempts. An accepted append is never repeated
		// because a later flush failed.
		strictEqual(
			readFileSync(currentPath, "utf8")
				.split("\n")
				.filter((line) => line.includes('"h1-prep"')).length,
			1,
		);
	});

	it("reports uncertain, with progress retained, when the barrier never succeeds", async () => {
		const record = preparedRecord(sessionId);
		const result = await persistContinuityGroup(
			{ entries: [record], barrier: { kind: "flush" } },
			ports({
				flushAppends: () => {
					throw new Error("injected fsync failure");
				},
			}),
			schedule(),
		);
		strictEqual(result.status, "uncertain");
		strictEqual(result.status === "uncertain" ? result.reason : "", "barrier_failed");
		deepStrictEqual(result.accepted, [{ entryId: "h1-prep", payloadDigest: continuityRecordDigest(record) }]);
		// Resuming with that progress must not write the bytes again.
		const second = await persistContinuityGroup(
			{ entries: [record], barrier: { kind: "flush" }, alreadyAccepted: result.accepted },
			ports(),
			schedule(),
		);
		strictEqual(second.status, "durable");
		strictEqual(
			readFileSync(currentPath, "utf8")
				.split("\n")
				.filter((line) => line.includes('"h1-prep"')).length,
			1,
		);
	});

	it("treats a throw after a completed write as accepted, not as a second record", async () => {
		const record = preparedRecord(sessionId);
		const real = createContinuityPersistencePorts({ session: contract, origin: { sessionId, cwdHash } });
		const result = await persistContinuityGroup(
			{ entries: [record], barrier: { kind: "flush" } },
			ports({
				append: (entry) => {
					real.append(entry);
					throw new Error("injected throw after the write completed");
				},
			}),
			schedule(),
		);
		strictEqual(result.status, "durable");
		strictEqual(
			readFileSync(currentPath, "utf8")
				.split("\n")
				.filter((line) => line.includes('"h1-prep"')).length,
			1,
		);
	});

	it("refuses a group whose record already exists under the same id with different bytes", async () => {
		const record = preparedRecord(sessionId);
		const real = createContinuityPersistencePorts({ session: contract, origin: { sessionId, cwdHash } });
		real.append({
			...record,
			event: { phase: "prepared", accepted: admit("a different accepted note"), policy: policy() },
		});
		const result = await persistContinuityGroup(
			{ entries: [record], barrier: { kind: "flush" } },
			ports({
				append: () => {
					throw new Error("injected ambiguous append");
				},
			}),
			schedule(),
		);
		strictEqual(result.status, "uncertain");
		strictEqual(result.status === "uncertain" ? result.reason : "", "append_conflicting");
	});

	it("sees a later conflicting copy even after an earlier exact match", async () => {
		const record = preparedRecord(sessionId);
		const real = createContinuityPersistencePorts({ session: contract, origin: { sessionId, cwdHash } });
		real.append(record);
		strictEqual(readContinuityRecordExact({ sessionId, cwdHash }, record).status, "matching");
		real.append({
			...record,
			event: { phase: "prepared", accepted: admit("a different accepted note"), policy: policy() },
		});
		// The old summary lookup returned at its first kind+id hit. Stopping there
		// would call this ledger clean while it holds two different records under
		// one reserved identity.
		strictEqual(readContinuityRecordExact({ sessionId, cwdHash }, record).status, "conflicting");
	});

	it("refuses to conclude absence from a torn ledger", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		writeFileSync(currentPath, `${readFileSync(currentPath, "utf8")}{"kind":"handoffTrans`, "utf8");
		const readback = readContinuityRecordExact({ sessionId, cwdHash }, record);
		strictEqual(readback.status, "unresolved");
		match(readback.detail ?? "", /could not be parsed/u);
	});

	it("refuses to conclude absence from a parseable record that is not a valid entry", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		const base = readFileSync(currentPath, "utf8");
		// Each of these parses cleanly and is not an admitted ledger record, so
		// none of them may be skipped on the way to a clean `absent`.
		for (const line of ["null", "42", '"text"', "[1,2]", '{"turnId":"h1-prep"}', '{"kind":"message","turnId":"x"}']) {
			writeFileSync(currentPath, `${base}${line}\n`, "utf8");
			const readback = readContinuityRecordExact({ sessionId, cwdHash }, record);
			strictEqual(readback.status, "unresolved", `line ${line} must not resolve`);
		}
	});

	it("refuses a ledger whose header belongs to another session", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		const lines = readFileSync(currentPath, "utf8").split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		writeFileSync(
			currentPath,
			[JSON.stringify({ ...header, id: "some-other-session" }), ...lines.slice(1)].join("\n"),
			"utf8",
		);
		const readback = readContinuityRecordExact({ sessionId, cwdHash }, record);
		strictEqual(readback.status, "unresolved");
		match(readback.detail ?? "", /not /u);
	});

	it("refuses a ledger whose header declares a format this build does not read", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		const lines = readFileSync(currentPath, "utf8").split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		for (const version of [2, 6]) {
			writeFileSync(currentPath, [JSON.stringify({ ...header, version }), ...lines.slice(1)].join("\n"), "utf8");
			const readback = readContinuityRecordExact({ sessionId, cwdHash }, record);
			strictEqual(readback.status, "unresolved", `version ${version} must not resolve`);
			match(readback.detail ?? "", /format version/u);
		}
	});

	it("refuses a headerless ledger rather than attributing it to this session", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		const lines = readFileSync(currentPath, "utf8").split("\n");
		writeFileSync(currentPath, lines.slice(1).join("\n"), "utf8");
		strictEqual(readContinuityRecordExact({ sessionId, cwdHash }, record).status, "unresolved");
	});

	it("leaves a temporary candidate alone instead of promoting it during inspection", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		const temp = `${currentPath}.tmp`;
		renameSync(currentPath, temp);
		const readback = readContinuityRecordExact({ sessionId, cwdHash }, record);
		strictEqual(readback.status, "unresolved");
		// The engine's own open path promotes a temp over a missing target and
		// fsyncs the directory. An inspection must not: the record may be in the
		// temp, the temp may be stale, and either way this is a read.
		ok(existsSync(temp));
		strictEqual(existsSync(currentPath), false);
	});

	it("does not recreate a removed state root", async () => {
		const record = preparedRecord(sessionId);
		rmSync(scratch.dir, { recursive: true, force: true });
		const result = await persistContinuityGroup({ entries: [record], barrier: { kind: "flush" } }, ports(), schedule());
		strictEqual(result.status, "uncertain");
		strictEqual(result.status === "uncertain" ? result.reason : "", "state_removed");
		strictEqual(existsSync(scratch.dir), false);
	});

	it("refuses to write once the session it was bound to is no longer current", async () => {
		const record = preparedRecord(sessionId);
		const bound = ports();
		// A navigation between binding and writing, which is what an awaited
		// barrier makes reachable.
		contract.create({ cwd: scratch.dir });
		const result = await persistContinuityGroup({ entries: [record], barrier: { kind: "flush" } }, bound, schedule());
		strictEqual(result.status, "uncertain");
		strictEqual(result.status === "uncertain" ? result.reason : "", "origin_changed");
		strictEqual(readFileSync(currentPath, "utf8").includes('"h1-prep"'), false);
	});

	it("keeps its binding when the caller mutates the origin object it passed", async () => {
		const mutable = { sessionId, cwdHash };
		const bound = createContinuityPersistencePorts({ session: contract, origin: mutable });
		(mutable as { sessionId: string }).sessionId = "some-other-session";
		// Captured by value: a caller that edits its own object mid-flight must not
		// be able to point the liveness check and the readback at a different
		// session at the same time, which would make them agree with each other.
		ok(bound.isOriginCurrent());
		const record = preparedRecord(sessionId);
		const result = await persistContinuityGroup({ entries: [record], barrier: { kind: "flush" } }, bound, schedule());
		strictEqual(result.status, "durable");
		strictEqual(readContinuityRecordExact({ sessionId, cwdHash }, record).status, "matching");
	});

	it("refuses a record with no reserved identity or explicit timestamp", () => {
		const bound = createContinuityPersistencePorts({ session: contract, origin: { sessionId, cwdHash } });
		const record = preparedRecord(sessionId) as Record<string, unknown>;
		throws(() => bound.append({ ...record, turnId: "" } as ContinuityAppendable), /reserved turnId/u);
		const { timestamp: _dropped, ...noTimestamp } = record;
		throws(() => bound.append(noTimestamp as ContinuityAppendable), /explicit timestamp/u);
	});

	it("reports an unsupported barrier rather than a success nobody ran", async () => {
		const { flushAppends: _unsupported, ...withoutFlush } = createContinuityPersistencePorts({
			session: contract,
			origin: { sessionId, cwdHash },
		});
		const result = await persistContinuityGroup(
			{ entries: [preparedRecord(sessionId)], barrier: { kind: "flush" } },
			withoutFlush,
			schedule(),
		);
		strictEqual(result.status, "uncertain");
		strictEqual(result.status === "uncertain" ? result.reason : "", "unsupported_barrier_port");
	});

	it("separates a persisted checkpoint from permission inside the deadline", async () => {
		const record = preparedRecord(sessionId);
		let reads = 0;
		const result = await persistContinuityGroup(
			{ entries: [record], barrier: { kind: "checkpoint", reason: "continuity-commit" } },
			ports(),
			schedule({
				deadlineAtMs: PREPARED_AT + 5,
				now: () => {
					reads += 1;
					// Inside the window for the appends, past it by the time the
					// awaited checkpoint resolves.
					return reads <= 3 ? PREPARED_AT : PREPARED_AT + 10;
				},
			}),
		);
		strictEqual(result.status, "durable");
		// Persisted, but not confirmed in time. The caller has to re-authorize
		// rather than inherit permission from this call.
		strictEqual(result.status === "durable" ? result.confirmedWithinDeadline : true, false);
		strictEqual(readContinuityRecordExact({ sessionId, cwdHash }, record).status, "matching");
	});

	it("classifies a record read-only, writing nothing", () => {
		const record = preparedRecord(sessionId);
		contract.flushAppends?.();
		const before = readFileSync(currentPath, "utf8");
		strictEqual(reconcileContinuityEntry(record, ports()).status, "absent");
		strictEqual(readFileSync(currentPath, "utf8"), before);
	});
});
