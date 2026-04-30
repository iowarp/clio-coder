export type StatusPhase =
	| "idle"
	| "preparing"
	| "thinking"
	| "writing"
	| "tool_running"
	| "tool_blocked"
	| "retrying"
	| "compacting"
	| "dispatching"
	| "stuck"
	| "ended";

export type ActiveStatusPhase = Exclude<StatusPhase, "idle" | "ended">;
export type OverlayPhase = "tool_blocked" | "retrying" | "compacting" | "dispatching" | "stuck";
export type WatchdogTier = 0 | 1 | 2 | 3 | 4;
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

export interface AgentStatusChangedPayload {
	runId: string | null;
	phase: StatusPhase;
	prevPhase: StatusPhase;
	at: number;
	elapsedFromStart: number;
	watchdogTier: WatchdogTier;
	metadata?: { toolName?: string; attempt?: number; reason?: string; agentName?: string } | undefined;
}

export const INITIAL_STATUS: AgentStatus = {
	phase: "idle",
	since: 0,
	lastMeaningfulAt: 0,
	watchdogTier: 0,
	watchdogPeak: 0,
	localRuntime: false,
};
