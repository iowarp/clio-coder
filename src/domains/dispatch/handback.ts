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
 */
export function wallHandbackOutcomeDetail(input: {
	reported: boolean;
	unfinishedTools: ReadonlyArray<{ tool: string; count: number }>;
	signal: string | null;
}): string {
	const share = `worker_run_timeout: the wall clock moved the run to its handback round at ${Math.round(WALL_HANDBACK_SHARE * 100)}%`;
	if (input.reported) return `${share} and it handed back its report`;
	const calls = input.unfinishedTools.reduce((sum, entry) => sum + entry.count, 0);
	const running =
		calls === 0
			? ""
			: ` with ${calls} tool ${calls === 1 ? "call" : "calls"} (${input.unfinishedTools.map((entry) => entry.tool).join(", ")}) still running`;
	const stopped = input.signal === null ? "the host stopped it" : `the host stopped it with ${input.signal}`;
	return `${share}, but it reached the wall clock${running} before it wrote a report; ${stopped}, so it handed back no report`;
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
