/**
 * Sidecar evidence index. A compact, append/merge-by-runId ledger written
 * under `<stateDir>/evidence-index.json` whenever a dispatch run completes and
 * the forensic evidence bundle is built (see extension.ts). Slice 6 reads this
 * to surface a rolling first-pass-success rate and a failure-cause histogram in
 * observability without re-running the heavy `buildEvidence` aggregator.
 *
 * The file is a JSON array kept as a bounded ring (newest rows win, capped at
 * MAX_EVIDENCE_INDEX_ROWS) mirroring the dispatch runs ledger. Read/merge/write
 * sections use the same cross-process state-file lock as runs.json; writes are
 * then atomic via safeResourceWrite (tmp + rename). Reads are tolerant: a
 * missing or malformed file yields an empty index rather than throwing, so a
 * corrupt sidecar never blocks a run or a view.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { EvidenceTag } from "../evidence/index.js";

/** Cap on retained index rows. Matches the dispatch runs ledger default. */
export const MAX_EVIDENCE_INDEX_ROWS = 1000;

/** Filename of the sidecar index under the state dir. */
export const EVIDENCE_INDEX_FILE = "evidence-index.json";

let evidenceIndexWriteQueue: Promise<void> = Promise.resolve();

/**
 * One row of the sidecar evidence index, keyed by runId. Derived from the
 * `EvidenceBuildResult` produced by `buildEvidence` plus the terminal dispatch
 * payload. `tags` and `findingCount` come from the built bundle's findings.
 * `firstPassSuccess` is computed from forensic evidence and is the authority
 * for user-visible accountability rates. The receipt's cheap findings summary
 * is intentionally conservative and may be false when transcript-level
 * validation evidence makes this value true.
 */
export interface EvidenceIndexRow {
	runId: string;
	evidenceId: string;
	tags: EvidenceTag[];
	firstPassSuccess: boolean;
	findingCount: number;
	/** ISO-8601 timestamp the row was written. */
	generatedAt: string;
}

function indexPath(stateDir: string): string {
	return join(stateDir, EVIDENCE_INDEX_FILE);
}

function isEvidenceIndexRow(value: unknown): value is EvidenceIndexRow {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.runId === "string" &&
		typeof row.evidenceId === "string" &&
		Array.isArray(row.tags) &&
		row.tags.every((tag) => typeof tag === "string") &&
		typeof row.firstPassSuccess === "boolean" &&
		typeof row.findingCount === "number" &&
		typeof row.generatedAt === "string"
	);
}

/**
 * Read the sidecar evidence index. Tolerant by design: a missing file, invalid
 * JSON, or a non-array payload all yield an empty array. Malformed rows are
 * dropped, valid rows are kept.
 */
export function readEvidenceIndex(stateDir: string): EvidenceIndexRow[] {
	let raw: string;
	try {
		raw = readFileSync(indexPath(stateDir), "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isEvidenceIndexRow);
}

/**
 * Merge one row into the sidecar index by runId and write it back atomically.
 * An existing row with the same runId is replaced (a retried run that finalizes
 * again overwrites the stale entry); the merged row is moved to the tail so the
 * ring keeps the most recently written entries when it is bounded. Returns the
 * full index as written.
 */
async function writeEvidenceIndexRow(stateDir: string, row: EvidenceIndexRow): Promise<EvidenceIndexRow[]> {
	let bounded: EvidenceIndexRow[] = [];
	await withStateFileLock(indexPath(stateDir), () => {
		const existing = readEvidenceIndex(stateDir).filter((entry) => entry.runId !== row.runId);
		existing.push(row);
		bounded = existing.length > MAX_EVIDENCE_INDEX_ROWS ? existing.slice(-MAX_EVIDENCE_INDEX_ROWS) : existing;
		safeResourceWrite(indexPath(stateDir), `${JSON.stringify(bounded, null, 2)}\n`, { encoding: "utf8" });
	});
	return bounded;
}

/**
 * Queue index row merges within this process. The state-file lock serializes
 * across processes; this queue avoids avoidable local lock contention when
 * terminal dispatch events start several evidence builds in parallel.
 */
export async function writeEvidenceIndexRowQueued(
	stateDir: string,
	row: EvidenceIndexRow,
): Promise<EvidenceIndexRow[]> {
	let written: EvidenceIndexRow[] = [];
	const write = evidenceIndexWriteQueue.then(async () => {
		written = await writeEvidenceIndexRow(stateDir, row);
	});
	evidenceIndexWriteQueue = write.catch(() => undefined);
	await write;
	return written;
}
