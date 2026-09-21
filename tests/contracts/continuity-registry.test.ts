import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSessionEntries } from "../../src/domains/session/archive-readers.js";
import { serializeConversation } from "../../src/domains/session/compaction/branch-summary.js";
import { findCutPoint } from "../../src/domains/session/compaction/cut-point.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import { calculateContextTokens, estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type {
	AcceptedNote,
	ContinuityCheckpointPayload,
	ContinuityCommitData,
	HandoffEvent,
	HandoffIdentity,
	HandoffPolicy,
} from "../../src/domains/session/continuity/contract.js";
import { resolveContinuityEvidence } from "../../src/domains/session/continuity/evidence.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";
import {
	HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE,
	isHandoffRecoveryRequestEntry,
} from "../../src/domains/session/continuity/operator-request.js";
import {
	continuityProjectionTokens,
	continuityReplayBlocks,
	resolveContinuityProjection,
} from "../../src/domains/session/continuity/projection.js";
import { isSessionEntry, SESSION_ENTRY_KINDS, type SessionEntry } from "../../src/domains/session/entries.js";
import { ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { CURRENT_SESSION_FORMAT_VERSION } from "../../src/engine/session.js";

/**
 * Format v5 registration and the readers it touches.
 *
 * Everything here is pure: records built in memory, run through the real
 * validators, readers and estimators. The session/fork/replay integration that
 * needs actual files lives in `continuity-replay-fork.test.ts`, and the real
 * writer binding in `continuity-binding.test.ts`.
 */

const SESSION = "session-a";
const AT = "2026-09-21T09:00:00.000Z";
const PREPARED_AT = 1_000_000;

function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`fixture note rejected: ${result.reason}`);
	return result.accepted;
}

const NOTE = admit("resume the migration at step 4; the rollback script is untested");

function identity(over: Partial<HandoffIdentity> = {}): HandoffIdentity {
	return {
		handoffId: "h1",
		preparedEntryId: "h1-prep",
		commitId: "h1-commit",
		commitEntryId: "h1-commit-entry",
		originSessionId: SESSION,
		branchAnchorTurnId: "a1",
		initiatingTurnId: "u1",
		toolCallId: "tc-1",
		sourceRevision: "lb-3-0123456789abcdef",
		...over,
	};
}

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

function tx(
	entryId: string,
	prevEntryId: string | null,
	sequence: number,
	attempt: number,
	event: HandoffEvent,
): SessionEntry {
	return {
		kind: "handoffTransaction",
		turnId: entryId,
		parentTurnId: "u1",
		timestamp: AT,
		schemaVersion: 1,
		identity: identity(),
		transition: { entryId, prevEntryId, sequence, attempt },
		event,
	} as SessionEntry;
}

const SUMMARIZED_COMMIT: ContinuityCommitData = {
	outcome: "summarized",
	entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: AT },
	transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce", sequence: 2, attempt: 1 },
	summaryRef: "h1-summary",
	tokensBefore: 30_000,
	tokensAfter: 9_000,
};

function checkpoint(over: Partial<ContinuityCheckpointPayload> = {}): ContinuityCheckpointPayload {
	const commit = over.commit ?? SUMMARIZED_COMMIT;
	return {
		schemaVersion: 1,
		identity: over.identity ?? identity(),
		accepted: over.accepted ?? NOTE,
		policy: over.policy ?? policy(),
		commit,
		state: over.state ?? { transition: commit.transition, event: { phase: "ready" }, activeResume: null, delivery: null },
	};
}

function commitEntry(payload = checkpoint()): SessionEntry {
	return {
		kind: "continuityCommit",
		turnId: payload.commit.entry.turnId,
		parentTurnId: payload.commit.entry.parentTurnId,
		timestamp: payload.commit.entry.timestamp,
		continuity: payload,
	} as SessionEntry;
}

function carryingSummary(turnId: string, payload = checkpoint()): SessionEntry {
	return {
		kind: "compactionSummary",
		turnId,
		parentTurnId: "a1",
		timestamp: AT,
		summary: "earlier work summarized",
		tokensBefore: 30_000,
		firstKeptTurnId: "u2",
		continuity: payload,
	} as SessionEntry;
}

function message(turnId: string, role: "user" | "assistant", parentTurnId: string | null, text: string): SessionEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: AT, role, payload: { text } } as SessionEntry;
}

