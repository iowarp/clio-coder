/**
 * The pure validating continuity fold (CONTRACTS.md §3, §7, §8).
 *
 * Given one ordered applicable projection of the ledger, this returns the state
 * of the selected transaction, the recallable note, the anomalies it found, and
 * a **proposed** recovery action. It reads no clock, mints no id, touches no
 * disk, calls no model, and never performs the action it proposes.
 *
 * The rules that decide what may extend a chain:
 *
 *   - A real record extends the chain only as a validated successor:
 *     predecessor equals the head, sequence is head + 1, attempt moves only for
 *     `reducing`, and the phase is legal from the head's phase. A higher
 *     sequence number is never on its own a reason to advance, for a commit any
 *     more than for an event.
 *   - A summary carry is a projection of a chain whose middle was cut out of
 *     this input, so it may be ahead of the observed head. It may never
 *     contradict what was observed: it cannot reopen a terminal state, walk the
 *     lifecycle backwards, leave a pause without a resume, or disagree with the
 *     observed identity, note, policy or commit.
 *   - An exact original commit appended after a validated later carry is the one
 *     legitimate out-of-order case. It fills the commit's presence and does not
 *     move the head, so recovery can write the record it owes without regressing
 *     an acknowledgement or a pause on the next reload.
 *   - Missing-commit classification waits for the whole input, because an
 *     initial summary legitimately precedes its own commit, and is abandoned
 *     entirely when unreadable records could still hide it.
 */

import {
	type AcceptedNote,
	type ContinuityAnomaly,
	type ContinuityAuthority,
	type ContinuityCarriedState,
	type ContinuityCheckpointPayload,
	type ContinuityCommitData,
	type ContinuityCommitEntry,
	type ContinuityFoldInput,
	type ContinuityFoldResult,
	type ContinuityOutcomeEvidence,
	type ContinuityPhase,
	type ContinuityPriorHandoff,
	type ContinuityRecoveryAction,
	HANDOFF_MAX_WINDOW_MS,
	HANDOFF_SCHEMA_VERSION,
	type HandoffEvent,
	type HandoffEventPhase,
	type HandoffIdentity,
	type HandoffPolicy,
	type HandoffResumeAuthority,
	type HandoffTransactionEntry,
	type MissingCommitReconstruction,
	type OperatorResumeAuthorityEvidence,
	type TerminalResponseEvidence,
} from "./contract.js";
import { verifyAcceptedNote } from "./note.js";
import {
	canonicalJson,
	isContinuityCarryingSummary,
	isContinuityCheckpointPayload,
	isContinuityCommitEntry,
	isHandoffTransactionEntry,
} from "./validate.js";

/** Phases a real successor may legally follow. */
const LEGAL_PREDECESSORS: Readonly<Record<HandoffEventPhase | "ready", ReadonlySet<ContinuityPhase>>> = Object.freeze({
	prepared: new Set<ContinuityPhase>(["absent"]),
	reducing: new Set<ContinuityPhase>(["prepared", "failed", "resumed"]),
	ready: new Set<ContinuityPhase>(["reducing"]),
	delivered: new Set<ContinuityPhase>(["ready", "resumed"]),
	acknowledged: new Set<ContinuityPhase>(["delivered"]),
	paused: new Set<ContinuityPhase>(["prepared", "reducing", "ready", "delivered", "resumed"]),
	failed: new Set<ContinuityPhase>(["prepared", "reducing", "resumed"]),
	resumed: new Set<ContinuityPhase>(["paused", "failed"]),
});

/** Position in the linear lifecycle, for carry comparison. Side states are -1. */
const LIFECYCLE_RANK: Readonly<Record<ContinuityPhase, number>> = Object.freeze({
	absent: 0,
	prepared: 1,
	reducing: 2,
	ready: 3,
	delivered: 4,
	acknowledged: 5,
	paused: -1,
	failed: -1,
	resumed: -1,
});

