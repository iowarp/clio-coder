import type { ResponseModelIdObservationCounts } from "../../core/response-model-id.js";
import type { AgentAudience } from "../agents/spec.js";
import type { RunToolBudgetEnvelope } from "../dispatch/budget-envelope.js";
import type { DispatchSnapshot } from "../dispatch/contract.js";
import type { DispatchRequestOrigin, RunKind } from "../dispatch/types.js";
import type { TrustSummaryProjection } from "../evidence/trust-projection.js";
import type { CanonicalTrustStatus } from "../evidence/trust-status.js";
import type { CostProvenance } from "../providers/index.js";
import type { CostAggregate, CostEntry, CostEntryLabel, UsageBreakdown } from "./cost.js";
import type { SessionTurnTrace } from "./trace-store.js";
import type { WorkerProgressSnapshot } from "./worker-progress.js";

/** The footer speed row reads every field: rate, generation time, TTFT and output count. */
export interface TokenThroughputSnapshot {
	tokensPerSecond: number;
	outputTokens: number;
	durationMs: number;
	ttftMs?: number;
}

/**
 * One bounded, product-facing observability event: an evidence build that
 * failed for a run, read by the Dispatch Board to explain why a run has no
 * evidence bundle. This used to also carry runtime/middleware/safety/loop/
 * tool-budget/context/budget notices classified off the same bus channels the
 * interactive layer's own notice pipeline (bus-notices.ts and
 * interactive-event-projection.ts) classifies independently for the toast
 * surface a session actually shows; those seven kinds had no reader of their
 * own here and were removed rather than kept as an unread second opinion.
 * `message` is a short rendered line and `ref` links back to the run.
 */
export interface ObservabilityNotice {
	kind: "evidence";
	level: "info" | "warning" | "error";
	message: string;
	ref?: {
		runId?: string;
	};
}

/**
 * Compact lifecycle summary for an active or recently settled dispatch run. Projected from the
 * dispatch bus channels; raw tool arguments and reasoning are absent. Worker
 * progress is a bounded, redacted presentation of the live stream. `evidence`
 * is populated asynchronously once the forensic bundle for the run finalizes.
 */
export interface ObservabilityRunSummary {
	runId: string;
	agentId: string;
	targetId?: string;
	modelId?: string;
	runtimeId?: string;
	runtimeKind?: RunKind;
	status: "enqueued" | "running" | "completed" | "failed" | "aborted" | "dead" | "stale" | "cancelling" | "retrying";
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	endpoint?: { key: string; label: string; limit: number };
	taskSummary?: string;
	budget?: RunToolBudgetEnvelope;
	ttftMs?: number | null;
	node?: string;
	gate?: { role: string; cycle: number };
	council?: { group: string; label: string; color?: string; round: number };
	hostVerification?: "verified" | "rejected" | "skipped" | "not_implicated";
	trust?: TrustSummaryProjection;
	rerouteCount?: number;
	failoverHops?: number;
	contextWindow?: number;
	lastContextTokens?: number;
	progress?: WorkerProgressSnapshot;
	/** Existing validator identity/conformance, admitted with the verified receipt answer. */
	resultContract?: { kind: string; conformance: string };
	receiptId?: string;
	retry?: { attempt: number; dueAtMs: number; reason: string };
	steerAcknowledgement?: { receivedAtMs: number; chars: number };
	writeRecordDowngrade?: { reason: "opaque_tool_succeeded"; tool: string; toolCallId: string };
	phase?: { wave: number; stepId: string };
	startedAtMs: number;
	finishedAtMs: number | null;
	durationMs: number | null;
	tokens: {
		input: number;
		output: number;
		total: number;
	};
	costUsd: number;
	costProvenance: CostProvenance;
	outcomeDetail?: string | null;
	/** The landed bundle, which the board links to by id. */
	evidence?: { evidenceId: string } | null;
}

