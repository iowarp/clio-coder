/**
 * Startup recovery of runs whose host died (Symphony P10: restart resumes from durable artifacts, not in-memory
 * state). A run's record is its journal's run.settled: a row that still claims a live run whose worker is gone is
 * settled from that record when it holds one, and closed as stalled when it does not, since a run with no settled
 * record did not finish (#434).
 */

import { hostname } from "node:os";
import { clioStateDir } from "../../core/xdg.js";
import type { SettledRunRecord } from "../telemetry/index.js";
import { readSettledRun } from "../telemetry/index.js";
import { runStatusForOutcome } from "./outcome.js";
import type { RunSettlement } from "./run-settlement.js";
import { settleUnfinishedRun } from "./run-settlement.js";
import type { Ledger } from "./state.js";
import type { RunEnvelope } from "./types.js";

export interface RunRecoverySummary {
	/** Non-terminal rows whose worker process no longer exists and whose run never settled, closed as stalled. */
	abandoned: number;
	/** Non-terminal rows whose worker process is gone but whose run settled, closed from that record. */
	sealed: number;
	/** The run.settled each abandoned run's journal lacks because its host died first; the caller journals them. */
	unsettled: Array<{ runId: string; settlement: RunSettlement }>;
	/**
	 * Terminal rows of this host whose run journal is not sealed: the host persisted the terminal row and died before
	 * the journal's seal landed. The caller seals the ones whose journal holds run.settled (#434).
	 */
	unsealed: string[];
}

export interface RunRecoveryOptions {
	stateDir?: string;
	/** Whether a run's journal exists without its sealed bundle; without it no terminal row is offered. */
	journalUnsealed?: (runId: string) => boolean;
}

function isProcessAlive(pid: number | null): boolean {
	if (pid === null || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "stale", "dead"]);

/** The ledger patch a settled run's record states: the row then reads as the run settled. */
function settledRowPatch(run: SettledRunRecord): Partial<RunEnvelope> {
	const settled = run.settled;
	return {
		status: runStatusForOutcome(settled.outcome),
		outcome: settled.outcome,
		outcomeCode: settled.outcomeCode,
		outcomeDetail: settled.outcomeDetail,
		endedAt: settled.endedAt,
		exitCode: settled.exitCode ?? settled.processExitCode,
	};
}

/**
 * Settle `runId`'s row from its run's settled record. Returns false, leaving the row alone, when the run never
 * settled.
 */
export function sealRowFromSettledRun(ledger: Ledger, runId: string, stateDir = clioStateDir()): boolean {
	const run = readSettledRun(stateDir, runId);
	if (run === null) return false;
	ledger.update(runId, settledRowPatch(run));
	return true;
}

/** Row states that still claim a live run. */
export function isOpenRunRow(row: RunEnvelope): boolean {
	return row.endedAt === null && NON_TERMINAL_STATUSES.has(row.status);
}

/**
 * Close abandoned ledger rows: a non-terminal row whose recorded worker pid
 * no longer exists belongs to an orchestrator that died mid-run.
 *
 * Such a run may still have settled in its journal. A run settles before it
 * persists the terminal row, so a crash or a clobbered persist in that window
 * leaves a run.settled saying `succeeded`/0 next to a row that still says
 * `running`. Stamping the row dead without looking was how a finished dispatch
 * came to be recorded as a failure. So the settled record decides when there is
 * one, and only a row with nothing to settle it from is closed as "stalled"
 * rather than left as a permanent ghost in status output.
 *
 * `endedAt` is the last instant the run was observed alive, not the instant
 * recovery noticed it was gone. Stamping recovery time made every phase
 * duration derived from the row (`executionMs`, `totalEndToEndMs`) span the
 * whole orchestrator downtime, which is not a measurement of anything. The
 * last heartbeat is the honest bound; a row that never heartbeat has only its
 * own start, which reads as a zero-length run rather than an invented one.
 *
 * A restart has no shared monotonic origin with the process that owned the
 * worker, so recovery never estimates heartbeat age. It first adjudicates the
 * host-scoped pid and uses the persisted wall-clock heartbeat only as this
 * display/evidence bound after that process is known to be gone.
 */
export function recoverAbandonedRuns(ledger: Ledger, options: RunRecoveryOptions = {}): RunRecoverySummary {
	const stateDir = options.stateDir ?? clioStateDir();
	let abandoned = 0;
	let sealed = 0;
	const unsettled: RunRecoverySummary["unsettled"] = [];
	const localHost = hostname();
	for (const row of ledger.list()) {
		if (!isOpenRunRow(row)) continue;
		// Transport-scoped liveness: the recorded pid is always a process on
		// the orchestrator host that created the row (for ssh runs it is the
		// local ssh client, i.e. the channel itself). On a shared filesystem
		// the ledger is visible from other hosts, where a local pid probe would
		// adjudicate the wrong process; rows created by another host are left
		// for that host's own recovery pass.
		if (row.identity !== undefined && row.identity.host !== localHost) continue;
		if (isProcessAlive(row.pid)) continue;
		if (sealRowFromSettledRun(ledger, row.id, stateDir)) {
			sealed += 1;
			continue;
		}
		const detail = "abandoned: orchestrator exited before the run finalized";
		const endedAt = row.heartbeatAt ?? row.startedAt;
		const closedRow = ledger.update(row.id, {
			status: "dead",
			outcome: "stalled",
			outcomeDetail: detail,
			endedAt,
			exitCode: row.exitCode ?? 1,
		});
		abandoned += 1;
		unsettled.push({
			runId: row.id,
			settlement: settleUnfinishedRun(closedRow ?? row, {
				terminal: { terminalReason: "stalled" },
				outcome: "stalled",
				detail,
				endedAt,
				processExitCode: row.exitCode ?? null,
			}),
		});
	}
	const settling = new Set(unsettled.map(({ runId }) => runId));
	const unsealed = options.journalUnsealed
		? ledger
				.list()
				.filter(
					(row) =>
						!isOpenRunRow(row) &&
						!settling.has(row.id) &&
						(row.identity === undefined || row.identity.host === localHost) &&
						options.journalUnsealed?.(row.id) === true,
				)
				.map((row) => row.id)
		: [];
	return { abandoned, sealed, unsettled, unsealed };
}
