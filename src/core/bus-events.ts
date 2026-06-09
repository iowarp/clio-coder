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
export interface ContextWindowWarningPayload {
	warning: string | null;
}

/**
 * Pressure-stage warning published on {@link BusChannels.ContextWarning} when
 * the context engine crosses the warning threshold but takes no action yet.
 */
export interface ContextPressureWarningPayload {
	stage: "warning";
	/** Used/window ratio (0..1); null when the window is unknown. */
	pressure: number | null;
	trigger: string;
	at: number;
}

export type ContextWarningPayload = ContextWindowWarningPayload | ContextPressureWarningPayload;

/** Payload published on {@link BusChannels.ContextPruned} after any compaction stage reclaims tokens. */
export interface ContextPrunedPayload {
	stage: string;
	tokensBefore: number;
	tokensAfter: number;
	trigger: string;
	snapshotIdBefore: string | null;
	snapshotIdAfter: string;
	at: number;
	/** Used/window ratio at trigger time; progressive stages only. */
	pressure?: number | null;
	maskedObservations?: number;
	prunedObservations?: number;
	maskedDialogue?: number;
}
