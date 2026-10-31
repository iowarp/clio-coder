/**
 * The System One recorder: what every call asked and got back, kept in two
 * places for two readers.
 *
 * The session ledger gets a compact row per call, at the next turn boundary,
 * always. The dataset gets the redacted state and the question specs, only when
 * research capture keeps it. Both start from the same `DecisionRecord` the
 * runner reports once per call, answered or not.
 */

import type { DecisionRecord, DecisionRecorder, OutcomeRecord } from "../types.js";
import type { DatasetWriterDeps } from "./dataset.js";
import { createDatasetWriter } from "./dataset.js";
import type { SessionRow } from "./rows.js";
import { buildSessionRow, digestOf, serializeState } from "./rows.js";

export type { RuntimeLookup } from "./bindings.js";
export { describeBindings } from "./bindings.js";
export type { DatasetDecisionRow, DatasetOutcomeRow, DatasetSample, SampleData } from "./dataset.js";
export type { DatasetSummary, ExportOptions, ExportResult, ExportSummary } from "./export.js";
export { buildExport, exportToFile, isDay, streamExport, summarizeDataset } from "./export.js";
export type { AnchoredRows, RowAnchorTree, SessionRow } from "./rows.js";
export { anchorSessionRows, SESSION_ROW_CUSTOM_TYPE } from "./rows.js";

/** A session that never reaches a drain must not grow the buffer without bound. */
const MAX_BUFFERED = 256;

export interface RecorderDeps {
	/**
	 * The session current now, or null before one exists. Only a record that carries
	 * no session of its own is filed under it: the runner stamps each call with the
	 * session it started in.
	 */
	currentSession: () => string | null;
	/** Whether research capture keeps the dataset for its destination; null means no session yet (#434). */
	recording: (session: string | null) => boolean;
	/** Hand one dataset sample to its session's journal, which stores the content and cites it (#434). */
	sample: DatasetWriterDeps["sample"];
	/**
	 * Where a row goes when its own session is no longer the one draining, so
	 * `/new` or `/resume` between a call and the next turn cannot lose it or file
	 * it under another session. May be a no-op for a session this process cannot write.
	 */
	appendSessionRow: (sessionId: string, row: SessionRow) => void;
}

export interface SystemOneRecorder extends DecisionRecorder {
	/**
	 * The compact rows for `sessionId`, oldest first, and the buffer emptied.
	 * The orchestrator's `flushSystemOne` writes them as custom entries of type
	 * `SESSION_ROW_CUSTOM_TYPE` (one per turn the rows name, see `anchorSessionRows`), at the turn boundaries the chat loop reports and on
	 * shutdown. A call is tagged with the session it started in. One that started before any
	 * session existed belongs to whoever drains, and one tagged with a different session goes to
	 * `appendSessionRow` under its own id, so a slow answer that outlives a session switch never
	 * lands in the next session's ledger. The dataset copy of a call that had no session waits
	 * for the same drain, so its row carries the id of the session whose ledger received the
	 * compact one, and every other dataset row keeps the session its call started in.
	 */
	drain(sessionId: string | null): SessionRow[];
	/** Drop the dataset samples still waiting for a session; the process scope keeps no content. */
	flush(): void;
}

export function createRecorder(deps: RecorderDeps): SystemOneRecorder {
	let pending: Array<{ session: string | null; row: SessionRow }> = [];
	const recording = deps.recording;
	const writer = createDatasetWriter({ recording, currentSession: deps.currentSession, sample: deps.sample });

	return {
		decision(record: DecisionRecord): void {
			try {
				const serialized = serializeState(record.state);
				const digest = digestOf(serialized);
				const session = record.session !== undefined ? record.session : deps.currentSession();
				pending.push({ session, row: buildSessionRow(record, serialized, digest) });
				// The newest calls are the ones a later turn can still be joined to.
				if (pending.length > MAX_BUFFERED) pending = pending.slice(pending.length - MAX_BUFFERED);
				if (recording(session)) writer.decision({ record, session, serialized, digest });
			} catch {
				// Recording never costs the decision it describes.
			}
		},

		outcome(record: OutcomeRecord): void {
			try {
				writer.outcome(record);
			} catch {
				// Recording never costs the outcome's source either.
			}
		},

		drain(sessionId: string | null): SessionRow[] {
			const taken = pending;
			pending = [];
			const mine: SessionRow[] = [];
			for (const entry of taken) {
				if (entry.session === null || entry.session === sessionId) {
					mine.push(entry.row);
					continue;
				}
				try {
					deps.appendSessionRow(entry.session, entry.row);
				} catch {
					// That session's ledger is closed to this process; the dataset copy, when recording, is already queued.
				}
			}
			// The rows taken above for lack of a session went to this one's ledger, so
			// their dataset copies, held for the same reason, are stamped with it too.
			if (sessionId !== null) writer.adopt(sessionId);
			return mine;
		},

		flush: () => writer.flush(),
	};
}
