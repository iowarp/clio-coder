/**
 * Delivery's unsettled-session ledger, beside the recall-use ledger in the state root.
 *
 * DESIGN 4.4 demotes a lesson delivered in three sessions in a row with no verdict. The count is kept here, keyed by
 * record id and claim revision, and never on the record: the store's schema is unchanged, so a build without this
 * slice reads every record as it did, and no operator-decided record gains a field. A delivery adds its session; any
 * verdict on the record (held or contradicted, whichever session gave it) clears the entry; a new revision starts over.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { MemoryGateOutcome } from "./guardian-gate.js";

/** Delivering sessions in a row with no verdict that return a lesson to the note layer. */
export const MEMORY_UNSETTLED_SESSIONS_MAX = 3;
/** Records the ledger keeps; the entries written longest ago fall off first. */
const UNSETTLED_LEDGER_MAX_RECORDS = 1_000;
const UNSETTLED_LEDGER_LOCK_TIMEOUT_MS = 2_000;

export interface UnsettledEntry {
	/** The claim revision the deliveries were of. */
	revision: string;
	/** Delivering sessions, oldest first. */
	sessions: string[];
}

export interface UnsettledLedger {
	version: 1;
	records: Record<string, UnsettledEntry>;
}

function unsettledLedgerPath(stateDir: string): string {
	return join(stateDir, "memory", "delivery-unsettled-v1.json");
}

/** The ledger on disk; a missing or unreadable file reads as empty, since the count only ever withholds. */
export function readUnsettledLedger(stateDir: string): UnsettledLedger {
	try {
		const parsed = JSON.parse(readFileSync(unsettledLedgerPath(stateDir), "utf8")) as {
			version?: unknown;
			records?: unknown;
		};
		if (parsed.version !== 1 || typeof parsed.records !== "object" || parsed.records === null)
			return { version: 1, records: {} };
		const records: Record<string, UnsettledEntry> = {};
		for (const [id, entry] of Object.entries(parsed.records as Record<string, unknown>)) {
			const value = entry as { revision?: unknown; sessions?: unknown } | null;
			if (
				typeof value?.revision === "string" &&
				Array.isArray(value.sessions) &&
				value.sessions.every((session) => typeof session === "string")
			)
				records[id] = { revision: value.revision, sessions: [...(value.sessions as string[])] };
		}
		return { version: 1, records };
	} catch {
		return { version: 1, records: {} };
	}
}

/** Sessions that were delivered this revision of the record since its last verdict. */
export function unsettledSessions(ledger: UnsettledLedger, id: string, revision: string): readonly string[] {
	const entry = ledger.records[id];
	return entry?.revision === revision ? entry.sessions : [];
}

/** Fold recorded observations into the ledger. Operator-decided records are never counted. */
function foldUnsettled(ledger: UnsettledLedger, observed: MemoryGateOutcome["observed"]): UnsettledLedger {
	const records: Record<string, UnsettledEntry> = { ...ledger.records };
	for (const item of observed) {
		if (item.operator || item.kind !== "delivered") {
			delete records[item.memoryId];
			continue;
		}
		const prior = records[item.memoryId];
		const sessions = (prior?.revision === item.revision ? prior.sessions : []).filter((id) => id !== item.sessionId);
		delete records[item.memoryId];
		records[item.memoryId] = {
			revision: item.revision,
			sessions: [...sessions, item.sessionId].slice(-(MEMORY_UNSETTLED_SESSIONS_MAX + 1)),
		};
	}
	const ids = Object.keys(records);
	for (const id of ids.slice(0, Math.max(0, ids.length - UNSETTLED_LEDGER_MAX_RECORDS))) delete records[id];
	return { version: 1, records };
}

/** Record observations under the ledger's lock; nothing is written when none of them changes it. */
export async function recordUnsettled(stateDir: string, observed: MemoryGateOutcome["observed"]): Promise<void> {
	if (observed.length === 0) return;
	const path = unsettledLedgerPath(stateDir);
	await withStateFileLock(
		path,
		() => {
			const prior = readUnsettledLedger(stateDir);
			const next = foldUnsettled(prior, observed);
			if (JSON.stringify(next) === JSON.stringify(prior)) return;
			safeResourceWrite(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		},
		{ timeoutMs: UNSETTLED_LEDGER_LOCK_TIMEOUT_MS, note: "memory delivery ledger" },
	);
}
