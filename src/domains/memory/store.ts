import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { MEMORY_VERSION, type MemoryRecord, type MemoryStatus, type MemoryStoreFile } from "./types.js";
import { validateMemoryRecord } from "./validate.js";

export const MEMORY_STORE_MAX_RECORDS = 500;
export const MEMORY_STALE_APPROVED_DAYS = 180;
export const MEMORY_STALE_UNAPPROVED_DAYS = 30;
/** Prompt compilation fails closed above this read ceiling; store writers are unchanged. */
export const MEMORY_PROMPT_STORE_MAX_BYTES = 16 * 1024 * 1024;
/** Quarantined records kept beside the store; the oldest fall off first. */
export const MEMORY_INVALID_RECORDS_MAX = 100;

interface InvalidMemoryRecord {
	record: unknown;
	issues: string[];
}

interface ParsedMemoryStore {
	records: MemoryRecord[];
	invalid: InvalidMemoryRecord[];
}

/** Stores this process already told the operator about, so each gets one notice. */
const noticedInvalidStores = new Set<string>();
const pendingStoreNotices: string[] = [];

/** Operator notices the store raised since the last call: invalid records it set aside. */
export function takeMemoryStoreNotices(): string[] {
	return pendingStoreNotices.splice(0);
}

export interface MemoryStoreSnapshot {
	revision: string;
	records: MemoryRecord[];
}

/** Background writes share their caller's deadline and recheck authority after acquiring the lock. */
export interface MemoryMutationOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	isCurrent?: () => boolean;
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
	const { records } = parseAndValidate(raw.toString("utf8"), path);
	if (records.length > MEMORY_STORE_MAX_RECORDS) throw new Error("memory prompt store exceeds record limit");
	return { revision: createHash("sha256").update(raw).digest("hex"), records };
}

export function memoryRoot(dataDir: string): string {
	return join(dataDir, "memory");
}

export function memoryStorePath(dataDir: string): string {
	return join(memoryRoot(dataDir), "records.json");
}

function memoryInvalidRecordsPath(dataDir: string): string {
	return join(memoryRoot(dataDir), "records.invalid.json");
}

export async function loadMemoryRecords(dataDir: string): Promise<MemoryRecord[]> {
	let raw: string;
	try {
		raw = await readFile(memoryStorePath(dataDir), "utf8");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") return [];
		throw error;
	}
	return parseAndValidate(raw, memoryStorePath(dataDir)).records;
}

/**
 * Synchronous variant for hot prompt-build paths. Reads the local memory
 * store file each call. The store is bounded at MEMORY_STORE_MAX_RECORDS and
 * lives on local disk, so the sync read is cheap and avoids forcing every
 * prompt compile site to thread an async boundary through the chat loop.
 */
export function loadMemoryRecordsSync(dataDir: string): MemoryRecord[] {
	return readParsedStoreSync(dataDir).records;
}

function readParsedStoreSync(dataDir: string): ParsedMemoryStore {
	let raw: string;
	try {
		raw = readFileSync(memoryStorePath(dataDir), "utf8");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") return { records: [], invalid: [] };
		throw error;
	}
	return parseAndValidate(raw, memoryStorePath(dataDir));
}

/**
 * The envelope must be valid; a record that is not is set aside rather than
 * failing every read, and moves to `records.invalid.json` on the next write.
 * A store a newer build wrote is never touched.
 */
function parseAndValidate(raw: string, source: string): ParsedMemoryStore {
	const parsed = parseJson(raw, source);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("memory store invalid: $: expected object");
	}
	const envelope = parsed as Record<string, unknown>;
	const extra = Object.keys(envelope).filter((key) => key !== "version" && key !== "records");
	if (typeof envelope.version === "number" && envelope.version > MEMORY_VERSION) {
		throw new Error(`memory store version ${envelope.version} is newer than this build supports (${MEMORY_VERSION})`);
	}
	if (envelope.version !== MEMORY_VERSION) throw new Error("memory store invalid: $.version: expected 1");
	if (extra.length > 0) throw new Error(`memory store invalid: $.${extra[0]}: unexpected field`);
	if (!Array.isArray(envelope.records)) throw new Error("memory store invalid: $.records: expected array");
	const records: MemoryRecord[] = [];
	const invalid: InvalidMemoryRecord[] = [];
	envelope.records.forEach((value: unknown, index) => {
		const result = validateMemoryRecord(value, `$.records[${index}]`);
		if (result.valid) records.push(result.record);
		else invalid.push({ record: value, issues: result.issues.map((issue) => `${issue.path}: ${issue.message}`) });
	});
	if (invalid.length > 0 && !noticedInvalidStores.has(source)) {
		noticedInvalidStores.add(source);
		pendingStoreNotices.push(
			`memory store: ${invalid.length} invalid record${invalid.length === 1 ? "" : "s"} skipped; moved to ${join(dirname(source), "records.invalid.json")} on the next store write`,
		);
	}
	return { records: sortMemoryRecords(records), invalid };
}

