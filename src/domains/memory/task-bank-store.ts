/**
 * Durable snapshots of a session's task bank.
 *
 * The bank is authoritative only while its session is open, and it used to be
 * cleared on park and on resume alike, so reopening a session with `/resume`
 * handed the guardian an empty bank and the first step relearned what the
 * session already knew. A snapshot is written when a session is parked and
 * read back only when that same session is resumed; nothing here crosses from
 * one session into another.
 */

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import {
	TASK_MEMORY_CONTENT_MAX_CHARS,
	TASK_MEMORY_VERSION,
	type TaskMemoryEntry,
	type TaskMemorySnapshot,
} from "./task-bank.js";

/** Newest snapshots kept; a session older than these resumes with an empty bank. */
export const TASK_BANK_SNAPSHOT_RETAIN = 64;
const SNAPSHOT_MAX_BYTES = 512 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function taskBankSnapshotDir(stateDir: string): string {
	return join(stateDir, "memory", "banks");
}

/**
 * Returns false when nothing was written. An empty bank removes the session's
 * older snapshot instead of leaving it: a bank cleared by `/tree` and then
 * parked empty would otherwise resume with the entries of the branch it left.
 */
export function saveTaskBankSnapshot(stateDir: string, sessionId: string, snapshot: TaskMemorySnapshot): boolean {
	if (!SESSION_ID_PATTERN.test(sessionId)) return false;
	if (snapshot.status === null && snapshot.knowledge.length === 0 && snapshot.procedural.length === 0) {
		deleteTaskBankSnapshot(stateDir, sessionId);
		return false;
	}
	const dir = taskBankSnapshotDir(stateDir);
	safeResourceWrite(join(dir, `${sessionId}.json`), `${JSON.stringify(snapshot)}\n`, { encoding: "utf8" });
	pruneSnapshots(dir);
	return true;
}

/** A snapshot describes one parked point of one session; any navigation away from that point retires it. */
export function deleteTaskBankSnapshot(stateDir: string, sessionId: string): void {
	if (!SESSION_ID_PATTERN.test(sessionId)) return;
	rmSync(join(taskBankSnapshotDir(stateDir), `${sessionId}.json`), { force: true });
}

export function loadTaskBankSnapshot(stateDir: string, sessionId: string): TaskMemorySnapshot | null {
	if (!SESSION_ID_PATTERN.test(sessionId)) return null;
	const path = join(taskBankSnapshotDir(stateDir), `${sessionId}.json`);
	try {
		if (statSync(path).size > SNAPSHOT_MAX_BYTES) return null;
		return parseSnapshot(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch {
		// Missing or unreadable: the session resumes with the empty bank it had before snapshots existed.
		return null;
	}
}

function parseSnapshot(value: unknown): TaskMemorySnapshot | null {
	if (!isRecord(value) || value.version !== TASK_MEMORY_VERSION) return null;
	if (!Array.isArray(value.knowledge) || !Array.isArray(value.procedural)) return null;
	const status = value.status === null ? null : parseEntry(value.status, "status");
	if (value.status !== null && status === null) return null;
	const knowledge = value.knowledge.map((entry) => parseEntry(entry, "knowledge"));
	const procedural = value.procedural.map((entry) => parseEntry(entry, "procedural"));
	if (knowledge.includes(null) || procedural.includes(null)) return null;
	return {
		version: TASK_MEMORY_VERSION,
		status,
		knowledge: knowledge.filter((entry) => entry !== null),
		procedural: procedural.filter((entry) => entry !== null),
	};
}

function parseEntry(value: unknown, kind: TaskMemoryEntry["kind"]): TaskMemoryEntry | null {
	if (!isRecord(value) || value.kind !== kind) return null;
	const { id, content, createdAt, lastTouchedAt, injectionCount } = value;
	if (typeof id !== "string" || !/^tm-[skp]-[0-9a-z]+$/u.test(id)) return null;
	if (typeof content !== "string" || content.length === 0 || content.length > TASK_MEMORY_CONTENT_MAX_CHARS) return null;
	if (typeof createdAt !== "string" || typeof lastTouchedAt !== "string") return null;
	if (typeof injectionCount !== "number" || !Number.isInteger(injectionCount) || injectionCount < 0) return null;
	return {
		id,
		kind,
		content,
		createdAt,
		lastTouchedAt,
		injectionCount,
		...(value.durable === true ? { durable: true } : {}),
		...(value.durable === true &&
		typeof value.evidenceCommand === "string" &&
		value.evidenceCommand.length > 0 &&
		value.evidenceCommand.length <= TASK_MEMORY_CONTENT_MAX_CHARS
			? { evidenceCommand: value.evidenceCommand }
			: {}),
		...(value.durable === true && isEvidenceSource(value.evidenceSource)
			? { evidenceSource: { path: value.evidenceSource.path, quote: value.evidenceSource.quote } }
			: {}),
	};
}

function isEvidenceSource(value: unknown): value is { path: string; quote: string } {
	if (value === null || typeof value !== "object") return false;
	const { path, quote } = value as { path?: unknown; quote?: unknown };
	return (
		typeof path === "string" &&
		path.length > 0 &&
		path.length <= TASK_MEMORY_CONTENT_MAX_CHARS &&
		typeof quote === "string" &&
		quote.length > 0 &&
		quote.length <= TASK_MEMORY_CONTENT_MAX_CHARS
	);
}

function pruneSnapshots(dir: string): void {
	try {
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => ({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs }))
			.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const file of files.slice(TASK_BANK_SNAPSHOT_RETAIN)) rmSync(file.path, { force: true });
	} catch {
		// Retention is best effort; an unpruned directory only costs disk.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