/** A usable durable timestamp: finite, non-negative, and an exact integer. */
function isUsableTimestamp(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

interface ChainState {
	handoffId: string;
	rootPosition: number;
	identity: HandoffIdentity | null;
	accepted: AcceptedNote | null;
	policy: HandoffPolicy | null;
	commit: ContinuityCommitData | null;
	head: { transition: ContinuityCarriedState["transition"]; event: HandoffEvent | { phase: "ready" } } | null;
	activeResume: { entryId: string; authority: HandoffResumeAuthority } | null;
	/** The evidence row that authorized `activeResume`, for the renewal base. */
	resumeEvidence: OperatorResumeAuthorityEvidence | null;
	delivery: { deliveryId: string; continuationTurnId: string } | null;
	/** Ledger position of the delivery intent, when its record is retained. */
	deliveryPosition: number | null;
	carry: ContinuityCheckpointPayload | null;
	commitPresent: boolean;
	rootSeen: boolean;
	seen: Map<string, string>;
	anomalies: ContinuityAnomaly[];
	poisoned: boolean;
}

function newChain(handoffId: string, position: number): ChainState {
	return {
		handoffId,
		rootPosition: position,
		identity: null,
		accepted: null,
		policy: null,
		commit: null,
		head: null,
		activeResume: null,
		resumeEvidence: null,
		delivery: null,
		deliveryPosition: null,
		carry: null,
		commitPresent: false,
		rootSeen: false,
		seen: new Map(),
		anomalies: [],
		poisoned: false,
	};
}

function fail(chain: ChainState, kind: ContinuityAnomaly["kind"], entryId: string | null, detail: string): void {
	chain.anomalies.push({ kind, entryId, detail });
	chain.poisoned = true;
}

function headPhase(chain: ChainState): ContinuityPhase {
	return chain.head ? (chain.head.event.phase as ContinuityPhase) : "absent";
}

function duplicateVerdict(chain: ChainState, entryId: string, payload: string): "new" | "identical" | "conflict" {
	const previous = chain.seen.get(entryId);
	if (previous === undefined) {
		chain.seen.set(entryId, payload);
		return "new";
	}
	return previous === payload ? "identical" : "conflict";
}

/** Immutable facts every copy of one transaction must agree on. */
function adoptImmutable(
	chain: ChainState,
	entryId: string,
	identity: HandoffIdentity,
	accepted: AcceptedNote,
	policy: HandoffPolicy,
): boolean {
	if (chain.identity === null) {
		chain.identity = identity;
	} else if (canonicalJson(chain.identity) !== canonicalJson(identity)) {
		fail(chain, "duplicate_conflict", entryId, "identity differs across copies of one handoff");
		return false;
	}
	// Every initial authority source is verified, not only the second one: a
	// carry-only note whose stored hash disagrees with its text must not become
	// the chain's accepted note.
	const verified = verifyAcceptedNote(accepted, chain.accepted ?? undefined);
	if (!verified.ok) {
		fail(chain, chain.accepted ? "conflicting_carry" : "unverified_note", entryId, `note rejected: ${verified.reason}`);
		return false;
	}
	chain.accepted ??= accepted;
	if (chain.policy === null) {
		chain.policy = policy;
	} else if (canonicalJson(chain.policy) !== canonicalJson(policy)) {
		fail(chain, "policy_conflict", entryId, "policy differs across copies of one handoff");
		return false;
	}
	return true;
}

function adoptCommit(chain: ChainState, entryId: string, commit: ContinuityCommitData): boolean {
	if (chain.commit === null) {
		chain.commit = commit;
		return true;
	}
	if (canonicalJson(chain.commit) !== canonicalJson(commit)) {
		fail(chain, "conflicting_carry", entryId, "commit data differs across copies of one handoff");
		return false;
	}
	return true;
}

/**
 * Validate a real successor against the observed head: legal phase, exact
 * predecessor, sequence + 1, and the attempt rule. Used for events and for a
 * commit alike, because "a larger sequence number is not proof of a valid
 * chain" applies to both.
 */
function validSuccessor(
	chain: ChainState,
	entryId: string,
	phase: ContinuityPhase,
	transition: ContinuityCarriedState["transition"],
): boolean {
	const from = headPhase(chain);
	if (!LEGAL_PREDECESSORS[phase as HandoffEventPhase | "ready"].has(from)) {
		fail(chain, "illegal_transition", entryId, `${from} -> ${phase} is not a legal transition`);
		return false;
	}
	if (phase === "prepared") return true;
	const head = chain.head;
	if (!head) {
		fail(chain, "broken_chain", entryId, `${phase} has no predecessor in this projection`);
		return false;
	}
	if (transition.prevEntryId !== head.transition.entryId) {
		fail(chain, "broken_chain", entryId, `predecessor ${transition.prevEntryId} is not the head`);
		return false;
	}
	if (transition.sequence !== head.transition.sequence + 1) {
		fail(chain, "broken_chain", entryId, `sequence ${transition.sequence} does not follow the head`);
		return false;
	}
	const expectedAttempt = phase === "reducing" ? head.transition.attempt + 1 : head.transition.attempt;
	if (transition.attempt !== expectedAttempt) {
		fail(chain, "invalid_attempt", entryId, `attempt ${transition.attempt} should be ${expectedAttempt}`);
		return false;
	}
	if (phase === "reducing" && chain.policy && transition.attempt > chain.policy.maxAttempts) {
		fail(chain, "invalid_attempt", entryId, `attempt ${transition.attempt} exceeds the policy maximum`);
		return false;
	}
	return true;
}

/**
 * A successor of a resume must cite it and match the action it was granted. The
 * same rule governs a real event and a one-step carried successor, because a
 * carry that names the adjacent link is making the same claim a record would.
 */
function resumeRefValid(chain: ChainState, entryId: string, event: HandoffEvent | { phase: "ready" }): boolean {
	if (event.phase !== "reducing" && event.phase !== "delivered") return true;
	const ref = event.resumeRef;
	if (headPhase(chain) !== "resumed") {
		if (ref === undefined) return true;
		fail(chain, "missing_resume_ref", entryId, "resumeRef names a resume this event does not follow");
		return false;
	}
	const resume = chain.activeResume;
	if (!resume || ref !== resume.entryId) {
		fail(chain, "missing_resume_ref", entryId, "event after a resume must name that resume");
		return false;
	}
	const wanted = event.phase === "reducing" ? "reduce" : "deliver";
	if (resume.authority.action !== wanted) {
		fail(chain, "illegal_transition", entryId, `resume granted ${resume.authority.action}, not ${wanted}`);
		return false;
	}
	return true;
}

interface ApplyContext {
	positions: ReadonlyMap<string, number>;
	/** The actual transaction records, by entry id, from this same input. */
	records: ReadonlyMap<string, HandoffTransactionEntry>;
	authorities: ReadonlyArray<OperatorResumeAuthorityEvidence>;
	sessionId: string;
}

/**
 * Bind a resume to a durable new operator control request. Every part of the
 * binding is required, and the request must sit strictly between the head it
 * answers and the resume that cites it: a request recorded before the pause
 * cannot have answered it, and one recorded after the resume cannot have
 * authorized it.
 */
function authorizeResume(
	chain: ChainState,
	entry: HandoffTransactionEntry,
	authority: HandoffResumeAuthority,
	position: number,
	context: ApplyContext,
): OperatorResumeAuthorityEvidence | null {
	// The answered head must be the resume's actual predecessor, so a request
	// answering an older pause cannot authorize a later one.
	if (entry.transition.prevEntryId !== authority.pausedOrFailedEntryId) {
		fail(chain, "unmatched_resume", entry.turnId, "resume authority does not name its own predecessor");
		return null;
	}
	if (authority.action === "deliver" && chain.commit === null) {
		fail(chain, "illegal_transition", entry.turnId, "resume to deliver requires a valid commit");
		return null;
	}
	// Once the reduction has committed there is nothing left to reduce; the
	// recovery path past a commit is delivery.
	if (authority.action === "reduce" && chain.commit !== null) {
		fail(chain, "illegal_transition", entry.turnId, "resume to reduce is not legal once a commit exists");
		return null;
	}
	const answered = context.positions.get(authority.pausedOrFailedEntryId);
	if (answered === undefined) {
		fail(chain, "unmatched_resume", entry.turnId, "the paused or failed head this resume answers is not in the input");
		return null;
	}
	const matched = context.authorities.find(
		(candidate) =>
			candidate.operatorRequestEntryId === authority.operatorRequestEntryId &&
			candidate.handoffId === chain.handoffId &&
			candidate.action === authority.action &&
			candidate.pausedOrFailedEntryId === authority.pausedOrFailedEntryId &&
			candidate.originSessionId === context.sessionId &&
			candidate.position > answered &&
			candidate.position < position,
	);
	if (!matched) {
		fail(
			chain,
			"unvalidated_resume_authority",
			entry.turnId,
			"no durable operator control request binds this handoff, action, head and position",
		);
		return null;
	}
	if (!isUsableTimestamp(matched.acceptedAtMs)) {
		fail(chain, "unvalidated_resume_authority", entry.turnId, "the operator request has no usable accepted time");
		return null;
	}
	return matched;
}

/**
 * Validate a resume that arrived through a summary carry.
 *
 * The references it names must resolve to real records in this input: the
 * answered paused/failed head and the resume itself, with the operator request
 * sitting strictly between them.
 *
 * The summary that carries the payload is **never** a stand-in for the resume's
 * own position. A request recorded before that summary is not thereby before the
 * resume the summary describes, and a carried payload is not evidence of when
 * the events it describes were written. A phase name is not authority either:
 * when a required reference cannot be resolved the transaction stays
 * recall-only and publishes no carry or reconstruction.
 */
function carriedResumeAuthorized(
	chain: ChainState,
	entryId: string,
	resume: { entryId: string; authority: HandoffResumeAuthority },
	context: ApplyContext,
	carriedPrevEntryId: string | null,
): OperatorResumeAuthorityEvidence | null {
	const refuse = (detail: string): null => {
		fail(chain, "unvalidated_resume_authority", entryId, detail);
		return null;
	};
	// When the carried head is the resume itself, its link must answer the head
	// its authority names; a request for an older pause authorizes nothing here.
	if (carriedPrevEntryId !== null) {
		if (carriedPrevEntryId !== resume.authority.pausedOrFailedEntryId) {
			return refuse("the carried resume does not follow the head its authority answers");
		}
		// A carried resumed head is a live request, so it obeys the same action
		// rule a real one does. A historical reduce resume that happened before
		// the commit and is merely retained under a later head is not this case.
		if (resume.authority.action === "reduce" && chain.commit !== null) {
			return refuse("a carried resume to reduce is not legal once a commit exists");
		}
		if (resume.authority.action === "deliver" && chain.commit === null) {
			return refuse("a carried resume to deliver requires a valid commit");
		}
	}
	// The referenced records are looked up and compared, not merely located by
	// id. A carry that reuses a real resume's id while rewriting its authority to
	// another genuine request names an event that never happened.
	const resumeRecord = context.records.get(resume.entryId);
	if (!resumeRecord || resumeRecord.event.phase !== "resumed") {
		return refuse("the carried resume names no actual resumed record in this input");
	}
	if (resumeRecord.identity.handoffId !== chain.handoffId) {
		return refuse("the referenced resumed record belongs to another handoff");
	}
	if (
		canonicalJson(resumeRecord.event.authority) !== canonicalJson(resume.authority) ||
		resumeRecord.transition.prevEntryId !== resume.authority.pausedOrFailedEntryId
	) {
		return refuse("the carried resume disagrees with the actual resumed record it names");
	}
	const answeredRecord = context.records.get(resume.authority.pausedOrFailedEntryId);
	if (!answeredRecord || (answeredRecord.event.phase !== "paused" && answeredRecord.event.phase !== "failed")) {
		return refuse("the head this carried resume answers is not an actual paused or failed record");
	}
	if (answeredRecord.identity.handoffId !== chain.handoffId) {
		return refuse("the answered paused or failed record belongs to another handoff");
	}
	const answered = context.positions.get(resume.authority.pausedOrFailedEntryId);
	const upper = context.positions.get(resume.entryId);
	if (answered === undefined || upper === undefined || upper <= answered) {
		return refuse("the carried resume does not sit after the head it answers");
	}
	const matched = context.authorities.find(
		(candidate) =>
			candidate.operatorRequestEntryId === resume.authority.operatorRequestEntryId &&
			candidate.handoffId === chain.handoffId &&
			candidate.action === resume.authority.action &&
			candidate.pausedOrFailedEntryId === resume.authority.pausedOrFailedEntryId &&
			candidate.originSessionId === context.sessionId &&
			isUsableTimestamp(candidate.acceptedAtMs) &&
			candidate.position > answered &&
			candidate.position < upper,
	);
	if (!matched) {
		return refuse("no durable operator control request binds this carried resume's handoff, action, head and order");
	}
	return matched;
}

function applyTransactionEvent(
	chain: ChainState,
	entry: HandoffTransactionEntry,
	position: number,
	context: ApplyContext,
): void {
	const verdict = duplicateVerdict(chain, entry.turnId, canonicalJson(entry));
	if (verdict === "identical") return;
	if (verdict === "conflict") {
		fail(chain, "duplicate_conflict", entry.turnId, `two different payloads share entry id ${entry.turnId}`);
		return;
	}

	if (entry.event.phase === "prepared") {
		if (!validSuccessor(chain, entry.turnId, "prepared", entry.transition)) return;
		if (!adoptImmutable(chain, entry.turnId, entry.identity, entry.event.accepted, entry.event.policy)) return;
		chain.rootSeen = true;
		chain.rootPosition = position;
	} else {
		if (chain.identity === null) {
			chain.identity = entry.identity;
		} else if (canonicalJson(chain.identity) !== canonicalJson(entry.identity)) {
			fail(chain, "duplicate_conflict", entry.turnId, "identity differs across records of one handoff");
			return;
		}
		if (!validSuccessor(chain, entry.turnId, entry.event.phase, entry.transition)) return;
	}

	// A failure only reopens reduction for a provider failure, and only within
	// the attempt budget. Every other failure reason is terminal for automatic
	// work and needs an explicit resume.
	if (entry.event.phase === "reducing" && headPhase(chain) === "failed") {
		const failure = chain.head?.event as Extract<HandoffEvent, { phase: "failed" }>;
		if (failure.reason !== "provider_failed") {
			fail(chain, "illegal_transition", entry.turnId, `failed(${failure.reason}) may not resume reduction`);
			return;
		}
	}

	if (!resumeRefValid(chain, entry.turnId, entry.event)) return;

	if (entry.event.phase === "resumed") {
		const evidence = authorizeResume(chain, entry, entry.event.authority, position, context);
		if (!evidence) return;
		chain.activeResume = { entryId: entry.turnId, authority: entry.event.authority };
		chain.resumeEvidence = evidence;
	}

	chain.head = { transition: entry.transition, event: entry.event };
	if (entry.event.phase === "delivered") {
		chain.delivery = { deliveryId: entry.event.deliveryId, continuationTurnId: entry.event.continuationTurnId };
		chain.deliveryPosition = position;
	}
}

/**
 * Apply a commit record. It is a validated successor of `reducing` like any
 * other event, with one deliberate exception: a commit that exactly matches a
 * commit a validated carry already described is the original being restored, so
 * it records presence and leaves the head alone.
 */
function applyCommit(chain: ChainState, entry: ContinuityCommitEntry): void {
	const payload = entry.continuity;
	const verdict = duplicateVerdict(chain, entry.turnId, canonicalJson(entry));
	if (verdict === "identical") {
		chain.commitPresent = true;
		return;
	}
	if (verdict === "conflict") {
		fail(chain, "duplicate_conflict", entry.turnId, `two different commit payloads share entry id ${entry.turnId}`);
		return;
	}
	if (!adoptImmutable(chain, entry.turnId, payload.identity, payload.accepted, payload.policy)) return;

	const known = chain.commit;
	const restoresKnownCommit = known !== null && canonicalJson(known) === canonicalJson(payload.commit);
	if (!adoptCommit(chain, entry.turnId, payload.commit)) return;

	if (restoresKnownCommit) {
		// The carry already proved this exact commit. Recording its presence is
		// the whole effect; moving the head would regress the carried state.
		chain.commitPresent = true;
		return;
	}
	if (!validSuccessor(chain, entry.turnId, "ready", payload.commit.transition)) return;
	chain.commitPresent = true;
	chain.head = { transition: payload.commit.transition, event: { phase: "ready" } };
}

/**
 * Whether a carried head may advance past an observed one.
 *
 * The intervening records were cut, so adjacency cannot be checked; what can be
 * checked is that the carry does not claim something the observed head rules
 * out. Linear phases must move strictly forward, because there is no legal
 * `ready -> ready` or `delivered -> delivered`; a terminal state is not
 * reopened; a pause is left only through a resume; and a failure reopens
 * reduction only when it was a provider failure.
 */
function carryMayAdvance(chain: ChainState, to: ContinuityPhase): boolean {
	const from = headPhase(chain);
	if (from === "absent") return true;
	if (from === "acknowledged") return false;
	if (from === "paused") return to === "resumed";
	if (from === "failed") {
		if (to === "resumed") return true;
		if (to !== "reducing") return false;
		const failure = chain.head?.event as Extract<HandoffEvent, { phase: "failed" }>;
		return failure.reason === "provider_failed";
	}
	if (to === "paused" || to === "failed" || to === "resumed") return true;
	return LIFECYCLE_RANK[to] > LIFECYCLE_RANK[from];
}

/**
 * Apply a summary-carried payload. The carry describes a chain whose middle was
 * cut out of this projection, so it may be ahead of the observed head; it may
 * never contradict what was observed, and at the same sequence it must be the
 * same state.
 */
function applyCarry(
	chain: ChainState,
	payload: ContinuityCheckpointPayload,
	entryId: string,
	context: ApplyContext,
): void {
	const verdict = duplicateVerdict(chain, entryId, canonicalJson(payload));
	if (verdict === "identical") return;
	if (verdict === "conflict") {
		fail(chain, "conflicting_carry", entryId, `two different carried payloads share entry id ${entryId}`);
		return;
	}
	if (!adoptImmutable(chain, entryId, payload.identity, payload.accepted, payload.policy)) return;
	if (!adoptCommit(chain, entryId, payload.commit)) return;

	if (chain.carry && payload.state.transition.sequence === chain.carry.state.transition.sequence) {
		if (canonicalJson(chain.carry.state) !== canonicalJson(payload.state)) {
			fail(chain, "conflicting_carry", entryId, "two carries disagree about the state at the same sequence");
			return;
		}
	}
	if (chain.carry === null || payload.state.transition.sequence > chain.carry.state.transition.sequence) {
		chain.carry = payload;
	}

	const head = chain.head;
	const carriedPhase = payload.state.event.phase as ContinuityPhase;
	let adjacent = false;
	if (head) {
		if (payload.state.transition.sequence === head.transition.sequence) {
			// At the same position the two must be the same state: link, event and
			// every retained field. A matching event under a different delivery or
			// an invented resume is a conflicting copy, not an idempotent repeat.
			const observed = {
				transition: head.transition,
				event: head.event,
				delivery: chain.delivery,
				activeResume: chain.activeResume,
			};
			const carried = {
				transition: payload.state.transition,
				event: payload.state.event,
				delivery: payload.state.delivery,
				activeResume: payload.state.activeResume,
			};
			if (canonicalJson(observed) !== canonicalJson(carried)) {
				fail(chain, "conflicting_carry", entryId, "the carry contradicts the observed head at the same sequence");
			}
			return;
		}
		if (payload.state.transition.sequence < head.transition.sequence) return;

		adjacent = payload.state.transition.sequence === head.transition.sequence + 1;
		if (adjacent) {
			// One step is one step whether a record or a carry describes it, so the
			// real successor rules apply in full: exact predecessor, the attempt
			// rule, and the legal phase.
			if (!validSuccessor(chain, entryId, carriedPhase, payload.state.transition)) return;
		} else {
			if (!carryMayAdvance(chain, carriedPhase)) {
				fail(chain, "fabricated_carry_extension", entryId, `a carry cannot move ${headPhase(chain)} to ${carriedPhase}`);
				return;
			}
			// Attempts are journaled and never refunded, so a carry that advances
			// the head while lowering the attempt count is another history.
			if (payload.state.transition.attempt < head.transition.attempt) {
				fail(chain, "invalid_attempt", entryId, "a carry cannot advance the head while refunding a spent attempt");
				return;
			}
		}
	}

	// A carried resume is held to the same durable operator authority a real one
	// is. Adopting the head first and checking later would let a phase name grant
	// execution for a request that never existed.
	const carriedResume = payload.state.activeResume;
	if (carriedResume) {
		const carriedPrev = carriedPhase === "resumed" ? payload.state.transition.prevEntryId : null;
		const evidence = carriedResumeAuthorized(chain, entryId, carriedResume, context, carriedPrev);
		if (!evidence) return;
		chain.activeResume = carriedResume;
		chain.resumeEvidence = evidence;
	} else if (carriedPhase === "resumed") {
		fail(chain, "unmatched_resume", entryId, "a carried resumed head retains no resume to validate");
		return;
	}

	// The resume reference is checked against the head the carry follows, which
	// is why it runs after the carried resume is in place and before the head
	// moves on from it.
	if (adjacent && !resumeRefValid(chain, entryId, payload.state.event)) return;

	chain.head = { transition: payload.state.transition, event: payload.state.event };
	if (payload.state.delivery) chain.delivery = payload.state.delivery;
}

function outcomeRefMatches(
	commit: ContinuityCommitData,
	identity: HandoffIdentity,
	refs: ReadonlyArray<ContinuityOutcomeEvidence>,
): boolean {
	if (commit.outcome === "continuity_only") return true;
	const expectedId = commit.outcome === "summarized" ? commit.summaryRef : commit.evictionRef;
	if (expectedId === undefined) return false;
	return refs.some(
		(ref) =>
			ref.entryId === expectedId &&
			ref.outcome === commit.outcome &&
			ref.handoffId === identity.handoffId &&
			ref.commitId === identity.commitId,
	);
}

/**
 * Acknowledgement needs a terminal success that is durable **before** the
 * acknowledgement and **after** the delivery it answers. Matching ids alone
 * would accept a response recorded after the acknowledgement that cites it, or
 * an older success for a newer delivery intent.
 *
 * Both bounds are required and both name real records in this input: the
 * delivery intent's own position and the acknowledgement's own position. The
 * summary that carried the state is never a stand-in for either, because a
 * carried payload is not evidence of when those events were written. Without
 * both bounds the order cannot be proven and the transaction stays recall-only.
 */
function acknowledgementSupported(
	event: Extract<HandoffEvent, { phase: "acknowledged" }>,
	delivery: { deliveryId: string; continuationTurnId: string } | null,
	responses: ReadonlyArray<TerminalResponseEvidence>,
	bounds: { deliveredAfter: number | null; acknowledgedBefore: number | null },
): boolean {
	if (!delivery || delivery.deliveryId !== event.deliveryId) return false;
	const { deliveredAfter, acknowledgedBefore } = bounds;
	if (deliveredAfter === null || acknowledgedBefore === null) return false;
	return responses.some(
		(response) =>
			response.entryId === event.terminalResponseEntryId &&
			response.continuationTurnId === delivery.continuationTurnId &&
			response.status === "success" &&
			Number.isFinite(response.position) &&
			response.position > deliveredAfter &&
			response.position < acknowledgedBefore,
	);
}

/**
 * The window in force, clamped to §7's ceiling. A renewal is measured from when
 * the operator control request was actually accepted, never from the deadline
 * the record asks for: deriving the base backwards would let a far-future
 * request renew itself without bound.
 */
function effectiveDeadline(
	policy: HandoffPolicy,
	resume: HandoffResumeAuthority | null,
	evidence: OperatorResumeAuthorityEvidence | null,
): number {
	if (resume && evidence) {
		return Math.min(resume.automaticDeadlineAtMs, evidence.acceptedAtMs + HANDOFF_MAX_WINDOW_MS);
	}
	return Math.min(policy.automaticDeadlineAtMs, policy.preparedAtMs + HANDOFF_MAX_WINDOW_MS);
}

function priorProjection(chain: ChainState): ContinuityPriorHandoff {
	return {
		handoffId: chain.handoffId,
		commitId: chain.identity?.commitId ?? "",
		phase: headPhase(chain),
		accepted: chain.accepted,
		outcome: chain.commit?.outcome ?? null,
	};
}

function applicable(identity: HandoffIdentity, input: ContinuityFoldInput, path: ReadonlySet<string>): boolean {
	if (identity.originSessionId !== input.selection.sessionId) return false;
	if (!path.has(identity.initiatingTurnId)) return false;
	return identity.branchAnchorTurnId === null || path.has(identity.branchAnchorTurnId);
}

/** A record that claims to be continuity but does not validate. */
function looksLikeContinuity(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.kind === "handoffTransaction" || record.kind === "continuityCommit") return true;
	return record.kind === "compactionSummary" && record.continuity !== undefined;
}

