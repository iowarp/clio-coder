/**
 * The light per-run telemetry reader: one run's journal as the read model's `JournalSource`, for a caller that folds
 * run rows without the telemetry domain module. It reads what `loadRunTelemetrySource`
 * (src/domains/session/telemetry-source.ts) reads for a run, through the same state boundary and the same unknown
 * coverage on an unreadable journal, but its static closure holds only the journal reader, the paths and the read
 * model, never `./index.ts` and the extension graph behind it, so `fleet status` over ledger rows stays a leaf path.
 */

import { assertSafeId } from "../../core/safe-id.js";
import { withinStateRoot } from "../../core/state-boundary.js";
import { readCallJournalSync } from "./call-journal.js";
import { telemetryJournalPath, telemetryRunDirectory } from "./paths.js";
import { type JournalSource, journalSourceFromRead } from "./read-model.js";

/** A journal directory that is a symlink or leaves the state root reads as an absent journal (#434). */
export function readRunJournalSource(stateDir: string, runId: string): JournalSource {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	try {
		const read = withinStateRoot(stateDir, directory)
			? readCallJournalSync(directory)
			: { records: [], skipped: 0, damaged: 0 };
		return journalSourceFromRead(read, withinStateRoot(stateDir, telemetryJournalPath(directory)), runId);
	} catch {
		// An unreadable run journal stays visible as unknown coverage (#434).
		return { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
	}
}
