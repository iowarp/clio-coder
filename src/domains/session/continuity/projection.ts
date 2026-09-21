/**
 * The reader-side adapter: a ledger and its fork bindings in, one execution
 * fold plus separately typed inherited recall out.
 *
 * `foldContinuity` is pure and single-origin. Its applicability check requires
 * `identity.originSessionId === selection.sessionId`, which is exactly right for
 * the session that minted a transaction and exactly wrong for a fork. A fork
 * gets a new session id from `buildMeta` while the seeded entries keep their
 * original ids, parent links and continuity origins, so folding a child's
 * ledger once under the child id drops every inherited note; substituting the
 * parent id loses the child's own transactions; marking the whole child
 * historical permanently disables its later fresh handoffs; and rewriting the
 * persisted origin would invalidate the immutable identity all the evidence
 * hangs off. None of those is acceptable, so this adapter keeps 02A unchanged
 * and partitions around it.
 *
 * What it produces:
 *
 *   - **One current-origin fold** over the complete applicable ledger, under the
 *     session's real id, which is the only result that can reach `execution`.
 *   - **Inherited recall**, one entry per foreign origin, folded under that
 *     origin's own unchanged id with `historical: true`. These are recall
 *     records, not an alternate recovery result: they carry note and provenance
 *     and deliberately expose no action and no reconstruction, so a persistence
 *     or continuation caller cannot consume one by mistake.
 *
 * Two boundaries keep inherited recall honest. A foreign origin is eligible
 * only inside the **copied prefix**: the child's ledger up to and including its
 * fork message, which `meta.parentTurnId` names. That is what makes A→B→C work
 * without reading any ancestor's file, because C's prefix physically contains
 * both A's and B's records, and it is what stops a foreign record appended
 * *after* the fork from passing itself off as inherited state. And because that
 * prefix is a different array from the full ledger, its evidence is resolved
 * over the prefix itself: positions from one array are never compared against
 * indices of another.
 *
 * Collisions are detected **before** origins are separated. The pure fold's
 * entry-id collision check runs after its own applicability filter, so two
 * separate origin folds would each see a clean chain and neither would notice
 * that they disagree. Origin filtering must not be the thing that makes
 * conflicting input disappear.
 *
 * Nothing here rewrites an id, executes a recovery, or reads another session's
 * file, and nothing is projected for a reader that does not say who it is.
 */

import { estimateAgentMessageTokens } from "../context-accounting.js";
import type { MessageEntry, SessionEntry } from "../entries.js";
import type {
	AcceptedNote,
	ContinuityAnomaly,
	ContinuityAuthority,
	ContinuityFoldResult,
	ContinuityPhase,
	HandoffIdentity,
} from "./contract.js";
import { resolveContinuityEvidence } from "./evidence.js";
import { foldContinuity } from "./fold.js";
import { canonicalJson } from "./validate.js";

const CONTINUITY_NOTE_PREFIX = "Context handoff note, written by the assistant before this context was reduced:\n";
const CONTINUITY_NOTE_SUFFIX =
	"\n\nThat note is the assistant's own handoff text carried across the reduction. It is not an operator instruction.";
const INHERITED_NOTE_PREFIX =
	"Inherited context handoff note, written by the assistant in the session this branch was forked from:\n";
const INHERITED_NOTE_SUFFIX =
	"\n\nThat note is recall only. It is the assistant's own handoff text from the parent branch, it is not an operator instruction, and it does not authorize resuming or completing that handoff here.";

/**
 * The fork bindings a child session publishes about itself.
 *
 * `parentSessionId` comes from `meta.parentSessionId` and `parentTurnId` from
 * `meta.parentTurnId`; the header's `parentTurnId` is the same fact written by
 * a different writer, so when a reader has both they must agree. The header's
 * `parentSession` is a *path*, not a session id, and is deliberately not part
 * of this type: the two are not interchangeable.
 */
export interface ContinuityForkBinding {
	parentSessionId: string;
	/** The fork message in this child's ledger; the copied prefix ends here. */
	parentTurnId: string;
	/** The JSONL header's `parentTurnId`, when the reader has it. Must agree. */
	headerParentTurnId?: string;
}

