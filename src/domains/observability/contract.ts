import type { CostEntry } from "./cost.js";
import type { MetricsView } from "./metrics.js";
import type { TelemetrySnapshot } from "./telemetry.js";

export interface ObservabilityContract {
	/** Raw counter + histogram view. */
	telemetry(): TelemetrySnapshot;
	/** Aggregated view the TUI consumes. */
	metrics(): MetricsView;
	/** Running session USD cost. */
	sessionCost(): number;
	/** Per-dispatch cost log. */
	costEntries(): ReadonlyArray<CostEntry>;
	/** Record a token count. Primarily used by dispatch glue + diags. */
	recordTokens(providerId: string, modelId: string, tokens: number): void;
}
