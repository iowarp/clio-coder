/**
 * Rebuild the running usage totals from a session's journal, scoped by its ledger.
 *
 * The `/usage` overlay and the footer both render one process-lifetime
 * accumulator, and only `startNewSession` ever reset it. Resuming did not, so a
 * resumed session showed the *previous* session's numbers under the resumed
 * session's id: one process, two sessions, byte-identical totals relabelled.
 * That is misattribution rather than an undercount, and a process that resumed
 * and sent nothing reported zero for a session holding tens of thousands of
 * tokens on disk.
 *
 * The fold itself is `ledgerUsageCalls` in the session domain: the journal's
 * calls that the ledger's active path links. This module is only the sink
 * wiring between that fold and the telemetry projection.
 */

import { writeDiagnostic } from "../../core/diagnostics.js";
import type { SessionEntry } from "./entries.js";
import type { SessionCallJournalRead } from "./fork-journal.js";
import { readSessionCallJournalSync } from "./fork-journal.js";
import { usageCallsFromRunJournals } from "./run-journal-usage.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";
import type { SessionUsageDefaults } from "./usage.js";
import { ledgerCallFailureCounts, ledgerUsageCalls } from "./usage.js";
import type { SessionUsageSink } from "./usage-record.js";
import { recordUsageCall } from "./usage-record.js";

export type { SessionUsageSink } from "./usage-record.js";

/**
 * Clear the running totals and replay the supplied session's journaled calls
 * into them. A session with no journal resets to nothing measured.
 *
 * `activeLeafTurnId` scopes the fold to one branch, through the same
 * `filterEntriesToActivePath` the transcript replays through. current.jsonl is
 * append-only, so after a `/tree` switch the abandoned sibling turns are still
 * in the file: the transcript stopped showing them and `/usage` and the footer Σ
 * kept counting them, which put a session total on screen for turns the reader
 * had just been told were not on this branch. Omitted, the fold follows the
 * newest message's ancestry, the same fallback an offline read of the transcript
 * takes; a ledger with no branch in it folds whole either way.
 */
export function reseedSessionUsageFromLedger(
	sink: SessionUsageSink,
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
	activeLeafTurnId?: string | null,
): void {
	const scoped = filterEntriesToActivePath(entries, activeLeafTurnId ?? undefined);
	let journal: SessionCallJournalRead | undefined;
	if (defaults.journalStateDir && defaults.sessionId) {
		try {
			journal = readSessionCallJournalSync(defaults.journalStateDir, defaults.sessionId, scoped);
			if (journal.skipped || journal.damaged)
				writeDiagnostic("[clio-coder:telemetry] session usage journal has skipped or damaged records\n");
		} catch {
			// Reset even when the journal cannot be read: the session then reads as not measured (#434).
			writeDiagnostic("[clio-coder:telemetry] session usage journal unavailable; usage not measured\n");
		}
	}
	sink.resetSession(defaults.sessionId);
	const records = journal?.records.map(({ record }) => record);
	sink.recordNeverSentCalls?.(ledgerCallFailureCounts(scoped, records).neverInvokedCalls);
	for (const call of ledgerUsageCalls(scoped, records)) recordUsageCall(sink, call, true);
	if (journal) for (const call of usageCallsFromRunJournals(journal.runs)) recordUsageCall(sink, call, true);
}
