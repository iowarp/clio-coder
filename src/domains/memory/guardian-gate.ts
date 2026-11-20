/**
 * The evidence gate that lets a repository lesson become durable without an
 * operator.
 *
 * Until this existed every proposal waited for `clio-coder memory approve`,
 * and on the maintainer's own machine the store never held one approved
 * record: the background tier wrote candidates nobody reviewed, so no session
 * ever read what an earlier one learned. The gate replaces that review for the
 * narrow case it can judge.
 *
 * A record is a claim (`recordClaim`), and one claim is one record however
 * many sessions file it (`memoryClaimKey`). A session's verdict on it is
 * scoped to the revision it judged, the checkout's branch and head, and
 * whether the session had been shown the note first. A note becomes a lesson
 * on two complete demonstrations of its current revision from distinct
 * sessions other than the one that wrote it, with no contradiction of that
 * revision. A complete demonstration of a fix claim is its failed pattern
 * failing and then its fixed pattern succeeding in one session, prompted or
 * not, because the session observed both halves; a success of a plain command
 * claim counts only when the note had not been delivered first. A
 * contradiction after the gate's own approval demotes the lesson.
 *
 * It only ever speaks for repository scope and for records the task bank or a
 * receipt pair produced. Global, runtime and agent scope widen where a lesson
 * applies, and an operator rejection or approval is a decision the guardian
 * never revisits.
 */

import { COMMAND_EVIDENCE_REF_PREFIX, commandSegments, receiptVouches } from "./command-evidence.js";
import { commandRefKeys, commandSubject } from "./lesson-evidence.js";
import { canonicalMemoryRepositoryIdentity, checkoutPosition, cloneMemoryRecord } from "./operations.js";
import {
	claimNote,
	claimPathRefusal,
	memoryClaimKey,
	memoryRevision,
	recordClaim,
	revisionAuthor,
} from "./promotion.js";
import type { MemoryMutationOptions } from "./store.js";
import { mutateMemoryRecords } from "./store.js";
import {
	MEMORY_OBSERVATIONS_MAX,
	MEMORY_REVISIONS_MAX,
	type MemoryClaim,
	type MemoryClaimCommand,
	type MemoryObservation,
	type MemoryObservationKind,
	type MemoryRecord,
} from "./types.js";

export type MemoryGateVerdict = "approve" | "demote" | "hold";

/** Complete demonstrations of one revision, from distinct non-author sessions, that promote a note. */
export const MEMORY_GATE_DEMONSTRATIONS = 2;

/** Where a verdict was observed. Absent fields were not read. */
export interface MemoryVerdictScope {
	branch?: string;
	head?: string;
	/** The session had been shown the note before the receipt. */
	prompted?: boolean;
}

export interface MemoryObservationInput extends MemoryVerdictScope {
	memoryId: string;
	sessionId: string;
	kind: MemoryObservationKind;
}

export interface MemoryGateOutcome {
	approved: MemoryRecord[];
	demoted: MemoryRecord[];
	/** Ids named by an observation that the store no longer holds. */
	missing: string[];
}

/**
 * Whether the operator owns a record's standing: their approval or rejection, or an approval made before approvals
 * were stamped, which a person gave. No automatic path demotes, merges, prunes or rewrites one.
 */
export function operatorDecided(record: MemoryRecord): boolean {
	return (
		record.rejectedAt !== undefined ||
		record.approval?.by === "operator" ||
		(record.approved && record.approval === undefined)
	);
}

/**
 * The records the gate may approve alone: a task-bank knowledge entry, as before claims, and a note composed from a
 * receipt pair (`claimNote`), which DESIGN 4.4 adds (the Note row's "composed by rule from a receipt pair" and the
 * promotion bar of "Promotion and demotion"). A procedural entry records one attempt, and a handoff snapshot or an
 * evidence proposal was filed for the operator; those wait for them.
 */
function gateSpeaksFor(record: MemoryRecord): boolean {
	const provenance = record.provenance;
	if (provenance?.sourceKind === "task-bank-entry") return provenance.sourceEntryKind === "knowledge";
	return (
		provenance?.sourceKind === "evidence" &&
		record.claim !== undefined &&
		provenance.sourceSessionId !== undefined &&
		provenance.evidenceId === `session:${provenance.sourceSessionId}`
	);
}

