/**
 * Building `ContinuityFoldEvidence` from an actual session ledger.
 *
 * `contract.ts` states what a caller's resolver must have proven before the
 * fold will treat a reference as authority. This module is that resolver for
 * Clio's ledger. It reads one ordered array, the full applicable ledger before
 * the replay cut, and every `position` it emits is an index into that same
 * array, because that is the only coordinate system the fold accepts.
 *
 * It resolves nothing it cannot prove. A control request whose timestamp does
 * not parse establishes no renewal base, so it is dropped rather than emitted
 * with a guessed time; an eviction that two commits both claim is ambiguous, so
 * neither claim becomes evidence. Dropping is the safe direction: missing
 * evidence leaves a transaction recall-only, while a fabricated row would
 * license execution.
 */

import type { MessageEntry, SessionEntry } from "../entries.js";
import type {
	ContinuityFoldEvidence,
	ContinuityOutcomeEvidence,
	OperatorResumeAuthorityEvidence,
	TerminalResponseEvidence,
} from "./contract.js";
import { isHandoffRecoveryRequestEntry } from "./operator-request.js";

export interface ContinuityEvidenceInput {
	/** The full applicable ledger before the replay cut, in ledger order. */
	entries: ReadonlyArray<SessionEntry>;
	/**
	 * Turn ids on the selected path. An operator control request whose claimed
	 * leaf is not on it was made on another branch and authorizes nothing here.
	 * Defaults to the message turns in `entries`.
	 */
	pathTurnIds?: ReadonlyArray<string>;
	/**
	 * Records the reader could not parse. A torn fragment must not become
	 * permission, so this count travels into the fold rather than being dropped
	 * by the collector that already skipped the line (§6).
	 */
	unreadableRecords: number;
}

/**
 * Classify one assistant response for acknowledgement.
 *
 * `success` is affirmative, not a default. The producer
 * (`interactive/chat-loop-messages.ts:assistantSessionPayload`) writes
 * `stopReason` **only** for a terminal failure, so a successful turn carries no
 * stop reason at all and demanding a canonical success value would reject every
 * real success. What can be required is everything else: no failure marker, no
 * error message, visible nonempty text, and no tool call still outstanding.
 *
 * That last condition is the one that matters most here. A turn whose content
 * holds a tool call has not terminated, whatever text it also produced: the host
 * reads those structured calls to decide the run continues. Treating it as a
 * terminal success would let an acknowledgement cite a turn that was still
 * working.
 */
function terminalStatus(entry: MessageEntry): TerminalResponseEvidence["status"] {
	const payload = entry.payload;
	if (!payload || typeof payload !== "object") return "empty";
	const record = payload as Record<string, unknown>;
	const stop = record.stopReason;
	if (stop === "error") return "error";
	if (stop === "aborted") return "aborted";
	if (stop === "interrupted") return "interrupted";
	if (typeof record.errorMessage === "string" && record.errorMessage.length > 0) return "error";
	// Any other recorded stop reason is a recorded failure or a non-terminal
	// stop (`toolUse`, `length`); neither acknowledges a delivery.
	if (stop !== undefined && stop !== "stop") return "empty";
	if (record.continuityDeliveryId !== undefined && stop !== "stop") return "empty";
	const content = Array.isArray(record.content) ? record.content : [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if ((block as Record<string, unknown>).type === "toolCall") return "empty";
	}
	if (typeof record.text === "string" && record.text.trim().length > 0) return "success";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as Record<string, unknown>;
		if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim().length > 0) return "success";
	}
	return "empty";
}

/**
 * Assistant responses, classified for acknowledgement.
 *
 * The continuation turn is the turn the response answers, which is the response
 * entry's structural parent. Packet 03 mints `delivered.continuationTurnId` as
 * that same turn id when it hands the replacement context over, so the two ends
 * of the binding meet on one ledger pointer rather than on a runtime handle.
 * A response with no parent answers nothing and is skipped.
 */
