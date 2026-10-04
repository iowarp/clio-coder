import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { MEMORY_VERSION, type MemoryRecord, type MemoryStatus, type MemoryStoreFile } from "./types.js";
import { validateMemoryStore } from "./validate.js";

export const MEMORY_STORE_MAX_RECORDS = 500;
export const MEMORY_STALE_APPROVED_DAYS = 180;
export const MEMORY_STALE_UNAPPROVED_DAYS = 30;
/** Prompt compilation fails closed above this read ceiling; store writers are unchanged. */
export const MEMORY_PROMPT_STORE_MAX_BYTES = 16 * 1024 * 1024;

export interface MemoryStoreSnapshot {
	revision: string;
	records: MemoryRecord[];
}

/** Hash the exact bounded bytes read, so same-size external replacements invalidate selection. */
export function readMemoryStoreSnapshot(dataDir: string): MemoryStoreSnapshot {
	const path = memoryStorePath(dataDir);
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") return { revision: "missing", records: [] };
		throw error;
	}
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MEMORY_PROMPT_STORE_MAX_BYTES + 1 - total));
			const count = readSync(fd, chunk);
			if (count === 0) break;
			total += count;
			if (total > MEMORY_PROMPT_STORE_MAX_BYTES) throw new Error("memory prompt store exceeds read ceiling");
			chunks.push(chunk.subarray(0, count));
		}
	} finally {
		closeSync(fd);
	}
	const raw = Buffer.concat(chunks);
	const records = parseAndValidate(raw.toString("utf8"), path);
	if (records.length > MEMORY_STORE_MAX_RECORDS) throw new Error("memory prompt store exceeds record limit");
	return { revision: createHash("sha256").update(raw).digest("hex"), records };
}

export function memoryRoot(dataDir: string): string {
	return join(dataDir, "memory");
}

export function memoryStorePath(dataDir: string): string {
	return join(memoryRoot(dataDir), "records.json");
}

export async function loadMemoryRecords(dataDir: string): Promise<MemoryRecord[]> {
	let raw: string;
	try {
		raw = await readFile(memoryStorePath(dataDir), "utf8");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") return [];
		throw error;
	}
	return parseAndValidate(raw, memoryStorePath(dataDir));
}

/**
 * Synchronous variant for hot prompt-build paths. Reads the local memory
 * store file each call. The store is bounded at MEMORY_STORE_MAX_RECORDS and
 * lives on local disk, so the sync read is cheap and avoids forcing every
 * prompt compile site to thread an async boundary through the chat loop.
 */
export function loadMemoryRecordsSync(dataDir: string): MemoryRecord[] {
	let raw: string;
	try {
		raw = readFileSync(memoryStorePath(dataDir), "utf8");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") return [];
		throw error;
	}
	return parseAndValidate(raw, memoryStorePath(dataDir));
}

