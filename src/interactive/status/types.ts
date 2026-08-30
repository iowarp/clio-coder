import type { StatusPhase, WatchdogTier } from "../../core/bus-events.js";
import type { ResponseModelIdObservation } from "../../core/response-model-id.js";

// StatusPhase, WatchdogTier, and AgentStatusChangedPayload moved to
// src/core/bus-events.ts (the phase taxonomy rides the agent.status.changed
// bus channel into the safety domain); re-exported here so interactive code
// keeps one import site.
export type { AgentStatusChangedPayload, StatusPhase, WatchdogTier } from "../../core/bus-events.js";

export type ActiveStatusPhase = Exclude<StatusPhase, "idle" | "ended">;
export type OverlayPhase = "tool_blocked" | "retrying" | "compacting" | "dispatching" | "stuck";
export type TurnStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "cancelled";
export type ReasoningTokenProvenance = "provider" | "estimated" | "mixed";

export interface RetryOverlay {
	attempt: number;
	maxAttempts: number;
	waitMs: number;
}

export interface ToolOverlay {
	toolName: string;
	toolPreview: string;
}

export interface DispatchOverlay {
	agentName: string;
}

export interface TurnSummary {
	elapsedMs: number;
	modelId: string;
	/** Direct response model-id observation for the last API call in the turn. */
	responseModelIdObservation: ResponseModelIdObservation;
	targetId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens?: number | undefined;
	/** Whether the reasoning total is provider-reported, estimated from text, or mixed. */
	reasoningTokenProvenance?: ReasoningTokenProvenance | undefined;
	toolCount: number;
	toolErrorCount: number;
	stopReason: TurnStopReason;
	/**
	 * Human-readable cancel/abort provenance, e.g. "dispatch drain" vs
	 * "stream cancel: user cancelled stream". Present only when the run ended
	 * through run.aborted or a forced cancel; distinguishes abort sources that
	 * share stopReason "cancelled".
	 */
	stopDetail?: string | undefined;
	watchdogPeak: WatchdogTier;
	truncated: boolean;
}

/**
 * Usage folded in as the run's messages settle, so a run that never reaches
 * `agent_end` can still report what it spent.
 *
 * The engine replaces an aborted run's message window with one synthetic
 * zero-usage failure message, and the cancel path built its summary from
 * nothing at all. A cancelled turn therefore reported no tokens and no tool
 * calls even when the session total moved by 64k in the same footer line.
 */
export interface RunTally {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	hadProviderReasoning: boolean;
	hadEstimatedReasoning: boolean;
	toolCount: number;
	toolErrorCount: number;
	/** Direct response model-id observation for the last assistant call folded. */
	responseModelIdObservation: ResponseModelIdObservation;
}

export interface OverlayFrame {
	phase: OverlayPhase;
	resumePhase: StatusPhase;
	retry?: RetryOverlay | undefined;
	tool?: ToolOverlay | undefined;
	dispatch?: DispatchOverlay | undefined;
}

export interface AgentStatus {
	phase: StatusPhase;
	since: number;
	lastMeaningfulAt: number;
	watchdogTier: WatchdogTier;
	watchdogPeak: WatchdogTier;
	localRuntime: boolean;
	runId?: string | null | undefined;
	resumePhase?: StatusPhase | undefined;
	activePhases?: ReadonlySet<OverlayPhase> | undefined;
	overlayStack?: OverlayFrame[] | undefined;
	tool?: ToolOverlay | undefined;
	/**
	 * Wall-clock start of the tool call the `tool_running` phase is showing, so
	 * the footer's `running tool · Ns` reads the call's OWN elapsed rather than
	 * time-since-turn-start. Set on `tool_execution_start`, cleared when the
	 * phase leaves `tool_running`.
	 */
	toolStartedAt?: number | undefined;
	retry?: RetryOverlay | undefined;
	dispatch?: DispatchOverlay | undefined;
	/**
	 * Set while the `preparing` phase belongs to a consumed prompt that has not
	 * yet been admitted, rather than to a run the engine has started. It is what
	 * lets `agent_start` take over a window this opened instead of treating an
	 * already-active phase as a duplicate start (issue #251).
	 */
	preparingSubmission?: boolean | undefined;
	summary?: TurnSummary | undefined;
	/** Usage settled so far in the active run. Reset by `agent_start`. */
	runTally?: RunTally | undefined;
}

export interface AgentStatusEvent {
	type: "agent_status";
	status: AgentStatus;
}

export const INITIAL_STATUS: AgentStatus = {
	phase: "idle",
	since: 0,
	lastMeaningfulAt: 0,
	watchdogTier: 0,
	watchdogPeak: 0,
	localRuntime: false,
};
