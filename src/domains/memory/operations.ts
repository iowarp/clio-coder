import { loadMemoryRecords, pruneStaleMemoryRecords, sortMemoryRecords, updateMemoryRecord } from "./store.js";
import type { MemoryRecord, MemoryRetrievalOptions } from "./types.js";

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

export async function retrieveApprovedMemory(
	dataDir: string,
	options: MemoryRetrievalOptions,
): Promise<MemoryRecord[]> {
	return selectApprovedMemory(await loadMemoryRecords(dataDir), options);
}

export function selectApprovedMemory(
	records: ReadonlyArray<MemoryRecord>,
	options: MemoryRetrievalOptions,
): MemoryRecord[] {
	if (options.tokenBudget <= 0) return [];
	const allowedScopes = options.scopes === undefined ? null : new Set(options.scopes);
	const candidates = sortMemoryRecords(records)
		.filter((record) => record.approved)
		.filter((record) => record.evidenceRefs.length > 0)
		.filter((record) => record.regressions === undefined || record.regressions.length === 0)
		.filter((record) => allowedScopes === null || allowedScopes.has(record.scope))
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
		...record.evidenceRefs,
		...record.appliesWhen,
		...record.avoidWhen,
		...(record.regressions ?? []),
	].join("\n");
	return Math.max(1, Math.ceil(text.length / 4));
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
	return next;
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
