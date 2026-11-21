import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock, withStateFileLockSync } from "../../core/state-file-lock.js";
import {
	AGENT_NOTE_EVIDENCE_PREFIX,
	MEMORY_VERSION,
	type MemoryRecord,
	type MemoryStatus,
	type MemoryStoreFile,
} from "./types.js";
import { validateMemoryRecord } from "./validate.js";

export const MEMORY_STORE_MAX_RECORDS = 500;
export const MEMORY_STALE_APPROVED_DAYS = 180;
export const MEMORY_STALE_UNAPPROVED_DAYS = 30;
/** Prompt compilation fails closed above this read ceiling; store writers are unchanged. */
export const MEMORY_PROMPT_STORE_MAX_BYTES = 16 * 1024 * 1024;

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

export async function loadMemoryRecords(dataDir: string): Promise<MemoryRecord[]> {
	return (await loadMemoryStore(dataDir)).records;
}

/** The valid records and the ones set aside as invalid; a read never writes, so those stay put until a store write. */
export async function loadMemoryStore(dataDir: string): Promise<ParsedMemoryStore> {
	let raw: string;
	try {
		raw = await readFile(memoryStorePath(dataDir), "utf8");
	} catch (error) {
		if (isErrorWithCode(error) && error.code === "ENOENT") return { records: [], invalid: [] };
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
 * failing every read, and is dropped by the next write.
 * A store of any other version, newer or older, is never touched; it reads as an error, and `clio-coder doctor --fix`
 * rewrites an older one with only the records this build reads.
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
	if (envelope.version !== MEMORY_VERSION)
		throw new Error(
			`memory store invalid: $.version: expected ${MEMORY_VERSION} (run \`clio-coder doctor --fix\` to drop what this build cannot read)`,
		);
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
			`memory store: ${invalid.length} invalid record${invalid.length === 1 ? "" : "s"} skipped; dropped by the next store write`,
		);
	}
	return { records: sortMemoryRecords(records), invalid };
}

export interface MemoryStoreRepair {
	path: string;
	/** The version the store was at; the repair writes the current one. */
	fromVersion: number | null;
	kept: number;
	dropped: number;
	/** Files earlier builds kept beside the store, deleted by the repair. */
	removedFiles: string[];
}

/** Files earlier builds wrote under the memory roots and this build never reads. */
function retiredMemoryFiles(dataDir: string, stateDir: string): string[] {
	return [join(memoryRoot(dataDir), "records.invalid.json"), join(stateDir, "memory", "flow-sweep-v1.json")];
}

/**
 * What `clio-coder doctor --fix` would change in the memory store, read-only: an older envelope, records this build
 * does not read, and retired files beside it. Null when there is nothing to repair; a newer or unparseable store is
 * never touched.
 */
export function inspectMemoryStoreRepair(dataDir: string, stateDir: string): MemoryStoreRepair | null {
	return planMemoryStoreRepair(dataDir, stateDir)?.repair ?? null;
}

function planMemoryStoreRepair(
	dataDir: string,
	stateDir: string,
): { repair: MemoryStoreRepair; records: MemoryRecord[] | null } | null {
	const path = memoryStorePath(dataDir);
	const removedFiles = retiredMemoryFiles(dataDir, stateDir).filter((file) => existsSync(file));
	let records: MemoryRecord[] | null = null;
	let fromVersion: number | null = null;
	let dropped = 0;
	let raw: string | null = null;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
	}
	if (raw !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
		const envelope =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
		if (
			envelope !== null &&
			typeof envelope.version === "number" &&
			envelope.version <= MEMORY_VERSION &&
			Array.isArray(envelope.records)
		) {
			const kept: MemoryRecord[] = [];
			for (const value of envelope.records) {
				const result = validateMemoryRecord(value);
				if (result.valid) kept.push(result.record);
				else dropped += 1;
			}
			const extra = Object.keys(envelope).some((key) => key !== "version" && key !== "records");
			if (envelope.version !== MEMORY_VERSION || dropped > 0 || extra) {
				records = kept;
				fromVersion = envelope.version;
			}
		}
	}
	if (records === null && removedFiles.length === 0) return null;
	return { repair: { path, fromVersion, kept: records?.length ?? 0, dropped, removedFiles }, records };
}

/**
 * Rewrite an older or partly unreadable store as the current version with only the records this build reads, and
 * delete the retired files beside it. Records are kept as written; nothing is converted.
 */
export function repairMemoryStore(dataDir: string, stateDir: string): MemoryStoreRepair | null {
	return withStateFileLockSync(memoryStorePath(dataDir), () => {
		const plan = planMemoryStoreRepair(dataDir, stateDir);
		if (plan === null) return null;
		if (plan.records !== null) {
			writeMemoryRecordsUnlocked(dataDir, plan.records, new Set(plan.records.map((record) => record.id)));
		}
		for (const file of plan.repair.removedFiles) rmSync(file, { force: true });
		return plan.repair;
	});
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
 * At the cap, make room from notes nobody decided on: first those with no
 * command or source evidence ref that no agent wrote through `memory_note`,
 * then the other unpromoted notes, the one observed longest
 * ago first. A lesson, an operator approval or rejection, and a record this
 * write adds are never evicted, so a write never reports a record it already
 * dropped.
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
				lastObservedAt(left).localeCompare(lastObservedAt(right)) ||
				left.id.localeCompare(right.id),
		);
	if (evictable.length < excess) {
		throw new Error(`memory store limit reached (${MEMORY_STORE_MAX_RECORDS}); run clio-coder memory prune --stale`);
	}
	const evicted = new Set(evictable.slice(0, excess));
	return records.filter((record) => !evicted.has(record));
}

/** The newest thing the store saw of a record: a verdict, a delivery, or its creation. */
function lastObservedAt(record: MemoryRecord): string {
	let latest = record.lastDeliveredAt ?? record.createdAt;
	for (const item of record.observations ?? []) if (item.at > latest) latest = item.at;
	return latest;
}

function hasEvidenceRef(record: MemoryRecord): boolean {
	return (
		record.evidenceRefs.some((ref) => /^(?:command|source):/u.test(ref)) ||
		record.provenance?.evidenceId?.startsWith(AGENT_NOTE_EVIDENCE_PREFIX) === true
	);
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
