import type { TurnConstraints } from "./turn-constraints.js";

/** Host identity; generation changes on navigation, never on ordinary turns (#411). */
export interface JobOwner {
	readonly sessionId: string;
	readonly cwd: string;
	readonly generation: string;
}
export interface JobPredicate {
	readonly path: readonly string[];
	readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "exists";
	readonly value?: string | number | boolean | null;
}
/** A further wait condition on a command job: its own pinned command and predicate, checked by the host each poll. */
export interface JobCondition {
	readonly argv: readonly string[];
	readonly executableSha256?: string;
	readonly until: JobPredicate;
}
export type JobRunner =
	| {
			readonly kind: "command";
			readonly argv: readonly string[];
			readonly executableSha256?: string;
			/** The job matches only when the spec's until and every one of these hold in the same occurrence. */
			readonly also?: readonly JobCondition[];
	  }
	| { readonly kind: "main"; readonly prompt: string };
export type JobMatchAction = { readonly kind: "notice" } | { readonly kind: "main_turn"; readonly prompt: string };
export interface JobCreateInput {
	readonly intervalMs: number;
	readonly runner: JobRunner;
	readonly count?: number;
	readonly deadlineAt?: number;
	readonly timeoutMs?: number;
	/** Restores a stored spec whose timeout the creator left to the default; a new job sets it by omitting timeoutMs. */
	readonly timeoutDefaulted?: true;
	readonly until?: JobPredicate;
	readonly onMatch?: JobMatchAction;
	/** Run until the operator stops it: no start count, no deadline (#450). */
	readonly untilStopped?: true;
	/** Host-supplied creating-turn scope, never authority supplied by model arguments. */
	readonly constraints?: TurnConstraints;
	readonly originTurnId?: string;
}
export interface JobSpec {
	readonly intervalMs: number;
	readonly runner: JobRunner;
	readonly count: number | null;
	readonly deadlineAt: number | null;
	readonly timeoutMs: number;
	/** The creator named no timeout. Absent on an explicit bound, which then also bounds a follow-up, and on older records (#445). */
	readonly timeoutDefaulted?: true;
	readonly until: JobPredicate | null;
	readonly onMatch: JobMatchAction;
	/** Ends only on a matched until, stop or cancel; count and deadline are null. Absent on bounded and older records (#450). */
	readonly untilStopped?: true;
	readonly constraints: TurnConstraints | null;
	readonly originTurnId: string | null;
}
/** A job's own clock ended the execution, as opposed to a person or the host stopping it (#445). */
export class JobClockExpired extends Error {
	override readonly name = "JobClockExpired";
}
/** Why an unattended turn gets another one at yolo (#445). */
export type TurnContinuationCause =
	| "clock"
	| "failure"
	| "tool_budget"
	| "loop_guard"
	| "retries_exhausted"
	| "compaction"
	| "job_exhausted"
	| "job_deadline"
	| "polls_failing";
/**
 * One job or one operator turn gets this many continuations after a failure stop; a turn that dies that often is not a
 * slow turn. A tool budget crossing is a checkpoint and does not count, or a steady poll would run out of them within
 * hours. The cost ceiling and the loop guard bound it instead (#445).
 */
export const TURN_CONTINUATION_CAP = 3;
/** A job runs out of starts or time once and wakes on failing polls once, so those wakes have nothing to cap. */
export const continuationCountsAgainstCap = (cause: TurnContinuationCause): boolean =>
	cause !== "tool_budget" && cause !== "job_exhausted" && cause !== "job_deadline" && cause !== "polls_failing";
