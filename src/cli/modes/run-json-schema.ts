/**
 * The `clio-coder run --json` wire schema.
 *
 * Every stdout line of a `--json` run is one compact JSON object matching
 * `RunJsonFrame`. The first line is the `session` header, which carries
 * `schemaVersion` so a consumer can refuse a stream it was not written for.
 * This module holds types and the version constant only, so any surface can
 * import it without pulling the chat loop or a renderer into its graph.
 *
 * Bump `RUN_JSON_SCHEMA_VERSION` when a frame loses a field, a field changes
 * meaning or type, or a frame type is removed. Adding an optional field or a
 * new frame type does not bump it: consumers ignore what they do not know.
 */

import type { DispatchScopeNoticeView } from "../../core/dispatch-scope-notice.js";
import type { RunReceipt } from "../../domains/dispatch/types.js";
import type { AgentMessage } from "../../engine/types.js";
import type { ChatLoopEvent } from "../../session-control/chat-loop.js";
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

export interface RunJsonSegmentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	apiCalls: number;
	/** False when the provider reported no usage or the numbers are an estimate. */
	measured: boolean;
	estimated?: true;
}

/** One agent segment's account, in place of a second copy of its messages. */
export interface RunJsonAgentEndFrame {
	type: "agent_end";
	messageCount: number;
	usage: RunJsonSegmentUsage;
}

/** The streamed `turn_end` of `--json-events full`, carrying the final answer text. */
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
 * `queued_user_turn`, `notice`, `agent_status`, `tool_approval_state` and
 * `speculative_dispatch`.
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

/** Synthesized by `--json-events terminal`; the streamed `turn_start` has no `startedAt`. */
export interface RunJsonTerminalTurnStartFrame {
	type: "turn_start";
	startedAt: string;
}

/**
 * Synthesized by `--json-events terminal` as the last frame. It shares its
 * `type` with the streamed `turn_end` but the two never share a stream: the
 * terminal mode withholds the streamed one. `exitCode` tells them apart.
 */
export interface RunJsonTerminalTurnEndFrame {
	type: "turn_end";
	startedAt: string;
	endedAt: string;
	exitCode: number;
	text: string;
	error?: string;
}

export interface RunJsonDispatchScopeNoticeFrame extends DispatchScopeNoticeView {
	type: "dispatch_scope_notice";
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

/** The sealed receipt, always the last frame of a `run --agent --json` stream. */
export interface RunJsonReceiptFrame {
	type: "receipt";
	receipt: RunReceipt;
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** Frames of a main-agent `run --json` stream. */
export type RunJsonMainFrame =
	| RunJsonMainSessionFrame
	| RunJsonPendingMainSessionFrame
	| RunJsonChatLoopFrame
	| RunJsonTerminalTurnStartFrame
	| RunJsonTerminalTurnEndFrame
	| RunJsonDispatchScopeNoticeFrame
	| RunJsonDispatchSettlementFrame;

/**
 * Frames of a `run --agent --json` stream. `RunJsonWorkerEventFrame` is open,
 * so narrow on the closed members first (`session`, `dispatch_scope_notice`,
 * `receipt`) and treat the rest as worker events.
 */
export type RunJsonAgentFrame =
	| RunJsonAgentSessionFrame
	| RunJsonDispatchScopeNoticeFrame
	| RunJsonWorkerEventFrame
	| RunJsonWorkerAgentEndFrame
	| RunJsonOpaqueWorkerEventFrame
	| RunJsonReceiptFrame;

export type RunJsonFrame = RunJsonMainFrame | RunJsonAgentFrame;