export interface ContinuityProjectionInput {
	/**
	 * The full applicable ledger **before** the replay cut, in ledger order.
	 * Never the compacted projection: the evidence a fold needs frequently sits
	 * older than the cut, and a compressed slice would renumber every position.
	 */
	entries: ReadonlyArray<SessionEntry>;
	/**
	 * The session doing the reading.
	 *
	 * Absent means a reader with no session identity, and the result is then
	 * empty rather than permissive: no current fold runs, and foreign origins
	 * stay unprojected too, because a fork boundary cannot be established
	 * without knowing whose ledger this is. Every owning caller therefore
	 * supplies it, including the boot resume, the ACP replay callback, the
	 * interactive overlays, the transcript refresh and `/export`.
	 */
	sessionId?: string;
	/**
	 * Turn ids on the selected path. Defaults to the message turns in `entries`,
	 * which the caller has already narrowed to the active path.
	 */
	pathTurnIds?: ReadonlyArray<string>;
	/** This child's fork bindings, when it is a fork. */
	fork?: ContinuityForkBinding;
	/**
	 * True only for a genuine historical cut of the reading session's own
	 * transactions, a `/fork` preview standing at an earlier turn.
	 *
	 * A live `/tree` selection is **not** historical. The renderer passes
	 * `uptoTurnId` for both, so deriving this flag from that option would turn
	 * every display truncation into a permanent loss of the session's own
	 * execution ownership. Callers state it explicitly or leave it false.
	 */
	historical?: boolean;
	/** Parse failures the reader already counted, carried through to the fold. */
	unreadableRecords?: number;
	nowMs?: number;
}

export interface ProjectedContinuityNote {
	/** The accepted bytes, exactly as admitted. Never trimmed or regenerated. */
	note: string;
	handoffId: string;
	commitId: string;
	originSessionId: string;
	phase: ContinuityPhase;
	authority: ContinuityAuthority;
}

export type ContinuityRecallProvenance = "inherited" | "inherited_prior";

/**
 * One inherited note, published for recall and nothing else.
 *
 * No action, no reconstruction and no carry is exposed on purpose. §8 makes an
 * inherited note recallable in every phase, including `ready`, `delivered` and
 * `acknowledged`, and a caller holding one of these has nothing it could
 * mistake for permission.
 */
export interface ContinuityRecallNote {
	originSessionId: string;
	handoffId: string;
	commitId: string;
	/** Exact accepted bytes. */
	note: string;
	phase: ContinuityPhase;
	provenance: ContinuityRecallProvenance;
	/** False when that origin's own fold could not validate every reference. */
	validated: boolean;
}

export interface ContinuityProjection {
	/** The reading session's own fold, or null when it has no identity here. */
	current: ContinuityFoldResult | null;
	/** The current transaction's note, when one is projectable. */
	note: ProjectedContinuityNote | null;
	/** Inherited recall, oldest origin first. Never executable. */
	inherited: ReadonlyArray<ContinuityRecallNote>;
	/** Cross-origin collisions, found before the origins were separated. */
	anomalies: ReadonlyArray<ContinuityAnomaly>;
	/** True when a collision or an unresolved fork boundary suppressed authority. */
	authoritySuppressed: boolean;
	/**
	 * The ledger turn id of the first record of the projected note's
	 * transaction, or null when no note is projected.
	 *
	 * Accounting needs it: a note introduced before the provider usage anchor is
	 * already inside that measurement, and adding it again would charge it twice
	 * on every later compaction cycle.
	 */
	noteAnchorTurnId: string | null;
}

interface ContinuityRecordFacts {
	entryId: string;
	identity: HandoffIdentity;
	accepted: AcceptedNote | null;
	position: number;
}

/**
 * Identity facts from every continuity-bearing record, in ledger order.
 *
 * Read structurally rather than through the validators, because a conflicting
 * claim has to be visible even when the record carrying it is otherwise
 * malformed. Skipping records that failed validation is how a hostile copy
 * would hide the collision it creates.
 */
