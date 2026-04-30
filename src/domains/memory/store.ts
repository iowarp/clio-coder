import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_VERSION, type MemoryRecord, type MemoryStatus, type MemoryStoreFile } from "./types.js";
import { validateMemoryStore } from "./validate.js";

export const MEMORY_STORE_MAX_RECORDS = 500;
export const MEMORY_STALE_APPROVED_DAYS = 180;
export const MEMORY_STALE_UNAPPROVED_DAYS = 30;

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

export async function writeMemoryRecords(dataDir: string, records: ReadonlyArray<MemoryRecord>): Promise<string> {
	const sorted = sortMemoryRecords(records);
	if (sorted.length > MEMORY_STORE_MAX_RECORDS) {
		throw new Error(`memory store limit reached (${MEMORY_STORE_MAX_RECORDS}); run clio memory prune --stale`);
	}
	const store: MemoryStoreFile = { version: MEMORY_VERSION, records: sorted };
	const path = memoryStorePath(dataDir);
	await mkdir(memoryRoot(dataDir), { recursive: true });
	await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	return path;
}

export async function upsertMemoryRecord(dataDir: string, record: MemoryRecord): Promise<MemoryRecord> {
	const records = await loadMemoryRecords(dataDir);
	const existingIndex = records.findIndex((item) => item.id === record.id);
	const next = existingIndex === -1 ? [...records, record] : replaceAt(records, existingIndex, record);
	await writeMemoryRecords(dataDir, next);
	return record;
}

export async function updateMemoryRecord(
	dataDir: string,
	memoryId: string,
	update: (record: MemoryRecord) => MemoryRecord,
): Promise<MemoryRecord> {
	const records = await loadMemoryRecords(dataDir);
	const index = records.findIndex((record) => record.id === memoryId);
	if (index === -1) throw new Error(`memory record not found: ${memoryId}`);
	const current = records[index];
	if (current === undefined) throw new Error(`memory record not found: ${memoryId}`);
	const updated = update(current);
	await writeMemoryRecords(dataDir, replaceAt(records, index, updated));
	return updated;
}

export async function pruneStaleMemoryRecords(dataDir: string, now: Date = new Date()): Promise<MemoryRecord[]> {
	const records = await loadMemoryRecords(dataDir);
	const kept = records.filter((record) => !isStaleMemoryRecord(record, now));
	const pruned = records.filter((record) => isStaleMemoryRecord(record, now));
	await writeMemoryRecords(dataDir, kept);
	return pruned;
}

export function isStaleMemoryRecord(record: MemoryRecord, now: Date): boolean {
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

export function compareMemoryRecords(left: MemoryRecord, right: MemoryRecord): number {
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
