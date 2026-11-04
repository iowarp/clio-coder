import type {
	JobChangedPayload,
	JobControlAction,
	JobCreateInput,
	JobOwner,
	JobRecord,
	TurnContinuationCause,
} from "../../core/job-types.js";

export type * from "../../core/job-types.js";

export type JobAdmission = { status: "ready" } | { status: "wait" | "denied"; reason: string };
export interface JobAdmissionContext {
	job: JobRecord;
	phase: "create" | "resume" | "run" | "delivery";
	signal: AbortSignal;
}
export interface JobExecutionContext {
	job: JobRecord;
	executionId: string;
	signal: AbortSignal;
	/** Call synchronously immediately before effects. False forbids execution. Persists start before true. */
	start(): boolean;
}
export interface JobRunResult {
	/** deferred is legal only before start(); retains pending work without charging a start. */
	outcome: "succeeded" | "failed" | "noop" | "deferred";
	summary?: string;
	json?: unknown;
	/** False when command output was capped/omitted, even if a prefix parses as JSON. */
	jsonComplete?: boolean;
	/** True for incomplete process-group cleanup OR incomplete pipe drain. Never confirmed termination. */
	cleanupUnresolved?: boolean;
	evidenceRefs?: readonly string[];
	costUsd?: number | null;
	errorClass?: "infrastructure" | "permission" | "execution";
	retryAfterMs?: number;
	/** The loop guard ended this main turn; the turn itself may still read as succeeded (#445). */
	stoppedBy?: "tool_budget" | "loop_guard";
}
export interface JobRunnerPorts {
	isCurrent(owner: JobOwner): boolean;
	admit(context: JobAdmissionContext): Promise<JobAdmission>;
	/** Call start() before effects. Resolve after cleanup, or explicitly return cleanupUnresolved on bounded cleanup failure. */
	run(context: JobExecutionContext): Promise<JobRunResult>;
	/** Same settlement contract; notice is host-only, main_turn uses scoped turn admission. */
	deliver(context: JobExecutionContext): Promise<JobRunResult>;
}
export interface JobStore {
	/** Bounded session snapshot, never a machine-wide scan. */
	list(owner: JobOwner): JobRecord[];
	/** null creates; otherwise compare-and-swap. Throws on conflict or failed persistence. */
	write(record: JobRecord, expectedRevision: number | null): void;
}
export interface JobControllerOptions {
	ports: JobRunnerPorts;
	store?: JobStore;
	now?: () => number;
	/** Process-local span clock; probes supplying now may use the same controlled clock. */
	monotonicNow?: () => number;
	/** False gives probes/hosts explicit tick ownership. Default true; timers are unref'd. */
	automatic?: boolean;
	onChange?: (payload: JobChangedPayload) => void;
	onError?: (error: Error) => void;
	/**
	 * Lets a job continue a main turn that stopped with nobody behind it and that
	 * no later occurrence would pick up, and keeps it from pausing on repeated
	 * infrastructure failures (#445). Absent means never.
	 */
	continuation?: {
		allowed(job: JobRecord): boolean;
		resumed(job: JobRecord, boundMs: number, cause: TurnContinuationCause): void;
	};
}
export interface JobController {
	create(input: JobCreateInput, owner: JobOwner): Promise<JobRecord>;
	control(id: string, action: JobControlAction, owner: JobOwner): Promise<JobRecord>;
	list(owner: JobOwner): JobRecord[];
	get(id: string, owner: JobOwner): JobRecord | null;
	/** Reconcile dead owners to paused/interrupted; never auto-resume. */
	recover(owner: JobOwner): JobRecord[];
	retire(owner: JobOwner, reason?: string): Promise<void>;
	/** Abort and await runner settlement; recorded cleanupUnresolved may remain incomplete after close returns. */
	close(): Promise<void>;
	/** Pump without awaiting long-running effects. */
	tick(): void;
}
