import type { TargetStatus } from "../providers/contract.js";
import type { CostProvenance } from "../providers/index.js";
import type { AccountabilitySummary } from "./accountability.js";
import type { CostAggregate, CostEntry, UsageBreakdown } from "./cost.js";
import type { MetricsView } from "./metrics.js";
import type { TelemetrySnapshot } from "./telemetry.js";

export interface TokenThroughputSnapshot {
	tokensPerSecond: number;
	outputTokens: number;
	durationMs: number;
	ttftMs?: number;
	providerId: string;
	modelId: string;
	recordedAt: number;
}

/**
 * One bounded, product-facing observability event. Notices are a redacted,
 * append-only stream: a runtime eviction, a blocked tool, a hook crash, a
 * pruned context window, and so on. They never carry raw worker output or tool
 * arguments; `message` is a short rendered line and `ref` links back to the
 * subject (a run, a target, an evidence bundle) without embedding its contents.
 */
export interface ObservabilityNotice {
	id: string;
	at: number;
	kind: "runtime" | "middleware" | "safety" | "loop" | "tool-budget" | "context" | "budget" | "provider" | "evidence";
	level: "info" | "warning" | "error";
	message: string;
	ref?: {
		runId?: string;
		agentId?: string;
		targetId?: string;
		modelId?: string;
		evidenceId?: string;
		tool?: string;
	};
}

/**
 * Compact lifecycle summary for a recent dispatch run. Projected from the
 * dispatch bus channels; the raw transcript, tool arguments, and worker output
 * are intentionally absent. `evidence` is populated asynchronously once the
 * forensic bundle for the run finalizes.
 */
export interface ObservabilityRunSummary {
	runId: string;
	agentId: string;
	targetId?: string;
	modelId?: string;
	runtimeId?: string;
	runtimeKind?: string;
	status: "enqueued" | "running" | "completed" | "failed" | "aborted" | "dead" | "stale";
	startedAtMs: number;
	updatedAtMs: number;
	finishedAtMs: number | null;
	durationMs: number | null;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		total: number;
	};
	costUsd: number;
	costProvenance: CostProvenance;
	outcome?: string | null;
	outcomeDetail?: string | null;
	evidence?: {
		evidenceId: string;
		firstPassSuccess: boolean;
		findingCount: number;
		tags: readonly string[];
	} | null;
}

/** Evidence-readiness detail attached to a run summary once its bundle lands. */
export type ObservabilityRunEvidence = NonNullable<ObservabilityRunSummary["evidence"]>;

/**
 * Single product-facing projection of the observability domain. A materialized,
 * bounded read model folded from the event bus plus the session cost/telemetry
 * trackers. `revision` is monotonic so consumers can cheaply detect change;
 * `generatedAt` is the wall-clock time the snapshot object was assembled.
 */
export interface ObservabilitySnapshot {
	revision: number;
	generatedAt: number;
	session: {
		costUsd: number;
		cost: CostAggregate;
		tokens: UsageBreakdown;
		latestThroughput: TokenThroughputSnapshot | null;
	};
	metrics: MetricsView;
	accountability: AccountabilitySummary;
	runs: readonly ObservabilityRunSummary[];
	providerHealth: Readonly<Record<string, TargetStatus>>;
	notices: readonly ObservabilityNotice[];
	pendingEvidenceBuildRunIds: readonly string[];
}

export interface ObservabilityContract {
	/** Raw counter + histogram view. */
	telemetry(): TelemetrySnapshot;
	/** Aggregated view the TUI consumes. */
	metrics(): MetricsView;
	/** Running session USD cost. */
	sessionCost(): number;
	sessionCostSummary(): CostAggregate;
	/** Running session token totals broken down by kind, including reasoning when exposed. */
	sessionTokens(): UsageBreakdown;
	/** Running session cost log entries. */
	costEntries(): ReadonlyArray<CostEntry>;
	/**
	 * Rolling first-pass-success rate and failure-cause histogram, aggregated
	 * from the sidecar evidence index on call. Read-only: it folds rows Slice 2
	 * already wrote and recomputes no evidence.
	 */
	accountability(): AccountabilitySummary;
	/** Latest completed assistant stream throughput for compact footer display. */
	latestTokenThroughput(): TokenThroughputSnapshot | null;
	/** Reset the running session token and cost totals. */
	resetSession(): void;
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
		costProvenance?: CostProvenance,
	): void;
	/** Record final output token throughput for one completed assistant stream. */
	recordTokenThroughput(snapshot: TokenThroughputSnapshot): void;
	/**
	 * Current product-facing projection. Cheap to call: it folds in-memory state
	 * (bounded run/notice rings, session cost/tokens, aggregated metrics, and the
	 * cached accountability summary) into a fresh immutable snapshot.
	 */
	snapshot(): ObservabilitySnapshot;
	/**
	 * Subscribe to projection updates. The listener is invoked immediately with
	 * the current snapshot, then on each coalesced change. Returns an unsubscribe
	 * function; high-frequency bus events are debounced so consumers are not
	 * thrashed. The listener must stay cheap and non-blocking.
	 */
	subscribe(listener: (snapshot: ObservabilitySnapshot) => void): () => void;
}
