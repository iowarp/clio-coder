import type { StatusPhase, WatchdogTier } from "../../core/bus-events.js";

// StatusPhase, WatchdogTier, and AgentStatusChangedPayload moved to
// src/core/bus-events.ts (the phase taxonomy rides the agent.status.changed
// bus channel into the safety domain); re-exported here so interactive code
// keeps one import site.
export type { AgentStatusChangedPayload, StatusPhase, WatchdogTier } from "../../core/bus-events.js";

export type ActiveStatusPhase = Exclude<StatusPhase, "idle" | "ended">;
export type OverlayPhase = "tool_blocked" | "retrying" | "compacting" | "dispatching" | "stuck";
export type TurnStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "cancelled";

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
	endpointId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens?: number | undefined;
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
	retry?: RetryOverlay | undefined;
	dispatch?: DispatchOverlay | undefined;
	summary?: TurnSummary | undefined;
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
