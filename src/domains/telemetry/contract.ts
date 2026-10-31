import type { TelemetryCapture } from "../../core/telemetry/capture.js";
import type { TelemetryAgent } from "../../core/telemetry/context.js";
import type {
	CacheReportV1,
	CallFilter,
	CallsReportV1,
	CostReportV1,
	ExplanationV1,
	FactMetric,
	FactRef,
	HealthV1,
	Quantity,
	QuotaStateV1,
	RunRowV1,
	RunTelemetryV1,
	SessionTelemetryV1,
	TelemetryTopic,
	TelemetryUpdateV1,
	TimelineV1,
	WhyStoppedV1,
} from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { PreimageData, PreimageEventName } from "../../core/telemetry/events.js";
import type { RunUsageFacts } from "../../core/telemetry/schemas.js";
import type { AgentAudience } from "../agents/spec.js";
import type { RunToolBudgetEnvelope } from "../dispatch/budget-envelope.js";
import type { DispatchSnapshot } from "../dispatch/contract.js";
import type { DispatchRequestOrigin, RunKind } from "../dispatch/types.js";
import type { TrustSummaryProjection } from "../evidence/trust-projection.js";
import type { CanonicalTrustStatus } from "../evidence/trust-status.js";
import type { TurnsSum } from "./read-model.js";
import type { TelemetrySessionLease, TelemetrySessionOrigin } from "./session-journals.js";
import type { WorkerProgressSnapshot } from "./worker-progress.js";

/**
 * The streaming turn's live rate and output count, for the footer while the turn runs. A settled call's rate and TTFT
 * are the read model's (#434).
 */
export interface TokenThroughputSnapshot {
	tokensPerSecond: number;
	outputTokens: number;
	/** True when any output in this rate is derived from characters rather than provider usage. */
	estimated?: boolean;
	durationMs: number;
}

/**
 * Compact lifecycle summary for an active or recently settled dispatch run. Projected from the
 * dispatch bus channels; raw tool arguments and reasoning are absent. Worker
 * progress is a bounded, redacted presentation of the live stream. `evidence`
 * is populated asynchronously once the forensic bundle for the run finalizes.
 */
export interface TelemetryRunSummary {
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
	/** Existing validator identity/conformance, admitted with the verified run-result answer. */
	resultContract?: { kind: string; conformance: string };
	runRecordId?: string;
	retry?: { attempt: number; dueAtMs: number; reason: string };
	steerAcknowledgement?: { receivedAtMs: number; chars: number };
	writeRecordDowngrade?: { reason: "opaque_tool_succeeded"; tool: string; toolCallId: string };
	phase?: { wave: number; stepId: string };
	startedAtMs: number;
	finishedAtMs: number | null;
	durationMs: number | null;
	/** The run's spend as the dispatch snapshot or its terminal event states it; unknown until either arrives (#434). */
	spend: RunUsageFacts;
	outcomeDetail?: string | null;
	/** The run's journaled assessment, as its `evidence.assessed` reported it (#434). */
	evidence?: { firstPassSuccess: boolean; findingCount: number } | null;
}

/**
 * Single product-facing projection of the telemetry domain: run lifecycle and assessments folded from the event bus. Spend, tokens and timing are read from the read model (`read`), never from here (#434). `generatedAt` is the
 * wall-clock time the snapshot object was assembled.
 */
export interface TelemetrySnapshot {
	generatedAt: number;
	runs: readonly TelemetryRunSummary[];
}

/** Runtime readers supplied after dispatch is composed, avoiding a domain dependency cycle. */
export interface TelemetryRunReaders {
	dispatchSnapshot?: () => DispatchSnapshot;
	readRunResult?: (
		runId: string,
	) => { text?: string; trust?: CanonicalTrustStatus; contractKind?: string; contract?: string } | null;
}

/** Run projection controls shared by the contract and the in-memory projection. */
export interface TelemetryRunProjection {
	/** Bind live dispatch and run-result readers; disposal detaches this binding only. */
	bindRunReaders(readers: TelemetryRunReaders): () => void;
	/** Fold retry timers and live counters from the dispatch reader. */
	reconcileRuns(): void;
	/** Record an explicit fleet position, including before a run's first event. */
	setFleetPhase(runId: string, phase: NonNullable<TelemetryRunSummary["phase"]>): void;
}

