import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { CallJournalRead } from "../observability/call-journal.js";
import { readCallJournalSync } from "../observability/call-journal.js";
import { readOutOfTurnUsageRows } from "../observability/out-of-turn-usage.js";
import type { JournalSource, SessionSource } from "../observability/read-model.js";
import type { SessionEntry, SessionHeader } from "./entries.js";
import { isSessionEntry, isSessionHeader } from "./entries.js";
import { importLegacySession } from "./legacy-import.js";

/**
 * Cold-path loader for the telemetry read model (#434 §11): a session's own journal, the ledger rows the journal
 * never held (folded through the legacy importer with stable ids), the run journals it referenced, and its fork
 * ancestors. Session spend is whole-session: every branch the account paid for counts. A fork child's journal holds
 * only its own calls, so the ledger prefix it copied from its parent is left to the parent's own fold.
 */

const MAX_LINEAGE = 32;

function journalSource(directory: string, read: CallJournalRead, file: string): JournalSource {
	return {
		present: existsSync(join(directory, file)) || read.records.length > 0,
		records: read.records.map(({ record }) => record),
		modes: read.modes ?? [],
		skipped: read.skipped,
		damaged: read.damaged,
	};
}

/** Session ids are path components under a workspace bucket; the first bucket holding the id wins. */
function findSessionDirectory(stateDir: string, sessionId: string): string | null {
	assertSafeId(sessionId, "session");
	const root = join(stateDir, "sessions");
	let buckets: string[];
	try {
		buckets = readdirSync(root).sort();
	} catch {
		// No sessions root: nothing to find.
		return null;
	}
	for (const bucket of buckets) {
		const directory = join(root, bucket, sessionId);
		if (existsSync(join(directory, "current.jsonl")) || existsSync(join(directory, "calls.jsonl"))) return directory;
	}
	return null;
}

function readLedger(directory: string): { header: SessionHeader | null; entries: SessionEntry[] } {
	let text: string;
	try {
		text = readFileSync(join(directory, "current.jsonl"), "utf8");
	} catch {
		// A journal-only session has no ledger rows to import.
		return { header: null, entries: [] };
	}
	let header: SessionHeader | null = null;
	const entries: SessionEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionHeader(value)) header ??= value;
			else if (isSessionEntry(value)) entries.push(value);
		} catch {
			// A torn or foreign line carries no call; the fold counts what it can read.
		}
	}
	return { header, entries };
}

export function loadRunTelemetrySource(stateDir: string, runId: string): JournalSource {
	assertSafeId(runId, "run");
	const directory = join(stateDir, "runs", runId);
	try {
		const read = readCallJournalSync(directory, "events.ndjson");
		const source = journalSource(directory, read, "events.ndjson");
		return { ...source, records: source.records.filter((record) => record.ctx.runId === runId) };
	} catch {
		// An unreadable run journal stays visible as unknown coverage (#434).
		return { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
	}
}

/** The ledger's copied fork prefix: the fork point's ancestry, plus a native checkpoint taken at the fork point. */
function copiedFromParent(entries: readonly SessionEntry[], forkPoint: string, forkedAt: string | null): Set<string> {
	const parentOf = new Map(entries.map((entry) => [entry.turnId, entry.parentTurnId]));
	const copied = new Set<string>();
	for (let id: string | null | undefined = forkPoint; id && !copied.has(id); id = parentOf.get(id)) copied.add(id);
	for (const entry of entries)
		if (
			entry.kind === "compactionSummary" &&
			entry.parentTurnId === forkPoint &&
			(forkedAt === null || entry.timestamp <= forkedAt)
		)
			copied.add(entry.turnId);
	return copied;
}

function legacyRecords(
	stateDir: string,
	sessionId: string,
	entries: readonly SessionEntry[],
	journal: readonly TelemetryRecord[],
	copied: ReadonlySet<string>,
): SessionSource["legacy"] {
	const journaled = new Set<string>();
	let firstJournalAt: string | null = null;
	for (const record of journal) {
		if (record.k === "call.started" || record.k === "call.settled") journaled.add(record.data.callId);
		if (firstJournalAt === null || record.t < firstJournalAt) firstJournalAt = record.t;
	}
	// Only rows the journal never held: an assistant message or checkpoint whose call ids resolve is journal-owned.
	const unjournaled = entries.filter((entry) => {
		if (copied.has(entry.turnId) && (entry.kind === "compactionSummary" || entry.kind === "message")) return false;
		if (entry.kind === "compactionSummary")
			return !(entry.callIds?.length && entry.callIds.every((id) => journaled.has(id)));
		if (entry.kind !== "message" || entry.role !== "assistant") return true;
		const callId = (entry.payload as { callId?: unknown } | null)?.callId;
		return !(typeof callId === "string" && journaled.has(callId));
	});
	// The out-of-turn store keeps being written beside the journal; only rows from before it opened are legacy.
	const outOfTurn = readOutOfTurnUsageRows(stateDir).rows.filter(
		(row) => row.sessionId === sessionId && (firstJournalAt === null || row.timestamp < firstJournalAt),
	);
	const imported = importLegacySession(sessionId, unjournaled, { outOfTurn, ids: "derived" });
	return { records: imported.records, aggregates: imported.aggregates + imported.invalid };
}

/**
 * Null when no session directory holds the id. A missing or unreadable ancestor leaves `parent.source` null, which
 * the lineage fold reports as unknown coverage.
 */
export function loadSessionTelemetrySource(
	stateDir: string,
	sessionId: string,
	directory = findSessionDirectory(stateDir, sessionId),
	seen: Set<string> = new Set(),
): SessionSource | null {
	if (directory === null) return null;
	seen.add(sessionId);
	const read = readCallJournalSync(directory);
	const journal = journalSource(directory, read, "calls.jsonl");
	const { header, entries } = readLedger(directory);
	const forked = journal.records.find((record) => record.k === "session.forked_from");
	const lineage =
		forked?.k === "session.forked_from"
			? {
					sessionId: forked.data.parentSessionId,
					turnId: forked.data.parentTurnId,
					at: forked.data.parentTurnAt,
					directory: join(stateDir, "sessions", forked.data.parentCwdHash, forked.data.parentSessionId),
				}
			: header?.parentSession && header.parentTurnId
				? { sessionId: header.parentSession, turnId: header.parentTurnId, at: header.timestamp, directory: undefined }
				: null;
	const copied = lineage ? copiedFromParent(entries, lineage.turnId, header?.timestamp ?? null) : new Set<string>();
	const runs = new Map<string, JournalSource>();
	for (const record of journal.records)
		if ((record.k === "call.ref" || record.k === "run.ref") && !runs.has(record.data.runId))
			runs.set(record.data.runId, loadRunTelemetrySource(stateDir, record.data.runId));
	let parent: SessionSource | null = null;
	if (lineage && !seen.has(lineage.sessionId) && seen.size < MAX_LINEAGE) {
		try {
			assertSafeId(lineage.sessionId, "parent session");
			parent = loadSessionTelemetrySource(
				stateDir,
				lineage.sessionId,
				lineage.directory ?? findSessionDirectory(stateDir, lineage.sessionId),
				seen,
			);
		} catch {
			// A missing or unsupported ancestor cannot prevent reading the child's own facts (#434).
			parent = null;
		}
	}
	return {
		sessionId,
		journal,
		legacy: legacyRecords(stateDir, sessionId, entries, journal.records, copied),
		runs,
		parent: lineage ? { sessionId: lineage.sessionId, turnId: lineage.turnId, at: lineage.at, source: parent } : null,
	};
}
