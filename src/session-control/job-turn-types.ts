import type { FactSum } from "../core/telemetry/fact.js";
import type { PricingSum } from "../core/telemetry/pricing.js";
import type { TurnConstraints } from "../core/turn-constraints.js";

/** Controller-owned delivery, never an entry in the operator's editable queue (#411). */
export interface MachineTurnRequest {
	jobId: string;
	executionId: string;
	text: string;
	origin: string;
	/** The text is the operator's own (an operator-created loop's task), so the safety judge may read it. */
	operatorAuthored?: boolean;
	sessionId: string;
	isAdmissionCurrent(): boolean;
	signal: AbortSignal;
	constraints?: TurnConstraints;
	/** One transcript line the turn opens with, so an automatic continuation is never silent (#445). */
	notice?: string;
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
	/** The loop guard ended the turn; a job can continue it at yolo (#445). */
	stoppedBy?: "tool_budget" | "loop_guard";
	/** How long the provider asked to wait, when the turn failed on it (#445). */
	retryAfterMs?: number;
	/** The turn's tokens and cost over its calls, each a fact sum (#434). */
	usage?: { tokens: FactSum; cost: PricingSum };
}
