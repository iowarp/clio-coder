/**
 * Structural validation for continuity records (CONTRACTS.md §3).
 *
 * These guards are independent of `isSessionEntry` and check the envelope
 * locally, so `entries.ts` can call them in 02B without this module ever
 * value-importing the session entry union back. They validate payload structure
 * and references, not just the kind string: a record that merely says
 * `kind: "continuityCommit"` and carries nothing usable is rejected here rather
 * than surfacing as an empty-but-present commit later.
 *
 * Everything numeric must be a finite integer. `Number.MAX_SAFE_INTEGER`
 * arithmetic and `Infinity` deadlines are both ways to obtain an unbounded
 * automatic window, so neither is accepted.
 */

import {
	type AcceptedNote,
	type ContinuityCarriedState,
	type ContinuityCarryingSummary,
	type ContinuityCheckpointPayload,
	type ContinuityCommitData,
	type ContinuityCommitEntry,
	type ContinuityOutcome,
	HANDOFF_NOTE_MAX_BYTES,
	HANDOFF_POLICY_LIMITS,
	HANDOFF_SCHEMA_VERSION,
	type HandoffEvent,
	type HandoffFailureReason,
	type HandoffIdentity,
	type HandoffPauseReason,
	type HandoffPolicy,
	type HandoffResumeAuthority,
	type HandoffTransactionEntry,
	type TransitionLink,
} from "./contract.js";

const OUTCOMES: ReadonlySet<string> = new Set<ContinuityOutcome>(["summarized", "evicted", "continuity_only"]);
const PAUSE_REASONS: ReadonlySet<string> = new Set<HandoffPauseReason>([
	"operator_cancelled",
	"origin_changed",
	"delivery_uncertain",
]);
const FAILURE_REASONS: ReadonlySet<string> = new Set<HandoffFailureReason>([
	"invalid_note",
	"note_exceeds_replay_budget",
	"budget_unsafe_no_material",
	"durability_unresolved",
	"state_root_removed",
	"origin_changed",
	"provider_failed",
	"attempts_exhausted",
	"deadline_exceeded",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || isNonEmptyString(value);
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return isFiniteInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return isFiniteInteger(value) && value > 0;
}

/** A valid `BaseSessionEntry` envelope, checked without importing the union. */
function hasEntryEnvelope(value: unknown, kind: string): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	return (
		value.kind === kind &&
		isNonEmptyString(value.turnId) &&
		isNullableString(value.parentTurnId) &&
		isNonEmptyString(value.timestamp)
	);
}

function isAcceptedNote(value: unknown): value is AcceptedNote {
	if (!isRecord(value)) return false;
	return (
		typeof value.note === "string" &&
		value.note.length > 0 &&
		isPositiveInteger(value.noteBytes) &&
		value.noteBytes <= HANDOFF_NOTE_MAX_BYTES &&
		typeof value.noteSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(value.noteSha256)
	);
}

function isHandoffIdentity(value: unknown): value is HandoffIdentity {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.handoffId) &&
		isNonEmptyString(value.preparedEntryId) &&
		isNonEmptyString(value.commitId) &&
		isNonEmptyString(value.commitEntryId) &&
		isNonEmptyString(value.originSessionId) &&
		isNullableString(value.branchAnchorTurnId) &&
		isNonEmptyString(value.initiatingTurnId) &&
		isNonEmptyString(value.toolCallId) &&
		typeof value.sourceRevision === "string"
	);
}

/**
 * A persisted policy is held to the frozen §2/§7 ceilings, not merely to being
 * positive. A ledger record claiming three attempts, a summary-retry loop, or
 * eight stream invocations would otherwise widen the automatic budget just by
 * surviving a restart.
 */
function isHandoffPolicy(value: unknown): value is HandoffPolicy {
	if (!isRecord(value)) return false;
	if (!isNonNegativeInteger(value.preparedAtMs)) return false;
	if (!isPositiveInteger(value.automaticDeadlineAtMs)) return false;
	// A deadline at or before preparation is not a window.
	if (value.automaticDeadlineAtMs <= value.preparedAtMs) return false;
	if (!isPositiveInteger(value.maxAttempts) || value.maxAttempts > HANDOFF_POLICY_LIMITS.maxAttempts) return false;
	if (
		!isPositiveInteger(value.maxSummaryCallsPerAttempt) ||
		value.maxSummaryCallsPerAttempt > HANDOFF_POLICY_LIMITS.maxSummaryCallsPerAttempt
	) {
		return false;
	}
	if (value.additionalSummaryRetriesPerCall !== HANDOFF_POLICY_LIMITS.additionalSummaryRetriesPerCall) return false;
	if (
		!isPositiveInteger(value.maxSummaryStreamInvocations) ||
		value.maxSummaryStreamInvocations > HANDOFF_POLICY_LIMITS.maxSummaryStreamInvocations
	) {
		return false;
	}
	return isNonNegativeInteger(value.flushRetryLimit) && value.flushRetryLimit <= HANDOFF_POLICY_LIMITS.flushRetryLimit;
}

