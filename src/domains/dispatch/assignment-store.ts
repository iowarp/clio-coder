/**
 * Durable logical-dispatch state. Assignment records live beside the run
 * ledger in `assignments.json`; immutable attempt evidence remains in receipts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../../core/process-identity.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import type { AssignmentStatus } from "./assignment.js";

const MAX_ASSIGNMENT_RECORDS = 1_000;

/**
 * Who decides a record's status.
 *
 * Absent is the ordinary case: the record is one logical dispatch, so the
 * attempts filed under it are the only thing that can settle it. A fleet claims
 * the verdict instead, because a fleet root gathers every step of a run under
 * one id and no single step is the run's answer. Without the claim the last
 * step to settle writes the row, which reports a green step of an aborted run
 * as the run's outcome.
 */
export type AssignmentVerdictOwner = "fleet";

/**
 * Durable identity of the process executing a running assignment. A pid alone
 * is not enough: the OS may recycle it after a crash, so the process birth
 * token must still match before another extension treats the owner as live.
 */
export interface AssignmentProcessOwner {
	pid: number;
	processBirthToken: string;
	acquiredAt: string;
}

export interface AssignmentProcessOwnerProbe {
	birthToken(pid: number): string | null;
	/** True when a missing birth token proves that the process is gone. */
	tokenProvesDeath?: boolean;
	/** Liveness fallback for platforms whose birth token is synthetic. */
	alive?(pid: number): boolean;
}

/**
 * One durable logical-dispatch row.
 *
 * `attempts` holds terminal run ids: an agent attempt's receipt id, and for a
 * fleet also each deterministic step's `code-*` run id, whose evidence lives
 * under `code-steps/<assignmentId>/`. `status` answers for the whole record,
 * so for a fleet it answers for the whole run rather than for its last step.
 */
export interface DurableAssignmentRecord {
	assignmentId: string;
	attempts: string[];
	terminalRunId: string | null;
	status: AssignmentStatus;
	/** Set when something other than the attempts decides `status`. */
	verdictOwner?: AssignmentVerdictOwner;
	/** Process lease held only while this record is running. */
	processOwner?: AssignmentProcessOwner;
}

interface AssignmentStoreFile {
	version: 1;
	assignments: DurableAssignmentRecord[];
}

function storePath(): string {
	return join(clioStateDir(), "assignments.json");
}

function validProcessOwner(value: unknown): value is AssignmentProcessOwner {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const owner = value as Partial<AssignmentProcessOwner>;
	return (
		Number.isSafeInteger(owner.pid) &&
		(owner.pid ?? 0) > 0 &&
		typeof owner.processBirthToken === "string" &&
		typeof owner.acquiredAt === "string" &&
		Number.isFinite(Date.parse(owner.acquiredAt))
	);
}

function validRecord(value: unknown): value is DurableAssignmentRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<DurableAssignmentRecord>;
	return (
		typeof record.assignmentId === "string" &&
		Array.isArray(record.attempts) &&
		record.attempts.every((runId) => typeof runId === "string") &&
		(record.terminalRunId === null || typeof record.terminalRunId === "string") &&
		(record.verdictOwner === undefined || record.verdictOwner === "fleet") &&
		(record.processOwner === undefined || validProcessOwner(record.processOwner)) &&
		(record.status === "running" ||
			record.status === "succeeded" ||
			record.status === "failed" ||
			record.status === "canceled" ||
			record.status === "timed_out")
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
	return {
		...record,
		attempts: [...record.attempts],
		...(record.processOwner === undefined ? {} : { processOwner: { ...record.processOwner } }),
	};
}

const defaultProcessOwnerProbe: AssignmentProcessOwnerProbe = {
	birthToken: processBirthToken,
	tokenProvesDeath: BIRTH_TOKEN_SOURCE_AVAILABLE,
	alive: processAlive,
};

