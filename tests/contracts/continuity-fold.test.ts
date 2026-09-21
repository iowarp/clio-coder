import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { continuityPayloadFromFold, missingCommitFromCarry } from "../../src/domains/session/continuity/carry.js";
import {
	type AcceptedNote,
	type ContinuityAnomalyKind,
	type ContinuityCarriedState,
	type ContinuityCheckpointPayload,
	type ContinuityCommitData,
	type ContinuityFoldInput,
	type ContinuityFoldResult,
	HANDOFF_MAX_WINDOW_MS,
	type HandoffEvent,
	type HandoffIdentity,
	type HandoffPolicy,
	type OperatorResumeAuthorityEvidence,
	type TerminalResponseEvidence,
} from "../../src/domains/session/continuity/contract.js";
import { foldContinuity } from "../../src/domains/session/continuity/fold.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";

const SESSION = "s-1";
const PATH = ["u1", "a1", "u2", "a2", "u3"];
const PREPARED_AT = 1_000_000;
const NOW = PREPARED_AT + 10_000;

function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`fixture note rejected: ${result.reason}`);
	return result.accepted;
}

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

function policy(over: Partial<HandoffPolicy> = {}): HandoffPolicy {
	return {
		preparedAtMs: PREPARED_AT,
		automaticDeadlineAtMs: PREPARED_AT + 600_000,
		maxAttempts: 2,
		maxSummaryCallsPerAttempt: 2,
		additionalSummaryRetriesPerCall: 0,
		maxSummaryStreamInvocations: 4,
		flushRetryLimit: 3,
		...over,
	};
}

const NOTE = admit("continue the ADR rewrite from section 4");

function tx(
	entryId: string,
	prevEntryId: string | null,
	sequence: number,
	attempt: number,
	event: HandoffEvent,
	over: { identity?: HandoffIdentity } = {},
) {
	return {
		kind: "handoffTransaction",
		turnId: entryId,
		parentTurnId: "u1",
		timestamp: "2026-09-21T09:00:00.000Z",
		schemaVersion: 1,
		identity: over.identity ?? identity(),
		transition: { entryId, prevEntryId, sequence, attempt },
		event,
	};
}

const SUMMARIZED_COMMIT: ContinuityCommitData = {
	outcome: "summarized",
	entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: "2026-09-21T09:05:00.000Z" },
	transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce", sequence: 2, attempt: 1 },
	summaryRef: "h1-summary",
	tokensBefore: 30_000,
	tokensAfter: 9_000,
};

const EVICTED_COMMIT: ContinuityCommitData = {
	outcome: "evicted",
	entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: "2026-09-21T09:05:00.000Z" },
	transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce", sequence: 2, attempt: 1 },
	evictionRef: "h1-evict",
	tokensBefore: 30_000,
	tokensAfter: 21_000,
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

function commitEntry(payload = checkpoint()) {
	return {
		kind: "continuityCommit",
		turnId: payload.commit.entry.turnId,
		parentTurnId: payload.commit.entry.parentTurnId,
		timestamp: payload.commit.entry.timestamp,
		continuity: payload,
	};
}

function summaryWithCarry(turnId: string, payload: ContinuityCheckpointPayload) {
	return {
		kind: "compactionSummary",
		turnId,
		parentTurnId: "u1",
		timestamp: "2026-09-21T09:06:00.000Z",
		summary: "earlier turns condensed",
		tokensBefore: 30_000,
		firstKeptTurnId: "u1",
		continuity: payload,
	};
}

function ordinarySummary(turnId: string) {
	return {
		kind: "compactionSummary",
		turnId,
		parentTurnId: "u1",
		timestamp: "2026-09-21T09:20:00.000Z",
		summary: "a later ordinary compaction",
		tokensBefore: 12_000,
		firstKeptTurnId: "u2",
	};
}

function message(turnId: string) {
	return {
		kind: "message",
		turnId,
		parentTurnId: null,
		timestamp: "2026-09-21T08:00:00.000Z",
		role: "user",
		payload: {},
	};
}

const SUMMARY_REF = {
	entryId: "h1-summary",
	outcome: "summarized" as const,
	handoffId: "h1",
	commitId: "h1-commit",
	position: 0,
};

function terminal(over: Partial<TerminalResponseEvidence> = {}): TerminalResponseEvidence {
	return { entryId: "a2", continuationTurnId: "u2", status: "success", position: 9, ...over };
}

function fold(entries: ReadonlyArray<unknown>, over: Partial<ContinuityFoldInput> = {}): ContinuityFoldResult {
	return foldContinuity({
		entries,
		selection: { sessionId: SESSION, pathTurnIds: PATH, historical: false },
		evidence: { resumeAuthorities: [], terminalResponses: [], outcomeRefs: [SUMMARY_REF], unreadableRecords: 0 },
		nowMs: NOW,
		...over,
	});
}

function evidence(over: Partial<ContinuityFoldInput["evidence"]> = {}): ContinuityFoldInput["evidence"] {
	return { resumeAuthorities: [], terminalResponses: [], outcomeRefs: [SUMMARY_REF], unreadableRecords: 0, ...over };
}

function hasAnomaly(result: ContinuityFoldResult, kind: ContinuityAnomalyKind): boolean {
	return result.anomalies.some((anomaly) => anomaly.kind === kind);
}

const PREPARED = tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() });
const REDUCING = tx("h1-reduce", "h1-prep", 1, 1, { phase: "reducing" });

/** prepared -> reducing -> ready, the ordinary successful reduction. */
function throughReady() {
	return [PREPARED, REDUCING, commitEntry()];
}

const DELIVERED = tx("h1-deliver", "h1-commit-entry", 3, 1, {
	phase: "delivered",
	deliveryId: "d1",
	continuationTurnId: "u2",
});
const ACKNOWLEDGED = tx("h1-ack", "h1-deliver", 4, 1, {
	phase: "acknowledged",
	deliveryId: "d1",
	terminalResponseEntryId: "a2",
});

/**
 * The full happy path, with the assistant response physically between the
 * delivery intent it answers and the acknowledgement that cites it.
 */
function throughAcknowledged() {
	return [...throughReady(), DELIVERED, message("a2"), ACKNOWLEDGED];
}

/** The terminal response at its position in `throughAcknowledged()`. */
const ACK_TERMINAL = terminal({ position: 4 });

describe("continuity fold: legal chain", () => {
	it("folds prepared through acknowledged with matching terminal evidence", () => {
		const result = fold(throughAcknowledged(), { evidence: evidence({ terminalResponses: [ACK_TERMINAL] }) });
		strictEqual(result.phase, "acknowledged");
		strictEqual(result.attemptsSpent, 1);
		strictEqual(result.commit?.outcome, "summarized");
		strictEqual(result.accepted?.note, NOTE.note);
		deepStrictEqual(result.anomalies, []);
		strictEqual(result.validated, true);
		deepStrictEqual(result.action, { kind: "none" }, "acknowledged is terminal");
		strictEqual(result.authority, "recall_only", "a terminal transaction owns no further execution");
		strictEqual(result.state?.delivery?.deliveryId, "d1", "the delivery intent survives acknowledgement");
	});

	it("treats an identical duplicate as idempotent and a contradictory one as a conflict", () => {
		const idempotent = fold([PREPARED, REDUCING, { ...REDUCING }]);
		strictEqual(idempotent.phase, "reducing");
		strictEqual(idempotent.attemptsSpent, 1, "a repeated record is never an extra attempt");
		deepStrictEqual(idempotent.anomalies, []);

		const conflicting = fold([
			PREPARED,
			REDUCING,
			tx("h1-reduce", "h1-prep", 1, 1, { phase: "paused", reason: "operator_cancelled" }),
		]);
		ok(hasAnomaly(conflicting, "duplicate_conflict"));
		strictEqual(conflicting.validated, false);
		deepStrictEqual(conflicting.action, { kind: "recall_only", reason: "conflicting_evidence" });
	});
});