/**
 * Pure verdict over one record's retained verdicts. `store` is the rest of the
 * store as read inside the same locked mutation, so a record approved a moment
 * earlier counts.
 */
export function evaluateMemoryGate(record: MemoryRecord, store: ReadonlyArray<MemoryRecord> = []): MemoryGateVerdict {
	if (record.scope !== "repo" || operatorDecided(record) || !gateSpeaksFor(record)) return "hold";
	const observations = record.observations ?? [];
	if (record.approved) {
		const approvedAt = record.approval?.at ?? "";
		return observations.some((item) => item.kind === "contradicted" && item.at > approvedAt) ? "demote" : "hold";
	}
	if ((record.regressions?.length ?? 0) > 0) return "hold";
	const claim = recordClaim(record);
	if (claim === null) return "hold";
	// A quote from a repository file is provenance, not proof, and a source-only
	// lesson reaches no prompt without the operator until delivery checks its
	// span: only a command that could have failed lets the gate approve alone.
	if (claim.kind === "source" || !record.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX)))
		return "hold";
	const revision = memoryRevision(record);
	const current = observations.filter((item) => item.revision === revision);
	// Held and contradicted on one revision is contested: it waits for the operator.
	if (current.some((item) => item.kind === "contradicted")) return "hold";
	const authors = new Set([record.provenance?.sourceSessionId, revisionAuthor(record)]);
	const demonstrations = new Set(
		current
			.filter((item) => item.kind === "held" && !authors.has(item.sessionId))
			.filter((item) => claim.kind === "fix" || item.prompted !== true)
			.map((item) => item.sessionId),
	);
	if (demonstrations.size < MEMORY_GATE_DEMONSTRATIONS) return "hold";
	return commandAlreadyClaimed(record, store) ? "hold" : "approve";
}

/**
 * A decided record speaks for its claim and its command. When an approved or
 * operator-rejected record of the same repository has the same claim identity
 * (two records of one claim survive from stores written before claims), or
 * carries one of this record's `command:` refs under any claim (a fix claim
 * recommending a command the operator rejected as a plain command), which
 * should stand is the operator's call, so this one waits as a pending note. A stored record's unverified `command-claimed:`
 * ref counts as its claim here, and both sides compare evidence identities, so
 * a ref written before identity existed and a spelling such as
 * `corepack pnpm -s test` against `pnpm test` meet as one command.
 */
function commandAlreadyClaimed(record: MemoryRecord, store: ReadonlyArray<MemoryRecord>): boolean {
	const commands = commandKeys(record, true);
	const identity = memoryClaimKey(record);
	const repository = record.repository;
	if (repository === undefined) return false;
	return store.some(
		(other) =>
			other.id !== record.id &&
			(other.approved || other.rejectedAt !== undefined) &&
			other.scope === "repo" &&
			other.repository?.kind === repository.kind &&
			other.repository.key === repository.key &&
			((identity !== null && memoryClaimKey(other) === identity) ||
				[...commandKeys(other, false)].some((key) => commands.has(key))),
	);
}

function commandKeys(record: MemoryRecord, verifiedOnly: boolean): Set<string> {
	const refs = verifiedOnly
		? record.evidenceRefs.filter((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX))
		: record.evidenceRefs;
	return commandRefKeys(record.lesson, refs);
}

/** Apply the same verdict whether observations arrive separately or with a new evidence-backed proposal. */
export function applyMemoryGate(
	record: MemoryRecord,
	at: string,
	store: ReadonlyArray<MemoryRecord> = [],
): MemoryGateVerdict {
	const verdict = evaluateMemoryGate(record, store);
	if (verdict === "approve") {
		record.approved = true;
		record.lastVerifiedAt = at;
		record.approval = { by: "guardian", at };
	} else if (verdict === "demote") {
		record.approved = false;
		Reflect.deleteProperty(record, "approval");
		record.regressions = [...(record.regressions ?? []), `contradicted after guardian approval at ${at}`];
	}
	return verdict;
}

/**
 * Legacy reader, on the first mutation of a record written before delivery
 * counters: its `delivered` observations become `deliveredCount` and
 * `lastDeliveredAt`, so the count survives and the window holds verdicts only.
 * A record already migrated is left as it is.
 */