export function foldContinuity(input: ContinuityFoldInput): ContinuityFoldResult {
	const path = new Set(input.selection.pathTurnIds);
	const chains = new Map<string, ChainState>();
	const positions = new Map<string, number>();
	const ownerByEntryId = new Map<string, string>();
	/** Entry ids seen as real records here, so a duplicate cannot reorder them. */
	const observed = new Set<string>();
	const malformed: ContinuityAnomaly[] = [];
	let inapplicable = 0;

	const records = new Map<string, HandoffTransactionEntry>();
	const context: ApplyContext = {
		positions,
		records,
		authorities: input.evidence.resumeAuthorities,
		sessionId: input.selection.sessionId,
	};

	const chainFor = (handoffId: string, position: number): ChainState => {
		const existing = chains.get(handoffId);
		if (existing) return existing;
		const created = newChain(handoffId, position);
		chains.set(handoffId, created);
		return created;
	};

	// Entry ids are indexed first so a resume can be checked against the position
	// of the head it answers regardless of scan order. The input is the full
	// applicable ledger before the replay cut, so a record a reference names is
	// present here or nowhere; there is no second coordinate system to reconcile.
	for (let position = 0; position < input.entries.length; position += 1) {
		const raw = input.entries[position];
		if (isHandoffTransactionEntry(raw) || isContinuityCommitEntry(raw)) {
			// First occurrence wins. An identical duplicate appended later must not
			// reorder history and revoke authority that was already valid against
			// the original position.
			const entryId = (raw as { turnId: string }).turnId;
			if (!observed.has(entryId)) {
				observed.add(entryId);
				positions.set(entryId, position);
				if (isHandoffTransactionEntry(raw)) records.set(entryId, raw);
			}
		}
	}

	for (let position = 0; position < input.entries.length; position += 1) {
		const raw = input.entries[position];
		const transaction = isHandoffTransactionEntry(raw) ? raw : null;
		const commit = !transaction && isContinuityCommitEntry(raw) ? raw : null;
		const carrying = !transaction && !commit && isContinuityCarryingSummary(raw) ? raw : null;

		if (!transaction && !commit && !carrying) {
			// An unrelated kind is inert. A record that claims to be continuity and
			// does not validate is not: ignoring it silently would let malformed
			// evidence read as missing evidence.
			if (looksLikeContinuity(raw)) {
				malformed.push({
					kind: "malformed_continuity_record",
					entryId: typeof (raw as { turnId?: unknown }).turnId === "string" ? (raw as { turnId: string }).turnId : null,
					detail: "a record claiming a continuity kind failed structural validation",
				});
			}
			continue;
		}

		const identity = transaction?.identity ?? commit?.continuity.identity ?? carrying?.continuity.identity;
		if (!identity || !applicable(identity, input, path)) {
			inapplicable += 1;
			continue;
		}
		const entryId = (transaction ?? commit ?? carrying)?.turnId as string;
		const owner = ownerByEntryId.get(entryId);
		if (owner !== undefined && owner !== identity.handoffId) {
			const chain = chainFor(identity.handoffId, position);
			fail(chain, "entry_id_reused", entryId, `entry id is also used by handoff ${owner}`);
			const other = chains.get(owner);
			if (other) fail(other, "entry_id_reused", entryId, `entry id is also used by handoff ${identity.handoffId}`);
			continue;
		}
		ownerByEntryId.set(entryId, identity.handoffId);

		const chain = chainFor(identity.handoffId, position);
		if (transaction) applyTransactionEvent(chain, transaction, position, context);
		else if (commit) applyCommit(chain, commit);
		else if (carrying) applyCarry(chain, carrying.continuity, carrying.turnId, context);
	}

	const base: Pick<ContinuityFoldResult, "skipped"> = {
		skipped: { inapplicable, unreadable: input.evidence.unreadableRecords },
	};
	if (chains.size === 0) {
		return {
			phase: "absent",
			authority: "none",
			identity: null,
			accepted: null,
			policy: null,
			commit: null,
			state: null,
			attemptsSpent: 0,
			effectiveDeadlineAtMs: null,
			missingCommit: null,
			validated: malformed.length === 0,
			anomalies: malformed,
			action: { kind: "none" },
			priorHandoffs: [],
			...base,
		};
	}

	// Successive compaction cycles leave several transactions behind. The
	// newest chain root is the selected transaction; the rest are history whose
	// notes stay recallable and which authorize nothing here. A duplicate of an
	// older prepared record never moves its root, so it cannot re-elect itself.
	const ordered = [...chains.values()].sort((a, b) => a.rootPosition - b.rootPosition);
	const selected = ordered[ordered.length - 1] as ChainState;
	const priorHandoffs = ordered.slice(0, -1).map(priorProjection);

	return finalize(selected, input, positions, records, malformed, priorHandoffs, inapplicable);
}