function terminalResponses(entries: ReadonlyArray<SessionEntry>): TerminalResponseEvidence[] {
	const rows: TerminalResponseEvidence[] = [];
	const messages = new Map(
		entries.filter((entry): entry is MessageEntry => entry.kind === "message").map((entry) => [entry.turnId, entry]),
	);
	for (let position = 0; position < entries.length; position += 1) {
		const entry = entries[position];
		if (entry?.kind !== "message" || entry.role !== "assistant" || entry.parentTurnId === null) continue;
		let continuationTurnId = entry.parentTurnId;
		const payload = entry.payload as { continuityDeliveryId?: unknown } | null;
		if (typeof payload?.continuityDeliveryId === "string") {
			const delivery = entries
				.slice(0, position)
				.filter(
					(candidate) =>
						candidate.kind === "handoffTransaction" &&
						candidate.event.phase === "delivered" &&
						candidate.event.deliveryId === payload.continuityDeliveryId,
				);
			if (delivery.length !== 1) continue;
			const intent = delivery[0];
			if (intent?.kind !== "handoffTransaction" || intent.event.phase !== "delivered") continue;
			const visited = new Set<string>();
			let ancestor: string | null = entry.parentTurnId;
			while (ancestor && ancestor !== intent.event.continuationTurnId && !visited.has(ancestor)) {
				visited.add(ancestor);
				const parent = messages.get(ancestor);
				// New operator input ends this delivery's authority, even on the same branch.
				if (parent?.role === "user") break;
				ancestor = parent?.parentTurnId ?? null;
			}
			if (ancestor !== intent.event.continuationTurnId) continue;
			continuationTurnId = ancestor;
		}
		rows.push({ entryId: entry.turnId, continuationTurnId, status: terminalStatus(entry), position });
	}
	return rows;
}

/**
 * Operator control requests, from the reserved typed subtype only.
 *
 * A display echo of `/context compact` and the text of a user turn are not
 * authority and never reach this list: the only carrier is the validated
 * `contextHandoffRecoveryRequest` record (§3.1). `acceptedAtMs` comes from the
 * record's own durable timestamp, which is the one base a renewed deadline may
 * be measured from.
 */
function resumeAuthorities(
	entries: ReadonlyArray<SessionEntry>,
	pathTurnIds: ReadonlySet<string>,
): OperatorResumeAuthorityEvidence[] {
	const rows: OperatorResumeAuthorityEvidence[] = [];
	// The immutable branch anchor each handoff actually recorded. A request has
	// to agree with it, and the only place that fact exists is the transaction's
	// own records.
	const anchorByHandoff = new Map<string, string | null>();
	for (const entry of entries) {
		const identity =
			entry.kind === "handoffTransaction"
				? entry.identity
				: entry.kind === "continuityCommit"
					? entry.continuity.identity
					: entry.kind === "compactionSummary"
						? entry.continuity?.identity
						: undefined;
		if (identity === undefined) continue;
		if (!anchorByHandoff.has(identity.handoffId)) anchorByHandoff.set(identity.handoffId, identity.branchAnchorTurnId);
	}
	for (let position = 0; position < entries.length; position += 1) {
		const entry = entries[position];
		if (!isHandoffRecoveryRequestEntry(entry)) continue;
		const acceptedAtMs = Date.parse(entry.timestamp);
		if (!Number.isFinite(acceptedAtMs)) continue;
		const data = entry.data;
		if (data === undefined) continue;
		// 02A matches handoff, action, answered head, session and order, and
		// explicitly leaves these bindings to the resolver. They cannot be
		// recovered later either: `OperatorResumeAuthorityEvidence` does not carry
		// the branch fields, so an unbound request checked here is unbound
		// forever. A request naming a sibling branch or an unrelated leaf is
		// dropped rather than emitted with its bindings discarded.
		if (!anchorByHandoff.has(data.handoffId)) continue;
		if (anchorByHandoff.get(data.handoffId) !== data.branchAnchorTurnId) continue;
		// The envelope's structural parent is the leaf the request claims it was
		// made at. §3.1 requires `parentTurnId` to equal the selected message leaf,
		// so a record whose envelope and payload disagree is not the adopted shape.
		if (entry.parentTurnId !== data.selectedLeafTurnId) continue;
		// And that leaf has to be on the path this projection is about. A request
		// made on a branch the reader is not standing on grants nothing here.
		if (data.selectedLeafTurnId !== null && !pathTurnIds.has(data.selectedLeafTurnId)) continue;
		rows.push({
			operatorRequestEntryId: entry.turnId,
			handoffId: data.handoffId,
			action: data.action,
			pausedOrFailedEntryId: data.pausedOrFailedEntryId,
			originSessionId: data.sessionId,
			position,
			acceptedAtMs,
		});
	}
	return rows;
}

