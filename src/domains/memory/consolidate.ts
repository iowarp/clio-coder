/**
 * `clio-coder memory consolidate`: the explicit, model-free pass over the durable store (DESIGN 4.4, MD7).
 *
 * It runs when the operator runs it. There is no automatic cadence and no model call. In one locked read-modify-write
 * of the store it:
 *
 * - merges records whose claim identity (`memoryClaimKey`) is equal into one, the others' wordings kept as earlier
 *   revisions and their verdicts and deliveries joined. Distinct claims are never merged, whatever their subject.
 * - re-checks every lesson of the current repository against the current checkout by its pinned evidence, the same
 *   delivery check sessions make (`checkoutDeliveryCheck`): a lesson that is certainly dead is demoted to the notes
 *   with a regression, or, when an operator approved it, only reported as withheld with its approval intact.
 * - drops notes nobody decided on that carry no command or source evidence, came from the automatic tier rather than
 *   an author, and were never observed or delivered.
 *
 * The pass sees the records retrieval would let into this checkout (`repositoryApplies` over the fingerprinted
 * identity): another repository's records, an earlier repository at this same path included, are left as they are.
 * An operator-approved or operator-rejected record is never merged, demoted, dropped or rewritten. A store and
 * checkout with nothing to do are left byte for byte as they were, so a second run started beside the first, which
 * waits on the store lock and reads the consolidated store, changes nothing.
 */

import { canonicalCheckout } from "../../core/project-root.js";
import { boundedVerdicts, operatorDecided } from "./guardian-gate.js";
import { checkoutDeliveryCheck } from "./lesson-projection.js";
import {
	canonicalMemoryRepositoryIdentity,
	cloneMemoryRecord,
	primeMemoryRepositoryFingerprint,
	repositoryApplies,
} from "./operations.js";
import { memoryClaimKey, memoryRevision, revisionAuthor } from "./promotion.js";
import { mutateMemoryRecords } from "./store.js";
import { MEMORY_REVISIONS_MAX, type MemoryObservation, type MemoryRecord, type MemoryRevision } from "./types.js";

export type MemoryConsolidationAction = "merged" | "demoted" | "withheld" | "dropped";

export interface MemoryConsolidationItem {
	id: string;
	action: MemoryConsolidationAction;
	/** The record a merged one was folded into. */
	into?: string;
	reason?: string;
}

export interface MemoryConsolidation {
	scanned: number;
	merged: number;
	demoted: number;
	withheld: number;
	dropped: number;
	/** Whether the store was written; false leaves it as it was. */
	changed: boolean;
	items: MemoryConsolidationItem[];
}

export interface MemoryConsolidationOptions {
	/** The working directory: its repository's lessons are re-checked against its checkout. */
	cwd: string;
	now?: Date;
}

export async function consolidateMemory(
	dataDir: string,
	options: MemoryConsolidationOptions,
): Promise<MemoryConsolidation> {
	const at = (options.now ?? new Date()).toISOString();
	// The identity retrieval uses: its fingerprint tells this repository from an earlier one at the same path.
	primeMemoryRepositoryFingerprint(options.cwd);
	const repository = canonicalMemoryRepositoryIdentity(options.cwd);
	const check = checkoutDeliveryCheck(canonicalCheckout(options.cwd).checkout);
	return mutateMemoryRecords<MemoryConsolidation>(dataDir, (records) => {
		const outcome: MemoryConsolidation = {
			scanned: records.length,
			merged: 0,
			demoted: 0,
			withheld: 0,
			dropped: 0,
			changed: false,
			items: [],
		};
		const replaced = new Map<string, MemoryRecord>();
		const removed = new Set<string>();
		const inScope = records.filter((record) => repositoryApplies(record, repository));

		for (const group of claimGroups(inScope)) {
			const [first, ...rest] = [...group].sort(survivorOrder);
			if (first === undefined || rest.length === 0) continue;
			const survivor = cloneMemoryRecord(first);
			for (const other of rest) {
				foldInto(survivor, other);
				removed.add(other.id);
				outcome.items.push({ id: other.id, action: "merged", into: survivor.id });
				outcome.merged += 1;
			}
			replaced.set(survivor.id, survivor);
		}

		for (const original of inScope) {
			if (removed.has(original.id)) continue;
			const record = replaced.get(original.id) ?? original;
			if (!record.approved || record.scope !== "repo") continue;
			const failed = check(record);
			if (failed === null) continue;
			const reason = `failed its delivery check: ${failed}`;
			if (operatorDecided(record)) {
				outcome.items.push({ id: record.id, action: "withheld", reason });
				outcome.withheld += 1;
				continue;
			}
			const note = replaced.has(record.id) ? record : cloneMemoryRecord(record);
			note.approved = false;
			Reflect.deleteProperty(note, "approval");
			note.regressions = [...(note.regressions ?? []), `demoted by memory consolidate at ${at}: ${reason}`];
			replaced.set(note.id, note);
			outcome.items.push({ id: note.id, action: "demoted", reason });
			outcome.demoted += 1;
		}

		for (const original of inScope) {
			if (removed.has(original.id)) continue;
			if (!droppable(replaced.get(original.id) ?? original)) continue;
			removed.add(original.id);
			outcome.items.push({ id: original.id, action: "dropped", reason: "no evidence, no author and no observation" });
			outcome.dropped += 1;
		}

		if (replaced.size === 0 && removed.size === 0) return { result: outcome };
		outcome.changed = true;
		return {
			records: records.filter((record) => !removed.has(record.id)).map((record) => replaced.get(record.id) ?? record),
			result: outcome,
		};
	});
}

