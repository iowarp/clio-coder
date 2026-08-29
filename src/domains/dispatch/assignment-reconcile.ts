/**
 * Startup reconciliation for durable assignments. The in-memory retry queue and
 * assignment registry do not survive a restart (Symphony §14.3), so a durable
 * record whose process owner is gone is orphaned: no active attempt, no queued
 * retry, and no attached terminal promise can ever settle it. Running records
 * owned by a live sibling process are deliberately left alone.
 *
 * This pass resolves each orphan deterministically against durable ledger
 * evidence so a later `wait`/`collect` can never observe a stuck `running`
 * record. It performs no I/O of its own; callers inject ledger lookup and the
 * durable settle.
 */

import type { AssignmentStatus } from "./assignment.js";
import type { AssignmentVerdictOwner, DurableAssignmentRecord } from "./assignment-store.js";

/** Minimal terminal view of one attempt's durable ledger row. */
export interface ReconcileAttemptView {
	runId: string;
	/** The ledger row reached a terminal status (not `running`). */
	terminal: boolean;
	/** The attempt verified as a successful terminal outcome. */
	succeeded: boolean;
}

export interface AssignmentReconcileDeps {
	/** Durable records currently marked `running`. */
	listRunning: () => ReadonlyArray<DurableAssignmentRecord>;
	/** Decide liveness from the record's durable pid and process birth token. */
	ownerAlive: (record: DurableAssignmentRecord) => boolean;
	/** Resolve one attempt's terminal view from the ledger, or null if pruned. */
	lookupAttempt: (runId: string) => ReconcileAttemptView | null;
	/** Persist the reconciled terminal status, as the record's verdict owner when it has one. */
	settle: (
		assignmentId: string,
		terminalRunId: string,
		status: Exclude<AssignmentStatus, "running">,
		owner?: AssignmentVerdictOwner,
	) => Promise<unknown>;
}

export interface AssignmentReconcileSummary {
	/** Resolved to a known terminal attempt receipt (succeeded or failed). */
	recovered: number;
	/** No recoverable attempt evidence; failed deterministically. */
	abandoned: number;
}

/**
 * Deterministic rule, in priority order:
 *  -1. a record owned by a live process is not an orphan and remains running;
 *   0. a record whose verdict belongs to its opener is failed (abandoned): the
 *      opener died before reaching a verdict, and a green attempt under it is
 *      one step of a run, never the run's answer;
 *   1. a recovered succeeded terminal attempt wins (`succeeded`);
 *   2. otherwise the last terminal attempt marks the assignment `failed`;
 *   3. otherwise no attempt is recoverable and the assignment is failed
 *      (abandoned) against its last recorded attempt id, or its own id.
 */
export async function reconcileOrphanAssignments(deps: AssignmentReconcileDeps): Promise<AssignmentReconcileSummary> {
	const summary: AssignmentReconcileSummary = { recovered: 0, abandoned: 0 };
	for (const record of deps.listRunning()) {
		if (record.status !== "running") continue;
		if (deps.ownerAlive(record)) continue;
		if (record.verdictOwner !== undefined) {
			// Attempts under a claimed row are fleet steps, not the fleet verdict.
			// Filing a green step as the terminal id of an abandoned fleet would
			// contradict that step's immutable ledger result.
			await deps.settle(record.assignmentId, record.assignmentId, "failed", record.verdictOwner);
			summary.abandoned += 1;
			continue;
		}
		const views = record.attempts
			.map((runId) => deps.lookupAttempt(runId))
			.filter((view): view is ReconcileAttemptView => view !== null);
		const succeeded = views.find((view) => view.succeeded);
		if (succeeded) {
			await deps.settle(record.assignmentId, succeeded.runId, "succeeded");
			summary.recovered += 1;
			continue;
		}
		const lastTerminal = [...views].reverse().find((view) => view.terminal);
		if (lastTerminal) {
			await deps.settle(record.assignmentId, lastTerminal.runId, "failed");
			summary.recovered += 1;
			continue;
		}
		const fallbackRunId = record.attempts.at(-1) ?? record.assignmentId;
		await deps.settle(record.assignmentId, fallbackRunId, "failed");
		summary.abandoned += 1;
	}
	return summary;
}
