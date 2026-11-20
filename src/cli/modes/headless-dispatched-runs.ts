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
	/**
	 * Final attempts of assignments the dispatching session canceled through steer (ns:61). The caller asked for the
	 * cancel, so they read canceled and do not fail the run. A cancel during a scheduled retry finds the last attempt
	 * already sealed failed; its entry here still reads canceled and names that attempt's ending in its detail.
	 */
	canceled: ReadonlyArray<RunEnvelope>;
	/**
	 * Schema v2 only (CLI-5): final attempts that did not deliver but a later dispatch of the same task by the same
	 * agent and parent did, so they no longer fail the run. Always empty unless the caller asks for it.
	 */
	superseded: ReadonlyArray<RunEnvelope>;
}

/** A steer-canceled run as it settles: canceled, with the sealed attempt's own ending kept when it was not one. */
function asSteerCanceled(run: RunEnvelope): RunEnvelope {
	if (run.outcome === "canceled") return { ...run, outcomeCode: null };
	const ended = run.outcomeCode ?? run.outcome ?? "unknown";
	return {
		...run,
		outcome: "canceled",
		outcomeCode: null,
		outcomeDetail: `canceled through steer by the dispatching session before its retry; the last attempt ended ${ended}`,
	};
}

function dispatchedBy(dispatch: Pick<DispatchContract, "listRuns">, rootRunId: string): RunEnvelope[] {
	// The ledger selects before it copies rows; a fake that ignores `where` is still filtered here.
	const ours = (run: Readonly<RunEnvelope>): boolean => run.id !== rootRunId && run.lineage?.rootRunId === rootRunId;
	return dispatch.listRuns(undefined, ours).filter(ours);
}

/**
 * Whether a later run of the same task delivered: same agent, same parent, byte-identical task, started after it and
 * sealed `succeeded`. A reworded task is a different task, so its failure still counts.
 */
function supersededBy(failed: RunEnvelope, runs: ReadonlyArray<RunEnvelope>): boolean {
	return runs.some(
		(later) =>
			later.id !== failed.id &&
			later.outcome === "succeeded" &&
			later.agentId === failed.agentId &&
			later.task === failed.task &&
			(later.lineage?.parentRunId ?? null) === (failed.lineage?.parentRunId ?? null) &&
			later.startedAt > failed.startedAt,
	);
}

/**
 * Wait for every run the headless turn dispatched to seal, then report the ones
 * that did not deliver. Detached runs are children of this process, so exiting
 * while they run drains and cancels them; before D3 a coordinator that ended
 * its turn early silently discarded its whole fan-out. Waiting stops when the
 * process starts shutting down (a signal or `--timeout`), and whatever is still
 * live is returned so the caller can name it. With `supersede` (schema v2), a
 * failure a later dispatch of the same task made good moves to `superseded`.
 */
export async function settleDispatchedRuns(
	dispatch: Pick<DispatchContract, "listRuns" | "canceledBySteer">,
	rootRunId: string,
	isShuttingDown: () => boolean,
	options: { supersede?: boolean } = {},
): Promise<DispatchedRunsSettlement> {
	while (!isShuttingDown() && dispatchedBy(dispatch, rootRunId).some((run) => !isTerminalRunEnvelope(run))) {
		await sleep(SETTLE_POLL_MS);
	}
	const runs = dispatchedBy(dispatch, rootRunId);
	const retried = new Set(
		runs.flatMap((run) => ((run.lineage?.attempt ?? 0) > 0 && run.lineage?.parentRunId ? [run.lineage.parentRunId] : [])),
	);
	const failed = runs.filter(
		(run) =>
			isTerminalRunEnvelope(run) &&
			!retried.has(run.id) &&
			run.outcome !== undefined &&
			run.outcome !== null &&
			UNDELIVERED_OUTCOMES.has(run.outcome),
	);
	// The dispatch domain's typed marker, never the outcome text: only a cancel the steer tool issued leaves the list.
	const steerCanceled = failed.filter((run) => dispatch.canceledBySteer?.(run.id) === true);
	const undeliveredCandidates = failed.filter((run) => !steerCanceled.includes(run));
	const superseded = options.supersede === true ? undeliveredCandidates.filter((run) => supersededBy(run, runs)) : [];
	return {
		live: runs.filter((run) => !isTerminalRunEnvelope(run)),
		undelivered: undeliveredCandidates.filter((run) => !superseded.includes(run)),
		canceled: steerCanceled.map(asSteerCanceled),
		superseded,
	};
}

/** Roomy enough for a branch name plus the merge recovery hint, small enough for one stderr line. */
const OUTCOME_DETAIL_MAX_CHARS = 600;

function boundedOutcomeDetail(detail: string): string {
	const clean = sanitizeCallTargetText(detail);
	return clean.length <= OUTCOME_DETAIL_MAX_CHARS ? clean : `${clean.slice(0, OUTCOME_DETAIL_MAX_CHARS - 1)}…`;
}

/**
 * One entry per run: `id (agent, <outcomeCode or outcome>): <detail>`. A
 * receipt's outcomeCode and outcomeDetail carry the reason (a rejected host
 * check, a withheld merge and its recovery hint), so a headless operator who
 * sees only stderr gets them for every run that has them.
 */
export function describeRuns(runs: ReadonlyArray<RunEnvelope>): string {
	return runs
		.map((run) => {
			const outcome = run.outcomeCode ?? run.outcome;
			const detail = run.outcomeDetail ? `: ${boundedOutcomeDetail(run.outcomeDetail)}` : "";
			return `${run.id} (${run.agentId}${outcome ? `, ${outcome}` : ""})${detail}`;
		})
		.join(", ");
}

export function projectDispatchedRunOutcome(run: RunEnvelope) {
	return {
		runId: run.id,
		agentId: run.agentId,
		outcome: run.outcome ?? null,
		outcomeCode: run.outcomeCode ?? null,
		outcomeDetail: run.outcomeDetail ? boundedOutcomeDetail(run.outcomeDetail) : null,
	};
}