describe("continuity fold: chain extension is validated, never inferred from a sequence", () => {
	it("refuses a commit that is not a validated successor of reducing", () => {
		// The review's fixture: prepared, then a structurally valid
		// continuity-only commit at sequence 50.
		const leapfrog = commitEntry(
			checkpoint({
				commit: {
					outcome: "continuity_only",
					entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: "2026-09-21T09:05:00.000Z" },
					transition: { entryId: "h1-commit-entry", prevEntryId: "h1-prep", sequence: 50, attempt: 0 },
					tokensBefore: 30_000,
					tokensAfter: 30_000,
				},
			}),
		);
		const result = fold([PREPARED, leapfrog]);
		strictEqual(result.phase, "prepared", "a high sequence is not proof of a valid chain");
		// A commit with no spent attempt does not describe a reduction at all.
		ok(hasAnomaly(result, "malformed_continuity_record"));
		strictEqual(result.authority, "recall_only");

		// With a spent attempt it validates structurally and is still refused,
		// because sequence 50 does not follow the head.
		const spent = commitEntry(
			checkpoint({
				commit: {
					outcome: "continuity_only",
					entry: { turnId: "h1-commit-entry", parentTurnId: "a1", timestamp: "2026-09-21T09:05:00.000Z" },
					transition: { entryId: "h1-commit-entry", prevEntryId: "h1-prep", sequence: 50, attempt: 1 },
					tokensBefore: 30_000,
					tokensAfter: 30_000,
				},
			}),
		);
		const linked = fold([PREPARED, spent], { evidence: evidence({ outcomeRefs: [] }) });
		strictEqual(linked.phase, "prepared");
		ok(hasAnomaly(linked, "illegal_transition"));
	});

	it("refuses a commit whose predecessor or attempt does not follow the head", () => {
		const wrongPredecessor = commitEntry(
			checkpoint({
				commit: { ...SUMMARIZED_COMMIT, transition: { ...SUMMARIZED_COMMIT.transition, prevEntryId: "elsewhere" } },
			}),
		);
		ok(hasAnomaly(fold([PREPARED, REDUCING, wrongPredecessor]), "broken_chain"));

		const wrongAttempt = commitEntry(
			checkpoint({ commit: { ...SUMMARIZED_COMMIT, transition: { ...SUMMARIZED_COMMIT.transition, attempt: 2 } } }),
		);
		ok(hasAnomaly(fold([PREPARED, REDUCING, wrongAttempt]), "invalid_attempt"));

		// Beyond the policy cap it is not even a readable record.
		const overCap = commitEntry(
			checkpoint({ commit: { ...SUMMARIZED_COMMIT, transition: { ...SUMMARIZED_COMMIT.transition, attempt: 7 } } }),
		);
		ok(hasAnomaly(fold([PREPARED, REDUCING, overCap]), "malformed_continuity_record"));
	});

	it("refuses a third reduction attempt and a retry after a non-provider failure", () => {
		const thirdAttempt = [
			PREPARED,
			REDUCING,
			tx("h1-fail", "h1-reduce", 2, 1, { phase: "failed", reason: "provider_failed" }),
			tx("h1-reduce2", "h1-fail", 3, 2, { phase: "reducing" }),
			tx("h1-fail2", "h1-reduce2", 4, 2, { phase: "failed", reason: "provider_failed" }),
			tx("h1-reduce3", "h1-fail2", 5, 3, { phase: "reducing" }),
		];
		ok(hasAnomaly(fold(thirdAttempt), "invalid_attempt"), "attempt 3 exceeds the policy maximum");

		const wrongFailure = [
			PREPARED,
			REDUCING,
			tx("h1-fail", "h1-reduce", 2, 1, { phase: "failed", reason: "budget_unsafe_no_material" }),
			tx("h1-reduce2", "h1-fail", 3, 2, { phase: "reducing" }),
		];
		ok(hasAnomaly(fold(wrongFailure), "illegal_transition"), "only provider_failed reopens reduction");
	});

	it("refuses a carry that fabricates an extension past what was observed", () => {
		const acknowledged = throughAcknowledged();
		// `ready` is definitionally the commit's own link, so a carry claiming it
		// at an invented sequence does not even validate structurally.
		const inventedReady = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				state: {
					transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce", sequence: 50, attempt: 1 },
					event: { phase: "ready" },
					activeResume: null,
					delivery: null,
				},
			}),
		);
		const structural = fold([...acknowledged, inventedReady], {
			evidence: evidence({ terminalResponses: [terminal()] }),
		});
		strictEqual(structural.phase, "acknowledged", "a terminal transaction cannot be reopened by a carry");
		ok(hasAnomaly(structural, "malformed_continuity_record"));
		strictEqual(structural.authority, "recall_only");

		// A structurally valid carry that still walks past a terminal head.
		const reopening = summaryWithCarry(
			"h1-summary-3",
			checkpoint({
				state: {
					transition: { entryId: "h1-deliver-2", prevEntryId: "h1-commit-entry", sequence: 50, attempt: 1 },
					event: { phase: "delivered", deliveryId: "d9", continuationTurnId: "u3" },
					activeResume: null,
					delivery: { deliveryId: "d9", continuationTurnId: "u3" },
				},
			}),
		);
		const result = fold([...acknowledged, reopening], { evidence: evidence({ terminalResponses: [ACK_TERMINAL] }) });
		strictEqual(result.phase, "acknowledged");
		ok(hasAnomaly(result, "fabricated_carry_extension"));
		strictEqual(result.authority, "recall_only");
	});

	it("holds a one-step carried successor to the real successor rules", () => {
		// Observed ready commit at sequence 2; a carried delivered at sequence 3
		// whose predecessor contradicts it.
		const contradictoryLink = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				state: {
					transition: { entryId: "h1-deliver", prevEntryId: "unrelated", sequence: 3, attempt: 1 },
					event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" },
					activeResume: null,
					delivery: { deliveryId: "d1", continuationTurnId: "u2" },
				},
			}),
		);
		const linked = fold([...throughReady(), contradictoryLink]);
		ok(hasAnomaly(linked, "broken_chain"), "one step is one step, whether a record or a carry describes it");
		strictEqual(linked.phase, "ready");

		// The same step with the right predecessor is accepted.
		const correctLink = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				state: {
					transition: { entryId: "h1-deliver", prevEntryId: "h1-commit-entry", sequence: 3, attempt: 1 },
					event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" },
					activeResume: null,
					delivery: { deliveryId: "d1", continuationTurnId: "u2" },
				},
			}),
		);
		const accepted = fold([...throughReady(), correctLink]);
		deepStrictEqual(accepted.anomalies, []);
		strictEqual(accepted.phase, "delivered");

		// A carried adjacent step cannot spend an attempt without reducing.
		const extraAttempt = summaryWithCarry(
			"h1-summary-3",
			checkpoint({
				state: {
					transition: { entryId: "h1-pause", prevEntryId: "h1-commit-entry", sequence: 3, attempt: 2 },
					event: { phase: "paused", reason: "operator_cancelled" },
					activeResume: null,
					delivery: null,
				},
			}),
		);
		ok(hasAnomaly(fold([...throughReady(), extraAttempt]), "invalid_attempt"));
	});

	it("compares every retained field of a carry against the observed head", () => {
		const observed = [
			...throughReady(),
			tx("h1-pause", "h1-commit-entry", 3, 1, { phase: "paused", reason: "operator_cancelled" }),
		];
		const base = {
			transition: { entryId: "h1-pause", prevEntryId: "h1-commit-entry", sequence: 3, attempt: 1 },
			event: { phase: "paused" as const, reason: "operator_cancelled" as const },
		};
		const invented: ContinuityCarriedState[] = [
			// A delivery the observed head never recorded.
			{ ...base, activeResume: null, delivery: { deliveryId: "d1", continuationTurnId: "u2" } },
			// An invented resume under an otherwise identical head.
			{
				...base,
				delivery: null,
				activeResume: {
					entryId: "h1-resume",
					authority: {
						operatorRequestEntryId: "op-1",
						pausedOrFailedEntryId: "h1-pause",
						action: "deliver",
						automaticDeadlineAtMs: NOW + 60_000,
					},
				},
			},
		];
		for (const state of invented) {
			const result = fold([...observed, summaryWithCarry("h1-summary-2", checkpoint({ state }))]);
			ok(hasAnomaly(result, "conflicting_carry"), `equal sequence with ${JSON.stringify(state.delivery)} must conflict`);
			strictEqual(result.validated, false);
		}

		// The identical state at the same sequence is an idempotent repeat.
		const same = fold([
			...observed,
			summaryWithCarry("h1-summary-2", checkpoint({ state: { ...base, activeResume: null, delivery: null } })),
		]);
		deepStrictEqual(same.anomalies, []);
		strictEqual(same.phase, "paused");
	});

	it("refuses a carry that refunds a spent attempt", () => {
		// Below its own commit's attempt, the payload does not even validate.
		const belowCommit = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				state: {
					transition: { entryId: "h1-deliver", prevEntryId: "h1-commit-entry", sequence: 3, attempt: 0 },
					event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" },
					activeResume: null,
					delivery: { deliveryId: "d1", continuationTurnId: "u2" },
				},
			}),
		);
		const structural = fold([...throughReady(), belowCommit]);
		ok(hasAnomaly(structural, "malformed_continuity_record"));
		strictEqual(structural.phase, "ready", "the observed head is untouched");

		// Valid against its own commit, but below the attempt the chain journaled.
		const secondAttempt = [
			PREPARED,
			REDUCING,
			tx("h1-fail", "h1-reduce", 2, 1, { phase: "failed", reason: "provider_failed" }),
			tx("h1-reduce2", "h1-fail", 3, 2, { phase: "reducing" }),
		];
		const refunding = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				state: {
					transition: { entryId: "h1-deliver", prevEntryId: "h1-commit-entry", sequence: 9, attempt: 1 },
					event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" },
					activeResume: null,
					delivery: { deliveryId: "d1", continuationTurnId: "u2" },
				},
			}),
		);
		const result = fold([...secondAttempt, refunding], { evidence: evidence({ outcomeRefs: [] }) });
		ok(hasAnomaly(result, "invalid_attempt"), "a carry cannot lower the journaled attempt count");
		strictEqual(result.validated, false);
	});

	it("refuses a carry whose link differs from the observed head at the same sequence", () => {
		const observed = [
			PREPARED,
			REDUCING,
			commitEntry(),
			tx("h1-pause", "h1-commit-entry", 3, 1, { phase: "paused", reason: "operator_cancelled" }),
		];
		const sameEventOtherLink = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				state: {
					transition: { entryId: "h1-other-pause", prevEntryId: "h1-commit-entry", sequence: 3, attempt: 1 },
					event: { phase: "paused", reason: "operator_cancelled" },
					activeResume: null,
					delivery: null,
				},
			}),
		);
		const result = fold([...observed, sameEventOtherLink]);
		ok(hasAnomaly(result, "conflicting_carry"), "a matching event under a different link is a contradiction");
		strictEqual(result.validated, false);
	});

	it("refuses two carries that disagree at the same sequence, and a mutated policy", () => {
		const paused: ContinuityCarriedState = {
			transition: { entryId: "h1-pause", prevEntryId: "h1-deliver", sequence: 4, attempt: 1 },
			event: { phase: "paused", reason: "delivery_uncertain" },
			activeResume: null,
			delivery: { deliveryId: "d1", continuationTurnId: "u2" },
		};
		const acknowledged: ContinuityCarriedState = {
			transition: { entryId: "h1-ack", prevEntryId: "h1-deliver", sequence: 4, attempt: 1 },
			event: { phase: "acknowledged", deliveryId: "d1", terminalResponseEntryId: "a2" },
			activeResume: null,
			delivery: { deliveryId: "d1", continuationTurnId: "u2" },
		};
		const conflicting = fold([
			summaryWithCarry("h1-summary-a", checkpoint({ state: paused })),
			summaryWithCarry("h1-summary-b", checkpoint({ state: acknowledged })),
		]);
		ok(hasAnomaly(conflicting, "conflicting_carry"), "equal sequence with a different state is a conflict");
		strictEqual(conflicting.validated, false);

		const mutatedPolicy = fold([
			commitEntry(),
			summaryWithCarry(
				"h1-summary-2",
				checkpoint({ policy: policy({ maxAttempts: 2, automaticDeadlineAtMs: PREPARED_AT + 800_000 }) }),
			),
		]);
		ok(hasAnomaly(mutatedPolicy, "policy_conflict"), "a carry may not rewrite the original policy");
	});

	it("refuses a carried resume whose referenced records are not in the input", () => {
		const authority = {
			operatorRequestEntryId: "op-1",
			pausedOrFailedEntryId: "h1-pause",
			action: "deliver" as const,
			automaticDeadlineAtMs: NOW + 120_000,
		};
		// prepared(0) reducing(1) commit(2) paused(3) resumed(4) summary(5). The
		// summary carries a later delivered head that retains that resume.
		const base = [
			PREPARED,
			REDUCING,
			commitEntry(),
			tx("h1-pause", "h1-commit-entry", 3, 1, { phase: "paused", reason: "operator_cancelled" }),
			tx("h1-resume", "h1-pause", 4, 1, { phase: "resumed", authority }),
		];
		const carriedDelivery = checkpoint({
			state: {
				transition: { entryId: "h1-deliver", prevEntryId: "h1-resume", sequence: 5, attempt: 1 },
				event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2", resumeRef: "h1-resume" },
				activeResume: { entryId: "h1-resume", authority },
				delivery: { deliveryId: "d1", continuationTurnId: "u2" },
			},
		});
		const ledger = [...base, summaryWithCarry("h1-summary-2", carriedDelivery)];
		const bound: OperatorResumeAuthorityEvidence = {
			operatorRequestEntryId: "op-1",
			handoffId: "h1",
			action: "deliver",
			pausedOrFailedEntryId: "h1-pause",
			originSessionId: SESSION,
			position: 3.5,
			acceptedAtMs: NOW - 1_000,
		};

		const authorized = fold(ledger, { evidence: evidence({ resumeAuthorities: [bound] }) });
		deepStrictEqual(authorized.anomalies, []);
		strictEqual(authorized.phase, "delivered");
		strictEqual(authorized.state?.activeResume?.entryId, "h1-resume");

		const refused: Array<[string, unknown[], Partial<ContinuityFoldInput>]> = [
			[
				"the resume record is not in the input at all",
				[
					...base.slice(0, 4),
					summaryWithCarry(
						"h1-summary-2",
						checkpoint({
							state: {
								transition: { entryId: "h1-resume", prevEntryId: "h1-pause", sequence: 4, attempt: 1 },
								event: { phase: "resumed", authority },
								activeResume: { entryId: "h1-resume", authority },
								delivery: null,
							},
						}),
					),
				],
				{ evidence: evidence({ resumeAuthorities: [bound] }) },
			],
			["no request at all", ledger, { evidence: evidence() }],
			[
				"a request recorded before the pause it answers",
				ledger,
				{ evidence: evidence({ resumeAuthorities: [{ ...bound, position: 2 }] }) },
			],
			[
				"a request recorded after the resume it claims to authorize",
				ledger,
				{ evidence: evidence({ resumeAuthorities: [{ ...bound, position: 4.5 }] }) },
			],
			[
				"a request for the other action",
				ledger,
				{ evidence: evidence({ resumeAuthorities: [{ ...bound, action: "reduce" }] }) },
			],
		];
		for (const [label, entries, over] of refused) {
			const result = fold(entries, over);
			ok(
				hasAnomaly(result, "unvalidated_resume_authority") || hasAnomaly(result, "broken_chain"),
				`${label}: ${JSON.stringify(result.anomalies)}`,
			);
			strictEqual(result.authority, "recall_only", label);
			ok(result.accepted, `${label}: the note stays recallable`);
		}
	});

	it("keeps a carry-only resume recall-only rather than borrowing the summary's position", () => {
		const authority = {
			operatorRequestEntryId: "op-1",
			pausedOrFailedEntryId: "h1-pause",
			action: "deliver" as const,
			automaticDeadlineAtMs: NOW + 120_000,
		};
		const carried = checkpoint({
			state: {
				transition: { entryId: "h1-resume", prevEntryId: "h1-pause", sequence: 4, attempt: 1 },
				event: { phase: "resumed", authority },
				activeResume: { entryId: "h1-resume", authority },
				delivery: null,
			},
		});
		// Nothing but the summary. A request recorded before this summary is not
		// thereby before the resume the summary describes.
		const result = fold([summaryWithCarry("h1-summary", carried)], {
			evidence: evidence({
				resumeAuthorities: [
					{
						operatorRequestEntryId: "op-1",
						handoffId: "h1",
						action: "deliver",
						pausedOrFailedEntryId: "h1-pause",
						originSessionId: SESSION,
						position: -1,
						acceptedAtMs: NOW - 1_000,
					},
				],
			}),
		});
		ok(hasAnomaly(result, "unvalidated_resume_authority"), "a missing reference is not a waived check");
		strictEqual(result.authority, "recall_only");
		strictEqual(missingCommitFromCarry(result), null, "reconstruction cannot launder the missing proof");
		strictEqual(continuityPayloadFromFold(result), null);
		ok(result.accepted, "the note itself stays recallable");
	});

	it("refuses a carried resumed head that asks to reduce once a commit exists", () => {
		const reduceAuthority = {
			operatorRequestEntryId: "op-1",
			pausedOrFailedEntryId: "h1-pause",
			action: "reduce" as const,
			automaticDeadlineAtMs: NOW + 120_000,
		};
		const carried = checkpoint({
			state: {
				transition: { entryId: "h1-resume", prevEntryId: "h1-pause", sequence: 4, attempt: 1 },
				event: { phase: "resumed", authority: reduceAuthority },
				activeResume: { entryId: "h1-resume", authority: reduceAuthority },
				delivery: null,
			},
		});
		// prepared(0) reducing(1) commit(2) paused(3) summary(4). Every string
		// matches, the request is correctly ordered, and only the phase/commit
		// combination is illegal.
		const ledger = [
			PREPARED,
			REDUCING,
			commitEntry(),
			tx("h1-pause", "h1-commit-entry", 3, 1, { phase: "paused", reason: "operator_cancelled" }),
			summaryWithCarry("h1-summary-2", carried),
		];
		const result = fold(ledger, {
			evidence: evidence({
				resumeAuthorities: [
					{
						operatorRequestEntryId: "op-1",
						handoffId: "h1",
						action: "reduce",
						pausedOrFailedEntryId: "h1-pause",
						originSessionId: SESSION,
						position: 3.5,
						acceptedAtMs: NOW - 1_000,
					},
				],
			}),
		});
		ok(hasAnomaly(result, "unvalidated_resume_authority"), "no reduction is legal once a commit exists");
		strictEqual(result.authority, "recall_only");
	});

	it("keeps a historical reduce resume retained under a later committed head", () => {
		// The reduce resume legitimately happened before the commit; a later
		// delivered head merely retains it. That is not a live reduce request.
		const historical = {
			operatorRequestEntryId: "op-1",
			pausedOrFailedEntryId: "h1-fail",
			action: "reduce" as const,
			automaticDeadlineAtMs: NOW + 120_000,
		};
		const committedAtTwo: ContinuityCommitData = {
			...SUMMARIZED_COMMIT,
			transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce2", sequence: 5, attempt: 2 },
		};
		// prepared(0) reducing(1) failed(2) resumed(3) reducing2(4) commit(5) summary(6)
		const ledger = [
			PREPARED,
			REDUCING,
			tx("h1-fail", "h1-reduce", 2, 1, { phase: "failed", reason: "provider_failed" }),
			tx("h1-resume", "h1-fail", 3, 1, { phase: "resumed", authority: historical }),
			tx("h1-reduce2", "h1-resume", 4, 2, { phase: "reducing", resumeRef: "h1-resume" }),
			commitEntry(checkpoint({ commit: committedAtTwo })),
			summaryWithCarry(
				"h1-summary-2",
				checkpoint({
					commit: committedAtTwo,
					state: {
						transition: { entryId: "h1-deliver", prevEntryId: "h1-commit-entry", sequence: 6, attempt: 2 },
						event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" },
						activeResume: { entryId: "h1-resume", authority: historical },
						delivery: { deliveryId: "d1", continuationTurnId: "u2" },
					},
				}),
			),
		];
		const result = fold(ledger, {
			evidence: evidence({
				resumeAuthorities: [
					{
						operatorRequestEntryId: "op-1",
						handoffId: "h1",
						action: "reduce",
						pausedOrFailedEntryId: "h1-fail",
						originSessionId: SESSION,
						position: 2.5,
						acceptedAtMs: NOW - 5_000,
					},
				],
			}),
		});
		deepStrictEqual(result.anomalies, [], "a retained historical resume is not a live request");
		strictEqual(result.phase, "delivered");
		strictEqual(result.state?.activeResume?.authority.action, "reduce");
		strictEqual(result.attemptsSpent, 2);
	});

	it("allows an explicitly requested delivery after the final reduction attempt", () => {
		const authority = {
			operatorRequestEntryId: "op-1",
			pausedOrFailedEntryId: "h1-pause",
			action: "deliver" as const,
			automaticDeadlineAtMs: NOW + 120_000,
		};
		// First reduction fails, the second commits, then a pause before delivery.
		const ledger = [
			PREPARED,
			REDUCING,
			tx("h1-fail", "h1-reduce", 2, 1, { phase: "failed", reason: "provider_failed" }),
			tx("h1-reduce2", "h1-fail", 3, 2, { phase: "reducing" }),
			commitEntry(
				checkpoint({
					commit: {
						...SUMMARIZED_COMMIT,
						transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce2", sequence: 4, attempt: 2 },
					},
				}),
			),
			tx("h1-pause", "h1-commit-entry", 5, 2, { phase: "paused", reason: "operator_cancelled" }),
			tx("h1-resume", "h1-pause", 6, 2, { phase: "resumed", authority }),
		];
		const request: OperatorResumeAuthorityEvidence = {
			operatorRequestEntryId: "op-1",
			handoffId: "h1",
			action: "deliver",
			pausedOrFailedEntryId: "h1-pause",
			originSessionId: SESSION,
			position: 5.5,
			acceptedAtMs: NOW - 1_000,
		};
		const result = fold(ledger, { evidence: evidence({ resumeAuthorities: [request] }) });
		strictEqual(result.attemptsSpent, 2, "both attempts stay spent");
		deepStrictEqual(result.anomalies, []);
		deepStrictEqual(result.action, { kind: "none" }, "delivering an existing commit is not a third reduction");
		strictEqual(result.authority, "execution");

		// The same ledger asking to reduce again is refused outright, because a
		// commit already exists.
		const reduceAgain = fold(
			[
				...ledger.slice(0, 6),
				tx("h1-resume", "h1-pause", 6, 2, { phase: "resumed", authority: { ...authority, action: "reduce" } }),
			],
			{ evidence: evidence({ resumeAuthorities: [{ ...request, action: "reduce" }] }) },
		);
		ok(hasAnomaly(reduceAgain, "illegal_transition"), "no reduction is legal once a commit exists");
		strictEqual(reduceAgain.authority, "recall_only");
	});

	it("fails closed on unreadable evidence even when the commit is present", () => {
		const withCommit = fold(throughReady(), { evidence: evidence({ unreadableRecords: 1 }) });
		ok(hasAnomaly(withCommit, "malformed_record"), "an unparsed line can hide a pause or a conflicting duplicate");
		strictEqual(withCommit.validated, false);
		strictEqual(withCommit.authority, "recall_only");
		strictEqual(continuityPayloadFromFold(withCommit), null, "nothing authoritative is published from unresolved input");
		ok(withCommit.accepted, "the note is still recallable");

		const carried = checkpoint({
			state: {
				transition: { entryId: "h1-pause", prevEntryId: "h1-commit-entry", sequence: 3, attempt: 1 },
				event: { phase: "paused", reason: "delivery_uncertain" },
				activeResume: null,
				delivery: { deliveryId: "d1", continuationTurnId: "u2" },
			},
		});
		const withCarry = fold([...throughReady(), summaryWithCarry("h1-summary-2", carried)], {
			evidence: evidence({ unreadableRecords: 1 }),
		});
		strictEqual(withCarry.validated, false);
		strictEqual(missingCommitFromCarry(withCarry), null);
		strictEqual(continuityPayloadFromFold(withCarry), null);
	});

	it("verifies the note on a first carry, not only on a second copy", () => {
		const corrupted: AcceptedNote = { ...NOTE, noteSha256: "0".repeat(64) };
		const result = fold([summaryWithCarry("h1-summary", checkpoint({ accepted: corrupted }))]);
		ok(hasAnomaly(result, "unverified_note"), "a carry-only note with a wrong hash is not authority");
		strictEqual(result.validated, false);
		strictEqual(missingCommitFromCarry(result), null, "a poisoned chain publishes no reconstruction");
		strictEqual(continuityPayloadFromFold(result), null, "and no new carry");
	});

	it("accounts for a malformed record that claims a continuity kind", () => {
		const result = fold([
			PREPARED,
			{ kind: "continuityCommit", turnId: "h1-commit-entry", parentTurnId: null, timestamp: "t" },
		]);
		ok(hasAnomaly(result, "malformed_continuity_record"), "a broken continuity record is not silently missing evidence");
		strictEqual(result.validated, false);
	});
});

