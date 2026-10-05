import type { AcpJob } from "../../contracts/wire.js";

/**
 * A job that only moved a counter or a clock is held at most this long before it is shown. A command polled
 * every second would otherwise push a session event per run, and the strip reads no better for it.
 */
export const JOB_QUIET_MS = 1000;

/**
 * Whether a change is one an operator acts on or must see at once: the job's state or end reason, a cancel
 * request, an analysis delivery moving, the scheduled turn opening or closing, a failed save, the job becoming
 * complete, or its last outcome changing. Everything else (starts, next due time, running, cost) can wait.
 */
export function jobChangeIsStructural(held: AcpJob | undefined, next: AcpJob): boolean {
	return (
		held === undefined ||
		held.state !== next.state ||
		held.reason !== next.reason ||
		held.turn !== next.turn ||
		held.cancelRequested !== next.cancelRequested ||
		held.complete !== next.complete ||
		held.saved !== next.saved ||
		held.delivery?.kind !== next.delivery?.kind ||
		held.delivery?.state !== next.delivery?.state ||
		held.last?.outcome !== next.last?.outcome
	);
}

/**
 * What the transcript calls a scheduled turn: which job and a prefix of the task the engine put on the wire. The
 * run count is not part of it. The turn opens while the occurrence is still being prepared, before the engine has
 * counted it, so a count here would be one behind; the job strip carries the canonical counts.
 */
export function scheduledTurnPrompt(job: AcpJob): string {
	if (job.delivery?.kind === "main_turn" && job.delivery.state === "running")
		return `Scheduled loop ${job.jobId}: follow-up analysis`;
	return `Scheduled loop ${job.jobId}: ${job.taskPreview}`;
}
