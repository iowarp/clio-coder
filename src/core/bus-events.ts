/**
 * Canonical channel names for the Clio event bus.
 *
 * Add new channels here. Downstream code imports from this file rather than
 * hard-coding string literals so renames are a single edit and typos fail fast.
 */

export const BusChannels = {
	SessionStart: "session.start",
	SessionEnd: "session.end",
	SessionParked: "session.parked",
	SessionResumed: "session.resumed",
	DomainLoaded: "domain.loaded",
	DomainFailed: "domain.failed",
	ConfigHotReload: "config.hotReload",
	ConfigNextTurn: "config.nextTurn",
	ConfigRestartRequired: "config.restartRequired",
	PermissionRequested: "permission.requested",
	PermissionResolved: "permission.resolved",
	SafetyClassified: "safety.classified",
	SafetyBlocked: "safety.blocked",
	SafetyAllowed: "safety.allowed",
	ProviderHealth: "provider.health",
	DispatchEnqueued: "dispatch.enqueued",
	DispatchStarted: "dispatch.started",
	DispatchProgress: "dispatch.progress",
	DispatchCompleted: "dispatch.completed",
	DispatchFailed: "dispatch.failed",
	CompactionBegin: "compaction.begin",
	CompactionEnd: "compaction.end",
	ContextActivity: "context.activity",
	ContextWarning: "context.warning",
	ContextPruned: "context.pruned",
	AgentStatusChanged: "agent.status.changed",
	RunAborted: "run.aborted",
	BudgetAlert: "budget.alert",
	ShutdownRequested: "shutdown.requested",
	ShutdownDrained: "shutdown.drained",
	ShutdownTerminated: "shutdown.terminated",
	ShutdownPersisted: "shutdown.persisted",
} as const;

export type BusChannel = (typeof BusChannels)[keyof typeof BusChannels];

/**
 * Window-resolution warning published on {@link BusChannels.ContextWarning}.
 * Emitted on transitions only: `warning` carries the text when a warning
 * appears or changes, and `null` when a prior warning clears.
 */
export interface ContextWarningPayload {
	warning: string | null;
}

export type ContextActivityKind = "context-init" | "context-clear" | "context-prime" | "context-handoff" | "compaction";
export type ContextActivityPhase = "scan" | "codewiki" | "generate" | "clio-md" | "state" | "handoff" | "done";
export type ContextActivityStatus = "started" | "running" | "completed" | "failed";

/** Structured progress for context operations. Interactive renders this as a live context island. */
export interface ContextActivityPayload {
	kind: ContextActivityKind;
	phase: ContextActivityPhase;
	status: ContextActivityStatus;
	message: string;
	at: number;
	current?: number;
	total?: number;
	detail?: string;
}

/** Payload published on {@link BusChannels.ContextPruned} after compaction reclaims tokens. */
export interface ContextPrunedPayload {
	stage: "mask_observations" | "llm_summary";
	tokensBefore: number;
	tokensAfter: number;
	trigger: string;
	snapshotIdBefore: string | null;
	snapshotIdAfter: string;
	at: number;
	/** Used/window ratio at trigger time; mask stage only. */
	pressure?: number | null;
	maskedObservations?: number;
}
