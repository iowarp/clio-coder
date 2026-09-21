import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	type AcceptedNote,
	HANDOFF_NOTE_MAX_BYTES,
	type HandoffIdentity,
	type HandoffPolicy,
} from "../../src/domains/session/continuity/contract.js";
import { validateContinuityNote, verifyAcceptedNote } from "../../src/domains/session/continuity/note.js";
import {
	isContinuityCarryingSummary,
	isContinuityCheckpointPayload,
	isContinuityCommitEntry,
	isHandoffEvent,
	isHandoffTransactionEntry,
} from "../../src/domains/session/continuity/validate.js";

function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to admit, got ${result.reason}`);
	return result.accepted;
}

const IDENTITY: HandoffIdentity = {
	handoffId: "h1",
	preparedEntryId: "e-prep",
	commitId: "c1",
	commitEntryId: "e-commit",
	originSessionId: "s-1",
	branchAnchorTurnId: "a1",
	initiatingTurnId: "u1",
	toolCallId: "tc-1",
	sourceRevision: "lb-3-0123456789abcdef",
};

const POLICY: HandoffPolicy = {
	preparedAtMs: 1_000_000,
	automaticDeadlineAtMs: 1_600_000,
	maxAttempts: 2,
	maxSummaryCallsPerAttempt: 2,
	additionalSummaryRetriesPerCall: 0,
	maxSummaryStreamInvocations: 4,
	flushRetryLimit: 3,
};

const NOTE = admit("continue the ADR rewrite");

function payload(over: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		identity: IDENTITY,
		accepted: NOTE,
		policy: POLICY,
		commit: {
			outcome: "summarized",
			entry: { turnId: "e-commit", parentTurnId: "a1", timestamp: "2026-09-21T10:00:00.000Z" },
			transition: { entryId: "e-commit", prevEntryId: "e-reduce", sequence: 2, attempt: 1 },
			summaryRef: "e-summary",
			tokensBefore: 30_000,
			tokensAfter: 9_000,
		},
		state: {
			transition: { entryId: "e-commit", prevEntryId: "e-reduce", sequence: 2, attempt: 1 },
			event: { phase: "ready" },
			activeResume: null,
			delivery: null,
		},
		...over,
	};
}

function commitEntry(over: Record<string, unknown> = {}) {
	return {
		kind: "continuityCommit",
		turnId: "e-commit",
		parentTurnId: "a1",
		timestamp: "2026-09-21T10:00:00.000Z",
		continuity: payload(),
		...over,
	};
}

function transaction(over: Record<string, unknown> = {}) {
	return {
		kind: "handoffTransaction",
		turnId: "e-prep",
		parentTurnId: "u1",
		timestamp: "2026-09-21T09:59:00.000Z",
		schemaVersion: 1,
		identity: IDENTITY,
		transition: { entryId: "e-prep", prevEntryId: null, sequence: 0, attempt: 0 },
		event: { phase: "prepared", accepted: NOTE, policy: POLICY },
		...over,
	};
}

describe("continuity note admission", () => {
	it("stores the submitted bytes exactly, without trimming or normalizing", () => {
		const cases = [
			"  leading and trailing space  ",
			"tabs\tand\nnewlines\r\n",
			"emoji 🧪🔬 and CJK 文脈 and RTL אב",
			// A combining sequence and its precomposed form are different notes.
			"é vs é",
			"markup <script>alert(1)</script> & entities",
		];
		for (const text of cases) {
			const accepted = admit(text);
			strictEqual(accepted.note, text, "the note is stored as submitted");
			strictEqual(accepted.noteBytes, Buffer.byteLength(text, "utf8"), "bytes are the UTF-8 length, not String.length");
			strictEqual(accepted.noteSha256, createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"));
			strictEqual(verifyAcceptedNote(accepted).ok, true);
		}
	});

	it("distinguishes a precomposed character from its combining sequence", () => {
		const composed = admit("café");
		const decomposed = admit("café");
		ok(composed.note !== decomposed.note, "no Unicode normalization happens");
		ok(composed.noteSha256 !== decomposed.noteSha256);
		strictEqual(verifyAcceptedNote(decomposed, composed).ok, false);
	});

	it("rejects blank, non-string, NUL and lone-surrogate notes", () => {
		const cases: Array<[unknown, string]> = [
			["", "blank"],
			["   \t\n  ", "blank"],
			[undefined, "not_a_string"],
			[null, "not_a_string"],
			[42, "not_a_string"],
			[{ note: "x" }, "not_a_string"],
			["before\u0000after", "contains_nul"],
			["lone \uD800 surrogate", "not_utf8_round_trip"],
			["trailing low \uDC00", "not_utf8_round_trip"],
		];
		for (const [input, reason] of cases) {
			const result = validateContinuityNote(input);
			strictEqual(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
			if (!result.ok) strictEqual(result.reason, reason);
		}
	});

	it("bounds the note by UTF-8 bytes at exactly the documented limit", () => {
		const exact = "a".repeat(HANDOFF_NOTE_MAX_BYTES);
		strictEqual(admit(exact).noteBytes, HANDOFF_NOTE_MAX_BYTES);

		const overByOne = validateContinuityNote("a".repeat(HANDOFF_NOTE_MAX_BYTES + 1));
		strictEqual(overByOne.ok, false);
		if (!overByOne.ok) {
			strictEqual(overByOne.reason, "exceeds_max_bytes");
			strictEqual(overByOne.noteBytes, HANDOFF_NOTE_MAX_BYTES + 1, "the rejection reports the real size");
		}

		// Multi-byte characters are bounded by their encoding, not their count.
		const multibyte = "🧪".repeat(HANDOFF_NOTE_MAX_BYTES / 4);
		strictEqual(admit(multibyte).noteBytes, HANDOFF_NOTE_MAX_BYTES);
		strictEqual(validateContinuityNote(`${multibyte}a`).ok, false);
	});

	it("refuses a record whose stored bytes or digest disagree with its text", () => {
		const good = admit("keep the failing test name");
		deepStrictEqual(verifyAcceptedNote({ ...good, noteBytes: good.noteBytes + 1 }), {
			ok: false,
			reason: "byte_count_mismatch",
		});
		deepStrictEqual(verifyAcceptedNote({ ...good, noteSha256: "0".repeat(64) }), {
			ok: false,
			reason: "hash_mismatch",
		});
		// A record whose text no longer admits is not evidence, whatever it stores.
		deepStrictEqual(verifyAcceptedNote({ note: "   ", noteBytes: 3, noteSha256: "0".repeat(64) }), {
			ok: false,
			reason: "blank",
		});
	});

	it("reports two copies of one transaction that carry different text", () => {
		const first = admit("summarize the migration");
		const second = admit("summarize the migratioN");
		strictEqual(first.noteBytes, second.noteBytes, "same length, so no token count could tell them apart");
		deepStrictEqual(verifyAcceptedNote(second, first), { ok: false, reason: "decoded_text_mismatch" });
		strictEqual(verifyAcceptedNote(first, first).ok, true);
	});
});

describe("continuity event and record validation", () => {
	it("requires each phase's own fields", () => {
		ok(isHandoffEvent({ phase: "prepared", accepted: NOTE, policy: POLICY }));
		ok(isHandoffEvent({ phase: "reducing" }));
		ok(isHandoffEvent({ phase: "reducing", resumeRef: "e-resume" }));
		ok(isHandoffEvent({ phase: "delivered", deliveryId: "d1", continuationTurnId: "u9" }));
		ok(isHandoffEvent({ phase: "acknowledged", deliveryId: "d1", terminalResponseEntryId: "a9" }));
		ok(isHandoffEvent({ phase: "paused", reason: "delivery_uncertain" }));
		ok(isHandoffEvent({ phase: "failed", reason: "attempts_exhausted" }));

		const rejected: unknown[] = [
			{ phase: "unknown" },
			{},
			null,
			"prepared",
			{ phase: "prepared", accepted: NOTE },
			{ phase: "prepared", policy: POLICY },
			{ phase: "delivered", deliveryId: "d1" },
			{ phase: "delivered", deliveryId: "", continuationTurnId: "u9" },
			{ phase: "acknowledged", deliveryId: "d1" },
			{ phase: "paused", reason: "because" },
			{ phase: "failed", reason: "no_material" },
			{ phase: "resumed", authority: { operatorRequestEntryId: "op1", action: "reduce" } },
			{
				phase: "resumed",
				authority: { operatorRequestEntryId: "op1", pausedOrFailedEntryId: "p", action: "erase", automaticDeadlineAtMs: 1 },
			},
		];
		for (const value of rejected) ok(!isHandoffEvent(value), `expected rejection for ${JSON.stringify(value)}`);
	});

	it("rejects non-finite, non-integer and out-of-range numbers", () => {
		const bad = [
			{ ...POLICY, automaticDeadlineAtMs: Number.POSITIVE_INFINITY },
			{ ...POLICY, automaticDeadlineAtMs: Number.NaN },
			{ ...POLICY, automaticDeadlineAtMs: 1.5 },
			// A deadline at or before preparation is not a window.
			{ ...POLICY, automaticDeadlineAtMs: POLICY.preparedAtMs },
			{ ...POLICY, automaticDeadlineAtMs: POLICY.preparedAtMs - 1 },
			{ ...POLICY, maxAttempts: 0 },
			{ ...POLICY, maxAttempts: -1 },
			{ ...POLICY, flushRetryLimit: -1 },
			{ ...POLICY, preparedAtMs: -1 },
		];
		for (const policy of bad) {
			ok(
				!isHandoffEvent({ phase: "prepared", accepted: NOTE, policy }),
				`expected rejection for ${JSON.stringify(policy)}`,
			);
		}

		for (const transition of [
			{ entryId: "e", prevEntryId: null, sequence: 1.5, attempt: 0 },
			{ entryId: "e", prevEntryId: null, sequence: -1, attempt: 0 },
			{ entryId: "e", prevEntryId: null, sequence: 0, attempt: Number.NaN },
			{ entryId: "e", prevEntryId: null, sequence: Number.MAX_VALUE, attempt: 0 },
		]) {
			ok(!isHandoffTransactionEntry(transaction({ transition, turnId: "e" })));
		}
	});

	it("refuses a persisted policy that widens the frozen automatic budget", () => {
		const widened: Array<[string, HandoffPolicy]> = [
			["a third attempt", { ...POLICY, maxAttempts: 3 }],
			["a third summary call per attempt", { ...POLICY, maxSummaryCallsPerAttempt: 3 }],
			["an added summary retry loop", { ...POLICY, additionalSummaryRetriesPerCall: 1 }],
			["more stream invocations", { ...POLICY, maxSummaryStreamInvocations: 8 }],
			["more barrier retries", { ...POLICY, flushRetryLimit: 5 }],
		];
		for (const [label, policy] of widened) {
			ok(!isHandoffEvent({ phase: "prepared", accepted: NOTE, policy }), `${label} must not survive a restart`);
			ok(!isContinuityCheckpointPayload(payload({ policy })), label);
		}
		// The frozen values themselves still admit.
		ok(isHandoffEvent({ phase: "prepared", accepted: NOTE, policy: POLICY }));
		ok(isHandoffEvent({ phase: "prepared", accepted: NOTE, policy: { ...POLICY, maxAttempts: 1, flushRetryLimit: 0 } }));
	});

	it("binds the transaction envelope to its own transition and prepared identity", () => {
		ok(isHandoffTransactionEntry(transaction()));
		// turnId must be the transition's entryId.
		ok(!isHandoffTransactionEntry(transaction({ turnId: "other" })));
		// Only `prepared` may root the chain.
		ok(!isHandoffTransactionEntry(transaction({ event: { phase: "reducing" } })));
		ok(
			isHandoffTransactionEntry(
				transaction({
					turnId: "e-reduce",
					event: { phase: "reducing" },
					transition: { entryId: "e-reduce", prevEntryId: "e-prep", sequence: 1, attempt: 1 },
				}),
			),
		);
		// A prepared record at a different reserved id, sequence or attempt.
		ok(
			!isHandoffTransactionEntry(
				transaction({ turnId: "e-x", transition: { entryId: "e-x", prevEntryId: null, sequence: 0, attempt: 0 } }),
			),
		);
		ok(
			!isHandoffTransactionEntry(
				transaction({ transition: { entryId: "e-prep", prevEntryId: null, sequence: 1, attempt: 0 } }),
			),
		);
		ok(
			!isHandoffTransactionEntry(
				transaction({ transition: { entryId: "e-prep", prevEntryId: null, sequence: 0, attempt: 1 } }),
			),
		);
		ok(!isHandoffTransactionEntry(transaction({ schemaVersion: 2 })));
		ok(!isHandoffTransactionEntry(transaction({ kind: "compactionSummary" })));
		ok(!isHandoffTransactionEntry(transaction({ timestamp: "" })));
	});

	it("requires the outcome's own reference and forbids the other one", () => {
		ok(isContinuityCheckpointPayload(payload()));

		const evicted = payload({
			commit: {
				outcome: "evicted",
				entry: { turnId: "e-commit", parentTurnId: "a1", timestamp: "2026-09-21T10:00:00.000Z" },
				transition: { entryId: "e-commit", prevEntryId: "e-reduce", sequence: 2, attempt: 1 },
				evictionRef: "e-evict",
				tokensBefore: 30_000,
				tokensAfter: 22_000,
			},
		});
		ok(isContinuityCheckpointPayload(evicted));

		const rejected = [
			// summarized without its ref, and with the wrong one.
			payload({ commit: { ...payload().commit, summaryRef: undefined } }),
			payload({ commit: { ...payload().commit, evictionRef: "e-evict" } }),
			// continuity_only may name neither.
			payload({ commit: { ...payload().commit, outcome: "continuity_only" } }),
			// `no_material` is not a commit outcome.
			payload({ commit: { ...payload().commit, outcome: "no_material", summaryRef: undefined } }),
			payload({ schemaVersion: 2 }),
			// The payload's commit envelope must be the reserved commit entry id.
			payload({ commit: { ...payload().commit, entry: { turnId: "elsewhere", parentTurnId: null, timestamp: "t" } } }),
			// A head that sits before its own commit describes no chain.
			payload({
				state: {
					transition: { entryId: "e-commit", prevEntryId: "e-reduce", sequence: 1, attempt: 1 },
					event: { phase: "ready" },
					activeResume: null,
					delivery: null,
				},
			}),
			// `ready` is a bare marker, not an event with extra fields.
			payload({
				state: {
					transition: { entryId: "e-commit", prevEntryId: "e-reduce", sequence: 2, attempt: 1 },
					event: { phase: "ready", deliveryId: "d1" },
					activeResume: null,
					delivery: null,
				},
			}),
		];
		for (const value of rejected)
			ok(!isContinuityCheckpointPayload(value), `expected rejection: ${JSON.stringify(value)}`);
	});

	it("holds the commit record to the exact envelope its payload reserved", () => {
		ok(isContinuityCommitEntry(commitEntry()));
		ok(!isContinuityCommitEntry(commitEntry({ turnId: "another" })));
		ok(!isContinuityCommitEntry(commitEntry({ parentTurnId: "different" })));
		ok(!isContinuityCommitEntry(commitEntry({ timestamp: "2020-01-01T00:00:00.000Z" })));
		ok(!isContinuityCommitEntry(commitEntry({ continuity: undefined })));
		ok(!isContinuityCommitEntry(commitEntry({ kind: "compactionSummary" })));
	});

	it("recognizes a carrying summary structurally and leaves ordinary summaries alone", () => {
		const carrying = {
			kind: "compactionSummary",
			turnId: "e-summary",
			parentTurnId: "u1",
			timestamp: "2026-09-21T10:00:00.000Z",
			summary: "…",
			tokensBefore: 30_000,
			firstKeptTurnId: "u1",
			continuity: payload(),
		};
		ok(isContinuityCarryingSummary(carrying));
		ok(!isContinuityCarryingSummary({ ...carrying, continuity: undefined }));
		ok(!isContinuityCarryingSummary({ ...carrying, continuity: { schemaVersion: 1 } }));
	});
});
