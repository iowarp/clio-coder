import type { BudgetVerdict } from "./budget.js";
import type { FleetRegistry } from "./cluster.js";
import type { LocalCapacity } from "./local-capacity.js";

export interface BudgetPreflight {
	verdict: BudgetVerdict;
	currentUsd: number;
	ceilingUsd: number;
}

export interface SchedulingContract {
	/** The configured session ceiling in USD; 0 means no ceiling. */
	ceilingUsd(): number;
	/**
	 * Evaluate the running session cost against the ceiling. Scheduling owns the
	 * observability lookup so callers (notably dispatch) don't need to import it.
	 * Verdict is "under" when spend is below the ceiling, "at" when equal, "over"
	 * when above. Dispatch records this session budget without denying reservations
	 * from the verdict; callers gate paid requests through admitPaidRequest.
	 */
	preflight(): BudgetPreflight;
	/** Park an interactive paid request until the operator raises the ceiling, or reject a headless one. */
	admitPaidRequest?(options: {
		waitForRaise: boolean;
		additionalUsd?: number;
		getCeilingUsd?: () => number;
		signal?: AbortSignal;
	}): Promise<void>;
	/** Configured global worker capacity; durable leases own active usage. */
	maxWorkers(): number;
	/**
	 * Worker limit for the implicit local node and the input that bound it.
	 * Under `auto` this follows host CPU and memory; optional so minimal
	 * scheduling stubs remain valid, and dispatch then uses `maxWorkers`.
	 */
	localCapacity?(): LocalCapacity;
	/**
	 * Fleet node registry backing multi-node placement: per-node states,
	 * capacity accounting, and channel-failure classification. Optional so
	 * minimal scheduling stubs remain valid; dispatch treats absence as a
	 * local-only fleet.
	 */
	fleet?: FleetRegistry;
}
