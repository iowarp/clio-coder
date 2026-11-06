/**
 * The transcript's account of a long silent model wait (F8).
 *
 * The rail escalates a silent wait in place and the hint row explains it from the third watchdog tier, but both are
 * gone the moment the wait ends, so the transcript held no trace that a call sat silent for minutes. Once a wait has
 * gone a minute without evidence, one row joins the transcript: what the last evidence was, when, and how long ago,
 * with the ways out while it lasts. When the wait ends the row keeps what happened and drops the keys, which no longer
 * reach anything.
 */

import type { AgentStatus } from "../session-control/status-types.js";
import { renderNoticeRow } from "./renderers/notice.js";
import { formatWaitClock } from "./theme/index.js";

/** The first escalation the transcript records; the rail's own `no bytes yet` and `Esc stops` come before it. */
export const SILENCE_ROW_AFTER_MS = 60_000;

function clockTime(at: number): string {
	return new Date(at).toTimeString().slice(0, 8);
}

/**
 * The silent wait the status describes now, or null when no model call is waiting on its first output. A stall inside
 * a streaming reply stays with the rail and the hint row: a row appended there would split the reply it interrupts.
 */
interface SilentWait {
	key: string;
	/** Epoch ms of the last evidence the call gave. */
	evidenceAt: number;
	/** `request sent 15:16:40`, the evidence named in operator words. */
	evidence: string;
	/** `No bytes` or `No output`: what has not arrived. */
	missing: string;
	model: string;
}

function silentWait(status: AgentStatus, model: string): SilentWait | null {
	const phase = status.phase === "stuck" ? status.resumePhase : status.phase;
	const waiting = phase === "waiting_model" || (phase === "retrying" && status.retry?.stage === "attempt");
	const run = status.runId ?? "run";
	if (waiting) {
		const request = status.modelRequest;
		// The same clock the rail and the hint row count from, so the three never disagree about when the wait began.
		const waitingFrom = status.retry?.attemptStartedAt ?? status.waitingSince ?? status.since;
		const sentAt =
			request?.admissionBeganAt !== undefined && request.admissionBeganAt >= waitingFrom ? request.sentAt : waitingFrom;
		if (request?.firstByteAt) {
			return {
				key: `${run}:${sentAt}:open`,
				evidenceAt: request.firstByteAt,
				evidence: `response opened ${clockTime(request.firstByteAt)}`,
				missing: "No output",
				model,
			};
		}
		return {
			key: `${run}:${sentAt}`,
			evidenceAt: sentAt,
			evidence: `request sent ${clockTime(sentAt)}`,
			missing: request?.bytesObservable ? "No bytes" : "No output",
			model,
		};
	}
	return null;
}

interface OpenRow {
	wait: SilentWait;
	/** Epoch ms the wait ended, and the words for how; null while it lasts. */
	endedAt: number | null;
	ending: string | null;
}

/** How the wait ended, read from the status that replaced it. */
function endingWords(next: AgentStatus, nextModel: string, model: string): string {
	const phase = next.phase === "stuck" ? next.resumePhase : next.phase;
	if (phase === "waiting_model" && nextModel !== model) return `then the request moved to ${nextModel}`;
	if (phase === "writing" || phase === "thinking" || next.modelRequest?.firstByteAt) return "then output arrived";
	if (phase === "cancelling" || next.cancelRequestedAt !== undefined) return "then you stopped it";
	if (phase === "retrying") return "then Clio retried";
	if (phase === "tool_running" || phase === "tool_blocked") return "then a tool call arrived";
	return "then the wait ended";
}

export interface SilenceTranscriptRow {
	/** Called once a second with the current status; appends or settles the row as the wait requires. */
	observe(status: AgentStatus, now: number): void;
}

export function createSilenceTranscriptRow(deps: {
	append(render: (width: number) => string[], isLive: () => boolean): void;
	/** The nickname the rail gives the model the request went to. */
	modelName(status: AgentStatus): string;
	now?: () => number;
}): SilenceTranscriptRow {
	const clock = deps.now ?? Date.now;
	let open: OpenRow | null = null;
	const recorded = new Set<string>();
	return {
		observe(status, now) {
			const wait = silentWait(status, deps.modelName(status));
			if (open !== null && open.endedAt === null && wait?.key !== open.wait.key) {
				open.endedAt = now;
				open.ending = endingWords(status, deps.modelName(status), open.wait.model);
				open = null;
			}
			if (wait === null || recorded.has(wait.key) || now - wait.evidenceAt < SILENCE_ROW_AFTER_MS) return;
			recorded.add(wait.key);
			const row: OpenRow = { wait, endedAt: null, ending: null };
			open = row;
			deps.append(
				(width) => {
					const { wait: w } = row;
					if (row.endedAt === null) {
						const silent = formatWaitClock(Math.max(0, clock() - w.evidenceAt));
						return renderNoticeRow(
							`${w.missing} from ${w.model} for ${silent} · last event: ${w.evidence} · Esc stops · /model to reroute`,
							"warning",
							width,
						);
					}
					const silent = formatWaitClock(Math.max(0, row.endedAt - w.evidenceAt));
					return renderNoticeRow(
						`${w.missing} from ${w.model} for ${silent} after the ${w.evidence}, ${row.ending} at ${clockTime(row.endedAt)}`,
						"info",
						width,
					);
				},
				() => row.endedAt === null,
			);
		},
	};
}