describe("continuity fold: rejected chains", () => {
	it("rejects a stale predecessor, a wrong sequence and a wrong attempt", () => {
		const cases: Array<[string, unknown[], ContinuityAnomalyKind]> = [
			["stale predecessor", [PREPARED, tx("h1-reduce", "h1-nope", 1, 1, { phase: "reducing" })], "broken_chain"],
			["sequence skip", [PREPARED, tx("h1-reduce", "h1-prep", 3, 1, { phase: "reducing" })], "broken_chain"],
			["attempt not spent", [PREPARED, tx("h1-reduce", "h1-prep", 1, 0, { phase: "reducing" })], "invalid_attempt"],
			[
				"attempt spent by a pause",
				[PREPARED, tx("h1-pause", "h1-prep", 1, 1, { phase: "paused", reason: "operator_cancelled" })],
				"invalid_attempt",
			],
		];
		for (const [label, entries, kind] of cases) {
			const result = fold(entries);
			ok(hasAnomaly(result, kind), label);
			strictEqual(result.authority, "recall_only", label);
		}
	});

	it("rejects illegal phase transitions", () => {
		const illegal: Array<[string, unknown[]]> = [
			[
				"acknowledged without a delivery",
				[
					...throughReady(),
					tx("h1-ack", "h1-commit-entry", 3, 1, { phase: "acknowledged", deliveryId: "d1", terminalResponseEntryId: "a2" }),
				],
			],
			[
				"delivered straight from prepared",
				[PREPARED, tx("h1-deliver", "h1-prep", 1, 0, { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" })],
			],
			[
				"failed after ready",
				[...throughReady(), tx("h1-fail", "h1-commit-entry", 3, 1, { phase: "failed", reason: "provider_failed" })],
			],
		];
		for (const [label, entries] of illegal) {
			ok(hasAnomaly(fold(entries), "illegal_transition"), label);
		}
	});

	it("refuses an acknowledgement without a matching terminal success", () => {
		const entries = throughAcknowledged();
		const refused: Array<[string, TerminalResponseEvidence[]]> = [
			["missing", []],
			["empty", [terminal({ status: "empty", position: 4 })]],
			["error", [terminal({ status: "error", position: 4 })]],
			["aborted", [terminal({ status: "aborted", position: 4 })]],
			["interrupted", [terminal({ status: "interrupted", position: 4 })]],
			["another turn", [terminal({ continuationTurnId: "u3", position: 4 })]],
			["another entry", [terminal({ entryId: "a9", position: 4 })]],
			// Recorded after the acknowledgement that cites it.
			["recorded after the acknowledgement", [terminal({ position: 6 })]],
			// An older success, before the delivery intent it claims to answer.
			["recorded before the delivery", [terminal({ position: 2 })]],
		];
		for (const [label, terminalResponses] of refused) {
			const result = fold(entries, { evidence: evidence({ terminalResponses }) });
			ok(hasAnomaly(result, "acknowledgement_unsupported"), label);
			strictEqual(result.authority, "recall_only", label);
		}
	});

	it("requires an outcome reference bound to this commit, not merely present", () => {
		deepStrictEqual(fold(throughReady()).anomalies, []);

		const unbound: Array<[string, ContinuityFoldInput["evidence"]["outcomeRefs"]]> = [
			["no refs at all", []],
			["another handoff's summary under the same id", [{ ...SUMMARY_REF, handoffId: "h-other" }]],
			["another commit's summary", [{ ...SUMMARY_REF, commitId: "c-other" }]],
			["an eviction standing in for a summary", [{ ...SUMMARY_REF, outcome: "evicted" }]],
		];
		for (const [label, outcomeRefs] of unbound) {
			const result = fold(throughReady(), { evidence: evidence({ outcomeRefs }) });
			ok(hasAnomaly(result, "unbound_outcome_ref"), label);
			strictEqual(result.authority, "recall_only", label);
		}
	});
});

describe("continuity fold: explicit resume authority", () => {
	const PAUSED = tx("h1-pause", "h1-prep", 1, 0, { phase: "paused", reason: "operator_cancelled" });
	const RESUME_AUTHORITY = {
		operatorRequestEntryId: "op-1",
		pausedOrFailedEntryId: "h1-pause",
		action: "reduce" as const,
		automaticDeadlineAtMs: NOW + 120_000,
	};
	const RESUMED = tx("h1-resume", "h1-pause", 2, 0, { phase: "resumed", authority: RESUME_AUTHORITY });
	const CHAIN = [PREPARED, PAUSED, RESUMED];
	const GOOD: OperatorResumeAuthorityEvidence = {
		operatorRequestEntryId: "op-1",
		handoffId: "h1",
		action: "reduce",
		pausedOrFailedEntryId: "h1-pause",
		originSessionId: SESSION,
		position: 1.5,
		acceptedAtMs: NOW - 1_000,
	};

	function withAuthorities(authorities: OperatorResumeAuthorityEvidence[], entries: unknown[] = CHAIN) {
		return fold(entries, { evidence: evidence({ resumeAuthorities: authorities, outcomeRefs: [] }) });
	}

	it("accepts a resume bound to a durable new operator control request", () => {
		const result = withAuthorities([GOOD]);
		strictEqual(result.phase, "resumed");
		deepStrictEqual(result.anomalies, []);
		strictEqual(result.authority, "execution");
		strictEqual(result.state?.activeResume?.entryId, "h1-resume");
	});

	it("refuses a request that is not strictly between the head it answers and the resume", () => {
		const cases: Array<[string, OperatorResumeAuthorityEvidence]> = [
			["recorded before the pause it claims to answer", { ...GOOD, position: 0 }],
			["recorded at the pause itself", { ...GOOD, position: 1 }],
			["recorded after the resume that cites it", { ...GOOD, position: 3 }],
			["recorded at the resume itself", { ...GOOD, position: 2 }],
		];
		for (const [label, authority] of cases) {
			const result = withAuthorities([authority]);
			ok(hasAnomaly(result, "unvalidated_resume_authority"), label);
			strictEqual(result.state?.activeResume, null, label);
		}
	});

	it("refuses a binding that names another handoff, action, head or session", () => {
		const cases: Array<[string, OperatorResumeAuthorityEvidence[]]> = [
			["no authority at all", []],
			["another handoff's request", [{ ...GOOD, handoffId: "h-other" }]],
			["a request for the other action", [{ ...GOOD, action: "deliver" }]],
			["a request answering a different head", [{ ...GOOD, pausedOrFailedEntryId: "h1-prep" }]],
			["a request from another session", [{ ...GOOD, originSessionId: "s-other" }]],
			["a different control record than the resume cites", [{ ...GOOD, operatorRequestEntryId: "op-2" }]],
			["a request with no usable accepted time", [{ ...GOOD, acceptedAtMs: Number.NaN }]],
		];
		for (const [label, authorities] of cases) {
			const result = withAuthorities(authorities);
			ok(
				hasAnomaly(result, "unvalidated_resume_authority") || hasAnomaly(result, "unmatched_resume"),
				`${label} must not authorize a resume`,
			);
			strictEqual(result.state?.activeResume, null, label);
			strictEqual(result.authority, "recall_only", label);
		}
	});

	it("refuses a resume that answers an older pause than its own predecessor", () => {
		const entries = [
			PREPARED,
			PAUSED,
			tx("h1-resume", "h1-pause", 2, 0, { phase: "resumed", authority: RESUME_AUTHORITY }),
			tx("h1-reduce", "h1-resume", 3, 1, { phase: "reducing", resumeRef: "h1-resume" }),
			tx("h1-pause-b", "h1-reduce", 4, 1, { phase: "paused", reason: "operator_cancelled" }),
			// This resume follows pause B but cites pause A.
			tx("h1-resume-b", "h1-pause-b", 5, 1, { phase: "resumed", authority: RESUME_AUTHORITY }),
		];
		const result = withAuthorities([GOOD], entries);
		ok(hasAnomaly(result, "unmatched_resume"), "authority must name the resume's own predecessor");
	});

	it("requires the dependent event to cite the resume and match its granted action", () => {
		const reduceGrant = [...CHAIN];
		const cases: Array<[string, unknown[], OperatorResumeAuthorityEvidence[], ContinuityAnomalyKind]> = [
			[
				"reducing without a resumeRef",
				[...reduceGrant, tx("h1-reduce", "h1-resume", 3, 1, { phase: "reducing" })],
				[GOOD],
				"missing_resume_ref",
			],
			[
				"reducing citing the wrong resume",
				[...reduceGrant, tx("h1-reduce", "h1-resume", 3, 1, { phase: "reducing", resumeRef: "h1-other" })],
				[GOOD],
				"missing_resume_ref",
			],
			[
				"a resumeRef on an event that follows no resume",
				[PREPARED, tx("h1-reduce", "h1-prep", 1, 1, { phase: "reducing", resumeRef: "h1-resume" })],
				[],
				"missing_resume_ref",
			],
		];
		for (const [label, entries, authorities, kind] of cases) {
			ok(hasAnomaly(withAuthorities(authorities, entries), kind), label);
		}

		// Granted reduce, emitted delivered.
		const commitFirst = [
			PREPARED,
			REDUCING,
			commitEntry(),
			tx("h1-pause2", "h1-commit-entry", 3, 1, { phase: "paused", reason: "operator_cancelled" }),
			tx("h1-resume2", "h1-pause2", 4, 1, {
				phase: "resumed",
				authority: { ...RESUME_AUTHORITY, pausedOrFailedEntryId: "h1-pause2", action: "reduce" },
			}),
			tx("h1-deliver", "h1-resume2", 5, 1, {
				phase: "delivered",
				deliveryId: "d1",
				continuationTurnId: "u2",
				resumeRef: "h1-resume2",
			}),
		];
		const mismatched = fold(commitFirst, {
			evidence: evidence({
				resumeAuthorities: [{ ...GOOD, pausedOrFailedEntryId: "h1-pause2", position: 3.5 }],
			}),
		});
		ok(hasAnomaly(mismatched, "illegal_transition"), "a reduce grant does not authorize a delivery");
	});

	it("refuses a resume to deliver when no valid commit exists", () => {
		const entries = [
			PREPARED,
			PAUSED,
			tx("h1-resume", "h1-pause", 2, 0, { phase: "resumed", authority: { ...RESUME_AUTHORITY, action: "deliver" } }),
		];
		const result = withAuthorities([{ ...GOOD, action: "deliver" }], entries);
		ok(hasAnomaly(result, "illegal_transition"));
		strictEqual(result.state?.activeResume, null);
	});

	it("does not refund a spent attempt across pause and resume", () => {
		const entries = [
			PREPARED,
			REDUCING,
			tx("h1-pause2", "h1-reduce", 2, 1, { phase: "paused", reason: "operator_cancelled" }),
			tx("h1-resume2", "h1-pause2", 3, 1, {
				phase: "resumed",
				authority: { ...RESUME_AUTHORITY, pausedOrFailedEntryId: "h1-pause2" },
			}),
			tx("h1-reduce2", "h1-resume2", 4, 2, { phase: "reducing", resumeRef: "h1-resume2" }),
		];
		const result = fold(entries, {
			evidence: evidence({
				resumeAuthorities: [{ ...GOOD, pausedOrFailedEntryId: "h1-pause2", position: 2.5 }],
				outcomeRefs: [],
			}),
		});
		strictEqual(result.attemptsSpent, 2);
		deepStrictEqual(result.anomalies, []);
		deepStrictEqual(result.action, { kind: "recall_only", reason: "attempts_exhausted" });
	});

	it("measures a renewed deadline from the accepted request, not from the deadline it asks for", () => {
		const farFuture = tx("h1-resume", "h1-pause", 2, 0, {
			phase: "resumed",
			authority: { ...RESUME_AUTHORITY, automaticDeadlineAtMs: NOW + 99_000_000 },
		});
		const acceptedAtMs = NOW - 1_000;
		const result = fold([PREPARED, PAUSED, farFuture], {
			evidence: evidence({ resumeAuthorities: [{ ...GOOD, acceptedAtMs }], outcomeRefs: [] }),
		});
		strictEqual(
			result.effectiveDeadlineAtMs,
			acceptedAtMs + HANDOFF_MAX_WINDOW_MS,
			"a far-future renewal is clamped to one window past the real request",
		);

		const rolledBack = fold([PREPARED, PAUSED, RESUMED], {
			evidence: evidence({ resumeAuthorities: [{ ...GOOD, acceptedAtMs }], outcomeRefs: [] }),
			nowMs: PREPARED_AT - 1,
		});
		deepStrictEqual(rolledBack.action, { kind: "recall_only", reason: "clock_ambiguous" });
	});

	it("treats a clock that fell behind the operator request as ambiguous, not as fresh time", () => {
		// Prepared at 1000, request accepted at 10000, renewed deadline 20000, now
		// 9000. The ledger order is valid and `now` is comfortably past
		// preparation, so only the renewal base can catch the rollback.
		const early = policy({ preparedAtMs: 1_000, automaticDeadlineAtMs: 601_000 });
		const prepared = tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: early });
		const renewed = tx("h1-resume", "h1-pause", 2, 0, {
			phase: "resumed",
			authority: { ...RESUME_AUTHORITY, automaticDeadlineAtMs: 20_000 },
		});
		const request = { ...GOOD, acceptedAtMs: 10_000 };
		const entries = [prepared, PAUSED, renewed];

		const rolledBack = fold(entries, {
			evidence: evidence({ resumeAuthorities: [request], outcomeRefs: [] }),
			nowMs: 9_000,
		});
		deepStrictEqual(rolledBack.action, { kind: "recall_only", reason: "clock_ambiguous" });
		strictEqual(rolledBack.attemptsSpent, 0, "an ambiguous clock refunds nothing");

		// The same ledger with a clock that did not move backwards.
		const forward = fold(entries, {
			evidence: evidence({ resumeAuthorities: [request], outcomeRefs: [] }),
			nowMs: 11_000,
		});
		deepStrictEqual(forward.action, { kind: "none" });
		strictEqual(forward.effectiveDeadlineAtMs, 20_000);
	});

	it("refuses an operator request whose accepted time is not a usable timestamp", () => {
		for (const acceptedAtMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = withAuthorities([{ ...GOOD, acceptedAtMs }]);
			ok(hasAnomaly(result, "unvalidated_resume_authority"), `acceptedAtMs ${acceptedAtMs} must not authorize`);
		}
	});

	it("keeps authority valid when an identical duplicate of the answered pause is appended later", () => {
		const result = withAuthorities([GOOD], [...CHAIN, { ...PAUSED }]);
		deepStrictEqual(result.anomalies, [], "an identical duplicate does not reorder history");
		strictEqual(result.phase, "resumed");
		strictEqual(result.state?.activeResume?.entryId, "h1-resume");
		strictEqual(result.authority, "execution");
	});
});

describe("continuity fold: deadlines", () => {
	it("ends automatic work when the window is reached, and clamps an overlong one", () => {
		const live = fold([PREPARED], { nowMs: PREPARED_AT + 1_000 });
		strictEqual(live.effectiveDeadlineAtMs, PREPARED_AT + 600_000);
		deepStrictEqual(live.action, { kind: "none" });

		const exact = fold([PREPARED], { nowMs: PREPARED_AT + 600_000 });
		deepStrictEqual(exact.action, { kind: "fail", reason: "deadline_exceeded" }, "reaching the deadline ends the window");
		strictEqual(exact.accepted?.note, NOTE.note, "expiry preserves the note");

		const overlong = [
			tx("h1-prep", null, 0, 0, {
				phase: "prepared",
				accepted: NOTE,
				policy: policy({ automaticDeadlineAtMs: PREPARED_AT + 99_000_000 }),
			}),
		];
		strictEqual(
			fold(overlong, { nowMs: PREPARED_AT + 1_000 }).effectiveDeadlineAtMs,
			PREPARED_AT + HANDOFF_MAX_WINDOW_MS,
		);
	});

	it("treats a backward or unusable clock as requiring operator recovery", () => {
		deepStrictEqual(fold([PREPARED], { nowMs: PREPARED_AT - 5_000 }).action, {
			kind: "recall_only",
			reason: "clock_ambiguous",
		});
		deepStrictEqual(fold([PREPARED], { nowMs: Number.NaN }).action, { kind: "recall_only", reason: "clock_ambiguous" });
	});
});

describe("continuity fold: summary carry and missing commit", () => {
	it("does not call a commit missing when it merely appears later in the input", () => {
		const result = fold([PREPARED, REDUCING, summaryWithCarry("h1-summary", checkpoint()), commitEntry()]);
		strictEqual(result.phase, "ready");
		strictEqual(result.missingCommit, null, "the commit is present, just later in file order");
		strictEqual(missingCommitFromCarry(result), null);
		deepStrictEqual(result.anomalies, []);
		deepStrictEqual(result.action, { kind: "none" });
	});

	it("reconstructs an absent commit under its reserved identity and keeps the later head", () => {
		// The real recovery shape: the initial summary carried `ready` but the
		// commit append was lost, and the run then delivered, was answered and
		// acknowledged. Every record the order proof needs is a real entry.
		const readyCarry = checkpoint();
		const ackCarry = checkpoint({
			state: {
				transition: { entryId: "h1-ack", prevEntryId: "h1-deliver", sequence: 4, attempt: 1 },
				event: { phase: "acknowledged", deliveryId: "d1", terminalResponseEntryId: "a2" },
				activeResume: null,
				delivery: { deliveryId: "d1", continuationTurnId: "u2" },
			},
		});
		// prepared(0) reducing(1) summary#1(2) delivered(3) response(4) ack(5) summary#2(6)
		const ledger = [
			PREPARED,
			REDUCING,
			summaryWithCarry("h1-summary", readyCarry),
			DELIVERED,
			message("a2"),
			ACKNOWLEDGED,
			summaryWithCarry("h1-summary-2", ackCarry),
		];
		const result = fold(ledger, { evidence: evidence({ terminalResponses: [terminal({ position: 4 })] }) });
		deepStrictEqual(result.anomalies, []);
		strictEqual(result.phase, "acknowledged", "the fold does not regress to ready");

		const reconstruction = missingCommitFromCarry(result);
		ok(reconstruction, "a validated carry proves the commit existed");
		strictEqual(reconstruction.entry.turnId, "h1-commit-entry", "the reserved id is reused, never a new one");
		strictEqual(reconstruction.entry.parentTurnId, "a1");
		strictEqual(reconstruction.entry.timestamp, "2026-09-21T09:05:00.000Z");
		strictEqual(
			reconstruction.entry.continuity.state.event.phase,
			"ready",
			"the rebuilt commit is the original ready state",
		);
		strictEqual(reconstruction.entry.continuity.state.delivery, null);
		strictEqual(reconstruction.carriedState.event.phase, "acknowledged", "the later head is returned separately");

		// Appending the recovered original commit at the physical end does not
		// move the head back.
		const reloaded = fold([...ledger, reconstruction.entry], {
			evidence: evidence({ terminalResponses: [terminal({ position: 4 })] }),
		});
		strictEqual(reloaded.phase, "acknowledged");
		strictEqual(reloaded.missingCommit, null);
		deepStrictEqual(reloaded.anomalies, []);
	});

	it("refuses a carried acknowledgement whose referenced records do not match", () => {
		const ackCarry = checkpoint({
			state: {
				transition: { entryId: "h1-ack", prevEntryId: "h1-deliver", sequence: 4, attempt: 1 },
				event: { phase: "acknowledged", deliveryId: "d1", terminalResponseEntryId: "a2" },
				activeResume: null,
				delivery: { deliveryId: "d1", continuationTurnId: "u2" },
			},
		});
		const full = [
			PREPARED,
			REDUCING,
			summaryWithCarry("h1-summary", checkpoint()),
			DELIVERED,
			message("a2"),
			ACKNOWLEDGED,
		];
		const refused: Array<[string, unknown[], TerminalResponseEvidence[]]> = [
			[
				"no acknowledgement record in the input",
				[...full.slice(0, 5), summaryWithCarry("h1-summary-2", ackCarry)],
				[terminal({ position: 4 })],
			],
			[
				"no delivery record in the input",
				[PREPARED, REDUCING, summaryWithCarry("h1-summary", checkpoint()), summaryWithCarry("h1-summary-2", ackCarry)],
				[terminal({ position: 1 })],
			],
			["a response recorded before the delivery it answers", [...full], [terminal({ position: 2 })]],
			["a response recorded after the acknowledgement that cites it", [...full], [terminal({ position: 6 })]],
		];
		for (const [label, entries, terminalResponses] of refused) {
			const result = fold(entries, { evidence: evidence({ terminalResponses }) });
			ok(
				hasAnomaly(result, "acknowledgement_unsupported") || hasAnomaly(result, "broken_chain"),
				`${label}: ${JSON.stringify(result.anomalies)}`,
			);
			strictEqual(result.authority, "recall_only", label);
			strictEqual(missingCommitFromCarry(result), null, `${label}: reconstruction is suppressed`);
			strictEqual(continuityPayloadFromFold(result), null, `${label}: no new carry`);
			ok(result.accepted, `${label}: the note stays recallable`);
		}
	});

	it("refuses a carried acknowledgement whose delivery disagrees with the actual intent record", () => {
		// The real delivery record named continuation u2. The carry keeps its id
		// but claims u3, and the terminal evidence is made to agree with the
		// carry, so only comparing the actual record catches it.
		const carried = checkpoint({
			state: {
				transition: { entryId: "h1-ack", prevEntryId: "h1-deliver", sequence: 4, attempt: 1 },
				event: { phase: "acknowledged", deliveryId: "d1", terminalResponseEntryId: "a2" },
				activeResume: null,
				delivery: { deliveryId: "d1", continuationTurnId: "u3" },
			},
		});
		const ledger = [
			PREPARED,
			REDUCING,
			summaryWithCarry("h1-summary", checkpoint()),
			DELIVERED,
			message("a2"),
			summaryWithCarry("h1-summary-2", carried),
		];
		const result = fold(ledger, {
			evidence: evidence({ terminalResponses: [terminal({ continuationTurnId: "u3", position: 4 })] }),
		});
		ok(
			hasAnomaly(result, "acknowledgement_unsupported") || hasAnomaly(result, "conflicting_carry"),
			`a delivery that disagrees with its record is not proof: ${JSON.stringify(result.anomalies)}`,
		);
		strictEqual(result.authority, "recall_only");
		strictEqual(continuityPayloadFromFold(result), null);
	});

	it("refuses a carry that reuses a real resume's id under a different authority", () => {
		const granted = {
			operatorRequestEntryId: "op-reduce",
			pausedOrFailedEntryId: "h1-fail",
			action: "reduce" as const,
			automaticDeadlineAtMs: NOW + 120_000,
		};
		// The real resume granted reduce via op-reduce.
		const ledger = [
			PREPARED,
			REDUCING,
			tx("h1-fail", "h1-reduce", 2, 1, { phase: "failed", reason: "provider_failed" }),
			tx("h1-resume", "h1-fail", 3, 1, { phase: "resumed", authority: granted }),
			tx("h1-reduce2", "h1-resume", 4, 2, { phase: "reducing", resumeRef: "h1-resume" }),
			commitEntry(
				checkpoint({
					commit: {
						...SUMMARIZED_COMMIT,
						transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce2", sequence: 5, attempt: 2 },
					},
				}),
			),
		];
		// The carry reuses that entry id but swaps in another genuine request.
		const swapped = {
			operatorRequestEntryId: "op-deliver",
			pausedOrFailedEntryId: "h1-fail",
			action: "deliver" as const,
			automaticDeadlineAtMs: NOW + 300_000,
		};
		const carry = summaryWithCarry(
			"h1-summary-2",
			checkpoint({
				commit: {
					...SUMMARIZED_COMMIT,
					transition: { entryId: "h1-commit-entry", prevEntryId: "h1-reduce2", sequence: 5, attempt: 2 },
				},
				state: {
					transition: { entryId: "h1-deliver", prevEntryId: "h1-commit-entry", sequence: 6, attempt: 2 },
					event: { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" },
					activeResume: { entryId: "h1-resume", authority: swapped },
					delivery: { deliveryId: "d1", continuationTurnId: "u2" },
				},
			}),
		);
		// Both requests exist and both look valid in isolation.
		const authorities: OperatorResumeAuthorityEvidence[] = [
			{
				operatorRequestEntryId: "op-reduce",
				handoffId: "h1",
				action: "reduce",
				pausedOrFailedEntryId: "h1-fail",
				originSessionId: SESSION,
				position: 2.5,
				acceptedAtMs: NOW - 5_000,
			},
			{
				operatorRequestEntryId: "op-deliver",
				handoffId: "h1",
				action: "deliver",
				pausedOrFailedEntryId: "h1-fail",
				originSessionId: SESSION,
				position: 2.6,
				acceptedAtMs: NOW - 4_000,
			},
		];
		const result = fold([...ledger, carry], { evidence: evidence({ resumeAuthorities: authorities }) });
		ok(
			hasAnomaly(result, "unvalidated_resume_authority"),
			`the same event id with a different payload must fail closed: ${JSON.stringify(result.anomalies)}`,
		);
		strictEqual(result.authority, "recall_only");
		strictEqual(continuityPayloadFromFold(result), null);
	});

	it("does not regress when the reconstructed commit is appended at the end of the file", () => {
		const carried = checkpoint({
			state: {
				transition: { entryId: "h1-pause", prevEntryId: "h1-deliver", sequence: 4, attempt: 1 },
				event: { phase: "paused", reason: "delivery_uncertain" },
				activeResume: null,
				delivery: { deliveryId: "d1", continuationTurnId: "u2" },
			},
		});
		const before = fold([summaryWithCarry("h1-summary", carried)]);
		const reconstruction = missingCommitFromCarry(before);
		ok(reconstruction);

		// Exactly what recovery does: append the recovered original commit at the
		// physical end, then reload.
		const after = fold([summaryWithCarry("h1-summary", carried), reconstruction.entry]);
		strictEqual(after.phase, "paused", "an old commit at the tail must not pull the head back to ready");
		strictEqual(after.state?.transition.sequence, 4);
		strictEqual(after.state?.delivery?.deliveryId, "d1");
		strictEqual(after.missingCommit, null, "the commit is no longer missing");
		strictEqual(after.commit?.outcome, "summarized");
		deepStrictEqual(after.anomalies, []);
	});

	it("refuses to conclude absence while unreadable records could hide the commit", () => {
		const result = fold([summaryWithCarry("h1-summary", checkpoint())], {
			evidence: evidence({ unreadableRecords: 2 }),
		});
		strictEqual(result.missingCommit, null);
		ok(hasAnomaly(result, "malformed_record"));
		strictEqual(result.authority, "recall_only");
		strictEqual(result.skipped.unreadable, 2);
	});

	it("preserves an eviction-only outcome through a later ordinary summary", () => {
		const entries = [
			PREPARED,
			REDUCING,
			commitEntry(checkpoint({ commit: EVICTED_COMMIT })),
			ordinarySummary("later-ordinary"),
		];
		const result = fold(entries, {
			evidence: evidence({
				outcomeRefs: [{ entryId: "h1-evict", outcome: "evicted", handoffId: "h1", commitId: "h1-commit", position: 2 }],
			}),
		});
		strictEqual(result.commit?.outcome, "evicted");
		strictEqual(result.commit?.evictionRef, "h1-evict");
		strictEqual(result.commit?.summaryRef, undefined, "a later ordinary summary never rewrites the outcome");
		deepStrictEqual(result.anomalies, []);
		strictEqual(continuityPayloadFromFold(result)?.commit.outcome, "evicted");
	});

	it("reports conflicting copies of one transaction and proposes nothing", () => {
		const result = fold([
			PREPARED,
			REDUCING,
			commitEntry(),
			summaryWithCarry("h1-summary", checkpoint({ accepted: admit("a different note") })),
		]);
		ok(hasAnomaly(result, "conflicting_carry"));
		deepStrictEqual(result.action, { kind: "recall_only", reason: "conflicting_evidence" });
		strictEqual(continuityPayloadFromFold(result), null, "a disputed chain publishes no carry");
	});
});

describe("continuity fold: applicability and successive handoffs", () => {
	it("pauses a delivery with no matching durable success", () => {
		const entries = [...throughReady(), DELIVERED, message("a2")];
		strictEqual(fold(entries).phase, "delivered");
		deepStrictEqual(fold(entries).action, { kind: "pause", reason: "delivery_uncertain" });
		deepStrictEqual(
			fold(entries, { evidence: evidence({ terminalResponses: [terminal({ position: 2 })] }) }).action,
			{ kind: "pause", reason: "delivery_uncertain" },
			"an older success does not resolve a later delivery intent",
		);
		deepStrictEqual(fold(entries, { evidence: evidence({ terminalResponses: [terminal({ position: 4 })] }) }).action, {
			kind: "none",
		});
	});

	it("grants an inherited historical note recall only, in every phase", () => {
		const entries = throughAcknowledged();
		for (const slice of [throughReady(), entries.slice(0, 4), entries]) {
			const result = fold(slice, {
				selection: { sessionId: SESSION, pathTurnIds: PATH, historical: true },
				evidence: evidence({ terminalResponses: [ACK_TERMINAL] }),
			});
			strictEqual(result.authority, "recall_only", `phase ${result.phase} must not inherit ownership`);
			strictEqual(result.validated, true, "an inherited note is valid history, not disputed evidence");
			ok(result.accepted, "the note itself is still recallable");
			ok(continuityPayloadFromFold(result), "valid history still carries forward");
		}
	});

	it("excludes another session's and another branch's transactions", () => {
		const foreign = tx(
			"x-prep",
			null,
			0,
			0,
			{ phase: "prepared", accepted: NOTE, policy: policy() },
			{
				identity: identity({ handoffId: "x", preparedEntryId: "x-prep", originSessionId: "s-other" }),
			},
		);
		const sibling = tx(
			"y-prep",
			null,
			0,
			0,
			{ phase: "prepared", accepted: NOTE, policy: policy() },
			{
				identity: identity({ handoffId: "y", preparedEntryId: "y-prep", branchAnchorTurnId: "sibling-leaf" }),
			},
		);
		const strayInitiator = tx(
			"z-prep",
			null,
			0,
			0,
			{ phase: "prepared", accepted: NOTE, policy: policy() },
			{
				identity: identity({ handoffId: "z", preparedEntryId: "z-prep", initiatingTurnId: "not-on-path" }),
			},
		);
		const result = fold([foreign, sibling, strayInitiator, message("u1")]);
		strictEqual(result.phase, "absent");
		strictEqual(result.identity, null);
		strictEqual(result.skipped.inapplicable, 3);
		deepStrictEqual(result.action, { kind: "none" });
	});

	function cycle(index: number, note: AcceptedNote) {
		const handoffId = `h${index}`;
		const ids = identity({
			handoffId,
			preparedEntryId: `${handoffId}-prep`,
			commitId: `${handoffId}-commit`,
			commitEntryId: `${handoffId}-commit-entry`,
		});
		const commit: ContinuityCommitData = {
			outcome: "summarized",
			entry: { turnId: `${handoffId}-commit-entry`, parentTurnId: "a1", timestamp: "2026-09-21T09:05:00.000Z" },
			transition: { entryId: `${handoffId}-commit-entry`, prevEntryId: `${handoffId}-reduce`, sequence: 2, attempt: 1 },
			summaryRef: `${handoffId}-summary`,
			tokensBefore: 30_000,
			tokensAfter: 9_000,
		};
		return {
			ids,
			commit,
			prepared: tx(
				`${handoffId}-prep`,
				null,
				0,
				0,
				{ phase: "prepared", accepted: note, policy: policy() },
				{ identity: ids },
			),
			entries: [
				tx(`${handoffId}-prep`, null, 0, 0, { phase: "prepared", accepted: note, policy: policy() }, { identity: ids }),
				tx(`${handoffId}-reduce`, `${handoffId}-prep`, 1, 1, { phase: "reducing" }, { identity: ids }),
				commitEntry(checkpoint({ identity: ids, accepted: note, commit })),
				ordinarySummary(`${handoffId}-ordinary`),
			],
			ref: {
				entryId: `${handoffId}-summary`,
				outcome: "summarized" as const,
				handoffId,
				commitId: `${handoffId}-commit`,
				position: index,
			},
		};
	}

	it("selects the newest of three successive handoffs and keeps the earlier ones recallable", () => {
		const cycles = [admit("first cycle note"), admit("second cycle note"), admit("third cycle note")].map((note, index) =>
			cycle(index + 1, note),
		);
		const result = fold([message("u1"), ...cycles.flatMap((entry) => entry.entries)], {
			evidence: evidence({ outcomeRefs: cycles.map((entry) => entry.ref) }),
		});

		strictEqual(result.identity?.handoffId, "h3", "the newest cycle is the selected transaction");
		strictEqual(result.accepted?.note, "third cycle note");
		strictEqual(result.phase, "ready");
		deepStrictEqual(result.anomalies, [], "earlier cycles are history, not conflicting identities");
		strictEqual(result.authority, "execution");
		deepStrictEqual(
			result.priorHandoffs.map((prior) => [prior.handoffId, prior.phase, prior.accepted?.note]),
			[
				["h1", "ready", "first cycle note"],
				["h2", "ready", "second cycle note"],
			],
			"earlier notes stay recallable, oldest first",
		);
	});

	it("does not let a duplicate of an older prepared record re-elect that handoff", () => {
		const first = cycle(1, admit("first cycle note"));
		const second = cycle(2, admit("second cycle note"));
		const cycles = [first, second];
		const entries = [
			...first.entries,
			...second.entries,
			// An identical repeat of the first cycle's prepared record, appended last.
			first.prepared,
		];
		const result = fold(entries, { evidence: evidence({ outcomeRefs: cycles.map((entry) => entry.ref) }) });
		strictEqual(result.identity?.handoffId, "h2", "a duplicate never moves a chain's root position");
		strictEqual(result.accepted?.note, "second cycle note");
		deepStrictEqual(result.anomalies, []);
	});

	it("reports one entry id reused by two different handoffs", () => {
		const secondIds = identity({
			handoffId: "h2",
			preparedEntryId: "h1-prep",
			commitId: "h2-commit",
			commitEntryId: "h2-commit-entry",
		});
		const result = fold([
			PREPARED,
			tx("h1-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() }, { identity: secondIds }),
		]);
		ok(hasAnomaly(result, "entry_id_reused"));
		strictEqual(result.validated, false);
	});

	it("ignores unrelated records entirely", () => {
		const result = fold([
			message("u1"),
			ordinarySummary("s-1"),
			{ kind: "modelChange", turnId: "m1", parentTurnId: null, timestamp: "t", provider: "p", modelId: "m" },
			null,
			"garbage",
		]);
		strictEqual(result.phase, "absent");
		deepStrictEqual(result.anomalies, []);
		deepStrictEqual(result.action, { kind: "none" });
	});
});

describe("continuity carry projection", () => {
	it("carries identity, note, policy, commit and the advanced state, and nothing else", () => {
		const entries = [
			...throughReady(),
			tx("h1-deliver", "h1-commit-entry", 3, 1, { phase: "delivered", deliveryId: "d1", continuationTurnId: "u2" }),
			tx("h1-pause", "h1-deliver", 4, 1, { phase: "paused", reason: "delivery_uncertain" }),
		];
		const carry = continuityPayloadFromFold(fold(entries));
		ok(carry);
		strictEqual(carry.identity.handoffId, "h1");
		strictEqual(carry.accepted.note, NOTE.note);
		strictEqual(carry.policy.preparedAtMs, PREPARED_AT);
		strictEqual(carry.commit.transition.sequence, 2, "the original commit link is preserved");
		strictEqual(carry.state.event.phase, "paused", "the advanced state is what a later summary carries");
		strictEqual(carry.state.delivery?.deliveryId, "d1", "the delivery intent survives the pause");

		const reloaded = fold([summaryWithCarry("h1-summary-2", carry)]);
		strictEqual(reloaded.phase, "paused");
		strictEqual(reloaded.state?.transition.sequence, 4);
	});

	it("has nothing to carry before a commit exists", () => {
		const result = fold([PREPARED]);
		strictEqual(result.phase, "prepared");
		strictEqual(continuityPayloadFromFold(result), null);
	});
});