/** A command job that fails this many polls in a row wakes the turn waiting on it at yolo (#445). */
export const JOB_FAILED_POLL_WAKE = 5;
/** Wait before continuing a turn that failed, so a provider outage has time to clear (#445). */
const TURN_CONTINUATION_FAILURE_DELAYS_MS = [60_000, 300_000, 900_000] as const;
export function turnContinuationDelayMs(attempt: number, retryAfterMs?: number): number {
	const index = Math.min(Math.max(1, attempt), TURN_CONTINUATION_FAILURE_DELAYS_MS.length) - 1;
	// A stated wait is never cut short, or the continuation would go back to the provider before the time it named.
	return Math.max(TURN_CONTINUATION_FAILURE_DELAYS_MS[index] ?? 0, retryAfterMs ?? 0);
}
export type JobEndReason = "count" | "condition" | "stopped" | "canceled" | "deadline" | "failure";
export interface JobEvidence {
	outcome: "succeeded" | "failed" | "noop" | "canceled" | "timed_out" | "interrupted";
	summary: string;
	json: unknown;
	jsonComplete: boolean;
	/** Bounded runner return did not confirm owned process-group/pipe cleanup. */
	cleanupUnresolved: boolean;
	evidenceRefs: string[];
	costUsd: number | null;
	truncated: boolean;
	errorClass: "infrastructure" | "permission" | "execution" | null;
}
export interface JobOccurrence {
	id: string;
	scheduledAt: number;
	startedAt: number | null;
	endedAt: number | null;
	state: "pending" | "running" | "terminal";
	evidence: JobEvidence | null;
}
export interface JobDelivery {
	id: string;
	occurrenceId: string;
	kind: "notice" | "main_turn";
	state: "pending" | "running" | "delivered" | "dropped" | "failed";
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	reason: string | null;
	evidence: JobEvidence | null;
	/** Set when this delivery continues a stopped turn at yolo rather than following up on a match (#445). */
	continuation?: TurnContinuationCause;
}
export interface JobRecord {
	version: 1;
	id: string;
	revision: number;
	spec: JobSpec;
	specHash: string;
	owner: JobOwner;
	generation: number;
	process: { pid: number; birthToken: string | null; instanceId: string };
	createdAt: number;
	updatedAt: number;
	state: "active" | "paused" | "terminal";
	reason: JobEndReason | null;
	cancelRequested: boolean;
	nextDueAt: number | null;
	starts: number;
	settled: number;
	consecutiveFailures: number;
	pendingReason: string | null;
	active: JobOccurrence | null;
	pending: JobOccurrence | null;
	/** Bounded terminal history; starts/settled are lifetime counters. */
	history: JobOccurrence[];
	delivery: JobDelivery | null;
	/** Continuations this job spent against the cap at yolo; a tool budget crossing spends none (#445). Absent on older records and on a job it never hit. */
	clockResumes?: number;
	/** Command polls failed in a row. Absent on older records and on main jobs (#445). */
	failedPolls?: number;
	/** The one wake for failing polls was queued (#445). */
	pollFailureWoken?: true;
	/** Null when any executed component has unknown pricing/usage. */
	costUsd: number | null;
	persistenceError: string | null;
}
export type JobControlAction = "pause" | "resume" | "stop" | "cancel";
export interface JobChangedPayload {
	job: JobRecord;
	/** Recurrence may be terminal while analysis delivery still owns live work. */
	complete: boolean;
}

/** What a job's failing polls look like to a person: the streak and the last exit code when the record has one (#445). */
export function jobPollFailure(
	job: JobRecord,
): { count: number; exitCode: string | null; stderr: string | null } | null {
	const count = job.failedPolls ?? 0;
	if (count === 0) return null;
	const summary = job.history.at(-1)?.evidence?.summary ?? "";
	const exitCode = /"exitCode":(\d+)/u.exec(summary)?.[1] ?? null;
	const quoted = /"stderrHead":("(?:[^"\\]|\\.)*")/u.exec(summary)?.[1];
	let stderr: string | null = null;
	try {
		if (quoted !== undefined) stderr = JSON.parse(quoted) as string;
	} catch {
		/* A clipped summary has no readable stderr line. */
	}
	return { count, exitCode, stderr };
}
