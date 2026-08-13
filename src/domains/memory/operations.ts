import { isAbsolute } from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { ceilChars } from "../session/context-accounting.js";
import { pruneStaleMemoryRecords, sortMemoryRecords, updateMemoryRecord } from "./store.js";
import type { MemoryRecord, MemoryRepositoryIdentity, MemoryRetrievalOptions } from "./types.js";

export async function approveMemoryRecord(
	dataDir: string,
	memoryId: string,
	now: Date = new Date(),
): Promise<MemoryRecord> {
	return updateMemoryRecord(dataDir, memoryId, (record) => approveRecord(record, now));
}

export async function rejectMemoryRecord(
	dataDir: string,
	memoryId: string,
	now: Date = new Date(),
): Promise<MemoryRecord> {
	return updateMemoryRecord(dataDir, memoryId, (record) => rejectRecord(record, now));
}

export async function pruneStaleMemory(dataDir: string, now: Date = new Date()): Promise<MemoryRecord[]> {
	return pruneStaleMemoryRecords(dataDir, now);
}

export function selectApprovedMemory(
	records: ReadonlyArray<MemoryRecord>,
	options: MemoryRetrievalOptions,
): MemoryRecord[] {
	if (options.tokenBudget <= 0) return [];
	const allowedScopes = options.scopes === undefined ? null : new Set(options.scopes);
	const activeRepository = canonicalActiveRepository(options.activeRepository);
	const candidates = sortMemoryRecords(records)
		.filter((record) => record.approved)
		.filter((record) => record.evidenceRefs.length > 0)
		.filter((record) => record.regressions === undefined || record.regressions.length === 0)
		.filter((record) => allowedScopes === null || allowedScopes.has(record.scope))
		.filter((record) => repositoryApplies(record, activeRepository))
		.sort(compareRetrievalPriority);
	const selected: MemoryRecord[] = [];
	let spent = 0;
	for (const record of candidates) {
		const cost = estimateMemoryTokens(record);
		if (spent + cost > options.tokenBudget) continue;
		selected.push(record);
		spent += cost;
	}
	return selected;
}

export function estimateMemoryTokens(record: MemoryRecord): number {
	const text = [
		record.scope,
		record.key,
		record.lesson,
		...(record.repository === undefined ? [] : [record.repository.kind, record.repository.key]),
		...record.evidenceRefs,
		...record.appliesWhen,
		...record.avoidWhen,
		...(record.regressions ?? []),
	].join("\n");
	return Math.max(1, ceilChars(text.length));
}

function cloneRecord(record: MemoryRecord): MemoryRecord {
	const next: MemoryRecord = {
		id: record.id,
		scope: record.scope,
		key: record.key,
		lesson: record.lesson,
		evidenceRefs: [...record.evidenceRefs],
		appliesWhen: [...record.appliesWhen],
		avoidWhen: [...record.avoidWhen],
		confidence: record.confidence,
		createdAt: record.createdAt,
		approved: record.approved,
	};
	if (record.lastVerifiedAt !== undefined) next.lastVerifiedAt = record.lastVerifiedAt;
	if (record.regressions !== undefined) next.regressions = [...record.regressions];
	if (record.rejectedAt !== undefined) next.rejectedAt = record.rejectedAt;
	if (record.repository !== undefined) next.repository = { ...record.repository };
	return next;
}

/**
 * Build the path identity expected by memory selection. The input must be an
 * absolute active repository root. Existing symlinks are resolved; non-Git
 * directories are valid identities too. Missing/moved paths stay distinct
 * from their former location and therefore fail closed against old records.
 */
export function canonicalMemoryRepositoryIdentity(repositoryPath: string): MemoryRepositoryIdentity | null {
	if (!isUsableAbsoluteRepositoryPath(repositoryPath)) return null;
	const key = canonicalizeExistingPath(repositoryPath);
	if (!isUsableAbsoluteRepositoryPath(key)) return null;
	return { kind: "canonical-path", key };
}

function canonicalActiveRepository(
	identity: MemoryRepositoryIdentity | null | undefined,
): MemoryRepositoryIdentity | null {
	if (identity === null || identity === undefined || identity.kind !== "canonical-path") return null;
	const canonical = canonicalMemoryRepositoryIdentity(identity.key);
	if (canonical === null || canonical.key !== identity.key) return null;
	return canonical;
}

function repositoryApplies(record: MemoryRecord, activeRepository: MemoryRepositoryIdentity | null): boolean {
	if (record.scope !== "repo") return true;
	if (activeRepository === null) return false;

	// The structured field is the only applicability mechanism: a repo-scoped
	// record without it never enters any repository prompt.
	if (record.repository === undefined) return false;
	return record.repository.kind === activeRepository.kind && record.repository.key === activeRepository.key;
}

function isUsableAbsoluteRepositoryPath(value: string): boolean {
	return value.length > 0 && !/[\0\r\n]/u.test(value) && isAbsolute(value);
}

function approveRecord(record: MemoryRecord, now: Date): MemoryRecord {
	const next = cloneRecord(record);
	next.approved = true;
	next.lastVerifiedAt = now.toISOString();
	Reflect.deleteProperty(next, "rejectedAt");
	return next;
}

function rejectRecord(record: MemoryRecord, now: Date): MemoryRecord {
	const next = cloneRecord(record);
	next.approved = false;
	next.rejectedAt = now.toISOString();
	return next;
}

function compareRetrievalPriority(left: MemoryRecord, right: MemoryRecord): number {
	const leftVerified = left.lastVerifiedAt ?? left.createdAt;
	const rightVerified = right.lastVerifiedAt ?? right.createdAt;
	const byVerified = rightVerified.localeCompare(leftVerified);
	if (byVerified !== 0) return byVerified;
	return left.id.localeCompare(right.id);
}
