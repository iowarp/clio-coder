import type { TurnConstraints } from "./turn-constraints.js";

/** Host identity; generation changes on navigation, never on ordinary turns (#411). */
export interface JobOwner {
	readonly sessionId: string;
	readonly cwd: string;
	readonly generation: string;
}
export type JobRunner =
	| { readonly kind: "command"; readonly argv: readonly string[]; readonly executableSha256?: string }
	| { readonly kind: "main"; readonly prompt: string };
export interface JobPredicate {
	readonly path: readonly string[];
	readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "exists";
	readonly value?: string | number | boolean | null;
}
export type JobMatchAction = { readonly kind: "notice" } | { readonly kind: "main_turn"; readonly prompt: string };
export interface JobCreateInput {
	readonly intervalMs: number;
	readonly runner: JobRunner;
	readonly count?: number;
	readonly deadlineAt?: number;
	readonly timeoutMs?: number;
	readonly until?: JobPredicate;
	readonly onMatch?: JobMatchAction;
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
	readonly until: JobPredicate | null;
	readonly onMatch: JobMatchAction;
	readonly constraints: TurnConstraints | null;
	readonly originTurnId: string | null;
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
