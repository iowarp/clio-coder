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
	type WorkerAttempt,
	type WorkerEntryState,
	type WorkerReceiptFacts,
	type WorkerReceiptSummary,
	workerTargetLabel,
} from "./worker-stream.js";

/** The `workerRun` entry a live block is worth, minus the fields the ledger stamps. */
export type WorkerRunEntryInput = Extract<SessionEntryInput, { kind: "workerRun" }>;

/** The same entry minus its parent pointer, which only the session owner can resolve. */
export type WorkerRunEntryFields = Omit<WorkerRunEntryInput, "parentTurnId">;

/**
 * One attempt's durable identity, snapshotted off the live block.
 *
 * A snapshot rather than the block itself: the reducer mutates one state object
 * per assignment, so a failover rewrites `runId` and `runtime` in place, and
 * anything that held the object would record the second attempt twice. Called
 * on every DispatchStarted for a transcript-bound run, so a failover writes a
 * second entry under the same assignment rather than amending the first. The
 * attempt trail is history, and history is append-only.
 */
export function workerRunEntryFields(state: WorkerEntryState): WorkerRunEntryFields {
	return {
		kind: "workerRun",
		assignmentId: state.assignmentId,
		runId: state.runId,
		origin: state.origin,
		agentId: state.agentId,
		runtime: {
			kind: state.runtime.kind,
			...(state.runtime.targetId !== undefined ? { targetId: state.runtime.targetId } : {}),
			...(state.runtime.wireModelId !== undefined ? { wireModelId: state.runtime.wireModelId } : {}),
			...(state.runtime.peerId !== undefined ? { peerId: state.runtime.peerId } : {}),
		},
		...(state.parentToolCallId !== undefined ? { parentToolCallId: state.parentToolCallId } : {}),
	};
}

/**
 * Receipt facts as the footer reports them. A run whose receipt is gone (an
 * expired state dir, a session copied without its receipts) settles as
 * `receipt unavailable` rather than as a block that still looks live: the run
 * is over, and the transcript should say so even when it cannot say how.
 */
function replayReceipt(facts: WorkerReceiptFacts | null): WorkerReceiptSummary {
	if (facts === null) return { outcome: "unknown", tokens: 0, elapsedMs: 0, receiptUnavailable: true };
	return {
		outcome: facts.outcome,
		...(facts.outcomeCode !== undefined ? { outcomeCode: facts.outcomeCode } : {}),
		tokens: facts.tokenCount ?? 0,
		elapsedMs: facts.durationMs ?? 0,
		...(facts.contract !== undefined ? { contract: facts.contract } : {}),
		...(facts.toolCalls !== undefined ? { toolCalls: facts.toolCalls } : {}),
		...(facts.exitCode !== undefined ? { exitCode: facts.exitCode } : {}),
		...(facts.failureMessage !== undefined ? { failureMessage: facts.failureMessage } : {}),
	};
}

/** Reads `receipts/<runId>.json` and projects it, or returns null when it is unreadable. */
export type WorkerReceiptReader = (runId: string) => WorkerReceiptFacts | null;

/**
 * Rebuild one block per assignment from the entries that recorded it.
 *
 * Attempts fold the way they did live: the entries of one assignment become one
 * block whose header names the last attempt and whose rail carries an `↻` line
 * for each earlier one, so a resumed failover reads as the single run it was.
 * The body and footer come from the last attempt's receipt, which is the
 * attempt that actually produced an answer.
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
		const runtime = { ...last.runtime };
		const facts = readReceipt(last.runId);
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
			runtime,
			text: facts?.text ?? "",
			droppedLines: 0,
			tools: [],
			attempts: trail,
			pending: false,
			receipt: replayReceipt(facts),
			...(last.parentToolCallId !== undefined ? { parentToolCallId: last.parentToolCallId } : {}),
			startedAtMs: Date.parse(last.timestamp) || 0,
		});
	}
	return states;
}
