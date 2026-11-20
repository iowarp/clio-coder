import type { ToolRoundRecord } from "../../engine/types.js";

/**
 * The headless run's internal JSON frame schema (v1).
 *
 * `run --json` and `--json-events` were removed in 0.8.5: these frames are no longer a public stream. A run under
 * `--output-format json|stream-json` writes them underneath and the schema v2 writer (`run-failure.ts`) reframes
 * them; `run --agent` and the arena read the same shapes. Every line is one compact JSON object matching
 * `RunJsonFrame`; the first is the `session` header, which carries `schemaVersion`.
 * This module holds types and the version constant only, so any surface can
 * import it without pulling the chat loop or a renderer into its graph.
 *
 * Bump `RUN_JSON_SCHEMA_VERSION` when a frame loses a field, a field changes
 * meaning or type, or a frame type is removed. Adding an optional field or a
 * new frame type does not bump it: consumers ignore what they do not know.
 */

import type { DispatchScopeNoticeView } from "../../core/dispatch-scope-notice.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import type { PricingSum } from "../../core/telemetry/pricing.js";
import type { RunResult } from "../../domains/dispatch/types.js";
import type { AutonomyReport } from "../../domains/safety/autonomy-window.js";
import type { AgentMessage } from "../../engine/types.js";
import type { ChatLoopEvent, StepPipelineEnd } from "../../session-control/chat-loop.js";
import type { VIA_GATEWAY } from "../../tools/gateway-display.js";

export const RUN_JSON_SCHEMA_VERSION = 1;

type LoopEvent<T extends ChatLoopEvent["type"]> = Extract<ChatLoopEvent, { type: T }>;

// ---------------------------------------------------------------------------
// Session header (both modes)
// ---------------------------------------------------------------------------

/**
 * Header of a main-agent run. `version` is the session ledger format, not the
 * stream schema. The route fields are absent when the header is written before
 * session metadata exists.
 */
export interface RunJsonMainSessionFrame {
	type: "session";
	schemaVersion: typeof RUN_JSON_SCHEMA_VERSION;
	mode: "main";
	id: string;
	timestamp: string;
	cwd: string;
	version?: number;
	target?: string | null;
	model?: string | null;
	clioCoderVersion?: string;
}

/**
 * Header of a `run --agent` dispatch. `runId` is absent only when a scope
 * notice forces the header out before admission returns the run.
 */
export interface RunJsonAgentSessionFrame {
	type: "session";
	schemaVersion: typeof RUN_JSON_SCHEMA_VERSION;
	mode: "agent";
	agentId: string;
	timestamp: string;
	cwd: string;
	clioCoderVersion: string;
	runId?: string;
}

/** Admission notices from a run that never created a durable session. */
export interface RunJsonPendingMainSessionFrame {
	type: "session";
	schemaVersion: typeof RUN_JSON_SCHEMA_VERSION;
	mode: "main";
	id: null;
	pending: true;
	timestamp: string;
	cwd: string;
}

export type RunJsonSessionFrame = RunJsonMainSessionFrame | RunJsonPendingMainSessionFrame | RunJsonAgentSessionFrame;

// ---------------------------------------------------------------------------
// Projected chat-loop events (main agent)
// ---------------------------------------------------------------------------

/** An assistant `text` block the deltas already carried. `text` is present only on `turn_end`. */
export interface RunJsonStreamedTextBlock {
	type: "text";
	streamed: true;
	textLength: number;
	text?: string;
	[key: string]: unknown;
}

/** An assistant `thinking` block the deltas already carried; its content never repeats. */
export interface RunJsonStreamedThinkingBlock {
	type: "thinking";
	streamed: true;
	thinkingLength: number;
	[key: string]: unknown;
}

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

export type RunJsonAssistantMessage = Omit<AssistantMessage, "content"> & {
	toolRounds?: ToolRoundRecord[];
	content: Array<
		| RunJsonStreamedTextBlock
		| RunJsonStreamedThinkingBlock
		| Exclude<AssistantContentBlock, { type: "text" | "thinking" }>
	>;
};

/** A message as the stream carries it: assistant content slimmed, every other role whole. */
export type RunJsonMessage = Exclude<AgentMessage, { role: "assistant" }> | RunJsonAssistantMessage;

