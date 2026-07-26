import type { BudgetVerdict } from "./budget.js";
import type { FleetRegistry } from "./cluster.js";

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
	/** Configured global worker capacity; durable leases own active usage. */
	maxWorkers(): number;
	/**
	 * Fleet node registry backing multi-node placement: per-node states,
	 * capacity accounting, and channel-failure classification. Optional so
	 * minimal scheduling stubs remain valid; dispatch treats absence as a
	 * local-only fleet.
	 */
	fleet?: FleetRegistry;
}
