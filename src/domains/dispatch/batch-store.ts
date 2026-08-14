/**
 * Durable detached-batch records (WS2 async fan-out).
 *
 * A detached dispatch returns to the caller before its runs finish, so the
 * grouping must outlive the tool call, the turn, and the session. Records
 * persist as `batches.json` under `clioStateDir()`, beside the run ledger and
 * never inside receipts: a batch is orchestration state, not run evidence.
 * Collection state lives here too, so completion nudges stay suppressed after
 * an operator or model has collected a batch, including across resume.
 *
 * Writes go through the shared state-file lock (read/merge/write), because a
 * sibling Clio process on the same state dir may register or collect batches
 * concurrently. Reads are lock-free snapshots, matching the run ledger.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { closeAgentLedger } from "./agent-ledger-store.js";

/** Bounded ring: newest first, oldest dropped past this count. */
const MAX_BATCH_RECORDS = 200;

export interface DetachedBatchRun {
	/** First attempt id. */
	runId: string;
	/** Logical assignment id (the root run id). */
	assignmentId: string;
	agentId: string;
}

export interface DetachedBatchRecord {
	id: string;
	runs: DetachedBatchRun[];
	sessionId: string | null;
	createdAt: string;
	/** ISO timestamp when the batch's results were collected; null while open. */
	collectedAt: string | null;
	/**
	 * The agent ledger these concurrent runs coordinated on, when the batch had
	 * more than one. It is recorded here because collection can happen in a
	 * later process, which has no other way to learn which ledger to close.
	 */
	ledgerId?: string;
}

interface DetachedBatchStoreFile {
	version: 1;
	batches: DetachedBatchRecord[];
}

function storePath(): string {
	return join(clioStateDir(), "batches.json");
}

function readStore(): DetachedBatchRecord[] {
	const path = storePath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as DetachedBatchStoreFile;
		if (parsed?.version !== 1 || !Array.isArray(parsed.batches)) return [];
		return parsed.batches;
	} catch {
		return [];
	}
}

function writeStore(batches: ReadonlyArray<DetachedBatchRecord>): void {
	const file: DetachedBatchStoreFile = { version: 1, batches: [...batches].slice(0, MAX_BATCH_RECORDS) };
	atomicWrite(storePath(), JSON.stringify(file, null, 2));
}

export interface RegisterDetachedBatchInput {
	batchId: string;
	runs: ReadonlyArray<DetachedBatchRun>;
	sessionId: string | null;
	ledgerId?: string;
}

export async function registerDetachedBatch(input: RegisterDetachedBatchInput): Promise<DetachedBatchRecord> {
	const record: DetachedBatchRecord = {
		id: input.batchId,
		runs: input.runs.map((run) => ({
			runId: run.runId,
			assignmentId: run.assignmentId,
			agentId: run.agentId,
		})),
		sessionId: input.sessionId,
		createdAt: new Date().toISOString(),
		collectedAt: null,
		...(input.ledgerId !== undefined ? { ledgerId: input.ledgerId } : {}),
	};
	await withStateFileLock(storePath(), () => {
		const existing = readStore().filter((entry) => entry.id !== record.id);
		writeStore([record, ...existing]);
	});
	return record;
}

export function listDetachedBatches(opts?: { includeCollected?: boolean }): ReadonlyArray<DetachedBatchRecord> {
	const batches = readStore();
	if (opts?.includeCollected === true) return batches;
	return batches.filter((batch) => batch.collectedAt === null);
}

export function getDetachedBatch(batchId: string): DetachedBatchRecord | null {
	return readStore().find((batch) => batch.id === batchId) ?? null;
}

/** Idempotent: an already-collected batch keeps its original collection time. */
export async function markDetachedBatchCollected(batchId: string): Promise<DetachedBatchRecord | null> {
	let updated: DetachedBatchRecord | null = null;
	// The agent ledger closes on the first collection, which is where a detached
	// batch's peers stop being concurrent.
	const ledgerToClose: string | null = null;
	await withStateFileLock(storePath(), () => {
		const batches = readStore();
		const index = batches.findIndex((batch) => batch.id === batchId);
		if (index === -1) return;
		const current = batches[index];
		if (!current) return;
		updated = current.collectedAt === null ? { ...current, collectedAt: new Date().toISOString() } : current;
		batches[index] = updated;
		writeStore(batches);
	});
	if (ledgerToClose !== null) await closeAgentLedger(ledgerToClose);
	return updated;
}