/**
 * The evidence-readiness facts an evidence build reports once its bundle lands.
 * It is the `accountability.evidenceReady` payload ACP forwards; the run
 * summary keeps only `evidenceId`.
 */
export interface ObservabilityRunEvidence {
	evidenceId: string;
	firstPassSuccess: boolean;
	findingCount: number;
	tags: readonly string[];
}

/**
 * Single product-facing projection of the observability domain. A materialized,
 * bounded read model folded from the event bus plus the session cost tracker.
 * `generatedAt` is the wall-clock time the snapshot object was assembled.
 */
export interface ObservabilitySnapshot {
	generatedAt: number;
	session: {
		cost: CostAggregate;
		tokens: UsageBreakdown;
		latestThroughput: TokenThroughputSnapshot | null;
	};
	runs: readonly ObservabilityRunSummary[];
	notices: readonly ObservabilityNotice[];
	pendingEvidenceBuildRunIds: readonly string[];
}

/** Runtime readers supplied after dispatch is composed, avoiding a domain dependency cycle. */
export interface ObservabilityRunReaders {
	dispatchSnapshot?: () => DispatchSnapshot;
	readReceipt?: (
		runId: string,
	) => { text?: string; trust?: CanonicalTrustStatus; contractKind?: string; contract?: string } | null;
}

/** Run projection controls shared by the contract and the in-memory projection. */
export interface ObservabilityRunProjection {
	/** Bind live dispatch and receipt readers; disposal detaches this binding only. */
	bindRunReaders(readers: ObservabilityRunReaders): () => void;
	/** Fold retry timers and live counters from the dispatch reader. */
	reconcileRuns(): void;
	/** Record an explicit fleet position, including before a run's first event. */
	setFleetPhase(runId: string, phase: NonNullable<ObservabilityRunSummary["phase"]>): void;
}

export interface ObservabilityContract extends ObservabilityRunProjection {
	/** Running session USD cost. */
	sessionCost(): number;
	sessionCostSummary(): CostAggregate;
	/** Running session cost log entries. */
	costEntries(): ReadonlyArray<CostEntry>;
	/** Reset the running session token and cost totals. */
	resetSession(): void;
	/**
	 * Record a token count. Used by dispatch glue, diags, and the chat loop's
	 * `agent_end` handler. `breakdown` is optional for call sites (dispatch
	 * bus payloads) that only know the total token count; callers with a
	 * pi-ai `Usage` object should pass the full breakdown so the snapshot's
	 * session tokens can surface input/output/reasoning separately.
	 */
	recordTokens(
		providerId: string,
		attributedModelId: string,
		tokens: number,
		costUsd?: number,
		breakdown?: Partial<UsageBreakdown>,
		costProvenance?: CostProvenance,
		modelIdFacts?: {
			requestedModelIds: ReadonlyArray<string>;
			responseModelIdObservationCounts: Readonly<ResponseModelIdObservationCounts>;
		},
		/** Marks a priced call that was not an ordinary turn, such as a `/btw` side question. */
		label?: CostEntryLabel,
	): void;
	/** Record final output token throughput for one completed assistant stream. */
	recordTokenThroughput(snapshot: TokenThroughputSnapshot): void;
	/**
	 * Mirror one fact about a turn the operator ran themselves into the trace
	 * database, so `clio-coder trace runs` lists the session's own turns beside the
	 * runs it dispatched. The dispatch mirror hears only the dispatch bus
	 * channels, and an interactive turn is not a dispatch, so without this the
	 * only rows a session contributes are its workers'.
	 *
	 * Best effort, exactly like the dispatch mirror: writes are queued off the
	 * turn hot path and a failing mirror degrades silently rather than
	 * interrupting chat.
	 */
	recordSessionTurn(trace: SessionTurnTrace): void;
	/**
	 * Current product-facing projection. Cheap to call: it folds in-memory state
	 * (active runs, bounded terminal history/notices, session cost/tokens and the
	 * latest throughput) into a fresh immutable snapshot.
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