function continuityRecordFacts(entries: ReadonlyArray<SessionEntry>): ContinuityRecordFacts[] {
	const facts: ContinuityRecordFacts[] = [];
	for (let position = 0; position < entries.length; position += 1) {
		const entry = entries[position];
		if (entry === undefined) continue;
		if (entry.kind === "handoffTransaction") {
			facts.push({
				entryId: entry.turnId,
				identity: entry.identity,
				accepted: entry.event.phase === "prepared" ? entry.event.accepted : null,
				position,
			});
			continue;
		}
		const payload =
			entry.kind === "continuityCommit"
				? entry.continuity
				: entry.kind === "compactionSummary"
					? entry.continuity
					: undefined;
		if (payload === undefined) continue;
		facts.push({ entryId: entry.turnId, identity: payload.identity, accepted: payload.accepted, position });
	}
	return facts;
}

/**
 * Collisions on the stable identifiers the whole protocol rests on.
 *
 * Two checks, both across every origin: one entry id carrying two different
 * continuity owners or payloads, and one handoff id carrying two different
 * immutable identities or two different accepted notes. Either means the ledger
 * disagrees with itself about what a name refers to, and no origin may act on
 * the disputed name.
 */
function detectCollisions(facts: ReadonlyArray<ContinuityRecordFacts>): {
	anomalies: ContinuityAnomaly[];
	disputedHandoffs: Set<string>;
} {
	const anomalies: ContinuityAnomaly[] = [];
	const disputedHandoffs = new Set<string>();

	const ownerByEntryId = new Map<string, string>();
	for (const fact of facts) {
		const owner = canonicalJson({ handoffId: fact.identity.handoffId, originSessionId: fact.identity.originSessionId });
		const previous = ownerByEntryId.get(fact.entryId);
		if (previous === undefined) {
			ownerByEntryId.set(fact.entryId, owner);
			continue;
		}
		if (previous === owner) continue;
		disputedHandoffs.add(fact.identity.handoffId);
		const prior = facts.find((candidate) => candidate.entryId === fact.entryId);
		if (prior) disputedHandoffs.add(prior.identity.handoffId);
		anomalies.push({
			kind: "entry_id_reused",
			entryId: fact.entryId,
			detail: "one entry id is claimed by two different continuity transactions or origins",
		});
	}

	const identityByHandoff = new Map<string, string>();
	const noteByHandoff = new Map<string, string>();
	for (const fact of facts) {
		const identity = canonicalJson(fact.identity);
		const previous = identityByHandoff.get(fact.identity.handoffId);
		if (previous === undefined) identityByHandoff.set(fact.identity.handoffId, identity);
		else if (previous !== identity) {
			disputedHandoffs.add(fact.identity.handoffId);
			anomalies.push({
				kind: "duplicate_conflict",
				entryId: fact.entryId,
				detail: `handoff ${fact.identity.handoffId} carries two different immutable identities`,
			});
		}
		if (fact.accepted === null) continue;
		const note = canonicalJson(fact.accepted);
		const priorNote = noteByHandoff.get(fact.identity.handoffId);
		if (priorNote === undefined) noteByHandoff.set(fact.identity.handoffId, note);
		else if (priorNote !== note) {
			// Two different accepted notes under one handoff are never reconciled by
			// taking the newer one. Both texts are retained in the record; neither
			// is authority.
			disputedHandoffs.add(fact.identity.handoffId);
			anomalies.push({
				kind: "duplicate_conflict",
				entryId: fact.entryId,
				detail: `handoff ${fact.identity.handoffId} carries two different accepted notes`,
			});
		}
	}
	return { anomalies, disputedHandoffs };
}

/** The first record of the projected note's transaction, for accounting. */
function noteAnchor(facts: ReadonlyArray<ContinuityRecordFacts>, note: ProjectedContinuityNote | null): string | null {
	if (note === null) return null;
	for (const fact of facts) {
		if (fact.identity.handoffId === note.handoffId) return fact.entryId;
	}
	return null;
}

function messageTurnIds(entries: ReadonlyArray<SessionEntry>): string[] {
	return entries.filter((entry): entry is MessageEntry => entry.kind === "message").map((entry) => entry.turnId);
}

/**
 * The copied prefix a fork inherited: the child's ledger up to and including
 * its fork message. Null when the boundary cannot be established, which is a
 * conservative refusal rather than a repair: §8 forbids inventing a boundary
 * from the latest handoff or from a summary's `firstKeptTurnId`.
 */
