import type { CostProvenance } from "../providers/index.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import type { DetachedBatchRecord, RegisterDetachedBatchInput } from "./batch-store.js";
import type { RunEnvelope, RunLineage, RunNodeIdentity, RunReceipt, RunStatus } from "./types.js";
import type { JobSpec } from "./validation.js";

export interface DispatchRequest extends JobSpec {
	systemPrompt?: string;
}

/** Internal, non-serializable admission hook for transactional resource owners. */
export interface DispatchAdmissionObserver {
	onAdmitted(run: { runId: string; pid: number | null; runtimeKind: RunEnvelope["runtimeKind"] }): void;
}

/** Side-effect-free effective routing used to construct a dispatch approval artifact. */
export interface DispatchPlanTaskResolution {
	agentId: string;
	targetId: string;
	wireModelId: string;
	node: RunNodeIdentity;
}

/**
 * Thrown by dispatch() when the concurrency gate is at capacity. Interactive
 * callers keep the fail-fast contract; dispatchBatch catches this error and
 * throttles remaining batch members until a slot frees.
 */
export class DispatchConcurrencyError extends Error {
	constructor(activeWorkers: number) {
		super(`dispatch: admission denied: concurrency limit reached (${activeWorkers} active workers)`);
		this.name = "DispatchConcurrencyError";
	}
}

/**
 * Read-only operator snapshot of orchestrator state. Drawn from in-memory
 * dispatch state plus the ledger mirror; performs no I/O and is never
 * required for correctness. Consumers wrap their own rendering errors.
 */
export interface DispatchSnapshot {
	generatedAt: string;
	running: Array<{
		runId: string;
		agentId: string;
		runtimeKind: string;
		outcomePhase: string;
		heartbeat: "alive" | "stale" | "dead" | "n/a";
		lineage: RunLineage;
		startedAt: string;
		elapsedMs: number;
		tokens: { input: number; output: number; total: number };
		costUsd: number;
		costProvenance?: CostProvenance;
		/** Fleet node this run was placed on; null means the local node. */
		node: RunNodeIdentity | null;
	}>;
	retrying: Array<{ runId: string; agentId: string; attempt: number; dueAt: string; reason: string }>;
	totals: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		cost?: { knownUsd: number; hasEstimated: boolean; hasUnknown: boolean; allKnownFree: boolean };
		runtimeSeconds: number;
	};
}

/**
 * Why a run is being aborted. Absent means an operator/user cancel. A caller
 * that time-boxes a run (dispatch `timeout_ms`) passes the timeout cause so the
 * receipt names the timeout instead of laundering it into "operator abort".
 */
export interface AbortReason {
	cause: "timeout";
	detail: string;
}

/**
 * Durable detached-batch surface. A detached dispatch's grouping and
 * collection state persist under the state dir (`batches.json`) so a barrier
 * collect works after session exit and completion nudges stay suppressed once
 * a batch is collected. Optional so lightweight contract fakes need not
 * implement it; the real dispatch extension always does.
 */
export interface DetachedBatchesContract {
	register(input: RegisterDetachedBatchInput): Promise<DetachedBatchRecord>;
	get(batchId: string): DetachedBatchRecord | null;
	list(opts?: { includeCollected?: boolean }): ReadonlyArray<DetachedBatchRecord>;
	markCollected(batchId: string): Promise<DetachedBatchRecord | null>;
}

export interface DispatchContract {
	/**
	 * Resolve effective agent/target/model/node without launching or acquiring a
	 * slot. Callers pin this result into the approved request; later placement
	 * failure aborts rather than choosing a different unapproved node.
	 */
	preview?(req: DispatchRequest): DispatchPlanTaskResolution;
	/** Session scheduling ceiling captured in the same immutable approval artifact. */
	costCeilingUsd?(): number;
	/** Current trusted hard-block state for coordinator-side merge validation. */
	protectedArtifactState?(): ProtectedArtifactState;
	/** Validate + admit + spawn a native worker. Returns run id + promise. */
	dispatch(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}>;

	/** Spawn a group of dispatches and expose one merged batch event stream. */
	dispatchBatch(reqs: ReadonlyArray<DispatchRequest>): Promise<{
		batchId: string;
		runIds: ReadonlyArray<string>;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<ReadonlyArray<RunReceipt>>;
	}>;

	/** List runs from the ledger. */
	listRuns(status?: RunStatus): ReadonlyArray<RunEnvelope>;

	/** Get a specific run envelope. */
	getRun(runId: string): RunEnvelope | null;

	/**
	 * Abort a running run. Absent `reason` means an operator/user cancel, sealed
	 * as `outcome=canceled, outcomeDetail="operator abort"`. Pass a reason to
	 * record a non-operator cause (e.g. a dispatch `timeout_ms`) in the receipt's
	 * outcomeDetail so a time-boxed kill is distinguishable from an operator
	 * cancel; the outcome stays `canceled`.
	 */
	abort(runId: string, reason?: AbortReason): void;

	/**
	 * Queue an operator steer on a running native worker. The text is sent as
	 * a JSON line on the worker's open stdin and injected into its transcript
	 * as a user message at the next loop boundary; the worker acks with a
	 * `clio_steer_received` event on its stream. Throws with an operator-facing
	 * message when the run is unknown or no longer active, when the run kind
	 * has no stdin channel (acp-delegation), or when the worker's stdin is
	 * already gone.
	 */
	steer(runId: string, text: string): void;

	/**
	 * Apply an operator's decision to a parked permission escalation on a
	 * running native worker (onPermission="escalate"). Writes a
	 * `permission_decision` JSON line on the worker's open stdin; the worker
	 * releases or denies the parked tool call and acks with a
	 * `clio_permission_resolved` event. Human-only: no model-facing tool can
	 * reach this. Throws with an operator-facing message when the run is
	 * unknown or no longer active, when the run kind has no stdin channel
	 * (acp-delegation), or when the worker's stdin is already gone. Mirrors
	 * steer's validation and error wording. Optional so lightweight contract
	 * fakes need not implement it; the real dispatch extension always does.
	 */
	resolveWorkerPermission?(runId: string, requestId: string, decision: "approve" | "deny"): void;

	/** Durable detached-batch records for async fan-out + collect. */
	detached?: DetachedBatchesContract;

	/** Read-only runtime snapshot for operator surfaces. */
	snapshot(): DispatchSnapshot;

	/** Drain active runs on shutdown (SIGTERM + grace + SIGKILL). */
	drain(): Promise<void>;
}