function parseAndValidate(raw: string, source: string): MemoryRecord[] {
	const parsed = parseJson(raw, source);
	const result = validateMemoryStore(parsed, "$");
	if (!result.valid) {
		throw new Error(
			`memory store invalid: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
	}
	return sortMemoryRecords(result.store.records);
}

/** Replaces the whole store under the store lock. Mutations that depend on current content use `mutateMemoryRecords`. */
export async function writeMemoryRecords(dataDir: string, records: ReadonlyArray<MemoryRecord>): Promise<string> {
	return withStateFileLock(memoryStorePath(dataDir), () => writeMemoryRecordsUnlocked(dataDir, records));
}

function writeMemoryRecordsUnlocked(dataDir: string, records: ReadonlyArray<MemoryRecord>): string {
	const sorted = sortMemoryRecords(records);
	if (sorted.length > MEMORY_STORE_MAX_RECORDS) {
		throw new Error(`memory store limit reached (${MEMORY_STORE_MAX_RECORDS}); run clio-coder memory prune --stale`);
	}
	const store: MemoryStoreFile = { version: MEMORY_VERSION, records: sorted };
	const path = memoryStorePath(dataDir);
	safeResourceWrite(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8" });
	return path;
}

/**
 * The one way to change the store. Several sessions and `clio-coder memory`
 * share `records.json`, and each mutation used to read the file, edit its copy
 * and write the whole file back: twelve concurrent observations kept one, and
 * a background write could replace an operator's approval or rejection with
 * the copy it read before that decision. The read, the edit and the write now
 * happen under one cross-process lock. Callers never nest it: a mutation that
 * needs to look before it writes does both inside `mutate`.
 */
export async function mutateMemoryRecords<T>(
	dataDir: string,
	mutate: (records: MemoryRecord[]) => { records: ReadonlyArray<MemoryRecord>; result: T } | { result: T },
): Promise<T> {
	return withStateFileLock(memoryStorePath(dataDir), () => {
		const outcome = mutate(loadMemoryRecordsSync(dataDir));
		if ("records" in outcome) writeMemoryRecordsUnlocked(dataDir, outcome.records);
		return outcome.result;
	});
}

/** Insert `record` unless the store already holds it or `findExisting` names an equivalent. */
export async function insertMemoryRecordIfAbsent(
	dataDir: string,
	record: MemoryRecord,
	findExisting?: (records: ReadonlyArray<MemoryRecord>) => MemoryRecord | null,
): Promise<{ record: MemoryRecord; created: boolean }> {
	return mutateMemoryRecords<{ record: MemoryRecord; created: boolean }>(dataDir, (records) => {
		const existing = records.find((item) => item.id === record.id) ?? findExisting?.(records) ?? null;
		if (existing !== null) return { result: { record: existing, created: false } };
		return { records: [...records, record], result: { record, created: true } };
	});
}

export async function updateMemoryRecord(
	dataDir: string,
	memoryId: string,
	update: (record: MemoryRecord) => MemoryRecord,
): Promise<MemoryRecord> {
	return mutateMemoryRecords(dataDir, (records) => {
		const index = records.findIndex((record) => record.id === memoryId);
		const current = records[index];
		if (current === undefined) throw new Error(`memory record not found: ${memoryId}`);
		const updated = update(current);
		return { records: replaceAt(records, index, updated), result: updated };
	});
}

export async function pruneStaleMemoryRecords(dataDir: string, now: Date = new Date()): Promise<MemoryRecord[]> {
	return mutateMemoryRecords(dataDir, (records) => ({
		records: records.filter((record) => !isStaleMemoryRecord(record, now)),
		result: records.filter((record) => isStaleMemoryRecord(record, now)),
	}));
}

function isStaleMemoryRecord(record: MemoryRecord, now: Date): boolean {
	const reference = record.lastVerifiedAt ?? record.createdAt;
	const referenceMs = Date.parse(reference);
	if (!Number.isFinite(referenceMs)) return true;
	const staleAfterDays = record.approved ? MEMORY_STALE_APPROVED_DAYS : MEMORY_STALE_UNAPPROVED_DAYS;
	return now.getTime() - referenceMs > staleAfterDays * 24 * 60 * 60 * 1000;
}

export function memoryStatus(record: MemoryRecord): MemoryStatus {
	if (record.approved) return "approved";
	if (record.rejectedAt !== undefined) return "rejected";
	return "proposed";
}

export function sortMemoryRecords(records: ReadonlyArray<MemoryRecord>): MemoryRecord[] {
	return [...records].sort(compareMemoryRecords);
}

function compareMemoryRecords(left: MemoryRecord, right: MemoryRecord): number {
	const byScope = scopeRank(left.scope) - scopeRank(right.scope);
	if (byScope !== 0) return byScope;
	const byKey = left.key.localeCompare(right.key);
	if (byKey !== 0) return byKey;
	const byCreated = left.createdAt.localeCompare(right.createdAt);
	if (byCreated !== 0) return byCreated;
	return left.id.localeCompare(right.id);
}

function replaceAt(records: ReadonlyArray<MemoryRecord>, index: number, record: MemoryRecord): MemoryRecord[] {
	return records.map((item, itemIndex) => (itemIndex === index ? record : item));
}

function scopeRank(scope: MemoryRecord["scope"]): number {
	switch (scope) {
		case "global":
			return 0;
		case "repo":
			return 1;
		case "language":
			return 2;
		case "runtime":
			return 3;
		case "agent":
			return 4;
		case "task-family":
			return 5;
		case "hpc-domain":
			return 6;
	}
}

function parseJson(raw: string, source: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${source}: invalid JSON: ${message}`);
	}
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}
