import type { BudgetVerdict } from "./budget.js";
import type { ClusterNode } from "./cluster.js";

export interface BudgetPreflight {
	verdict: BudgetVerdict;
	currentUsd: number;
	ceilingUsd: number;
}

export interface SchedulingContract {
	ceilingUsd(): number;
	checkCeiling(currentUsd: number): BudgetVerdict;
	raiseCeiling(newUsd: number): void;
	/**
	 * Evaluate the running session cost against the ceiling. Scheduling owns the
	 * observability lookup so callers (notably dispatch) don't need to import it.
	 * Verdict is "under" when spend is below the ceiling, "at" when equal, "over"
	 * when above. Dispatch treats "at" and "over" as admission failures.
	 */
	preflight(): BudgetPreflight;
	activeWorkers(): number;
	tryAcquireWorker(): boolean;
	releaseWorker(): void;
	listNodes(): ReadonlyArray<ClusterNode>;
}