/** One session's telemetry DTOs over one fixed read; every quantity carries its fact, display and ref (#434 §11). */
export interface TelemetryView {
	readonly sessionId: string;
	/** True while the live model's cold read has not merged; whole-scope sums stay partial until it does. */
	readonly seeding: boolean;
	session(): SessionTelemetryV1;
	calls(filter?: CallFilter): CallsReportV1;
	/** The journal records behind the session's own attempts the filter matches, for a fold that keeps provenance. */
	callRecords(filter?: CallFilter): TelemetryRecord[];
	cost(groupBy?: CostReportV1["groupBy"]): CostReportV1;
	cache(): CacheReportV1;
	timeline(range?: { from: string; to: string } | null): TimelineV1;
	runs(): RunRowV1[];
	/** A run this session references; null for any other run. */
	run(runId: string): RunTelemetryV1 | null;
	whyStopped(): WhyStoppedV1;
	explain(ref: FactRef): ExplanationV1 | null;
	/** Any one number by reference, e.g. a turn's input tokens, without building a whole report for it. */
	quantity(ref: FactRef): Quantity | null;
	/** Several operator turns read as one number, such as the turns one ACP prompt ran (#434 §11.3). */
	turns(turnIds: readonly string[], metric: FactMetric): TurnsSum;
	/** Some of the session's own attempts read as one, such as one agent segment's calls (#434). */
	attempts(attemptIds: readonly string[], metric: FactMetric): TurnsSum;
}

/**
 * The telemetry read model (#434 §11). `live()` folds exactly the batches the bound session's writers made durable,
 * so it equals a cold read of the same files; `open()` is that cold read, for any session, off the event loop.
 */
export interface TelemetryReadModel {
	/** The bound session, current with every persisted batch; null only when no session is bound. */
	live(): TelemetryView | null;
	/** A cold read identical to `clio-coder telemetry`; null when no session directory holds the id. */
	open(sessionId: string): Promise<TelemetryView | null>;
	/** Any run journal, read cold. */
	run(runId: string): Promise<RunTelemetryV1>;
	/**
	 * One quantity over this process's own calls, those no session or run owned, read after its journal flushes; null
	 * when the process journaled none (#434).
	 */
	processQuantity?(metric: FactMetric): Promise<Quantity | null>;
	/** Resolve a reference against the live session when it owns the ref, else against a cold read of its owner. */
	explain(ref: FactRef): Promise<ExplanationV1 | null>;
	quota(provider?: string): QuotaStateV1;
	health(): HealthV1;
	/** Coalesced to at most 10 Hz and never per token; readers fetch the topics they show. */
	subscribe(topic: TelemetryTopic, listener: (update: TelemetryUpdateV1) => void): () => void;
}

/** Priced spend with how it was priced: any estimated part marks it `~`, any unpriced call or gap marks it partial. */
export interface SessionSpend {
	usd: number;
	estimated: boolean;
	unpriced: boolean;
	/** The fact the amount came from; null when nothing has been spent yet. */
	ref: FactRef | null;
}

export interface TelemetryContract extends TelemetryRunProjection {
	/** Absent on contracts built without the telemetry extension, such as test doubles. */
	read?: TelemetryReadModel;
	/**
	 * The status the process exits with, which `process.exited` records. Each host names it before stopping domains:
	 * the coordinated shutdown's status, or the status a CLI command returns (#434).
	 */
	setExitStatus?(code: number): void;
	/**
	 * Spend so far as the budget gate enforces it: the live read model's `session:<id>#usd` (own calls plus referenced
	 * runs) for the bound session, or with no session this process's own calls (`process:<id>#usd`), its estimated
	 * and unpriced parts flagged. Read from persisted batches only; the gate itself reads {@link settledSessionSpend}.
	 */
	sessionSpend(): SessionSpend;
	/** {@link sessionSpend} after every queued record is written and the live fold has seeded, so it never lags (#434). */
	settledSessionSpend(): Promise<SessionSpend>;
	/** What the live read model already holds of a run's priced spend, so a meter's in-flight cost is not counted twice. */
	journaledRunUsd(runId: string): number;
	/** Bind the read model to the session now current, or to none. */
	resetSession(sessionId?: string | null): void;
	/** Hold the journal for this work's original session, including work surviving a UI switch (#434). */
	acquireTelemetrySession?(
		origin: TelemetrySessionOrigin,
		agent: TelemetryAgent,
		turnId?: string,
	): Promise<TelemetrySessionLease>;
	/** What the session's telemetry captures now, for recorders that write outside the call journal (#434). */
	telemetryCapture?(origin: TelemetrySessionOrigin): TelemetryCapture;
	/**
	 * Journal a background research trace into the session's own journal, its text into `objects/`, as the agent whose
	 * step it records (#434).
	 */
	recordResearchTrace?<K extends PreimageEventName>(
		origin: TelemetrySessionOrigin,
		agent: TelemetryAgent,
		kind: K,
		data: PreimageData<K>,
		preimage: unknown,
	): void;
	/**
	 * Current product-facing projection. Cheap to call: it folds in-memory state
	 * (active runs, bounded terminal history and the latest throughput)
	 * into a fresh immutable snapshot.
	 */
	snapshot(): TelemetrySnapshot;
	/**
	 * Subscribe to projection updates. The listener is invoked immediately with
	 * the current snapshot, then on each coalesced change. Returns an unsubscribe
	 * function; high-frequency bus events are debounced so consumers are not
	 * thrashed. The listener must stay cheap and non-blocking.
	 */
	subscribe(listener: (snapshot: TelemetrySnapshot) => void): () => void;
}
