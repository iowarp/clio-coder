/**
 * Durable session continuity: the typed core.
 *
 * These are the record shapes, fold inputs/results, and injected persistence
 * ports for CONTRACTS.md §§2–8. Nothing here is registered in the live
 * `SessionEntry` union yet and no session is stamped v5: packet 02B does that
 * once readers, replay, fork and export can all interpret the records. Until
 * then these types describe records the core can build and validate, not
 * records the product writes.
 *
 * The module imports `BaseSessionEntry` as a type only. A value import from
 * `entries.ts` would create the reverse cycle 02B needs to avoid when
 * `entries.ts` starts calling these validators, so envelope checking is done
 * locally by `validate.ts`.
 *
 * Nothing in the pure half of this domain (contract, note, validate, fold,
 * carry) reads a clock, mints an ID, touches disk, or calls a model. Time,
 * authority, already-allocated identifiers and persistence are supplied by the
 * caller. Preparation and composition mint identity; recovery only reuses it.
 */

import type { BaseSessionEntry } from "../entries.js";

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_NOTE_MAX_BYTES = 8192;

/**
 * Bound on any single automatic handoff window, from §7. A persisted deadline
 * is clamped to this ceiling on reload so a wrong or hostile recorded value
 * cannot grant unbounded automatic execution.
 */
export const HANDOFF_MAX_WINDOW_MS = 900_000;

/** What a reduction actually did. `no_material` is never a commit outcome. */
export type ContinuityOutcome = "summarized" | "evicted" | "continuity_only";

export type HandoffFailureReason =
	| "invalid_note"
	| "note_exceeds_replay_budget"
	| "budget_unsafe_no_material"
	| "durability_unresolved"
	| "state_root_removed"
	| "origin_changed"
	| "provider_failed"
	| "attempts_exhausted"
	| "deadline_exceeded";

export type HandoffPauseReason = "operator_cancelled" | "origin_changed" | "delivery_uncertain";

/**
 * Identity minted once at admitted preparation and never replaced. Recovery
 * reuses every field, including `commitEntryId`, so a commit that went missing
 * is rebuilt under the identity the original reserved rather than a new one.
 */
export interface HandoffIdentity {
	handoffId: string;
	preparedEntryId: string;
	commitId: string;
	/** Reserved before any summary append so a missing commit is reconstructible. */
	commitEntryId: string;
	originSessionId: string;
	/** The originally selected message leaf. Immutable; not the live selection. */
	branchAnchorTurnId: string | null;
	initiatingTurnId: string;
	toolCallId: string;
	/** Opaque live-budget revision from packet 01. Persistence never interprets it. */
	sourceRevision: string;
}

export interface HandoffPolicy {
	preparedAtMs: number;
	/** Absolute, finite, positive. Never reset on reload. */
	automaticDeadlineAtMs: number;
	maxAttempts: number;
	maxSummaryCallsPerAttempt: number;
	additionalSummaryRetriesPerCall: number;
	maxSummaryStreamInvocations: number;
	flushRetryLimit: number;
}

/**
 * The frozen §2/§7 ceilings. A persisted policy is validated against these, so
 * a record that claims three attempts or a summary-retry loop cannot widen the
 * automatic budget merely by being on disk. Runtime stream counting is packet
 * 03's job; this is the durable bound it starts from.
 */
export const HANDOFF_POLICY_LIMITS = Object.freeze({
	maxAttempts: 2,
	maxSummaryCallsPerAttempt: 2,
	additionalSummaryRetriesPerCall: 0,
	maxSummaryStreamInvocations: 4,
	flushRetryLimit: 3,
});

/** Barrier retries after the first attempt, from `HandoffPolicy.flushRetryLimit`. */
export const HANDOFF_MAX_FLUSH_RETRIES = 3;

/**
 * An admitted note, stored as exactly the bytes that were submitted.
 *
 * The note is **agent-authored**: it is the text the model supplied as the
 * `self_compact` argument, not operator-written prose. Replay and export must
 * preserve that authorship and never present it as an operator turn. `note` is
 * never trimmed, normalized, truncated or regenerated; `noteSha256` is over its
 * UTF-8 encoding and `noteBytes` is that encoding's length.
 */
export interface AcceptedNote {
	note: string;
	noteBytes: number;
	noteSha256: string;
}

/**
 * Position in the transaction chain. `entryId` equals the envelope's `turnId`;
 * `prevEntryId` is the transaction predecessor, which is deliberately not the
 * structural `parentTurnId`.
 */
