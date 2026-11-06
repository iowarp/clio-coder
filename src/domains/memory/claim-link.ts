import { createHash } from "node:crypto";
import { canonicalMemoryRepositoryIdentity, cloneMemoryRecord } from "./operations.js";
import { insertMemoryRecordIfAbsent, mutateMemoryRecords } from "./store.js";
import type { MemoryProposalResult, MemoryRecord } from "./types.js";
import { validateMemoryRecord } from "./validate.js";

/**
 * Memory's side of the claims log (#406). A record rests on a claim when its evidence refs name it; a contradiction of
 * that claim appends a regression here, under the store's lock, and the eligibility filter then keeps the record out of
 * the prompt and recall until an operator approves it again. A contradiction can withdraw reuse; it never grants it.
 */

const LESSON_MAX_CHARS = 480;

export interface ClaimRegressionInput {
	/** Evidence refs any of which makes a record rest on the overturned claim. */
	refs: ReadonlyArray<string>;
	/** The regression text, citing both claims. */
	note: string;
}

/**
 * Append each regression to every record citing one of its refs, in one locked read-modify-write. A record already
 * carrying the same text is left alone. Returns, per input, the ids of the records it reached.
 */
export async function recordClaimRegressions(
	dataDir: string,
	inputs: ReadonlyArray<ClaimRegressionInput>,
): Promise<string[][]> {
	if (inputs.length === 0) return [];
	return mutateMemoryRecords(dataDir, (records) => {
		const touched = new Map<string, MemoryRecord>();
		const reached = inputs.map((input) => {
			const ids: string[] = [];
			for (const record of records) {
				if (!record.evidenceRefs.some((ref) => input.refs.includes(ref))) continue;
				ids.push(record.id);
				const next = touched.get(record.id) ?? cloneMemoryRecord(record);
				if (!(next.regressions ?? []).includes(input.note)) next.regressions = [...(next.regressions ?? []), input.note];
				touched.set(record.id, next);
			}
			return ids;
		});
		if (touched.size === 0) return { result: reached };
		return { records: records.map((record) => touched.get(record.id) ?? record), result: reached };
	});
}

export interface ClaimMemorySource {
	claimId: string;
	/** The claim's own sentence, which states agreement within a declared tolerance and its conditions. */
	text: string;
	check: string;
	/** The claim's project root. */
	project: string;
	at: string;
}

export function memoryIdFromClaim(claimId: string): string {
	return `mem-${createHash("sha256").update(`claim\n${claimId}`, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * An unapproved repository record resting on one claim. It cites `claim:<id>`, so a later contradiction of the claim
 * reaches it, and it waits for `clio-coder memory approve` like any proposal: the guardian gate approves only
 * task-bank lessons, so nothing here approves on its own.
 */
export function memoryRecordFromClaim(source: ClaimMemorySource): MemoryRecord {
	const repository = canonicalMemoryRepositoryIdentity(source.project);
	if (repository === null) throw new Error(`claim project ${source.project} is not a usable repository path`);
	const lesson = `Recorded claim: ${source.text}`;
	const record: MemoryRecord = {
		id: memoryIdFromClaim(source.claimId),
		scope: "repo",
		key: `claim:${source.claimId}`,
		lesson: lesson.length <= LESSON_MAX_CHARS ? lesson : `${lesson.slice(0, LESSON_MAX_CHARS - 3)}...`,
		evidenceRefs: [`claim:${source.claimId}`],
		appliesWhen: [`work touching check '${source.check}' under the claim's recorded conditions`],
		avoidWhen: ["the check's commit, inputs, reference or tolerance differ from the cited claim"],
		// Memory requires a number; it is displayed, never used for selection. The claim states agreement, not truth.
		confidence: 0.5,
		createdAt: source.at,
		approved: false,
		repository,
	};
	const validated = validateMemoryRecord(record);
	if (!validated.valid)
		throw new Error(
			`claim memory record invalid: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
	return validated.record;
}

export async function proposeMemoryFromClaim(
	dataDir: string,
	source: ClaimMemorySource,
): Promise<MemoryProposalResult> {
	return insertMemoryRecordIfAbsent(dataDir, memoryRecordFromClaim(source));
}