function inheritedPrefix(
	entries: ReadonlyArray<SessionEntry>,
	fork: ContinuityForkBinding,
): { prefix: ReadonlyArray<SessionEntry> } | { problem: string } {
	if (fork.headerParentTurnId !== undefined && fork.headerParentTurnId !== fork.parentTurnId) {
		return { problem: "the session header and metadata disagree about the fork message" };
	}
	const boundary = entries.findIndex((entry) => entry.turnId === fork.parentTurnId);
	if (boundary < 0) return { problem: `the fork message ${fork.parentTurnId} is not present in this ledger` };
	return { prefix: entries.slice(0, boundary + 1) };
}

function recallFromFold(
	fold: ContinuityFoldResult,
	originSessionId: string,
	disputed: ReadonlySet<string>,
): ContinuityRecallNote[] {
	const notes: ContinuityRecallNote[] = [];
	if (fold.identity !== null && fold.accepted !== null && !disputed.has(fold.identity.handoffId)) {
		notes.push({
			originSessionId,
			handoffId: fold.identity.handoffId,
			commitId: fold.identity.commitId,
			note: fold.accepted.note,
			phase: fold.phase,
			provenance: "inherited",
			validated: fold.validated,
		});
	}
	for (const prior of fold.priorHandoffs) {
		if (prior.accepted === null || disputed.has(prior.handoffId)) continue;
		notes.push({
			originSessionId,
			handoffId: prior.handoffId,
			commitId: prior.commitId,
			note: prior.accepted.note,
			phase: prior.phase,
			// A prior handoff is a recall projection of an earlier completed cycle,
			// never independently finalized authority.
			provenance: "inherited_prior",
			validated: fold.validated,
		});
	}
	return notes;
}