/** True only when the durable identity still names the same live process. */
export function assignmentProcessOwnerAlive(
	record: Pick<DurableAssignmentRecord, "processOwner">,
	probe: AssignmentProcessOwnerProbe = defaultProcessOwnerProbe,
): boolean {
	const owner = record.processOwner;
	if (owner === undefined) return false;
	const current = probe.birthToken(owner.pid);
	if (current === null || current !== owner.processBirthToken) return false;
	// A synthetic `pid-N` token cannot distinguish pid reuse, so require an
	// independent liveness signal on platforms without a real birth-token source.
	if (probe.tokenProvesDeath === false) return probe.alive?.(owner.pid) ?? false;
	return true;
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

export async function renameStoredAssignment(
	fromAssignmentId: string,
	toAssignmentId: string,
): Promise<DurableAssignmentRecord> {
	let result!: DurableAssignmentRecord;
	await withStateFileLock(storePath(), () => {
		const records = readStore();
		const from = records.findIndex((record) => record.assignmentId === fromAssignmentId);
		if (from === -1) throw new Error(`unknown queued assignment '${fromAssignmentId}'`);
		if (records.some((record) => record.assignmentId === toAssignmentId))
			throw new Error(`assignment '${toAssignmentId}' already exists`);
		const current = records[from];
		if (!current) throw new Error(`unknown queued assignment '${fromAssignmentId}'`);
		result = { ...current, assignmentId: toAssignmentId };
		records[from] = result;
		writeStore(records);
	});
	return copyRecord(result);
}

function currentProcessOwner(): AssignmentProcessOwner {
	const token = processBirthToken();
	if (token === null) throw new Error("dispatch: cannot establish assignment owner process birth token");
	return {
		pid: process.pid,
		processBirthToken: token,
		acquiredAt: new Date().toISOString(),
	};
}

function openRecord(assignmentId: string): DurableAssignmentRecord {
	return {
		assignmentId,
		attempts: [],
		terminalRunId: null,
		status: "running",
		processOwner: currentProcessOwner(),
	};
}

function ensureRunningProcessOwner(record: DurableAssignmentRecord): DurableAssignmentRecord {
	if (record.status !== "running" || record.processOwner !== undefined) return record;
	return { ...record, processOwner: currentProcessOwner() };
}

function clearProcessOwner(record: DurableAssignmentRecord): DurableAssignmentRecord {
	const result = { ...record };
	delete result.processOwner;
	return result;
}

export function registerAssignment(assignmentId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => ensureRunningProcessOwner(current ?? openRecord(assignmentId)));
}

/**
 * Reserve this record's status for `owner`, opening the record if it is new.
 * Attempts filed by anyone are still recorded; only the verdict is reserved,
 * and until the owner settles it the record stays `running`.
 */
export function claimAssignmentVerdict(
	assignmentId: string,
	owner: AssignmentVerdictOwner,
): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => ({
		...ensureRunningProcessOwner(current ?? openRecord(assignmentId)),
		verdictOwner: owner,
	}));
}

export function recordAssignmentAttempt(assignmentId: string, runId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = ensureRunningProcessOwner(current ?? openRecord(assignmentId));
		return base.attempts.includes(runId) ? base : { ...base, attempts: [...base.attempts, runId] };
	});
}

export function failQueuedAssignment(assignmentId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? openRecord(assignmentId);
		if (base.verdictOwner !== undefined) return base;
		return base.status === "running" ? clearProcessOwner({ ...base, status: "failed" }) : base;
	});
}

export function timeoutStoredAssignment(assignmentId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? openRecord(assignmentId);
		if (base.verdictOwner !== undefined) return base;
		return base.status === "running" ? clearProcessOwner({ ...base, status: "timed_out" }) : base;
	});
}

export function cancelStoredAssignment(assignmentId: string): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? openRecord(assignmentId);
		if (base.verdictOwner !== undefined) return base;
		return base.status === "running" ? clearProcessOwner({ ...base, status: "canceled" }) : base;
	});
}

/**
 * File `terminalRunId` as an attempt and, when the caller owns the verdict, set
 * the record's status. An attempt settling under a claimed record settles
 * itself and not the record: one fleet step reaching a green receipt says
 * nothing about the six steps behind it that never ran.
 */
export function settleStoredAssignment(
	assignmentId: string,
	terminalRunId: string,
	status: Exclude<AssignmentStatus, "running">,
	owner?: AssignmentVerdictOwner,
): Promise<DurableAssignmentRecord> {
	return updateRecord(assignmentId, (current) => {
		const base = current ?? openRecord(assignmentId);
		const attempts = base.attempts.includes(terminalRunId) ? base.attempts : [...base.attempts, terminalRunId];
		if (base.verdictOwner !== owner) return { ...base, attempts };
		return clearProcessOwner({ ...base, attempts, terminalRunId, status });
	});
}
