import type { RunEnvelope, RunLineage, RunReceipt, RunStatus } from "./types.js";
import type { JobSpec } from "./validation.js";

export interface DispatchRequest extends JobSpec {
	systemPrompt?: string;
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
	}>;
	retrying: Array<{ runId: string; agentId: string; attempt: number; dueAt: string; reason: string }>;
	totals: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		runtimeSeconds: number;
	};
}

export interface DispatchContract {
	/** Validate + admit + spawn a native worker. Returns run id + promise. */
	dispatch(req: DispatchRequest): Promise<{
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

	/** Abort a running run. */
	abort(runId: string): void;

	/** Read-only runtime snapshot for operator surfaces. */
	snapshot(): DispatchSnapshot;

	/** Drain active runs on shutdown (SIGTERM + grace + SIGKILL). */
	drain(): Promise<void>;
}