function operatorRequest(turnId: string, over: Record<string, unknown> = {}): SessionEntry {
	return {
		kind: "custom",
		turnId,
		// §3.1: the envelope parent is the selected message leaf, and the payload
		// repeats it. The resolver requires the two to agree.
		parentTurnId: "u2",
		timestamp: AT,
		customType: HANDOFF_RECOVERY_REQUEST_CUSTOM_TYPE,
		display: false,
		data: {
			version: 1,
			requestKind: "handoff_recovery",
			handoffId: "h1",
			action: "deliver",
			sessionId: SESSION,
			branchAnchorTurnId: "a1",
			selectedLeafTurnId: "u2",
			pausedOrFailedEntryId: "h1-pause",
			...over,
		},
	} as SessionEntry;
}

/** prepared, reducing, the carrying summary, then the commit it names. */
function readyLedger(): SessionEntry[] {
	return [
		message("u1", "user", null, "start"),
		message("a1", "assistant", "u1", "working"),
		tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() }),
		tx("h1-reduce", "h1-prep", 1, 1, { phase: "reducing" }),
		carryingSummary("h1-summary"),
		commitEntry(),
		message("u2", "user", "a1", "next"),
	];
}

describe("format v5 registration", () => {
	it("stamps version 5 and lists both continuity kinds", () => {
		strictEqual(CURRENT_SESSION_FORMAT_VERSION, 5);
		ok(SESSION_ENTRY_KINDS.includes("handoffTransaction"));
		ok(SESSION_ENTRY_KINDS.includes("continuityCommit"));
	});

	it("admits a valid transaction and commit through the shared entry validator", () => {
		ok(isSessionEntry(tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() })));
		ok(isSessionEntry(commitEntry()));
	});

	it("rejects a record that only claims the kind", () => {
		// The point of routing through the continuity validators rather than a
		// kind check: an empty-but-present commit must not become a present commit.
		ok(!isSessionEntry({ kind: "continuityCommit", turnId: "x", parentTurnId: null, timestamp: AT }));
		ok(!isSessionEntry({ kind: "handoffTransaction", turnId: "x", parentTurnId: null, timestamp: AT, schemaVersion: 1 }));
	});

	it("rejects a transaction whose envelope disagrees with its transition", () => {
		const entry = tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() }) as unknown as Record<
			string,
			unknown
		>;
		ok(!isSessionEntry({ ...entry, turnId: "someone-else" }));
	});

	it("rejects a persisted policy that claims a wider budget than the frozen ceiling", () => {
		const wide = { ...policy(), maxAttempts: 3 };
		ok(!isSessionEntry(tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: wide })));
	});

	it("accepts a summary with a valid carry and one without", () => {
		ok(isSessionEntry(carryingSummary("h1-summary")));
		const plain = carryingSummary("plain") as unknown as Record<string, unknown>;
		delete plain.continuity;
		ok(isSessionEntry(plain));
	});

	it("rejects a summary whose carry is malformed rather than ignoring the field", () => {
		const broken = carryingSummary("h1-summary") as unknown as Record<string, unknown>;
		ok(!isSessionEntry({ ...broken, continuity: { schemaVersion: 1 } }));
		const payload = checkpoint();
		ok(
			!isSessionEntry({
				...broken,
				// A `ready` state must be the commit's own link. An invented sequence
				// is what a fabricated carry would look like.
				continuity: { ...payload, state: { ...payload.state, transition: { ...payload.commit.transition, sequence: 9 } } },
			}),
		);
	});
});

describe("operator recovery request carrier", () => {
	it("accepts the reserved subtype only with its complete binding", () => {
		ok(isSessionEntry(operatorRequest("op-1")));
		ok(isHandoffRecoveryRequestEntry(operatorRequest("op-1")));
	});

	it("rejects opaque data under the reserved custom type", () => {
		const entry = operatorRequest("op-1") as unknown as Record<string, unknown>;
		ok(!isSessionEntry({ ...entry, data: { anything: true } }));
		ok(!isSessionEntry({ ...entry, data: undefined }));
	});

	it("rejects a request that omits part of its binding", () => {
		for (const missing of [
			"handoffId",
			"sessionId",
			"pausedOrFailedEntryId",
			"branchAnchorTurnId",
			"selectedLeafTurnId",
		]) {
			const data = (operatorRequest("op-1") as unknown as { data: Record<string, unknown> }).data;
			delete data[missing];
			const entry = operatorRequest("op-1") as unknown as Record<string, unknown>;
			ok(!isSessionEntry({ ...entry, data }), `${missing} must be required`);
		}
	});

	it("rejects an action the protocol does not define", () => {
		ok(!isSessionEntry(operatorRequest("op-1", { action: "summarize" })));
	});

	it("leaves ordinary custom entries alone", () => {
		ok(
			isSessionEntry({ kind: "custom", turnId: "c1", parentTurnId: null, timestamp: AT, customType: "anything", data: 7 }),
		);
	});
});