export interface TransitionLink {
	entryId: string;
	prevEntryId: string | null;
	/** prepared = 0; each accepted successor = predecessor + 1. */
	sequence: number;
	/** 0 initially; incremented only when a `reducing` event is accepted. */
	attempt: number;
}

/**
 * The durable authority a `resumed` event cites.
 *
 * `operatorRequestEntryId` names a **control-request record**, not a
 * conversation turn. Clio's `/context compact [instructions]` and the other
 * control commands are display-only today and `/resume` opens session
 * navigation, so there is no operator message turn that means "resume this
 * handoff". The feasible carrier is a typed `CustomEntry<T>` control record;
 * reading and writing it is 02B/03/05 wiring, and nothing here fabricates a
 * message entry to stand in for it.
 */
export interface HandoffResumeAuthority {
	operatorRequestEntryId: string;
	pausedOrFailedEntryId: string;
	action: "reduce" | "deliver";
	automaticDeadlineAtMs: number;
}

export type HandoffEvent =
	| { phase: "prepared"; accepted: AcceptedNote; policy: HandoffPolicy }
	| { phase: "reducing"; resumeRef?: string }
	| { phase: "delivered"; deliveryId: string; continuationTurnId: string; resumeRef?: string }
	| { phase: "acknowledged"; deliveryId: string; terminalResponseEntryId: string }
	| { phase: "paused"; reason: HandoffPauseReason }
	| { phase: "failed"; reason: HandoffFailureReason }
	| { phase: "resumed"; authority: HandoffResumeAuthority };

export type HandoffEventPhase = HandoffEvent["phase"];

/** The fold head is an event phase, or `ready` once a valid commit exists. */
export type ContinuityPhase = HandoffEventPhase | "ready" | "absent";

export interface HandoffTransactionEntry extends BaseSessionEntry {
	kind: "handoffTransaction";
	schemaVersion: 1;
	identity: HandoffIdentity;
	transition: TransitionLink;
	event: HandoffEvent;
}

export interface ContinuityCommitData {
	outcome: ContinuityOutcome;
	/** The commit's exact original envelope, retained for reconstruction. */
	entry: { turnId: string; parentTurnId: string | null; timestamp: string };
	transition: TransitionLink;
	/** Required only for `summarized`. */
	summaryRef?: string;
	/** Required only for `evicted`. */
	evictionRef?: string;
	tokensBefore: number;
	tokensAfter: number;
}

/**
 * The latest validated fold head, carried alongside the immutable transaction
 * facts. `activeResume` keeps the newest durable resume permission after its
 * event stops being the head; `delivery` keeps the matching intent through a
 * pause or acknowledgement. Neither authorizes automatic redelivery.
 */
export interface ContinuityCarriedState {
	transition: TransitionLink;
	event: HandoffEvent | { phase: "ready" };
	activeResume: { entryId: string; authority: HandoffResumeAuthority } | null;
	delivery: { deliveryId: string; continuationTurnId: string } | null;
}

export interface ContinuityCheckpointPayload {
	schemaVersion: 1;
	identity: HandoffIdentity;
	accepted: AcceptedNote;
	policy: HandoffPolicy;
	commit: ContinuityCommitData;
	state: ContinuityCarriedState;
}

export interface ContinuityCommitEntry extends BaseSessionEntry {
	kind: "continuityCommit";
	continuity: ContinuityCheckpointPayload;
}

/**
 * A compaction summary that carries a continuity payload. 02B adds the optional
 * field to `CompactionSummaryEntry` itself; until then the fold recognizes the
 * shape structurally so no live union changes here.
 */
export interface ContinuityCarryingSummary extends BaseSessionEntry {
	kind: "compactionSummary";
	continuity: ContinuityCheckpointPayload;
}

// ---------------------------------------------------------------------------
// Note admission
// ---------------------------------------------------------------------------

export type NoteRejectionReason =
	| "not_a_string"
	| "blank"
	| "contains_nul"
	| "not_utf8_round_trip"
	| "exceeds_max_bytes";

export type NoteValidation =
	| { ok: true; accepted: AcceptedNote }
	| { ok: false; reason: NoteRejectionReason; noteBytes: number | null };

export type AcceptedNoteVerification =
	| { ok: true }
	| { ok: false; reason: "byte_count_mismatch" | "hash_mismatch" | "decoded_text_mismatch" | NoteRejectionReason };