/** Records of one claim identity, two or more, none of them decided by an operator. */
function claimGroups(records: ReadonlyArray<MemoryRecord>): MemoryRecord[][] {
	const groups = new Map<string, MemoryRecord[]>();
	for (const record of records) {
		if (operatorDecided(record)) continue;
		const key = memoryClaimKey(record);
		if (key === null) continue;
		groups.set(key, [...(groups.get(key) ?? []), record]);
	}
	return [...groups.values()].filter((group) => group.length > 1);
}

/** The record a group keeps: a lesson before a note, then the oldest, then by id. */
function survivorOrder(left: MemoryRecord, right: MemoryRecord): number {
	return (
		Number(right.approved) - Number(left.approved) ||
		left.createdAt.localeCompare(right.createdAt) ||
		left.id.localeCompare(right.id)
	);
}

/**
 * Fold one record of the same claim into the survivor. The survivor's current wording and evidence stay current, so
 * verdicts already counted toward it still count; the other's wordings join as earlier revisions. Verdicts are joined
 * once per session, kind and revision, within the verdict window; deliveries are summed.
 */
function foldInto(survivor: MemoryRecord, other: MemoryRecord): void {
	const current = memoryRevision(survivor);
	const known = new Map<string, MemoryRevision>();
	for (const entry of [...revisionHistory(survivor), ...revisionHistory(other)]) {
		if (entry.revision === current) continue;
		const seen = known.get(entry.revision);
		if (seen === undefined || entry.at < seen.at) known.set(entry.revision, entry);
	}
	if (known.size > 0) {
		const ownCurrent = revisionHistory(survivor).at(-1);
		const earlier = [...known.values()].sort((left, right) => left.at.localeCompare(right.at));
		survivor.revisions = [...earlier, ...(ownCurrent === undefined ? [] : [ownCurrent])].slice(-MEMORY_REVISIONS_MAX);
	}

	const deliveries = (survivor.deliveredCount ?? 0) + (other.deliveredCount ?? 0);
	const verdicts = new Map<string, MemoryObservation>();
	for (const item of [...(survivor.observations ?? []), ...(other.observations ?? [])]) {
		const key = JSON.stringify([item.sessionId, item.kind, item.revision]);
		const seen = verdicts.get(key);
		if (seen === undefined || item.at < seen.at) verdicts.set(key, { ...item });
	}
	const joined = boundedVerdicts([...verdicts.values()].sort((left, right) => left.at.localeCompare(right.at)));
	const lastDelivered = latest(survivor.lastDeliveredAt, other.lastDeliveredAt);
	if (joined.length > 0) survivor.observations = joined;
	else Reflect.deleteProperty(survivor, "observations");
	if (deliveries > 0) survivor.deliveredCount = deliveries;
	if (lastDelivered !== undefined) survivor.lastDeliveredAt = lastDelivered;
	const lastVerified = latest(survivor.lastVerifiedAt, other.lastVerifiedAt);
	if (lastVerified !== undefined) survivor.lastVerifiedAt = lastVerified;

	const regressions = unique([...(survivor.regressions ?? []), ...(other.regressions ?? [])]);
	if (regressions.length > 0) survivor.regressions = regressions;
	survivor.appliesWhen = unique([...survivor.appliesWhen, ...other.appliesWhen]);
	survivor.avoidWhen = unique([...survivor.avoidWhen, ...other.avoidWhen]);
	survivor.confidence = Math.max(survivor.confidence, other.confidence);
	if (other.createdAt < survivor.createdAt) survivor.createdAt = other.createdAt;
}

/** A record's wordings, oldest first, its current one last; one entry for a record with a single wording. */
function revisionHistory(record: MemoryRecord): MemoryRevision[] {
	if (record.revisions !== undefined && record.revisions.length > 0)
		return record.revisions.map((item) => ({ ...item }));
	return [
		{
			revision: memoryRevision(record),
			lesson: record.lesson,
			at: record.createdAt,
			sessionId: revisionAuthor(record) ?? record.id,
		},
	];
}

function latest(...values: Array<string | undefined>): string | undefined {
	let result: string | undefined;
	for (const value of values) if (value !== undefined && (result === undefined || value > result)) result = value;
	return result;
}

function unique(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)];
}

/**
 * A note the automatic tier wrote that nothing supports: nobody approved or rejected it, it cites no command or
 * source evidence, and no session ever observed or was delivered it. Proposals filed for the operator (from evidence,
 * a claim, a handoff or their own words) wait for them, evidence or not.
 */
function droppable(record: MemoryRecord): boolean {
	return (
		!record.approved &&
		record.rejectedAt === undefined &&
		record.provenance?.sourceKind === "task-bank-entry" &&
		!record.evidenceRefs.some((ref) => /^(?:command|source):/u.test(ref)) &&
		(record.observations ?? []).length === 0 &&
		(record.deliveredCount ?? 0) === 0
	);
}
