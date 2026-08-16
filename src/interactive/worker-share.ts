/**
 * Sharing a worker's answer with the main agent.
 *
 * A `/run` or `/delegate` result reaches the operator's screen and stops there:
 * the main agent is not told about it, which is what makes a side run a side
 * run. `--share` and `/share` are the two ways an operator crosses that line on
 * purpose, and this module owns what crosses. It picks the run and shapes the
 * note; the caller owns the path the note takes into the session, which is the
 * ordinary user-turn path so replay and compaction treat it as operator text.
 *
 * Pure: no I/O, no bus, no session.
 */

import { WORKER_OUTPUT_MAX_BYTES } from "../domains/dispatch/event-pump.js";
import { truncateUtf8 } from "../tools/truncate-utf8.js";
import { type WorkerEntryState, workerAskedByModel } from "./worker-stream.js";

/** Terminal facts of one finished run, from a receipt or from a settled block. */
export interface WorkerShareFacts {
	agentId: string;
	runId: string;
	outcome: string;
	text: string;
}

/**
 * Bound on shared worker prose. It is the receipt's own output bound, so a
 * note carries exactly what the receipt sealed and the model is never handed
 * more of a worker's answer than the worker's answer.
 */
export const WORKER_SHARE_MAX_BYTES = WORKER_OUTPUT_MAX_BYTES;

const SHARE_TRUNCATION_MARKER = "\n[worker output truncated]";

/** The word the note reports; `succeeded` reads as `ok` everywhere else in the UI. */
function outcomeWord(outcome: string): string {
	return outcome === "succeeded" ? "ok" : outcome;
}

/**
 * The operator note a shared run becomes:
 *
 *   [worker result] coder · run 2mkas6s · ok
 *   <bounded output text>
 *
 * The header names the worker so the main agent can tell a shared answer from
 * the operator's own words, and returns null when there is nothing to share:
 * a run that produced no text is not worth a turn.
 */
export function formatWorkerShareNote(facts: WorkerShareFacts): string | null {
	const text = facts.text.trim();
	if (text.length === 0) return null;
	const header = `[worker result] ${facts.agentId} · run ${facts.runId} · ${outcomeWord(facts.outcome)}`;
	return `${header}\n${truncateUtf8(text, WORKER_SHARE_MAX_BYTES, SHARE_TRUNCATION_MARKER)}`;
}

/** Terminal facts of a settled worker block, or null while it is still running. */
export function workerShareFactsFromEntry(entry: WorkerEntryState): WorkerShareFacts | null {
	if (entry.pending || entry.receipt === undefined) return null;
	return { agentId: entry.agentId, runId: entry.runId, outcome: entry.receipt.outcome, text: entry.text };
}

/**
 * Which run `/share` means. A named id matches either the logical assignment or
 * any attempt of it, so an operator can name the run id a failover left behind
 * and still get the block they watched. Without an id it is the most recent
 * settled run the operator started themselves: a run the model asked for
 * already reached the model through its tool result, so defaulting to one would
 * share something the model has, and hide the run the operator was looking at.
 */
export function selectWorkerRunToShare(entries: ReadonlyArray<WorkerEntryState>, id?: string): WorkerEntryState | null {
	const wanted = id?.trim();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined || entry.pending || entry.receipt === undefined) continue;
		if (wanted === undefined || wanted.length === 0) {
			if (!workerAskedByModel(entry)) return entry;
			continue;
		}
		if (entry.assignmentId === wanted || entry.attempts.some((attempt) => attempt.runId === wanted)) return entry;
	}
	return null;
}