function finalize(
	chain: ChainState,
	input: ContinuityFoldInput,
	positions: ReadonlyMap<string, number>,
	records: ReadonlyMap<string, HandoffTransactionEntry>,
	malformed: ReadonlyArray<ContinuityAnomaly>,
	priorHandoffs: ReadonlyArray<ContinuityPriorHandoff>,
	inapplicable: number,
): ContinuityFoldResult {
	const anomalies: ContinuityAnomaly[] = [...malformed, ...chain.anomalies];
	const unreadable = input.evidence.unreadableRecords;
	const identity = chain.identity;
	const policy = chain.policy;
	let poisoned = chain.poisoned || malformed.length > 0;

	// Unreadable records fail closed whether or not a commit is present: a line
	// this projection could not parse can hide a pause, a conflicting duplicate,
	// or the very evidence a reference needs. The note stays recallable; nothing
	// authoritative is published from unresolved input.
	if (unreadable > 0 && identity !== null) {
		anomalies.push({
			kind: "malformed_record",
			entryId: null,
			detail: `${unreadable} unreadable records leave this transaction's evidence unresolved`,
		});
		poisoned = true;
	}

	if (chain.commit && identity && !outcomeRefMatches(chain.commit, identity, input.evidence.outcomeRefs)) {
		anomalies.push({
			kind: unreadable > 0 ? "missing_commit_ref" : "unbound_outcome_ref",
			entryId: chain.commit.entry.turnId,
			detail: `no ${chain.commit.outcome} record is bound to commit ${identity.commitId}`,
		});
		poisoned = true;
	}

	const phase = headPhase(chain);
	if (phase === "acknowledged") {
		const event = chain.head?.event as Extract<HandoffEvent, { phase: "acknowledged" }>;
		// Both bounds come from actual records whose payloads are compared, not
		// from ids that merely resolve. When the head arrived through a carry, the
		// delivery intent is the acknowledgement's own predecessor link.
		const ackEntryId = chain.head?.transition.entryId ?? "";
		const deliveryEntryId = chain.head?.transition.prevEntryId ?? "";
		const ackRecord = records.get(ackEntryId);
		const deliveryRecord = records.get(deliveryEntryId);
		const ackMatches =
			ackRecord?.event.phase === "acknowledged" &&
			ackRecord.identity.handoffId === chain.handoffId &&
			ackRecord.event.deliveryId === event.deliveryId &&
			ackRecord.event.terminalResponseEntryId === event.terminalResponseEntryId;
		const deliveryMatches =
			deliveryRecord?.event.phase === "delivered" &&
			deliveryRecord.identity.handoffId === chain.handoffId &&
			deliveryRecord.event.deliveryId === (chain.delivery?.deliveryId ?? null) &&
			deliveryRecord.event.continuationTurnId === (chain.delivery?.continuationTurnId ?? null);
		const ackBounds = {
			deliveredAfter: deliveryMatches ? (chain.deliveryPosition ?? positions.get(deliveryEntryId) ?? null) : null,
			acknowledgedBefore: ackMatches ? (positions.get(ackEntryId) ?? null) : null,
		};
		if (!acknowledgementSupported(event, chain.delivery, input.evidence.terminalResponses, ackBounds)) {
			anomalies.push({
				kind: "acknowledgement_unsupported",
				entryId: chain.head?.transition.entryId ?? null,
				detail: "no terminal successful response matches this delivery",
			});
			poisoned = true;
		}
	}

	const state: ContinuityCarriedState | null = chain.head
		? {
				transition: chain.head.transition,
				event: chain.head.event,
				activeResume: chain.activeResume,
				delivery: chain.delivery,
			}
		: null;

	// Absence is concluded only from a complete, validated projection.
	let missingCommit: MissingCommitReconstruction | null = null;
	if (!chain.commitPresent && chain.carry && identity && state && !poisoned) {
		{
			const original = chain.carry.commit;
			const rebuilt: ContinuityCommitEntry = {
				kind: "continuityCommit",
				turnId: original.entry.turnId,
				parentTurnId: original.entry.parentTurnId,
				timestamp: original.entry.timestamp,
				continuity: {
					schemaVersion: HANDOFF_SCHEMA_VERSION,
					identity,
					accepted: chain.carry.accepted,
					policy: chain.carry.policy,
					commit: original,
					state: { transition: original.transition, event: { phase: "ready" }, activeResume: null, delivery: null },
				},
			};
			// Never publish a reconstruction this module would refuse to read.
			if (isContinuityCheckpointPayload(rebuilt.continuity)) {
				missingCommit = { entry: rebuilt, carriedState: state };
			} else {
				anomalies.push({
					kind: "conflicting_carry",
					entryId: original.entry.turnId,
					detail: "the reconstructed commit does not validate",
				});
				poisoned = true;
			}
		}
	}

	const attemptsSpent = chain.head?.transition.attempt ?? 0;
	// A clock that sits before preparation, or before the operator request a
	// renewal is measured from, cannot be used to decide a window. Either way
	// the operator recovers; the fold never silently grants time.
	const renewalBase = chain.resumeEvidence?.acceptedAtMs ?? null;
	const clockAmbiguous =
		!Number.isFinite(input.nowMs) ||
		(policy !== null && input.nowMs < policy.preparedAtMs) ||
		(renewalBase !== null && input.nowMs < renewalBase);
	const deadline = policy
		? effectiveDeadline(policy, chain.activeResume?.authority ?? null, chain.resumeEvidence)
		: null;
	const expired = deadline !== null && !clockAmbiguous && input.nowMs >= deadline;

	const action = resolveAction({
		historical: input.selection.historical,
		poisoned,
		phase,
		clockAmbiguous,
		expired,
		missingCommit,
		attemptsSpent,
		policy,
		delivery: chain.delivery,
		deliveryPosition: chain.deliveryPosition,
		responses: input.evidence.terminalResponses,
		committed: chain.commit !== null,
		resumeAction: chain.activeResume?.authority.action ?? null,
	});
	// Authority follows the action, so the two can never disagree about whether
	// automatic work may proceed. A transaction whose records were all rejected
	// still has an identity and a note, so it is recall-only rather than absent.
	const authority: ContinuityAuthority =
		identity === null
			? "none"
			: action.kind === "none" && phase !== "absent" && phase !== "acknowledged"
				? "execution"
				: "recall_only";

	return {
		phase,
		authority,
		identity,
		accepted: chain.accepted,
		policy,
		commit: chain.commit,
		state,
		attemptsSpent,
		effectiveDeadlineAtMs: deadline,
		missingCommit,
		validated: !poisoned,
		anomalies,
		action,
		priorHandoffs,
		skipped: { inapplicable, unreadable },
	};
}