// ---------------------------------------------------------------------------
// Fold inputs
// ---------------------------------------------------------------------------

/**
 * A terminal assistant response the caller has already located and classified.
 * Acknowledgement needs `status: "success"` on the continuation turn that
 * consumed the delivery; empty, errored, aborted or interrupted responses and
 * another turn's response are not acknowledgement (§3.4, §12.4).
 */
export interface TerminalResponseEvidence {
	entryId: string;
	continuationTurnId: string;
	status: "success" | "empty" | "error" | "aborted" | "interrupted";
	/** Index into `ContinuityFoldInput.entries`; see its note on one coordinate system. */
	position: number;
}

/**
 * A durable **new** operator control request that can authorize one explicit
 * resume, prevalidated by the caller.
 *
 * Every field is part of the binding, because a bare list of entry ids proves
 * only that the operator did something. Authority requires that this request
 * named this handoff, asked for this action, answered this exact paused/failed
 * head, originated in this session, and was recorded after the head it answers.
 * The fold refuses a resume that does not match all of it.
 *
 * The record behind `operatorRequestEntryId` is a typed control-request entry
 * (a `CustomEntry<T>` in the feasible 02B shape), never a fabricated
 * conversation turn.
 */
export interface OperatorResumeAuthorityEvidence {
	operatorRequestEntryId: string;
	handoffId: string;
	action: "reduce" | "deliver";
	pausedOrFailedEntryId: string;
	/** The session the control request was recorded in. */
	originSessionId: string;
	/** Index into `ContinuityFoldInput.entries`; see its note on one coordinate system. */
	position: number;
	/**
	 * When the control request was durably accepted. This is the **only** base a
	 * renewed deadline is measured from: deriving a base backwards from the
	 * deadline the record itself asks for would let a far-future request renew
	 * itself without bound.
	 */
	acceptedAtMs: number;
}

/**
 * What the caller's evidence resolver must already have proven, stated here
 * because the fold cannot re-derive it from an opaque id.
 *
 * For `OperatorResumeAuthorityEvidence`: the record is a genuine typed operator
 * control request (§3.1's `CustomEntry` carrier), reached through an operator
 * surface rather than an agent tool, on this session's selected path and within
 * the historical cutoff. For `ContinuityOutcomeEvidence`: the named record is
 * really a summary or eviction of the stated kind, produced by that commit. For
 * `TerminalResponseEvidence`: the named record is a real assistant response for
 * that continuation turn and `status: "success"` means terminal and nonempty.
 *
 * Test-constructed evidence proves the fold's handling of it, never that 02B/03
 * adapters discharge these obligations.
 */
export type ContinuityEvidenceObligations = never;

/**
 * A summary or eviction record bound to the commit that produced it.
 *
 * A record merely existing under the id a commit names is not matching
 * evidence: an unrelated ordinary summary can share neither this handoff nor
 * this commit. The caller supplies the binding it established.
 */
export interface ContinuityOutcomeEvidence {
	entryId: string;
	outcome: Exclude<ContinuityOutcome, "continuity_only">;
	handoffId: string;
	commitId: string;
	/** Index into `ContinuityFoldInput.entries`; see its note on one coordinate system. */
	position: number;
}

export interface ContinuityFoldEvidence {
	/** Prevalidated resume authority, bound per transaction. */
	resumeAuthorities: ReadonlyArray<OperatorResumeAuthorityEvidence>;
	terminalResponses: ReadonlyArray<TerminalResponseEvidence>;
	/** Summary and eviction records bound to the commits that produced them. */
	outcomeRefs: ReadonlyArray<ContinuityOutcomeEvidence>;
	/**
	 * Records the caller could not parse. A nonzero count forbids concluding
	 * absence: skipped corrupt records must not turn missing evidence into
	 * permission (§6).
	 */
	unreadableRecords: number;
}

export interface ContinuityFoldSelection {
	sessionId: string;
	/** Turn ids on the selected path, for branch and initiating-turn applicability. */
	pathTurnIds: ReadonlyArray<string>;
	/**
	 * True when this projection is a historical fork cut. Inherited notes are
	 * then recallable only, in any phase, and never grant execution ownership.
	 */
	historical: boolean;
}

