/**
 * The handback to the parent (DESIGN 4.5 and 4.6, slice M3). Pure: no I/O, no clock.
 *
 * Context: every role with a result enters its handback round at a share of the usable window (the window less the
 * output reserve), decided by the role alone. A builder is first told once, at the note share, to write now or report.
 *
 * Answer: the parent's view of a run's answer is fixed at dispatch. A batch shares ANSWER_BUDGET_BYTES equally with an
 * ANSWER_BUDGET_FLOOR_BYTES floor; a lone run gets all of it. The worker is told the number, and the sync result,
 * collect and the run record all show that same number of bytes.
 */

import type { RunRole } from "./obligation.js";

/** Share of the usable window at which each role's next round is its handback round. */
export const HANDBACK_CONTEXT_SHARE: Readonly<Record<RunRole, number>> = {
	explorer: 0.7,
	checker: 0.7,
	reviewer: 0.7,
	judge: 0.7,
	seat: 0.7,
	builder: 0.85,
};

/** Share of the usable window past which a run that changed nothing is told once to write now or report. */
export const HANDBACK_NOTE_SHARE = 0.7;

/** Share of a run's wall clock at which its next round is the handback round (DESIGN 4.5, fleet M8). */
export const WALL_HANDBACK_SHARE = 0.85;

/**
 * What a run the wall clock moved to its handback round did next, as the host observed it (fleet M8). The worker's own
 * line is written at the handback, before any report exists, so the sealed detail says whether a report came: a tool
 * call still running at the handback can carry the run past its wall clock, where the host stops it with no answer.
 * Only the host's own deadline abort (`hostStopped`) is a stop; a worker that crashed, was killed by something else or
 * exited without a report is described by its exit.
 */
export function wallHandbackOutcomeDetail(input: {
	reported: boolean;
	unfinishedTools: ReadonlyArray<{ tool: string; count: number }>;
	/** The calls the host saw in flight when its abort started, before the abort finished them; null without a snapshot. */
	runningAtStop: ReadonlyArray<{ tool: string; object?: string }> | null;
	hostStopped: boolean;
	/** The signals the host itself delivered to the worker, in order (SIGTERM, then SIGKILL after the grace). */
	hostSignals: ReadonlyArray<string>;
	exitCode: number | null;
	signal: string | null;
}): string {
	const share = `worker_run_timeout: the wall clock moved the run to its handback round at ${Math.round(WALL_HANDBACK_SHARE * 100)}%`;
	if (input.reported) return `${share} and it handed back its report`;
	if (!input.hostStopped) {
		const exit = [
			input.exitCode === null ? null : `exit code ${input.exitCode}`,
			input.signal === null ? null : `signal ${input.signal}`,
		].filter((part) => part !== null);
		return `${share}, but it exited${exit.length === 0 ? "" : ` (${exit.join(", ")})`} before it wrote a report, so it handed back no report`;
	}
	// A worker traps SIGTERM and exits 1, so its exit names no signal; the host's own signals and the calls it saw
	// running are the facts (M-37).
	const labels =
		input.runningAtStop !== null && input.runningAtStop.length > 0
			? input.runningAtStop.map((call) => (call.object === undefined ? call.tool : `${call.tool}: ${call.object}`))
			: input.unfinishedTools.flatMap((entry) => Array.from({ length: entry.count }, () => entry.tool));
	const running =
		labels.length === 0
			? ""
			: ` while ${labels.length} tool ${labels.length === 1 ? "call" : "calls"} (${labels.join(", ")}) ${labels.length === 1 ? "was" : "were"} still running`;
	const signals =
		input.hostSignals.length === 0
			? ""
			: input.hostSignals.length === 2 && input.hostSignals[0] === "SIGTERM" && input.hostSignals[1] === "SIGKILL"
				? " with SIGTERM, then SIGKILL when the grace period ran out"
				: ` with ${input.hostSignals.join(", then ")}`;
	return `${share}, but it reached the wall clock before it wrote a report; the host stopped it${signals}${running}, so it handed back no report`;
}

/** What a batch shares, and what a lone run gets. */
export const ANSWER_BUDGET_BYTES = 12_000;
/** No run's answer budget is smaller than this, however large its batch. */
export const ANSWER_BUDGET_FLOOR_BYTES = 2_000;

/** The answer budget of each run in a batch of `runs`: an equal share of the batch budget, never under the floor. */
export function answerBudgetForBatch(runs: number): number {
	return Math.max(ANSWER_BUDGET_FLOOR_BYTES, Math.floor(ANSWER_BUDGET_BYTES / Math.max(1, Math.floor(runs))));
}

/** A run's sealed answer budget, or a lone run's when the record predates it. */
export function sealedAnswerBudgetBytes(sealed: number | undefined | null): number {
	return typeof sealed === "number" && Number.isInteger(sealed) && sealed > 0 ? sealed : ANSWER_BUDGET_BYTES;
}

/** The line that tells the worker how much of its answer the dispatching agent sees. */
export function answerBudgetMessage(bytes: number): string {
	return `Answer budget: the dispatching agent sees the first ${bytes} bytes of your final answer; it reads anything past that only if it asks for the rest. Write your final answer to fit in ${bytes} bytes, leading with the findings that matter most.`;
}
