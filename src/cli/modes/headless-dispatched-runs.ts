import { sleep } from "../../core/timers.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { isTerminalRunEnvelope, type RunEnvelope, type RunOutcome } from "../../domains/dispatch/types.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";

const SETTLE_POLL_MS = 500;

/** Terminal outcomes that mean a dispatched worker did not deliver. */
const UNDELIVERED_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
	"failed",
	"timed_out",
	"stalled",
	"canceled",
	"denied_by_policy",
	"spawn_failed",
]);

export interface DispatchedRunsSettlement {
	/** Runs still in flight when waiting stopped; shutdown drain cancels them. */
	live: ReadonlyArray<RunEnvelope>;
	/** Final attempts that ended without delivering (a retried attempt is not final). */
	undelivered: ReadonlyArray<RunEnvelope>;
}

function dispatchedBy(dispatch: Pick<DispatchContract, "listRuns">, rootRunId: string): RunEnvelope[] {
	return dispatch.listRuns().filter((run) => run.id !== rootRunId && run.lineage?.rootRunId === rootRunId);
}

/**
 * Wait for every run the headless turn dispatched to seal, then report the ones
 * that did not deliver. Detached runs are children of this process, so exiting
 * while they run drains and cancels them; before D3 a coordinator that ended
 * its turn early silently discarded its whole fan-out. Waiting stops when the
 * process starts shutting down (a signal or `--timeout`), and whatever is still
 * live is returned so the caller can name it.
 */
export async function settleDispatchedRuns(
	dispatch: Pick<DispatchContract, "listRuns">,
	rootRunId: string,
	isShuttingDown: () => boolean,
): Promise<DispatchedRunsSettlement> {
	while (!isShuttingDown() && dispatchedBy(dispatch, rootRunId).some((run) => !isTerminalRunEnvelope(run))) {
		await sleep(SETTLE_POLL_MS);
	}
	const runs = dispatchedBy(dispatch, rootRunId);
	const retried = new Set(
		runs.flatMap((run) => ((run.lineage?.attempt ?? 0) > 0 && run.lineage?.parentRunId ? [run.lineage.parentRunId] : [])),
	);
	return {
		live: runs.filter((run) => !isTerminalRunEnvelope(run)),
		undelivered: runs.filter(
			(run) =>
				isTerminalRunEnvelope(run) &&
				!retried.has(run.id) &&
				run.outcome !== undefined &&
				run.outcome !== null &&
				UNDELIVERED_OUTCOMES.has(run.outcome),
		),
	};
}

export function describeRuns(runs: ReadonlyArray<RunEnvelope>): string {
	return runs
		.map((run) => {
			const outcome =
				run.outcomeCode === "merge_withheld" || run.outcomeCode === "worker_no_work" ? run.outcomeCode : run.outcome;
			const detail =
				(run.outcomeCode === "merge_withheld" || run.outcomeCode === "worker_no_work") && run.outcomeDetail
					? `: ${sanitizeCallTargetText(run.outcomeDetail)}`
					: "";
			return `${run.id} (${run.agentId}${outcome ? `, ${outcome}` : ""})${detail}`;
		})
		.join(", ");
}