export function resolveContinuityProjection(input: ContinuityProjectionInput): ContinuityProjection {
	const facts = continuityRecordFacts(input.entries);
	if (facts.length === 0) {
		return {
			current: null,
			note: null,
			inherited: [],
			anomalies: [],
			authoritySuppressed: false,
			noteAnchorTurnId: null,
		};
	}

	// Collisions first, over every origin, before any partition exists.
	const collisions = detectCollisions(facts);
	const anomalies: ContinuityAnomaly[] = [...collisions.anomalies];

	const pathTurnIds = input.pathTurnIds ?? messageTurnIds(input.entries);
	const nowMs = input.nowMs ?? Date.now();

	const current =
		input.sessionId === undefined
			? null
			: foldContinuity({
					entries: input.entries,
					selection: { sessionId: input.sessionId, pathTurnIds, historical: input.historical ?? false },
					// Evidence for the full ledger, resolved over the full ledger. Every
					// position in it indexes this same array.
					evidence: resolveContinuityEvidence({
						entries: input.entries,
						unreadableRecords: input.unreadableRecords ?? 0,
					}),
					nowMs,
				});

	const inherited: ContinuityRecallNote[] = [];
	const foreignOrigins = new Set<string>();
	for (const fact of facts) {
		if (fact.identity.originSessionId !== input.sessionId) foreignOrigins.add(fact.identity.originSessionId);
	}
	let boundaryUnresolved = false;
	if (foreignOrigins.size > 0) {
		if (input.fork === undefined) {
			boundaryUnresolved = true;
			anomalies.push({
				kind: "malformed_continuity_record",
				entryId: null,
				detail: `this ledger holds continuity records from ${foreignOrigins.size} other origin session(s) but publishes no fork binding; they are not projected`,
			});
		} else {
			const bounded = inheritedPrefix(input.entries, input.fork);
			if ("problem" in bounded) {
				boundaryUnresolved = true;
				anomalies.push({
					kind: "malformed_continuity_record",
					entryId: null,
					detail: `inherited boundary unresolved: ${bounded.problem}`,
				});
			} else {
				// One array for every inherited origin, with its own evidence. A
				// foreign record appended after the fork message is outside this
				// prefix and is therefore not inherited state, whatever it claims.
				const prefix = bounded.prefix;
				const prefixEvidence = resolveContinuityEvidence({
					entries: prefix,
					unreadableRecords: input.unreadableRecords ?? 0,
				});
				const prefixPath = input.pathTurnIds ?? messageTurnIds(prefix);
				const eligible = [...new Set(continuityRecordFacts(prefix).map((fact) => fact.identity.originSessionId))].filter(
					(origin) => origin !== input.sessionId,
				);
				for (const originSessionId of eligible) {
					const fold = foldContinuity({
						entries: prefix,
						// The origin is the record's own, unchanged. `historical: true` is
						// the honest description of the projection: another branch's
						// transaction, which the fold answers recall-only in every phase.
						selection: { sessionId: originSessionId, pathTurnIds: prefixPath, historical: true },
						evidence: prefixEvidence,
						nowMs,
					});
					inherited.push(...recallFromFold(fold, originSessionId, collisions.disputedHandoffs));
				}
			}
		}
	}

	// Exact repeats collapse; different text under one handoff never does, because
	// `detectCollisions` already disputed that handoff and dropped both.
	const seen = new Set<string>();
	const deduped = inherited.filter((entry) => {
		const key = canonicalJson({ h: entry.handoffId, c: entry.commitId, o: entry.originSessionId, n: entry.note });
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	const authoritySuppressed =
		boundaryUnresolved ||
		(current !== null && current.identity !== null && collisions.disputedHandoffs.has(current.identity.handoffId));
	// Suppression is enforced on the exported fold, not left as an advisory flag
	// beside an otherwise untouched result. A caller holding `current` reaches
	// `continuityPayloadFromFold` and `missingCommitFromCarry` with it, and both
	// gate on `validated`; publishing a `validated: true` fold next to a boolean
	// saying "but not really" would republish evidence this adapter just
	// disputed, and every consumer would have to remember to check. The disputed
	// note stays readable, which is the whole point of recall.
	const published: ContinuityFoldResult | null =
		current === null
			? null
			: authoritySuppressed
				? {
						...current,
						authority: current.authority === "none" ? "none" : "recall_only",
						validated: false,
						action: { kind: "recall_only", reason: "conflicting_evidence" },
						missingCommit: null,
						anomalies: [...current.anomalies, ...anomalies],
					}
				: current;
	const note =
		published === null || published.identity === null || published.accepted === null
			? null
			: {
					note: published.accepted.note,
					handoffId: published.identity.handoffId,
					commitId: published.identity.commitId,
					originSessionId: published.identity.originSessionId,
					phase: published.phase,
					authority: published.authority as ContinuityAuthority,
				};
	return {
		current: published,
		note,
		inherited: deduped,
		anomalies,
		authoritySuppressed,
		noteAnchorTurnId: noteAnchor(facts, note),
	};
}

/** The exact text replay projects for the current session's own note. */
export function continuityReplayText(note: ProjectedContinuityNote): string {
	return `${CONTINUITY_NOTE_PREFIX}${note.note}${CONTINUITY_NOTE_SUFFIX}`;
}

/** The exact text replay projects for one inherited note. */
export function inheritedContinuityReplayText(note: ContinuityRecallNote): string {
	return `${INHERITED_NOTE_PREFIX}${note.note}${INHERITED_NOTE_SUFFIX}`;
}

/**
 * Every block replay projects, in order: inherited recall first, then this
 * session's own note.
 *
 * Each note appears exactly once. Copies of a carried payload add nothing:
 * three summary cycles carrying one transaction still put one note in front of
 * the model. The accepted bytes go in verbatim and never through the replay
 * text cap, because §4 forbids cropping or regenerating accepted text and a
 * truncated handoff note is a corrupted one.
 */
export function continuityReplayBlocks(projection: ContinuityProjection): string[] {
	const blocks = projection.inherited.map(inheritedContinuityReplayText);
	if (projection.note !== null && projection.note.authority !== "none") {
		blocks.push(continuityReplayText(projection.note));
	}
	return blocks;
}

/**
 * Tokens for exactly the blocks above, priced once each.
 *
 * Each block is emitted as its own user message, so it costs its text plus the
 * per-message structural overhead the shared estimator charges every other
 * replayed message. Pricing the text alone under-counted the projection by that
 * overhead per block. This is the same chars/4 approximation the rest of the
 * accounting uses and is not provider-exact tokenization.
 */
export function continuityProjectionTokens(projection: ContinuityProjection): number {
	let total = 0;
	for (const block of continuityReplayBlocks(projection)) {
		total += estimateAgentMessageTokens({ role: "user", payload: { text: block } });
	}
	return total;
}
