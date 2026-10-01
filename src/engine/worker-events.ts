/**
 * Clio-specific events that ride the same NDJSON IPC channel as
 * pi-agent-core's `AgentEvent`. The worker subprocess emits these alongside
 * AgentEvents; the dispatch parent decodes the union and aggregates Clio
 * events without disturbing pi-agent-core consumers.
 */

import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import type { StructuredHelperResult } from "../domains/agents/result-contract.js";
import type { RunOutcomeCode } from "../domains/dispatch/types.js";
import type { ToolFinishEvent, ToolStartEvent } from "../tools/agent-tools.js";

export interface ClioToolStartEvent {
	type: "clio_coder_tool_start";
	payload: ToolStartEvent;
}

export interface ClioToolFinishEvent {
	type: "clio_coder_tool_finish";
	payload: ToolFinishEvent;
}

/** Emitted when the worker's non-stall policy resolves a permission-requiring tool call. */
export interface ClioPermissionResolvedEvent {
	type: "clio_coder_permission_resolved";
	payload: {
		tool: string;
		actionClass: string;
		mode: "deny" | "fail" | "escalate";
		reason: string;
		/**
		 * Resolution provenance. Policy deny/fail uses "policy"; escalation
		 * resolutions distinguish operator decisions from timeout fallbacks.
		 * "remembered" answers an identical call with an earlier denial from
		 * this run, without a new escalation; approvals are never remembered.
		 * "main" is a main-agent grant decision (Phase D); "binding" denies a
		 * decision whose attempt, request or argument digest did not match.
		 */
		source?: "operator" | "timeout" | "policy" | "remembered" | "main" | "binding";
		/** Approval request id this resolution answers. */
		requestId?: string;
		/** Resolved outcome for an escalation; escalate path only. */
		decision?: "approved" | "denied";
		/** Who may discharge this ask; present on main-routed asks. */
		authority?: "main" | "operator";
	};
}

/**
 * Execution of a call a live grant released (Phase D). The decision frame
 * says who approved; this says whether the call ran. A worker that dies
 * between `start` and `end` leaves the outcome unknown to the host.
 */
export interface ClioPermissionGrantExecutionEvent {
	type: "clio_coder_permission_grant_execution";
	payload: {
		requestId: string;
		tool: string;
		phase: "start" | "end" | "not_executed";
		outcome?: "ok" | "error" | "blocked";
		detail?: string;
	};
}

/**
 * Emitted when an escalate-posture worker parks a permission-requiring tool
 * call and hands the decision up to the operator. The orchestrator republishes
 * it as a PermissionRequested bus event; an operator permission_decision line
 * on stdin (or the timeout fallback) resolves it.
 */
export interface ClioPermissionEscalatedEvent {
	type: "clio_coder_permission_escalated";
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
		/**
		 * What a bash command would do, one sentence per step, composed in the
		 * worker from the full command. The bounded `target` is flattened and cut,
		 * so the host never rebuilds this from it.
		 */
		consequence?: ReadonlyArray<string>;
		axis?: string;
		decision: {
			actionClass: string;
			reasons: ReadonlyArray<string>;
			reasonCode?: string;
			ruleId?: string;
			policySource?: string;
		};
		timeoutMs: number;
		/**
		 * Who may discharge this ask. Present on main-routed asks: `main` for an
		 * ordinary autonomy ask the main agent may grant, `operator` for a rail
		 * only a person clears.
		 */
		authority?: "main" | "operator";
		/** sha256 over the parked call's effect descriptor; a grant must name it. */
		argDigest?: string;
	};
}

/**
 * Emitted when the worker accepts an operator steer line from stdin and
 * queues it on the agent's steering queue. The steer text itself reaches the
 * transcript as a normal user message at the next loop boundary; this event
 * is the delivery ack for operator surfaces.
 */
export interface ClioSteerReceivedEvent {
	type: "clio_coder_steer_received";
	payload: {
		chars: number;
		/** Exact parent-side steering provenance entry this acceptance closes. */
		sequence: number;
	};
}

/** Machine-readable terminal classification, emitted where the condition is known. */
export interface ClioRunOutcomeEvent {
	type: "clio_coder_run_outcome";
	/**
	 * `detail` says why, where the worker knows more than its exit code. The
	 * parent bounds and redacts it before it reaches the receipt.
	 */
	payload: { outcomeCode: RunOutcomeCode; detail?: string };
}

/**
 * The run's information-flow restrictions after a read added to them: the
 * inherited set plus what this worker read. The parent absorbs the latest
 * into its own ledger before the result is shown or injected, and seals it
 * in the receipt so a background or resumed collection carries it too.
 */
export interface ClioFlowRestrictionsEvent {
	type: "clio_coder_flow_restrictions";
	payload: { set: FlowRestrictionSet };
}

/** Emitted only after the host validates an internal helper's terminal object. */
export interface ClioHelperResultEvent {
	type: "clio_coder_helper_result";
	payload: StructuredHelperResult;
}

export type ClioWorkerEvent =
	| ClioToolStartEvent
	| ClioToolFinishEvent
	| ClioPermissionResolvedEvent
	| ClioPermissionEscalatedEvent
	| ClioPermissionGrantExecutionEvent
	| ClioSteerReceivedEvent
	| ClioRunOutcomeEvent
	| ClioFlowRestrictionsEvent
	| ClioHelperResultEvent;