function resolveAction(facts: {
	historical: boolean;
	poisoned: boolean;
	phase: ContinuityPhase;
	clockAmbiguous: boolean;
	expired: boolean;
	missingCommit: MissingCommitReconstruction | null;
	attemptsSpent: number;
	policy: HandoffPolicy | null;
	delivery: { deliveryId: string; continuationTurnId: string } | null;
	deliveryPosition: number | null;
	responses: ReadonlyArray<TerminalResponseEvidence>;
	committed: boolean;
	resumeAction: "reduce" | "deliver" | null;
}): ContinuityRecoveryAction {
	// Disputed evidence is reported before anything else, including an empty
	// head: a chain whose only records were rejected has evidence to explain,
	// not nothing to say.
	if (facts.poisoned) return { kind: "recall_only", reason: "conflicting_evidence" };
	if (facts.phase === "absent") return { kind: "none" };
	if (facts.phase === "acknowledged") return { kind: "none" };
	// An inherited note is recallable in any phase; a fresh explicit request is
	// what establishes ownership in the new session.
	if (facts.historical) return { kind: "recall_only", reason: "historical_fork" };
	if (facts.phase === "paused") return { kind: "recall_only", reason: "paused" };
	if (facts.phase === "failed") return { kind: "recall_only", reason: "failed" };
	if (facts.clockAmbiguous) return { kind: "recall_only", reason: "clock_ambiguous" };
	if (facts.expired) return { kind: "fail", reason: "deadline_exceeded" };

	if (facts.phase === "delivered") {
		// An older success for an earlier delivery does not resolve this one, and
		// an intent whose own position was cut cannot be ordered against anything.
		const supported =
			facts.deliveryPosition !== null &&
			facts.responses.some(
				(response) =>
					response.continuationTurnId === facts.delivery?.continuationTurnId &&
					response.status === "success" &&
					Number.isFinite(response.position) &&
					response.position > (facts.deliveryPosition as number),
			);
		return supported ? { kind: "none" } : { kind: "pause", reason: "delivery_uncertain" };
	}
	if (facts.missingCommit) return { kind: "reconstruct_commit", reconstruction: facts.missingCommit };
	// The attempt budget bounds reductions, not deliveries. Delivering a commit
	// the final attempt already produced, under an explicit operator request,
	// spends no attempt and is not a third reduction.
	const wouldReduce = !(facts.committed && facts.phase === "resumed" && facts.resumeAction === "deliver");
	if (facts.policy && facts.phase !== "ready" && wouldReduce && facts.attemptsSpent >= facts.policy.maxAttempts) {
		return { kind: "recall_only", reason: "attempts_exhausted" };
	}
	return { kind: "none" };
}