describe("continuity readers", () => {
	it("never cuts the conversation at a continuity record", () => {
		// The cut index also names `firstKeptTurnId`, which becomes the next
		// summary's structural parent, so it has to stay on a conversation
		// anchor at every budget. A tiny budget drives the cut as late as
		// possible, which is where a bookkeeping record would be picked up.
		const entries = readyLedger();
		for (const keep of [1, 10, 100, 1_000, 10_000]) {
			const at = entries[findCutPoint(entries, keep).firstKeptEntryIndex];
			ok(
				at === undefined || (at.kind !== "handoffTransaction" && at.kind !== "continuityCommit"),
				`keep=${keep} cut on ${at?.kind}`,
			);
		}
	});

	it("never serializes transaction JSON into the summarization prompt", () => {
		const serialized = serializeConversation(readyLedger());
		ok(!serialized.includes("h1-commit-entry"));
		ok(!serialized.includes("handoffTransaction"));
		ok(!serialized.includes(NOTE.note));
		ok(serialized.includes("[User]: start"));
	});

	it("prices continuity bookkeeping at zero", () => {
		strictEqual(estimateTokens(tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() })), 0);
		strictEqual(estimateTokens(commitEntry()), 0);
	});

	it("does not charge a carried payload copy to the summary that carries it", () => {
		const plain = carryingSummary("s1") as unknown as Record<string, unknown>;
		delete plain.continuity;
		strictEqual(estimateTokens(carryingSummary("s1")), estimateTokens(plain as unknown as SessionEntry));
	});

	it("charges the rendered note once, through the caller that resolved it", () => {
		const entries = readyLedger();
		const projection = resolveContinuityProjection({ entries, sessionId: SESSION, nowMs: PREPARED_AT + 1_000 });
		const noteTokens = continuityProjectionTokens(projection);
		ok(noteTokens > 0);
		const without = calculateContextTokens(entries);
		strictEqual(
			calculateContextTokens(entries, undefined, { tokens: noteTokens, anchorTurnId: projection.noteAnchorTurnId }),
			without + noteTokens,
		);
	});

	it("prices one note once across three summary cycles that each carry it", () => {
		const entries = [...readyLedger(), carryingSummary("s2"), carryingSummary("s3")];
		const projection = resolveContinuityProjection({ entries, sessionId: SESSION, nowMs: PREPARED_AT + 1_000 });
		const once = resolveContinuityProjection({ entries: readyLedger(), sessionId: SESSION, nowMs: PREPARED_AT + 1_000 });
		strictEqual(continuityProjectionTokens(projection), continuityProjectionTokens(once));
		strictEqual(continuityReplayBlocks(projection).length, 1);
	});

	it("keeps continuity out of billed usage and charges a carrying summary's own call once", () => {
		const summary = carryingSummary("h1-summary") as unknown as Record<string, unknown>;
		const billed = ledgerUsageCalls(
			[
				tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() }),
				commitEntry(),
				{
					...summary,
					usage: {
						targetId: "t",
						modelId: "m",
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						totalTokens: 15,
						cost: { total: 0.1 },
						apiCalls: 1,
					},
				} as unknown as SessionEntry,
			],
			{},
		);
		strictEqual(billed.length, 1);
		strictEqual(billed[0]?.totalTokens, 15);
	});

	it("round-trips both kinds and a carry through the tolerant archive reader", () => {
		const raw = `${readyLedger()
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		const result = parseSessionEntries(raw, "fixture");
		deepStrictEqual(result.errors, []);
		strictEqual(result.entries.length, readyLedger().length);
		const commit = result.entries.find((entry) => entry.kind === "continuityCommit");
		ok(commit?.kind === "continuityCommit");
		strictEqual(commit.continuity.accepted.note, NOTE.note);
	});

	it("reports a malformed carry as an unreadable entry instead of dropping the field", () => {
		const broken = carryingSummary("h1-summary") as unknown as Record<string, unknown>;
		const raw = `${JSON.stringify({ ...broken, continuity: { schemaVersion: 2 } })}\n`;
		const result = parseSessionEntries(raw, "fixture");
		strictEqual(result.entries.length, 0);
		match(result.errors.join("\n"), /unreadable entry/u);
	});

	it("fails a strict load on an invalid continuity record", () => {
		throws(
			() =>
				collectSessionEntries([{ kind: "continuityCommit", turnId: "x", parentTurnId: null, timestamp: AT }], "fixture"),
			/unreadable entry/u,
		);
	});
});

describe("evidence resolved from a real ledger", () => {
	it("indexes every evidence position into the array it was given", () => {
		const entries = [...readyLedger(), operatorRequest("op-1")];
		const evidence = resolveContinuityEvidence({ entries, unreadableRecords: 0 });
		const rows: Array<[string, number]> = [
			...evidence.resumeAuthorities.map((row): [string, number] => [row.operatorRequestEntryId, row.position]),
			...evidence.terminalResponses.map((row): [string, number] => [row.entryId, row.position]),
			...evidence.outcomeRefs.map((row): [string, number] => [row.entryId, row.position]),
		];
		ok(rows.length > 0);
		for (const [entryId, position] of rows) strictEqual(entries[position]?.turnId, entryId);
	});

	it("builds resume authority only from the typed control record", () => {
		const entries = [
			...readyLedger(),
			// A user turn quoting the same request is not authority.
			message("u9", "user", "u2", JSON.stringify({ requestKind: "handoff_recovery", handoffId: "h1", action: "deliver" })),
			operatorRequest("op-1"),
		];
		const evidence = resolveContinuityEvidence({ entries, unreadableRecords: 0 });
		deepStrictEqual(
			evidence.resumeAuthorities.map((row) => row.operatorRequestEntryId),
			["op-1"],
		);
		strictEqual(evidence.resumeAuthorities[0]?.acceptedAtMs, Date.parse(AT));
	});

	it("binds a summarized outcome through the payload the summary carries", () => {
		const evidence = resolveContinuityEvidence({ entries: readyLedger(), unreadableRecords: 0 });
		const summarized = evidence.outcomeRefs.filter((row) => row.outcome === "summarized");
		strictEqual(summarized.length, 1);
		strictEqual(summarized[0]?.entryId, "h1-summary");
		strictEqual(summarized[0]?.commitId, "h1-commit");
	});

	it("classifies terminal responses and refuses to call an interrupted turn a success", () => {
		const entries = [
			message("u1", "user", null, "start"),
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: AT,
				role: "assistant",
				payload: { content: [{ type: "text", text: "done" }] },
			} as SessionEntry,
			{
				kind: "message",
				turnId: "a2",
				parentTurnId: "u1",
				timestamp: AT,
				role: "assistant",
				payload: { stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
			} as SessionEntry,
			{
				kind: "message",
				turnId: "a3",
				parentTurnId: "u1",
				timestamp: AT,
				role: "assistant",
				payload: { content: [] },
			} as SessionEntry,
			{
				kind: "message",
				turnId: "a4",
				parentTurnId: "u1",
				timestamp: AT,
				role: "assistant",
				payload: { stopReason: "toolUse", content: [{ type: "text", text: "calling" }] },
			} as SessionEntry,
		];
		const evidence = resolveContinuityEvidence({ entries, unreadableRecords: 0 });
		deepStrictEqual(
			evidence.terminalResponses.map((row) => [row.entryId, row.status]),
			[
				["a1", "success"],
				["a2", "aborted"],
				["a3", "empty"],
				["a4", "empty"],
			],
		);
	});

	it("refuses an eviction two different commits both claim", () => {
		const eviction: SessionEntry = {
			kind: "contextEviction",
			turnId: "evict-1",
			parentTurnId: "a1",
			timestamp: AT,
			policyId: "p",
			trigger: "pressure",
			evicted: [],
			tokensBefore: 10,
			tokensAfter: 5,
			pressureBefore: null,
			snapshotIdBefore: null,
		} as SessionEntry;
		const evictedCommit: ContinuityCommitData = {
			outcome: "evicted",
			entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: AT },
			transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce", sequence: 2, attempt: 1 },
			evictionRef: "evict-1",
			tokensBefore: 30_000,
			tokensAfter: 21_000,
		};
		const rival: ContinuityCommitData = {
			...evictedCommit,
			entry: { turnId: "h2-commit-entry", parentTurnId: "a1", timestamp: AT },
			transition: { entryId: "h2-commit-entry", prevEntryId: "h2-reduce", sequence: 2, attempt: 1 },
		};
		const one = commitEntry(checkpoint({ commit: evictedCommit }));
		const two = commitEntry(
			checkpoint({
				commit: rival,
				identity: identity({ handoffId: "h2", commitId: "h2-commit", commitEntryId: "h2-commit-entry" }),
			}),
		);
		const single = resolveContinuityEvidence({ entries: [eviction, one], unreadableRecords: 0 });
		strictEqual(single.outcomeRefs.filter((row) => row.outcome === "evicted").length, 1);
		const disputed = resolveContinuityEvidence({ entries: [eviction, one, two], unreadableRecords: 0 });
		strictEqual(disputed.outcomeRefs.filter((row) => row.outcome === "evicted").length, 0);
	});

	it("refuses an eviction claimed by a commit that precedes it", () => {
		const evictedCommit: ContinuityCommitData = {
			outcome: "evicted",
			entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: AT },
			transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce", sequence: 2, attempt: 1 },
			evictionRef: "evict-1",
			tokensBefore: 30_000,
			tokensAfter: 21_000,
		};
		const eviction: SessionEntry = {
			kind: "contextEviction",
			turnId: "evict-1",
			parentTurnId: "a1",
			timestamp: AT,
			policyId: "p",
			trigger: "pressure",
			evicted: [],
			tokensBefore: 10,
			tokensAfter: 5,
			pressureBefore: null,
			snapshotIdBefore: null,
		} as SessionEntry;
		const evidence = resolveContinuityEvidence({
			entries: [commitEntry(checkpoint({ commit: evictedCommit })), eviction],
			unreadableRecords: 0,
		});
		strictEqual(evidence.outcomeRefs.filter((row) => row.outcome === "evicted").length, 0);
	});
});

describe("projected note", () => {
	it("carries the accepted bytes verbatim and labels their authorship", () => {
		const projection = resolveContinuityProjection({
			entries: readyLedger(),
			sessionId: SESSION,
			nowMs: PREPARED_AT + 1_000,
		});
		strictEqual(projection.note?.note, NOTE.note);
		const blocks = continuityReplayBlocks(projection);
		strictEqual(blocks.length, 1);
		ok(blocks[0]?.includes(NOTE.note));
		match(blocks[0] ?? "", /written by the assistant/u);
		match(blocks[0] ?? "", /not an operator instruction/u);
	});

	it("keeps a note whose bytes would otherwise be trimmed or normalized", () => {
		const exact = admit("  leading and trailing spaces, a ́ combining mark, and a tab\tkept  ");
		const entries = [
			message("u1", "user", null, "start"),
			message("a1", "assistant", "u1", "working"),
			tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: exact, policy: policy() }),
			tx("h1-reduce", "h1-prep", 1, 1, { phase: "reducing" }),
			carryingSummary("h1-summary", checkpoint({ accepted: exact })),
			commitEntry(checkpoint({ accepted: exact })),
		];
		const projection = resolveContinuityProjection({ entries, sessionId: SESSION, nowMs: PREPARED_AT + 1_000 });
		strictEqual(projection.note?.note, exact.note);
		ok(continuityReplayBlocks(projection)[0]?.includes(exact.note));
	});

	it("reports nothing for a ledger with no continuity records", () => {
		const projection = resolveContinuityProjection({ entries: [message("u1", "user", null, "hi")], sessionId: SESSION });
		strictEqual(projection.note, null);
		deepStrictEqual(projection.inherited, []);
		strictEqual(projection.current, null);
		strictEqual(continuityProjectionTokens(projection), 0);
	});

	it("does not project a foreign origin in a session that never forked", () => {
		const entries = readyLedger();
		const projection = resolveContinuityProjection({
			entries,
			sessionId: "some-other-session",
			nowMs: PREPARED_AT + 1_000,
		});
		deepStrictEqual(projection.inherited, []);
		strictEqual(projection.note, null);
		ok(projection.authoritySuppressed);
		match(projection.anomalies.map((a) => a.detail).join("\n"), /publishes no fork binding/u);
	});
});