/** Present on a tool frame whose capability ran behind the gateway. */
interface GatewayMark {
	via?: typeof VIA_GATEWAY;
	/** Set on the start/end pair synthesized for one settled chain step. */
	parentToolCallId?: string;
}

export type RunJsonToolExecutionStartFrame = LoopEvent<"tool_execution_start"> & GatewayMark;
export type RunJsonToolExecutionUpdateFrame = LoopEvent<"tool_execution_update"> & GatewayMark;
export type RunJsonToolExecutionEndFrame = LoopEvent<"tool_execution_end"> &
	GatewayMark & {
		/** Admission facts, present only on a chain step's end frame. */
		outcome?: "ok" | "error" | "blocked";
		actionClass?: string;
		decision?: string;
		blockReason?: string;
		bindingError?: string;
		/** The output limit cut off the reply that made this call, so it never ran; its error result is no tool error. */
		notRun?: "output_limit";
	};

export interface RunJsonTextDeltaFrame {
	type: "text_delta";
	contentIndex: number;
	delta: string;
}

export interface RunJsonThinkingDeltaFrame {
	type: "thinking_delta";
	contentIndex: number;
	delta: string;
}

export type RunJsonMessageEndFrame = Omit<LoopEvent<"message_end">, "message"> & { message: RunJsonMessage };

/** One agent segment's usage over its calls, one fact sum per quantity (#434); never a zero for a call that said nothing. */
export interface RunJsonSegmentUsage {
	input: FactSum;
	output: FactSum;
	cacheRead: FactSum;
	cacheWrite: FactSum;
	reasoning: FactSum;
	totalTokens: FactSum;
	cost: PricingSum;
	/** Calls that reached a provider. */
	apiCalls: number;
}

/** One agent segment's account, in place of a second copy of its messages. */
export interface RunJsonAgentEndFrame {
	type: "agent_end";
	messageCount: number;
	usage: RunJsonSegmentUsage;
}

/** The streamed `turn_end` of a full JSON stream, carrying the final answer text. */
export interface RunJsonTurnEndFrame {
	type: "turn_end";
	message: RunJsonMessage;
}

export type RunJsonNoticeFrame = LoopEvent<"notice">;

/** Chat-loop events the projection rewrites or drops; every other event crosses unchanged. */
type ProjectedLoopEventType =
	| "message_update"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "text_delta"
	| "thinking_delta"
	| "message_end"
	| "agent_end"
	| "turn_end";

/**
 * Chat-loop events that cross unchanged: `agent_start`, `turn_start`,
 * `message_start`, `text_frame`, `retry_status`, `queue_update`,
 * `queued_user_turn`, `notice`, `agent_status` and `tool_approval_state`.
 */
export type RunJsonPassThroughFrame = Exclude<ChatLoopEvent, { type: ProjectedLoopEventType }>;

/** Everything `projectHeadlessJsonEvent` can return for one chat-loop event. */
export type RunJsonChatLoopFrame =
	| RunJsonToolExecutionStartFrame
	| RunJsonToolExecutionUpdateFrame
	| RunJsonToolExecutionEndFrame
	| RunJsonTextDeltaFrame
	| RunJsonThinkingDeltaFrame
	| RunJsonMessageEndFrame
	| RunJsonAgentEndFrame
	| RunJsonTurnEndFrame
	| RunJsonPassThroughFrame;

// ---------------------------------------------------------------------------
// Frames the headless driver builds itself (main agent)
// ---------------------------------------------------------------------------

/**
 * The host's verdict on a full JSON stream, always its last line (S-51). The model's own `turn_end` and `agent_end`
 * say how the model stopped; this says whether the run succeeded. The schema v2 writer reads it and withholds it.
 */
export interface RunJsonRunEndFrame {
	type: "run_end";
	startedAt: string;
	endedAt: string;
	exitCode: number;
	error?: string;
	outcome: RunResult["outcome"];
	outcomeDetail?: string;
	/** The run's safety summary; a `permissionRequired` attempt needed an approval the run could not give. */
	safety?: Pick<
		NonNullable<RunResult["safety"]>,
		"decisions" | "blockedAttempts" | "blockedAttemptsTruncated" | "guardBlockedAttempts" | "permissionRequestedAttempts"
	>;
	stepPipeline?: StepPipelineEnd;
}