/**
 * Stable value identity with normalized key order, used for comparing two
 * copies of one record and for the persistence progress token. `undefined`
 * fields are dropped so an explicitly-absent optional and a missing one are the
 * same record.
 */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const fields = Object.entries(value as Record<string, unknown>)
		.filter(([, field]) => field !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(",")}}`;
}

function isTransitionLink(value: unknown): value is TransitionLink {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.entryId) &&
		isNullableString(value.prevEntryId) &&
		isNonNegativeInteger(value.sequence) &&
		isNonNegativeInteger(value.attempt)
	);
}

function isResumeAuthority(value: unknown): value is HandoffResumeAuthority {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.operatorRequestEntryId) &&
		isNonEmptyString(value.pausedOrFailedEntryId) &&
		(value.action === "reduce" || value.action === "deliver") &&
		isPositiveInteger(value.automaticDeadlineAtMs)
	);
}

/** Validate one event, discriminating on `phase` and requiring that phase's fields. */
export function isHandoffEvent(value: unknown): value is HandoffEvent {
	if (!isRecord(value)) return false;
	switch (value.phase) {
		case "prepared":
			return isAcceptedNote(value.accepted) && isHandoffPolicy(value.policy);
		case "reducing":
			return value.resumeRef === undefined || isNonEmptyString(value.resumeRef);
		case "delivered":
			return (
				isNonEmptyString(value.deliveryId) &&
				isNonEmptyString(value.continuationTurnId) &&
				(value.resumeRef === undefined || isNonEmptyString(value.resumeRef))
			);
		case "acknowledged":
			return isNonEmptyString(value.deliveryId) && isNonEmptyString(value.terminalResponseEntryId);
		case "paused":
			return typeof value.reason === "string" && PAUSE_REASONS.has(value.reason);
		case "failed":
			return typeof value.reason === "string" && FAILURE_REASONS.has(value.reason);
		case "resumed":
			return isResumeAuthority(value.authority);
		default:
			return false;
	}
}

/**
 * A transaction record. Beyond the field shapes this enforces the two identity
 * equalities the chain depends on: the envelope's `turnId` is the transition's
 * `entryId`, and a `prepared` event must occupy the reserved prepared identity
 * at sequence 0 with no predecessor.
 */
export function isHandoffTransactionEntry(value: unknown): value is HandoffTransactionEntry {
	if (!hasEntryEnvelope(value, "handoffTransaction")) return false;
	if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION) return false;
	if (!isHandoffIdentity(value.identity)) return false;
	if (!isTransitionLink(value.transition)) return false;
	if (!isHandoffEvent(value.event)) return false;
	if (value.transition.entryId !== value.turnId) return false;
	if (value.event.phase === "prepared") {
		return (
			value.transition.entryId === value.identity.preparedEntryId &&
			value.transition.prevEntryId === null &&
			value.transition.sequence === 0 &&
			value.transition.attempt === 0
		);
	}
	// Only `prepared` may be the chain root.
	return value.transition.prevEntryId !== null && value.transition.sequence > 0;
}

function isCommitData(value: unknown): value is ContinuityCommitData {
	if (!isRecord(value)) return false;
	if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return false;
	if (!isRecord(value.entry)) return false;
	if (!isNonEmptyString(value.entry.turnId)) return false;
	if (!isNullableString(value.entry.parentTurnId)) return false;
	if (!isNonEmptyString(value.entry.timestamp)) return false;
	if (!isTransitionLink(value.transition)) return false;
	if (value.transition.entryId !== value.entry.turnId) return false;
	if (!isNonNegativeInteger(value.tokensBefore) || !isNonNegativeInteger(value.tokensAfter)) return false;
	// The ref an outcome names is required for that outcome and forbidden for
	// the others: an eviction-only commit that also claims a summary ref is not
	// a record this core will treat as valid evidence.
	if (value.outcome === "summarized") {
		return isNonEmptyString(value.summaryRef) && value.evictionRef === undefined;
	}
	if (value.outcome === "evicted") {
		return isNonEmptyString(value.evictionRef) && value.summaryRef === undefined;
	}
	return value.summaryRef === undefined && value.evictionRef === undefined;
}

/**
 * A head must be internally consistent, not merely well-shaped. A phase name is
 * not authority: a `resumed` head has to carry the resume it names, and a
 * `delivered` head the delivery intent it describes, or the payload is claiming
 * a state it does not actually record.
 */
function isCarriedState(value: unknown): value is ContinuityCarriedState {
	if (!isRecord(value)) return false;
	if (!isTransitionLink(value.transition)) return false;
	if (!isRecord(value.event)) return false;
	if (value.event.phase !== "ready" && !isHandoffEvent(value.event)) return false;
	if (value.event.phase === "ready" && Object.keys(value.event).length !== 1) return false;
	if (value.activeResume !== null) {
		if (!isRecord(value.activeResume)) return false;
		if (!isNonEmptyString(value.activeResume.entryId)) return false;
		if (!isResumeAuthority(value.activeResume.authority)) return false;
	}
	if (value.delivery !== null) {
		if (!isRecord(value.delivery)) return false;
		if (!isNonEmptyString(value.delivery.deliveryId)) return false;
		if (!isNonEmptyString(value.delivery.continuationTurnId)) return false;
	}
	if (value.event.phase === "resumed") {
		const resume = value.activeResume;
		if (!isRecord(resume)) return false;
		if (resume.entryId !== value.transition.entryId) return false;
		if (canonicalJson(resume.authority) !== canonicalJson(value.event.authority)) return false;
	}
	if (value.event.phase === "delivered") {
		const delivery = value.delivery;
		if (!isRecord(delivery)) return false;
		if (delivery.deliveryId !== value.event.deliveryId) return false;
		if (delivery.continuationTurnId !== value.event.continuationTurnId) return false;
	}
	return true;
}

/**
 * The shared payload a commit embeds and a later summary carries.
 *
 * The carried `state` must extend the commit's own chain, so its sequence is
 * required to be at least the commit's. A payload whose head sits before its
 * own commit describes no chain this core can fold.
 */
export function isContinuityCheckpointPayload(value: unknown): value is ContinuityCheckpointPayload {
	if (!isRecord(value)) return false;
	if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION) return false;
	if (!isHandoffIdentity(value.identity)) return false;
	if (!isAcceptedNote(value.accepted)) return false;
	if (!isHandoffPolicy(value.policy)) return false;
	if (!isCommitData(value.commit)) return false;
	if (!isCarriedState(value.state)) return false;
	if (value.commit.entry.turnId !== value.identity.commitEntryId) return false;
	// A commit exists because a reduction was spent, and no more of them than the
	// policy allows. An attempt of 0 or 99 on a commit describes a history the
	// policy could not have produced, whatever else the payload says.
	if (value.commit.transition.attempt < 1 || value.commit.transition.attempt > value.policy.maxAttempts) return false;
	if (value.state.transition.attempt > value.policy.maxAttempts) return false;
	if (value.state.transition.sequence < value.commit.transition.sequence) return false;
	// `ready` is definitionally the commit's own transition, so a payload
	// claiming ready at some other link is describing a state that never
	// existed. This is what stops a carry from asserting `ready` at an invented
	// sequence the chain never reached.
	if (value.state.event.phase === "ready") {
		return canonicalJson(value.state.transition) === canonicalJson(value.commit.transition);
	}
	// Past the commit, a reduction has necessarily been spent.
	return value.state.transition.attempt >= value.commit.transition.attempt;
}

/**
 * An original commit record. Beyond the shared payload it must be the envelope
 * its payload reserved and must carry the exact original `ready` state: an
 * advanced head belongs on a later summary carry, never on the commit itself.
 */
export function isContinuityCommitEntry(value: unknown): value is ContinuityCommitEntry {
	if (!hasEntryEnvelope(value, "continuityCommit")) return false;
	if (!isContinuityCheckpointPayload(value.continuity)) return false;
	const payload = value.continuity;
	if (payload.state.event.phase !== "ready") return false;
	if (payload.state.activeResume !== null || payload.state.delivery !== null) return false;
	return (
		value.turnId === payload.commit.entry.turnId &&
		value.parentTurnId === payload.commit.entry.parentTurnId &&
		value.timestamp === payload.commit.entry.timestamp
	);
}

/**
 * A compaction summary carrying continuity. Recognized structurally so 02A adds
 * no field to the live `CompactionSummaryEntry`; a summary without the field is
 * an ordinary summary and not this shape.
 */
export function isContinuityCarryingSummary(value: unknown): value is ContinuityCarryingSummary {
	if (!hasEntryEnvelope(value, "compactionSummary")) return false;
	return isContinuityCheckpointPayload(value.continuity);
}
