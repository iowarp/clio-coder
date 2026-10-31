import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { BudgetAlertPayload } from "../../core/telemetry/live-events.js";
import type { BudgetSpendPricing, BudgetVerdict, RunCostCap } from "./budget.js";
import type { FleetRegistry } from "./cluster.js";
import type { LocalCapacity } from "./local-capacity.js";

export interface BudgetPreflight {
	verdict: BudgetVerdict;
	currentUsd: number;
	ceilingUsd: number;
	/** How `currentUsd` was priced, from the read model's spend fold; absent only on a caller that cannot say. */
	pricing?: BudgetSpendPricing;
}

export interface SchedulingContract {
	/** The session ceiling in USD from the session's effective settings; 0 means no ceiling. */
	ceilingUsd(): number;
	/**
	 * Evaluate the running session cost against the ceiling. Scheduling owns the
	 * telemetry lookup so callers (notably dispatch) don't need to import it.
	 * Verdict is "under" when spend is below the ceiling, "at" when equal, "over"
	 * when above. Dispatch records this session budget without denying reservations
	 * from the verdict; callers gate paid requests through admitPaidRequest.
	 */
	preflight(): BudgetPreflight;
	/** Park an interactive paid request until the operator raises the ceiling, or reject a headless one. */
	admitPaidRequest?(options: {
		waitForRaise: boolean;
		/**
		 * Cost counted ahead of its settlement. A function is read after admission's settled spend on every retry, so it
		 * can subtract what that same fold already holds (#434).
		 */
		additionalUsd?: number | (() => number);
		/** How `additionalUsd` was priced, so a stop that counts it marks it (#434 §6.3). */
		additionalPricing?: BudgetSpendPricing;
		getCeilingUsd?: () => number;
		/** Estimated input tokens the parked request sends, so a ceiling stop shows what each call costs (#423). */
		contextTokens?: number;
		/** Record the first block before either waiting or rejecting (#424). */
		onBlocked?: (block: BudgetAlertPayload) => void;
		/** The held call's telemetry context; with it the crossing and the hold are journaled for that call (#424, #434). */
		telemetry?: TelemetryContext;
		signal?: AbortSignal;
	}): Promise<void>;
	/** Arm a `clio-coder run --max-cost-usd` cap, so a stop at it names the flag. */
	setRunCostCap?(cap: RunCostCap): void;
	/** The armed run cap, or null outside a capped run. */
	runCostCap?(): RunCostCap | null;
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
