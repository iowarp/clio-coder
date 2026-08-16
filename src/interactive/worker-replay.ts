/**
 * The durable half of a worker block.
 *
 * A `/run`, a `/delegate`, or a model-driven dispatch draws its block from live
 * bus events, which a resumed session no longer has. What it does still have is
 * two things it wrote at the time: a `workerRun` session entry naming the run,
 * and the sealed receipt under `receipts/<runId>.json` holding the answer. This
 * module is the bridge in both directions. It projects a live entry state onto
 * the session entry going out, and rebuilds the same {@link WorkerEntryState}
 * from entries plus receipts coming back, so replay hands the renderer the
 * exact object the reducer would have.
 *
 * Streamed prose never crosses either way. The receipt is the terminal truth
 * for a worker's answer, so persisting the live tail would only add a second,
 * staler copy of it to the session file.
 *
 * Pure: the receipt reader is a parameter, so nothing here touches disk.
 */

import type { SessionEntryInput, WorkerRunEntry } from "../domains/session/index.js";
import {
	boundSettledText,
	type WorkerAttempt,
	type WorkerEntryState,
	type WorkerReceiptReader,
	workerReceiptSummary,
	workerTargetLabel,
} from "./worker-stream.js";

/** The `workerRun` entry a live block is worth, minus the fields the ledger stamps. */
export type WorkerRunEntryInput = Extract<SessionEntryInput, { kind: "workerRun" }>;

/** The same entry minus its parent pointer, which only the session owner can resolve. */
export type WorkerRunEntryFields = Omit<WorkerRunEntryInput, "parentTurnId">;

/**
 * One attempt's durable identity, read off the live block at the moment it
 * starts. Called on every DispatchStarted for a transcript-bound run, so a
 * failover writes a second entry under the same assignment rather than
 * amending the first: the attempt trail is history, and history is
 * append-only. The scalars are copied here; the runtime object is shared, and
 * safely so, because the reducer replaces it on failover rather than mutating
 * it.
 */
export function workerRunEntryFields(state: WorkerEntryState): WorkerRunEntryFields {
	const { assignmentId, runId, origin, agentId, runtime, parentToolCallId } = state;
	return {
		kind: "workerRun",
		assignmentId,
		runId,
		origin,
		agentId,
		runtime,
		...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
	};
}

/**
 * Rebuild one block per assignment from the entries that recorded it.
 *
 * Attempts fold the way they did live: the entries of one assignment become one
 * block whose header names the last attempt and whose rail carries an `↻` line
 * for each earlier one, so a resumed failover reads as the single run it was.
 * The body and footer come from the last attempt's receipt, which is the
 * attempt that actually produced an answer, through the same projection the
 * live fold uses to settle a block.
 *
 * The returned map is keyed by assignment. Tool names are not reconstructed:
 * they were live telemetry, the receipt seals a call count rather than a list,
 * and inventing names from anything else would put a worker's arguments one
 * inference away from the transcript.
 */
export function workerEntriesFromRunEntries(
	entries: ReadonlyArray<WorkerRunEntry>,
	readReceipt: WorkerReceiptReader,
): Map<string, WorkerEntryState> {
	const byAssignment = new Map<string, WorkerRunEntry[]>();
	for (const entry of entries) {
		const attempts = byAssignment.get(entry.assignmentId);
		if (attempts === undefined) byAssignment.set(entry.assignmentId, [entry]);
		else attempts.push(entry);
	}

	const states = new Map<string, WorkerEntryState>();
	for (const [assignmentId, attempts] of byAssignment) {
		const last = attempts[attempts.length - 1];
		if (last === undefined) continue;
		const facts = readReceipt(last.runId);
		const bounded = boundSettledText(facts?.text ?? "");
		const trail: WorkerAttempt[] = attempts.map((attempt) => ({
			runId: attempt.runId,
			targetLabel: workerTargetLabel(attempt.runtime),
			...(attempt.runId === last.runId && facts !== null ? { outcome: facts.outcome } : {}),
		}));
		states.set(assignmentId, {
			assignmentId,
			runId: last.runId,
			origin: last.origin,
			agentId: last.agentId,
			runtime: last.runtime,
			text: bounded.text,
			droppedLines: bounded.dropped,
			tools: [],
			attempts: trail,
			pending: false,
			receipt: workerReceiptSummary(facts),
			...(last.parentToolCallId !== undefined ? { parentToolCallId: last.parentToolCallId } : {}),
		});
	}
	return states;
}
