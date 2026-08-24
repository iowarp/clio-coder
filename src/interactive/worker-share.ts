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

import type { CouncilReport } from "../domains/agents/result-contract.js";
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

/** The prefix every shared note starts with; docs, tests, and the honesty rail pin it. */
export const WORKER_SHARE_NOTE_PREFIX = "[worker result]";

/** The origin the header names, so a model with a compacted context still sees who put the note there. */
export const WORKER_SHARE_ORIGIN = "shared by the operator";

/**
 * The operator note a shared run becomes:
 *
 *   [worker result] coder · run 2mkas6s · ok · shared by the operator
 *   <bounded output text>
 *
 * The header names the worker so the main agent can tell a shared answer from
 * the operator's own words, and names the operator as the origin so a model
 * that never dispatched the run does not read the note as an unattributed tool
 * result (#73). Returns null when there is nothing to share: a run that
 * produced no text is not worth a turn.
 */
export function formatWorkerShareNote(facts: WorkerShareFacts): string | null {
	return shareNote(facts, facts.text);
}

/** The header every shared note carries, plus one bounded body under it. */
function shareNote(facts: WorkerShareFacts, body: string): string | null {
	const text = body.trim();
	if (text.length === 0) return null;
	const header = `${WORKER_SHARE_NOTE_PREFIX} ${facts.agentId} · run ${facts.runId} · ${outcomeWord(facts.outcome)} · ${WORKER_SHARE_ORIGIN}`;
	return `${header}\n${truncateUtf8(text, WORKER_SHARE_MAX_BYTES, SHARE_TRUNCATION_MARKER)}`;
}

/** One member's answer under its roster label, or its failure when it produced none. */
function councilMemberLine(member: CouncilReport["members"][number]): string {
	if (member.failed !== undefined) return `[${member.label}] failed: ${member.failed.reason}`;
	const verdict = member.verdict === undefined ? "" : ` (verdict ${member.verdict})`;
	return `[${member.label}]${verdict} ${member.answer.trim()}`;
}

/** The synthesis line: what the council concluded, and how it concluded it. */
function councilSynthesisLines(synthesis: CouncilReport["synthesis"]): string[] {
	if (synthesis.kind === "none") return ["[synthesis none] the members answered separately; no synthesis was run."];
	const facts = [
		...(synthesis.verdict !== undefined ? [`verdict ${synthesis.verdict}`] : []),
		...(synthesis.tally !== undefined
			? [
					`tally ${Object.entries(synthesis.tally)
						.map(([key, count]) => `${key}=${count}`)
						.join(" ")}`,
				]
			: []),
		...(synthesis.judgeRunId !== undefined ? [`judge run ${synthesis.judgeRunId}`] : []),
	];
	const head = `[synthesis ${synthesis.kind}]${facts.length > 0 ? ` ${facts.join(" · ")}` : ""}`;
	const text = synthesis.text?.trim() ?? "";
	return text.length > 0 ? [head, text] : [head];
}

/**
 * A whole council as one operator note: every member's labelled answer, in the
 * order the report seals them, then the synthesis. Sharing a synthesis run id
 * means sharing what the council decided, and the members' answers are what it
 * decided from, so they travel together in one bounded block rather than as
 * several notes the main agent would have to reassemble.
 */
export function formatCouncilShareNote(facts: WorkerShareFacts, report: CouncilReport): string | null {
	const finalRound = report.members.reduce((highest, member) => Math.max(highest, member.round), 1);
	const body = [
		...report.members.filter((member) => member.round === finalRound).map(councilMemberLine),
		...councilSynthesisLines(report.synthesis),
	].join("\n\n");
	return shareNote(facts, body);
}

/** One council member's answer, labelled with the roster label the operator watched it under. */
export function formatCouncilMemberShareNote(facts: WorkerShareFacts, label: string): string | null {
	const text = facts.text.trim();
	if (text.length === 0) return null;
	return shareNote(facts, `[${label}] ${text}`);
}

/**
 * Whether operator text is a shared worker note. The header is the first line,
 * so the chat loop can tell the honesty rail a worker result entered the turn
 * by the operator's hand rather than by a dispatch call.
 */
export function isWorkerShareNote(text: string): boolean {
	return text.trimStart().startsWith(`${WORKER_SHARE_NOTE_PREFIX} `);
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