function quarantineInvalidRecordsUnlocked(dataDir: string, invalid: ReadonlyArray<InvalidMemoryRecord>): void {
	const path = memoryInvalidRecordsPath(dataDir);
	let existing: unknown[] = [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (Array.isArray(parsed)) existing = parsed;
	} catch {
		// Missing or unreadable: start a fresh quarantine file.
	}
	const at = new Date().toISOString();
	const entries = [...existing, ...invalid.map((item) => ({ quarantinedAt: at, ...item }))].slice(
		-MEMORY_INVALID_RECORDS_MAX,
	);
	safeResourceWrite(path, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function writeMemoryRecordsUnlocked(
	dataDir: string,
	records: ReadonlyArray<MemoryRecord>,
	storedIds: ReadonlySet<string>,
): string {
	const sorted = sortMemoryRecords(evictForRoom(records, storedIds));
	const store: MemoryStoreFile = { version: MEMORY_VERSION, records: sorted };
	const path = memoryStorePath(dataDir);
	safeResourceWrite(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

/**
 * At the cap, make room from proposals nobody decided on: those without a
 * command or source evidence ref first, then evidence-backed ones, oldest
 * first. Approved records, operator rejections and records this write adds
 * are never evicted, so a write never reports a record it already dropped.
 */
function evictForRoom(
	records: ReadonlyArray<MemoryRecord>,
	storedIds: ReadonlySet<string>,
): ReadonlyArray<MemoryRecord> {
	const excess = records.length - MEMORY_STORE_MAX_RECORDS;
	if (excess <= 0) return records;
	const evictable = records
		.filter((record) => storedIds.has(record.id) && !record.approved && record.rejectedAt === undefined)
		.sort(
			(left, right) =>
				Number(hasEvidenceRef(left)) - Number(hasEvidenceRef(right)) ||
				left.createdAt.localeCompare(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
	if (evictable.length < excess) {
		throw new Error(`memory store limit reached (${MEMORY_STORE_MAX_RECORDS}); run clio-coder memory prune --stale`);
	}
	const evicted = new Set(evictable.slice(0, excess));
	return records.filter((record) => !evicted.has(record));
}

function hasEvidenceRef(record: MemoryRecord): boolean {
	return record.evidenceRefs.some((ref) => /^(?:command|source):/u.test(ref));
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
	options: MemoryMutationOptions = {},
): Promise<T> {
	return withStateFileLock(
		memoryStorePath(dataDir),
		() => {
			options.signal?.throwIfAborted();
			if (options.isCurrent?.() === false) throw new Error("memory write lost content authority");
			const parsed = readParsedStoreSync(dataDir);
			const outcome = mutate(parsed.records);
			options.signal?.throwIfAborted();
			if (options.isCurrent?.() === false) throw new Error("memory write lost content authority");
			if ("records" in outcome) {
				if (parsed.invalid.length > 0) quarantineInvalidRecordsUnlocked(dataDir, parsed.invalid);
				writeMemoryRecordsUnlocked(dataDir, outcome.records, new Set(parsed.records.map((record) => record.id)));
			}
			return outcome.result;
		},
		options,
	);
}

/** Insert `record` unless the store already holds it or `findExisting` names an equivalent. */
export async function insertMemoryRecordIfAbsent(
	dataDir: string,
	record: MemoryRecord,
	findExisting?: (records: ReadonlyArray<MemoryRecord>) => MemoryRecord | null,
	options: MemoryMutationOptions = {},
): Promise<{ record: MemoryRecord; created: boolean }> {
	return mutateMemoryRecords<{ record: MemoryRecord; created: boolean }>(
		dataDir,
		(records) => {
			const existing = records.find((item) => item.id === record.id) ?? findExisting?.(records) ?? null;
			if (existing !== null) return { result: { record: existing, created: false } };
			return { records: [...records, record], result: { record, created: true } };
		},
		options,
	);
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