/** One `run --verify` check, run with bash in the run's cwd once the turn settled. */
export interface RunJsonVerifyResult {
	/** `run-acceptance`, then `run-acceptance-2` and on, in flag order. */
	id: string;
	command: string;
	/** Null when the shell ended by a signal, a timeout among them, or never started. */
	exitCode: number | null;
	passed: boolean;
	durationMs: number;
	timedOut: boolean;
	/** The agent itself ran this check after its last edit, so the finish gate counted it. */
	ranAfterLastEdit: boolean;
}

/** The `run --verify` results a full JSON stream ends with. */
export interface RunJsonVerifyFrame {
	type: "verify";
	checks: RunJsonVerifyResult[];
}

/** The yolo audit a JSON stream ends with: the window, its halt and the calls left for the operator. */
export interface RunJsonAutonomyFrame extends AutonomyReport {
	type: "autonomy";
}

export interface RunJsonDispatchScopeNoticeFrame extends DispatchScopeNoticeView {
	type: "dispatch_scope_notice";
}

/** A `run --agent --json` dispatch that admission refused before any worker started; no model was called. */
export interface RunJsonAdmissionRefusedFrame {
	type: "admission_refused";
	agentId: string;
	message: string;
	exitCode: number;
}

export interface RunJsonDispatchedRunOutcome {
	runId: string;
	agentId: string;
	outcome: string | null;
	outcomeCode: string | null;
	outcomeDetail: string | null;
}

/** Detached workers the turn left behind: still live at exit, or settled with no delivery. */
export interface RunJsonDispatchSettlementFrame {
	type: "dispatch_settlement";
	live: RunJsonDispatchedRunOutcome[];
	undelivered: RunJsonDispatchedRunOutcome[];
}

// ---------------------------------------------------------------------------
// `run --agent` frames
// ---------------------------------------------------------------------------

/**
 * A worker event passed through as the worker published it. The worker's event
 * shapes belong to the Pi SDK and the worker runtime, so this stream promises
 * only an object with a string `type`.
 */
export interface RunJsonWorkerEventFrame {
	type: string;
	[key: string]: unknown;
}

/** A worker `agent_end` with its transcript replaced by the segment account. */
export interface RunJsonWorkerAgentEndFrame extends RunJsonAgentEndFrame {
	[key: string]: unknown;
}

/** A worker event that is not an object with a string `type`, wrapped so the line stays a frame. */
export interface RunJsonOpaqueWorkerEventFrame {
	type: "worker_event";
	event: unknown;
}

/** The dispatched run's result, always the last frame of a `run --agent --json` stream. */
export interface RunJsonResultFrame {
	/** Display-only reference relative to the Clio state root; outside the run's settled record. */
	recording?: import("../../domains/dispatch/index.js").RecordingReference;
	type: "result";
	result: RunResult;
	/** A verifier report's own verdict; `fail` makes the process exit 1 though the run succeeded. */
	verdict?: string;
	/** The verifier's checks that ran and failed, as `name: evidence`. */
	failedChecks?: string[];
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** Frames of a main-agent JSON stream, which the schema v2 writer reframes. */
export type RunJsonMainFrame =
	| RunJsonMainSessionFrame
	| RunJsonPendingMainSessionFrame
	| RunJsonChatLoopFrame
	| RunJsonRunEndFrame
	| RunJsonDispatchScopeNoticeFrame
	| RunJsonDispatchSettlementFrame
	| RunJsonAutonomyFrame
	| RunJsonVerifyFrame;

/**
 * Frames of a `run --agent --json` stream. `RunJsonWorkerEventFrame` is open,
 * so narrow on the closed members first (`session`, `dispatch_scope_notice`,
 * `result`) and treat the rest as worker events.
 */
export type RunJsonAgentFrame =
	| RunJsonAgentSessionFrame
	| RunJsonDispatchScopeNoticeFrame
	| RunJsonAdmissionRefusedFrame
	| RunJsonWorkerEventFrame
	| RunJsonWorkerAgentEndFrame
	| RunJsonOpaqueWorkerEventFrame
	| RunJsonResultFrame;

export type RunJsonFrame = RunJsonMainFrame | RunJsonAgentFrame;
