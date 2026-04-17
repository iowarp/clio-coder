import type { BudgetVerdict } from "./budget.js";
import type { ClusterNode } from "./cluster.js";

export interface SchedulingContract {
	ceilingUsd(): number;
	checkCeiling(currentUsd: number): BudgetVerdict;
	raiseCeiling(newUsd: number): void;
	activeWorkers(): number;
	tryAcquireWorker(): boolean;
	releaseWorker(): void;
	listNodes(): ReadonlyArray<ClusterNode>;
}