function migrateLegacyDeliveries(record: MemoryRecord): void {
	const delivered = (record.observations ?? []).filter((item) => item.kind === "delivered");
	if (delivered.length === 0) return;
	record.deliveredCount = (record.deliveredCount ?? 0) + delivered.length;
	for (const item of delivered)
		if (record.lastDeliveredAt === undefined || item.at > record.lastDeliveredAt) record.lastDeliveredAt = item.at;
	record.observations = (record.observations ?? []).filter((item) => item.kind !== "delivered");
	if (record.observations.length === 0) Reflect.deleteProperty(record, "observations");
}

/**
 * Add one observation to a record already cloned for this mutation. A delivery
 * is counted; a verdict joins the window scoped to the record's current
 * revision, once per session, kind and revision, and the window keeps its
 * newest contradiction however many verdicts follow it.
 */
export function observeMemoryRecord(
	record: MemoryRecord,
	input: { sessionId: string; kind: MemoryObservationKind } & MemoryVerdictScope,
	at: string,
): void {
	migrateLegacyDeliveries(record);
	if (input.kind === "delivered") {
		record.deliveredCount = (record.deliveredCount ?? 0) + 1;
		if (record.lastDeliveredAt === undefined || at > record.lastDeliveredAt) record.lastDeliveredAt = at;
		return;
	}
	const revision = memoryRevision(record);
	const seen = (record.observations ?? []).some(
		(item) => item.sessionId === input.sessionId && item.kind === input.kind && item.revision === revision,
	);
	// A later session that saw an approved lesson hold re-verified it; approval itself does not change.
	if (input.kind === "held" && record.approved) record.lastVerifiedAt = at;
	if (seen) return;
	const observation: MemoryObservation = {
		at,
		sessionId: input.sessionId,
		kind: input.kind,
		revision,
		...(input.branch !== undefined ? { branch: input.branch } : {}),
		...(input.head !== undefined ? { head: input.head } : {}),
		...(input.prompted !== undefined ? { prompted: input.prompted } : {}),
	};
	record.observations = boundedVerdicts([...(record.observations ?? []), observation]);
}

/** The newest verdicts, at most `MEMORY_OBSERVATIONS_MAX`, with the newest contradiction pinned in. */
function boundedVerdicts(verdicts: ReadonlyArray<MemoryObservation>): MemoryObservation[] {
	if (verdicts.length <= MEMORY_OBSERVATIONS_MAX) return [...verdicts];
	const pinned = [...verdicts].reverse().find((item) => item.kind === "contradicted");
	const recent = verdicts.slice(-MEMORY_OBSERVATIONS_MAX);
	if (pinned === undefined || recent.includes(pinned)) return recent;
	const rest = new Set(verdicts.filter((item) => item !== pinned).slice(-(MEMORY_OBSERVATIONS_MAX - 1)));
	return verdicts.filter((item) => item === pinned || rest.has(item));
}

/**
 * Append observations and apply the gate inside the store's one locked
 * read-modify-write, so concurrent sessions and operator decisions are never
 * overwritten by a copy read before them.
 */
export async function recordMemoryObservations(
	dataDir: string,
	inputs: ReadonlyArray<MemoryObservationInput>,
	now: Date = new Date(),
	options: MemoryMutationOptions = {},
): Promise<MemoryGateOutcome> {
	const outcome: MemoryGateOutcome = { approved: [], demoted: [], missing: [] };
	if (inputs.length === 0) return outcome;
	const at = now.toISOString();
	return mutateMemoryRecords(
		dataDir,
		(records) => {
			const byId = new Map(records.map((record) => [record.id, record]));
			const touched = new Map<string, MemoryRecord>();
			for (const input of inputs) {
				const current = touched.get(input.memoryId) ?? byId.get(input.memoryId);
				if (current === undefined) {
					outcome.missing.push(input.memoryId);
					continue;
				}
				// The operator's decision stands as they left it: no automatic observation rewrites it.
				if (operatorDecided(current)) continue;
				const next = touched.has(current.id) ? current : cloneMemoryRecord(current);
				observeMemoryRecord(next, input, at);
				touched.set(next.id, next);
			}
			if (touched.size === 0) return { result: outcome };
			gateTouched(records, touched, at, outcome);
			return { records: records.map((record) => touched.get(record.id) ?? record), result: outcome };
		},
		options,
	);
}

