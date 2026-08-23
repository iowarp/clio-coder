/**
 * Clio-specific events that ride the same NDJSON IPC channel as
 * pi-agent-core's `AgentEvent`. The worker subprocess emits these alongside
 * AgentEvents; the dispatch parent decodes the union and aggregates Clio
 * events without disturbing pi-agent-core consumers.
 */

import type { RunOutcomeCode } from "../domains/dispatch/types.js";
import type { ToolFinishEvent, ToolStartEvent } from "../tools/agent-tools.js";

export interface ClioToolStartEvent {
	type: "clio_tool_start";
	payload: ToolStartEvent;
}

export interface ClioToolFinishEvent {
	type: "clio_tool_finish";
	payload: ToolFinishEvent;
}

/** Emitted when the worker's non-stall policy resolves a permission-requiring tool call. */
export interface ClioPermissionResolvedEvent {
	type: "clio_permission_resolved";
	payload: {
		tool: string;
		actionClass: string;
		mode: "deny" | "fail" | "escalate";
		reason: string;
		/**
		 * Resolution provenance. Policy deny/fail uses "policy"; escalation
		 * resolutions distinguish operator decisions from timeout fallbacks.
		 * "remembered" answers an identical call with the operator's earlier
		 * decision from this run, without a new escalation.
		 */
		source?: "operator" | "timeout" | "policy" | "remembered";
		/** Approval request id this resolution answers. */
		requestId?: string;
		/** Resolved outcome for an escalation; escalate path only. */
		decision?: "approved" | "denied";
	};
}

/**
 * Emitted when an escalate-posture worker parks a permission-requiring tool
 * call and hands the decision up to the operator. The orchestrator republishes
 * it as a PermissionRequested bus event; an operator permission_decision line
 * on stdin (or the timeout fallback) resolves it.
 */
export interface ClioPermissionEscalatedEvent {
	type: "clio_permission_escalated";
	payload: {
		requestId: string;
		tool: string;
		summary: string;
		/**
		 * Sanitized one-line preview of the call's allowlisted object fields, so
		 * the operator's approval overlay can show what the call will touch.
		 * Unlisted fields carry only type-and-size summaries, and the args
		 * themselves never cross the stdout seam.
		 */
		target?: string;
		axis?: string;
		decision: {
			actionClass: string;
			reasons: ReadonlyArray<string>;
			reasonCode?: string;
			ruleId?: string;
			policySource?: string;
		};
		timeoutMs: number;
	};
}

/**
 * Emitted when the worker accepts an operator steer line from stdin and
 * queues it on the agent's steering queue. The steer text itself reaches the
 * transcript as a normal user message at the next loop boundary; this event
 * is the delivery ack for operator surfaces.
 */
export interface ClioSteerReceivedEvent {
	type: "clio_steer_received";
	payload: {
		chars: number;
		/** Exact parent-side steering provenance entry this acceptance closes. */
		sequence: number;
	};
}

/** Machine-readable terminal classification, emitted where the condition is known. */
export interface ClioRunOutcomeEvent {
	type: "clio_run_outcome";
	payload: { outcomeCode: RunOutcomeCode };
}

export type ClioWorkerEvent =
	| ClioToolStartEvent
	| ClioToolFinishEvent
	| ClioPermissionResolvedEvent
	| ClioPermissionEscalatedEvent
	| ClioSteerReceivedEvent
	| ClioRunOutcomeEvent;
