import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { rejectMemoryRecords } from "./operations.js";
import { loadMemoryRecordsSync } from "./store.js";
import type { MemoryRecord } from "./types.js";

/**
 * Releases before 0.6.8 filed lessons from sessions under an information-flow restriction, with no label, and they reach
 * every later route. One pass withdraws them. Nothing filed since can need it, because every filing path now refuses a
 * labeled source, so a marker ends the work for good and an operator's `memory approve` afterwards stands.
 */
const SWEEP_LOCK_TIMEOUT_MS = 2_000;

export interface MemoryFlowSweepPorts {
	/** When a session first took a label, as its ledger states it, or null for none. Throws when the ledger cannot be read. */
	sessionFirstLabelAt(sessionId: string): string | null;
	/** Whether a repository's project declares source rules, so an unknown source cannot be vouched for there. */
	repositoryDeclaresFlowRules(repositoryPath: string): boolean;
}

function memoryFlowSweepMarkerPath(stateDir: string): string {
	return join(stateDir, "memory", "flow-sweep-v1.json");
}

/** The live records the sweep withdraws: filed at or after their source's label, or unvouched under source rules. */
export function restrictedMemoryRecordIds(
	records: ReadonlyArray<MemoryRecord>,
	ports: MemoryFlowSweepPorts,
): Set<string> {
	const sessions = new Map<string, { labelAt: string | null } | "unreadable">();
	const repositories = new Map<string, boolean>();
	const underRules = (record: MemoryRecord): boolean => {
		const path = record.repository?.key;
		if (path === undefined) return false;
		let declared = repositories.get(path);
		if (declared === undefined) {
			declared = ports.repositoryDeclaresFlowRules(path);
			repositories.set(path, declared);
		}
		return declared;
	};
	const sessionState = (sessionId: string): { labelAt: string | null } | "unreadable" => {
		let state = sessions.get(sessionId);
		if (state === undefined) {
			try {
				state = { labelAt: ports.sessionFirstLabelAt(sessionId) };
			} catch {
				// A ledger that is gone or unreadable states nothing; the record's repository decides below.
				state = "unreadable";
			}
			sessions.set(sessionId, state);
		}
		return state;
	};
	const ids = new Set<string>();
	for (const record of records) {
		if (record.rejectedAt !== undefined) continue;
		const sessionId = record.provenance?.sourceSessionId;
		const state = sessionId === undefined ? "unreadable" : sessionState(sessionId);
		const restricted =
			state === "unreadable"
				? underRules(record)
				: state.labelAt !== null && !(Date.parse(record.createdAt) < Date.parse(state.labelAt));
		if (restricted) ids.add(record.id);
	}
	return ids;
}

/**
 * Run the sweep unless its marker exists. Returns the ids it rejected, or null when an earlier pass already finished.
 * Throws with no marker written when the store or the marker cannot be handled, so the next boot tries again.
 */
export async function sweepRestrictedMemory(
	dataDir: string,
	stateDir: string,
	ports: MemoryFlowSweepPorts,
	now: Date = new Date(),
): Promise<string[] | null> {
	const marker = memoryFlowSweepMarkerPath(stateDir);
	if (existsSync(marker)) return null;
	const ids = restrictedMemoryRecordIds(loadMemoryRecordsSync(dataDir), ports);
	const rejected =
		ids.size > 0 ? await rejectMemoryRecords(dataDir, ids, now, { timeoutMs: SWEEP_LOCK_TIMEOUT_MS }) : [];
	safeResourceWrite(marker, `${JSON.stringify({ version: 1, at: now.toISOString(), rejected }, null, 2)}\n`, {
		mode: 0o600,
	});
	return rejected;
}

export function memoryFlowSweepNotice(count: number): string {
	return `Memory withdrew ${count} lesson${count === 1 ? "" : "s"} filed from sessions under an information-flow restriction. Review with clio-coder memory list; clio-coder memory approve <id> restores one.`;
}