function gateTouched(
	records: ReadonlyArray<MemoryRecord>,
	touched: ReadonlyMap<string, MemoryRecord>,
	at: string,
	outcome: MemoryGateOutcome,
): void {
	for (const record of touched.values()) {
		// Approvals made earlier in this loop are part of the store the next verdict reads.
		const verdict = applyMemoryGate(
			record,
			at,
			records.map((candidate) => touched.get(candidate.id) ?? candidate),
		);
		if (verdict === "approve") outcome.approved.push(record);
		else if (verdict === "demote") outcome.demoted.push(record);
	}
}

/** One shell call a session made, as the host recorded it. */
export interface ClaimReceipt {
	command: string;
	ok: boolean;
	/** The call's own working directory; absent means the workspace root. */
	cwd?: string;
}

/**
 * What one session's receipts, in order, say about a claim; the session's
 * last word on it decides. A command claim is held by a success of a segment
 * that vouches for it (`receiptVouches`) and contradicted by a later lone
 * invocation of it failing. A fix claim is held by its failed pattern failing
 * and its fixed pattern then succeeding with no success of the failed pattern
 * in between (DESIGN 4.4, rules capture); a later failure of the fixed pattern
 * contradicts it, as does the fixed pattern failing right after the failed
 * one. A failed chain does not say which segment failed, so only a lone
 * invocation counts as a failure. A source claim is not judged by shell
 * receipts. An unrelated success on the same subject vouches for nothing.
 */
export function claimDemonstration(
	claim: MemoryClaim,
	receipts: ReadonlyArray<ClaimReceipt>,
	root: string,
	scratchRoots: ReadonlyArray<string> = [],
): "held" | "contradicted" | null {
	if (claim.kind === "source") return null;
	const vouches = (pattern: MemoryClaimCommand, receipt: ClaimReceipt, ok: boolean): boolean => {
		if (receipt.ok !== ok) return false;
		const segments = commandSegments(receipt.command, root, receipt.cwd);
		if (!ok && segments.length !== 1) return false;
		return segments.some((segment) => receiptVouches(pattern, segment, scratchRoots));
	};
	let verdict: "held" | "contradicted" | null = null;
	if (claim.kind === "command") {
		for (const receipt of receipts) {
			if (vouches(claim.command, receipt, true)) verdict = "held";
			else if (vouches(claim.command, receipt, false)) verdict = "contradicted";
		}
		return verdict;
	}
	let failedOpen = false;
	for (const receipt of receipts) {
		if (vouches(claim.failed, receipt, false)) failedOpen = true;
		else if (vouches(claim.failed, receipt, true)) failedOpen = false;
		else if (failedOpen && vouches(claim.fixed, receipt, true)) {
			verdict = "held";
			failedOpen = false;
		} else if ((failedOpen || verdict === "held") && vouches(claim.fixed, receipt, false)) verdict = "contradicted";
	}
	return verdict;
}

/**
 * The subject index: the claims of a repository's records under the search
 * key of the command each one is about (a fix claim's failed pattern), so a
 * failed call finds its candidate claims. It finds; it never vouches, merges
 * or approves, since `node x.mjs --a` and `node x.mjs --b` share a subject.
 */
export function memorySubjectIndex(records: ReadonlyArray<MemoryRecord>, root: string): Map<string, MemoryRecord[]> {
	const index = new Map<string, MemoryRecord[]>();
	const repository = canonicalMemoryRepositoryIdentity(root);
	if (repository === null) return index;
	for (const record of records) {
		if (record.scope !== "repo" || record.repository?.key !== repository.key) continue;
		const claim = recordClaim(record);
		const pattern = claim?.kind === "command" ? claim.command : claim?.kind === "fix" ? claim.failed : null;
		const subject = pattern === null ? null : commandSubject(pattern.argv, root);
		if (subject === null) continue;
		index.set(subject.key, [...(index.get(subject.key) ?? []), record]);
	}
	return index;
}

export interface ClaimSessionInput {
	sessionId: string;
	/** The session's workspace; its repository files the claim and roots its receipts. */
	cwd: string;
	/** The note's words, written as the current revision when this session demonstrates the claim. */
	lesson: string;
	claim: MemoryClaim;
	/** Conditions the claim holds under beyond its repository; a claim under other conditions is another record. */
	appliesWhen?: ReadonlyArray<string>;
	receipts: ReadonlyArray<ClaimReceipt>;
	/** The note had been delivered to this session before its receipts. */
	prompted?: boolean;
	scratchRoots?: ReadonlyArray<string>;
	now?: Date;
	writeOptions?: MemoryMutationOptions;
}