export interface ContinuityFoldInput {
	/**
	 * Ordered applicable ledger records; unknown shapes are ignored.
	 *
	 * This is the **full applicable ledger before the replay cut**, including
	 * archive reads where they are needed, which is what makes one coordinate
	 * system possible: every evidence `position` is an index into this array, and
	 * so is every record position the fold resolves itself. A reference whose
	 * record is not here cannot be ordered against anything, and the transaction
	 * stays recall-only rather than borrowing another record's position.
	 */
	entries: ReadonlyArray<unknown>;
	selection: ContinuityFoldSelection;
	evidence: ContinuityFoldEvidence;
	/** Supplied wall clock in ms. The fold never reads one itself. */
	nowMs: number;
}

// ---------------------------------------------------------------------------
// Fold results
// ---------------------------------------------------------------------------

export type ContinuityAnomalyKind =
	| "duplicate_conflict"
	| "entry_id_reused"
	| "unbound_outcome_ref"
	| "illegal_transition"
	| "broken_chain"
	| "invalid_attempt"
	| "policy_conflict"
	| "unmatched_resume"
	| "unvalidated_resume_authority"
	| "missing_resume_ref"
	| "missing_commit_ref"
	| "conflicting_carry"
	| "fabricated_carry_extension"
	| "unverified_note"
	| "acknowledgement_unsupported"
	| "malformed_continuity_record"
	| "malformed_record";

export interface ContinuityAnomaly {
	kind: ContinuityAnomalyKind;
	entryId: string | null;
	detail: string;
}

export type ContinuityRecallReason =
	| "historical_fork"
	| "conflicting_evidence"
	| "missing_evidence"
	| "attempts_exhausted"
	| "deadline_expired"
	| "clock_ambiguous"
	| "paused"
	| "failed";

/**
 * Reconstruction of a commit that a validated carry proves existed. The
 * envelope is the original reserved one, so appending it creates no new
 * identity; `carriedState` is the later head to keep, so appending the old
 * commit at the end of the file cannot regress the fold on reload.
 */
export interface MissingCommitReconstruction {
	entry: ContinuityCommitEntry;
	carriedState: ContinuityCarriedState;
}

export type ContinuityRecoveryAction =
	| { kind: "none" }
	| { kind: "recall_only"; reason: ContinuityRecallReason }
	| { kind: "reconstruct_commit"; reconstruction: MissingCommitReconstruction }
	| { kind: "pause"; reason: HandoffPauseReason }
	| { kind: "fail"; reason: HandoffFailureReason };

/**
 * Whether this projection may act on the transaction at all. `recall_only`
 * means the note can be shown and nothing else; it is the standing answer for
 * an inherited historical note and for any evidence the fold could not verify.
 */
export type ContinuityAuthority = "none" | "recall_only" | "execution";

/**
 * A transaction from an earlier compaction cycle on the same path.
 *
 * Repeated `self_compact` cycles leave several completed transactions in one
 * ledger. They are history, not rivals: a prior handoff is neither a
 * conflicting identity for the selected one nor a source of authority for it.
 * Its note stays recallable, which is all the projection needs.
 */
export interface ContinuityPriorHandoff {
	handoffId: string;
	commitId: string;
	phase: ContinuityPhase;
	accepted: AcceptedNote | null;
	outcome: ContinuityOutcome | null;
}

export interface ContinuityFoldResult {
	phase: ContinuityPhase;
	authority: ContinuityAuthority;
	identity: HandoffIdentity | null;
	accepted: AcceptedNote | null;
	policy: HandoffPolicy | null;
	commit: ContinuityCommitData | null;
	state: ContinuityCarriedState | null;
	/** Attempts already journaled. Never refunded by a pause or a resume. */
	attemptsSpent: number;
	/** The deadline in force, after clamping and any validated resume. */
	effectiveDeadlineAtMs: number | null;
	/** Set when a validated carry proves a commit that is absent from the input. */
	missingCommit: MissingCommitReconstruction | null;
	/**
	 * True when every record and reference this fold relied on validated.
	 * A historical inherited note is `validated` and still recall-only; a chain
	 * with conflicting copies is neither. Only a validated fold may be projected
	 * into a new carry or a reconstruction.
	 */
	validated: boolean;
	anomalies: ReadonlyArray<ContinuityAnomaly>;
	/** Proposed only. Inspection never invokes it. */
	action: ContinuityRecoveryAction;
	/**
	 * Earlier completed or abandoned transactions on this path, oldest first.
	 * Recall projection only.
	 */
	priorHandoffs: ReadonlyArray<ContinuityPriorHandoff>;
	skipped: { inapplicable: number; unreadable: number };
}

