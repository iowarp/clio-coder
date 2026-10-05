import type { TurnConstraints } from "../core/turn-constraints.js";

/** Controller-owned delivery, never an entry in the operator's editable queue (#411). */
export interface MachineTurnRequest {
	jobId: string;
	executionId: string;
	text: string;
	origin: string;
	sessionId: string;
	isAdmissionCurrent(): boolean;
	signal: AbortSignal;
	constraints?: TurnConstraints;
	onStarting(): boolean;
}

/** Presentation lease only; the ordinary machine turn retains execution and cancellation authority (#411). */
export interface MachineTurnProjectionRequest
	extends Pick<MachineTurnRequest, "jobId" | "executionId" | "text" | "origin" | "sessionId" | "signal"> {
	cwd: string;
}

export type MachineTurnProjectionAdmission =
	| { status: "ready"; release(): void }
	| { status: "deferred"; reason: string };

export interface MachineTurnProjectionHost {
	acquire(request: MachineTurnProjectionRequest): MachineTurnProjectionAdmission;
}

export interface MachineTurnResult {
	status: "refused" | "succeeded" | "failed" | "canceled";
	turnId: string | null;
	reason?: string;
	text?: string;
	usage?: { tokens: number; costUsd: number | null };
}