export interface ClaimSessionResult {
	record: MemoryRecord | null;
	created: boolean;
	verdict: "held" | "contradicted" | null;
	gate: MemoryGateVerdict | null;
}

/**
 * File one session's receipts against a claim. The record is found by claim
 * identity, so every session that demonstrates one claim lands on one record;
 * the first to demonstrate it writes it and is its author. A note's wording is
 * the current revision; a different wording a demonstrating session brings is
 * a new revision, and only verdicts on it count from then on. An operator's
 * decision and a lesson are never reworded. A session whose receipts neither
 * hold nor contradict the claim writes nothing.
 */
export async function recordClaimSession(dataDir: string, input: ClaimSessionInput): Promise<ClaimSessionResult> {
	const repository = canonicalMemoryRepositoryIdentity(input.cwd);
	if (repository === null) throw new Error("a claim note requires a canonical repository identity");
	const refusal = claimPathRefusal(input.claim, repository.key, input.scratchRoots ?? []);
	if (refusal !== null) throw new Error(refusal);
	const verdict = claimDemonstration(input.claim, input.receipts, input.cwd, input.scratchRoots ?? []);
	const at = (input.now ?? new Date()).toISOString();
	const candidate = claimNoteRecord(input, repository, at);
	const scope: MemoryVerdictScope = {
		...checkoutPosition(input.cwd),
		...(input.prompted !== undefined ? { prompted: input.prompted } : {}),
	};
	const identity = memoryClaimKey(candidate);
	return mutateMemoryRecords<ClaimSessionResult>(
		dataDir,
		(records) => {
			const existing = records.find((record) => record.id === candidate.id || memoryClaimKey(record) === identity);
			// No receipt verdict, or the operator's decision: nothing is written.
			if (verdict === null || (existing !== undefined && operatorDecided(existing)))
				return { result: { record: existing ?? null, created: false, verdict, gate: null } };
			if (existing === undefined && verdict !== "held")
				return { result: { record: null, created: false, verdict, gate: null } };
			const record = existing === undefined ? candidate : cloneMemoryRecord(existing);
			if (existing !== undefined && verdict === "held" && !record.approved)
				reviseMemoryLesson(record, candidate.lesson, record.evidenceRefs, input.sessionId, at);
			observeMemoryRecord(record, { sessionId: input.sessionId, kind: verdict, ...scope }, at);
			const next =
				existing === undefined ? [...records, record] : records.map((item) => (item === existing ? record : item));
			const gate = applyMemoryGate(record, at, next);
			return { records: next, result: { record, created: existing === undefined, verdict, gate } };
		},
		input.writeOptions,
	);
}

/**
 * Give a note new words or evidence. A change is a new current revision, written by `sessionId`; the earlier ones
 * stay listed, the oldest dropped first. Unchanged words and evidence change nothing.
 */
export function reviseMemoryLesson(
	record: MemoryRecord,
	lesson: string,
	evidenceRefs: ReadonlyArray<string>,
	sessionId: string,
	at: string,
): void {
	const before = memoryRevision(record);
	if (memoryRevision({ lesson, evidenceRefs: [...evidenceRefs] }) === before) return;
	const history = record.revisions ?? [
		{ revision: before, lesson: record.lesson, at: record.createdAt, sessionId: revisionAuthor(record) ?? sessionId },
	];
	record.lesson = lesson;
	record.evidenceRefs = [...evidenceRefs];
	record.revisions = [...history, { revision: memoryRevision(record), lesson, at, sessionId }].slice(
		-MEMORY_REVISIONS_MAX,
	);
}

function claimNoteRecord(
	input: ClaimSessionInput,
	repository: NonNullable<ReturnType<typeof canonicalMemoryRepositoryIdentity>>,
	at: string,
): MemoryRecord {
	return claimNote({
		sessionId: input.sessionId,
		lesson: input.lesson,
		claim: input.claim,
		repository,
		at,
		...(input.appliesWhen !== undefined ? { appliesWhen: input.appliesWhen } : {}),
	});
}
