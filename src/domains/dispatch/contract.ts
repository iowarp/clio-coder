import type { RunEnvelope, RunReceipt, RunStatus } from "./types.js";
import type { JobSpec } from "./validation.js";

export interface DispatchRequest extends JobSpec {
	systemPrompt?: string;
}

export interface DispatchContract {
	/** Validate + admit + spawn a native worker. Returns run id + promise. */
	dispatch(req: DispatchRequest): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}>;

	/** List runs from the ledger. */
	listRuns(status?: RunStatus): ReadonlyArray<RunEnvelope>;

	/** Get a specific run envelope. */
	getRun(runId: string): RunEnvelope | null;

	/** Abort a running run. */
	abort(runId: string): void;

	/** Drain active runs on shutdown (SIGTERM + grace + SIGKILL). */
	drain(): Promise<void>;
}
