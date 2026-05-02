import type { CostEntry, UsageBreakdown } from "./cost.js";
import type { MetricsView } from "./metrics.js";
import type { TelemetrySnapshot } from "./telemetry.js";

export interface ObservabilityContract {
	/** Raw counter + histogram view. */
	telemetry(): TelemetrySnapshot;
	/** Aggregated view the TUI consumes. */
	metrics(): MetricsView;
	/** Running session USD cost. */
	sessionCost(): number;
	/** Running session token totals broken down by kind, including reasoning when exposed. */
	sessionTokens(): UsageBreakdown;
	/** Per-dispatch cost log. */
	costEntries(): ReadonlyArray<CostEntry>;
	/**
	 * Record a token count. Used by dispatch glue, diags, and the chat loop's
	 * `agent_end` handler. `breakdown` is optional for call sites (dispatch
	 * bus payloads) that only know the total token count; callers with a
	 * pi-ai `Usage` object should pass the full breakdown so
	 * `sessionTokens()` can surface input/output/reasoning separately.
	 */
	recordTokens(
		providerId: string,
		modelId: string,
		tokens: number,
		costUsd?: number,
		breakdown?: Partial<UsageBreakdown>,
	): void;
}