// ---------------------------------------------------------------------------
// Persistence ports
// ---------------------------------------------------------------------------

/** A record the group persister may append. Identity is already allocated. */
export interface ContinuityAppendable {
	kind: string;
	turnId: string;
	[field: string]: unknown;
}

/**
 * Readback is four-valued on purpose. A boolean would let malformed data stand
 * in for proven absence, and only proven absence licenses a re-append.
 */
export type ContinuityReadback =
	| { status: "matching" }
	| { status: "absent" }
	| { status: "conflicting"; detail?: string }
	| { status: "unresolved"; detail?: string };

export interface ContinuityPersistencePorts {
	/** Append one record. A throw proves neither success nor absence. */
	append(entry: ContinuityAppendable): void;
	/**
	 * Authoritative lookup for exactly this record.
	 *
	 * The expected record is passed in rather than a `(kind, id)` pair, because
	 * a port given only an id cannot compare payload and would have to answer
	 * from the id alone. A stored record with this id but different bytes must
	 * return `conflicting`; it must never return `matching`. `unresolved` is the
	 * answer whenever the ledger could not be read cleanly, including a
	 * malformed line anywhere that could hide this record.
	 */
	readExact(expected: ContinuityAppendable): ContinuityReadback;
	/** Synchronous fsync barrier. Absent means an unsupported port, never success. */
	flushAppends?: () => void;
	/** Transcript + tree + meta barrier. Absent means an unsupported port. */
	checkpoint?: (reason: string) => Promise<void>;
	isStateRemoved(): boolean;
	isOriginCurrent(): boolean;
}

export interface ContinuityRetrySchedule {
	/** Barrier retries after the first attempt. */
	limit: number;
	/** Absolute deadline; no retry starts at or after it. */
	deadlineAtMs: number;
	now(): number;
	wait(attempt: number): Promise<void>;
}

export type ContinuityBarrier = { kind: "flush" } | { kind: "checkpoint"; reason: string };

/**
 * Progress from a previous partial attempt at this same group.
 *
 * An entry id alone would let a changed payload hide behind an accepted id, so
 * each token carries the digest of the record that was actually accepted. A
 * token whose digest does not match this request's record of the same id is a
 * different request, and the group is refused rather than silently completed.
 */
export interface ContinuityAcceptedProgress {
	entryId: string;
	payloadDigest: string;
}

export interface ContinuityPersistRequest {
	/** Ordered group. One barrier runs after the complete group. */
	entries: ReadonlyArray<ContinuityAppendable>;
	barrier: ContinuityBarrier;
	/** What a previous attempt at this exact group already got accepted. */
	alreadyAccepted?: ReadonlyArray<ContinuityAcceptedProgress>;
}

export type ContinuityPersistBlockedReason =
	| "append_absent_after_retry"
	| "append_conflicting"
	| "append_unresolved"
	| "barrier_failed"
	| "unsupported_barrier_port"
	| "state_removed"
	| "origin_changed"
	| "invalid_retry_schedule"
	| "deadline_expired"
	| "duplicate_group_entry"
	| "progress_mismatch";

export type ContinuityPersistResult =
	| {
			status: "durable";
			accepted: ReadonlyArray<ContinuityAcceptedProgress>;
			barrierAttempts: number;
			/**
			 * True only when the barrier is **known** to have completed inside the
			 * window: the clock stayed usable and monotonic throughout and had not
			 * reached the deadline. A barrier that landed late and one whose clock
			 * became unusable are both `false`, because neither confirms anything.
			 *
			 * The records are persisted either way. `false` is not a persistence
			 * failure; it means the caller must re-authorize before dependent
			 * execution rather than inherit permission from this call.
			 */
			confirmedWithinDeadline: boolean;
	  }
	| {
			status: "uncertain";
			reason: ContinuityPersistBlockedReason;
			accepted: ReadonlyArray<ContinuityAcceptedProgress>;
			barrierAttempts: number;
			anomalies: ReadonlyArray<ContinuityAnomaly>;
	  };

export type ContinuityReconcileResult =
	| { status: "accepted" }
	/** Proven absent, and the re-append under the original id also failed. */
	| { status: "absent"; detail?: string }
	| { status: "conflicting"; detail?: string }
	| { status: "unresolved"; detail?: string };