/**
 * Summary and eviction records bound to the commit that produced them.
 *
 * The two outcomes carry different strengths of binding and this resolver does
 * not pretend otherwise. A `summarized` outcome is self-declaring: the summary
 * carries the continuity payload, so it names its own handoff and commit, and a
 * summary belonging to another transaction can never be mistaken for it. An
 * `evicted` outcome has no such field, because `contextEviction` is a
 * working-set record that predates continuity and gains nothing from carrying a
 * handoff payload. Its binding is therefore the commit's own `evictionRef`,
 * qualified two ways: exactly one commit in this input may claim the eviction,
 * and the eviction must be positioned before the commit that claims it, which
 * is the order §5's write group produces. An eviction two commits both claim is
 * ambiguous and yields no evidence for either.
 */
function outcomeRefs(entries: ReadonlyArray<SessionEntry>): ContinuityOutcomeEvidence[] {
	const rows: ContinuityOutcomeEvidence[] = [];
	const positions = new Map<string, number>();
	for (let position = 0; position < entries.length; position += 1) {
		const entry = entries[position];
		if (entry === undefined) continue;
		if (!positions.has(entry.turnId)) positions.set(entry.turnId, position);
		if (entry.kind === "compactionSummary" && entry.continuity !== undefined) {
			rows.push({
				entryId: entry.turnId,
				outcome: "summarized",
				handoffId: entry.continuity.identity.handoffId,
				commitId: entry.continuity.identity.commitId,
				position,
			});
		}
	}
	// Eviction claims come from a commit row **and** from a summary carrying that
	// commit. Reading only commit rows would withhold the binding in precisely
	// the situation reconstruction exists for: the commit row is the thing that
	// went missing, and the validated carry is what proves it existed. The carry
	// names the same immutable identity and the same original outcome, so it is
	// the same claim, not a different one; a carry never turns an evicted outcome
	// into a summarized one, because the outcome is read off the carried commit.
	const claims = new Map<string, { handoffId: string; commitId: string; claimedAt: number } | null>();
	for (let position = 0; position < entries.length; position += 1) {
		const entry = entries[position];
		const payload =
			entry?.kind === "continuityCommit"
				? entry.continuity
				: entry?.kind === "compactionSummary"
					? entry.continuity
					: undefined;
		if (payload === undefined) continue;
		const ref = payload.commit.evictionRef;
		if (ref === undefined || payload.commit.outcome !== "evicted") continue;
		const identity = payload.identity;
		// The ordering bound is the commit's own recorded position when the row is
		// present, and the carrying record's position otherwise. Both are real
		// positions of real records in this one array.
		const claimedAt = positions.get(payload.commit.entry.turnId) ?? position;
		const existing = claims.get(ref);
		if (existing === undefined) {
			claims.set(ref, { handoffId: identity.handoffId, commitId: identity.commitId, claimedAt });
			continue;
		}
		// A second claim only conflicts when it is a different transaction. An
		// identical duplicate, a commit row and the summary that carries it
		// included, is idempotent, here as in the fold.
		if (existing !== null && (existing.handoffId !== identity.handoffId || existing.commitId !== identity.commitId)) {
			claims.set(ref, null);
		}
	}
	for (const [ref, claim] of claims) {
		if (claim === null) continue;
		const position = positions.get(ref);
		if (position === undefined || position >= claim.claimedAt) continue;
		if (entries[position]?.kind !== "contextEviction") continue;
		rows.push({ entryId: ref, outcome: "evicted", handoffId: claim.handoffId, commitId: claim.commitId, position });
	}
	return rows;
}

/** Resolve every evidence list the fold needs from one ordered ledger. */
export function resolveContinuityEvidence(input: ContinuityEvidenceInput): ContinuityFoldEvidence {
	const pathTurnIds = new Set(
		input.pathTurnIds ??
			input.entries.filter((entry): entry is MessageEntry => entry.kind === "message").map((entry) => entry.turnId),
	);
	return {
		resumeAuthorities: resumeAuthorities(input.entries, pathTurnIds),
		terminalResponses: terminalResponses(input.entries),
		outcomeRefs: outcomeRefs(input.entries),
		unreadableRecords: input.unreadableRecords,
	};
}
