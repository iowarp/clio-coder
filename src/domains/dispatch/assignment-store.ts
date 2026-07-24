/**
 * Durable logical-dispatch state. Assignment records live beside the run
 * ledger in `assignments.json`; immutable attempt evidence remains in receipts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import type { AssignmentStatus } from "./assignment.js";

const MAX_ASSIGNMENT_RECORDS = 1_000;

export interface DurableAssignmentRecord {
	assignmentId: string;
	attempts: string[];
	terminalRunId: string | null;
	status: AssignmentStatus;
}

interface AssignmentStoreFile {
	version: 1;
	assignments: DurableAssignmentRecord[];
}

function storePath(): string {
	return join(clioStateDir(), "assignments.json");
}

function validRecord(value: unknown): value is DurableAssignmentRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<DurableAssignmentRecord>;
	return (
		typeof record.assignmentId === "string" &&
		Array.isArray(record.attempts) &&
		record.attempts.every((runId) => typeof runId === "string") &&
		(record.terminalRunId === null || typeof record.terminalRunId === "string") &&
		(record.status === "running" ||
			record.status === "succeeded" ||
			record.status === "failed" ||
			record.status === "canceled")
	);
}

function readStore(): DurableAssignmentRecord[] {
	const path = storePath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as AssignmentStoreFile;
		if (parsed?.version !== 1 || !Array.isArray(parsed.assignments)) return [];
		return parsed.assignments.filter(validRecord).map(copyRecord);
	} catch {
		return [];
	}
}

function copyRecord(record: DurableAssignmentRecord): DurableAssignmentRecord {
	return { ...record, attempts: [...record.attempts] };
}

function writeStore(assignments: ReadonlyArray<DurableAssignmentRecord>): void {
	const file: AssignmentStoreFile = {
		version: 1,
		assignments: assignments.slice(0, MAX_ASSIGNMENT_RECORDS).map(copyRecord),
	};
	atomicWrite(storePath(), JSON.stringify(file, null, 2));
}

async function updateRecord(
	assignmentId: string,
	update: (current: DurableAssignmentRecord | null) => DurableAssignmentRecord,
): Promise<DurableAssignmentRecord> {
	let result!: DurableAssignmentRecord;
	await withStateFileLock(storePath(), () => {
		const records = readStore();
		const index = records.findIndex((record) => record.assignmentId === assignmentId);
		const current = index === -1 ? null : (records[index] ?? null);
		result = update(current);
		if (index === -1) records.unshift(result);
		else records[index] = result;
		writeStore(records);
	});
	return copyRecord(result);
}

export function getStoredAssignment(assignmentId: string): DurableAssignmentRecord | null {
	const record = readStore().find((entry) => entry.assignmentId === assignmentId);
	return record ? copyRecord(record) : null;
}

export function listStoredAssignments(): ReadonlyArray<DurableAssignmentRecord> {
	return readStore();
}

export function registerAssignment(assignmentId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(
		assignmentId,
		(current) => current ?? { assignmentId, attempts: [], terminalRunId: null, status: "running" },
	);
}

export function recordAssignmentAttempt(assignmentId: string, runId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? { assignmentId, attempts: [], terminalRunId: null, status: "running" as const };
		return base.attempts.includes(runId) ? base : { ...base, attempts: [...base.attempts, runId] };
	});
}

export function cancelStoredAssignment(assignmentId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? { assignmentId, attempts: [], terminalRunId: null, status: "running" as const };
		return base.status === "running" ? { ...base, status: "canceled" } : base;
	});
}

export function settleStoredAssignment(
	assignmentId: string,
	terminalRunId: string,
	status: Exclude<AssignmentStatus, "running">,
): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? { assignmentId, attempts: [], terminalRunId: null, status: "running" as const };
		const attempts = base.attempts.includes(terminalRunId) ? base.attempts : [...base.attempts, terminalRunId];
		return { ...base, attempts, terminalRunId, status };
	});
}
