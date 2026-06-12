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
	LoopBlocked: "safety.loopBlocked",
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

/**
 * Payload published on {@link BusChannels.LoopBlocked} when the interactive
 * loop guard blocks a verbatim-repeated tool call before execution. The
 * interactive layer renders a warn notice per block and, when `interrupted`
 * is true, cancels the active turn with an error notice. The backend never
 * imports TUI code; this event is the only seam between them.
 */
export interface LoopBlockedPayload {
	tool: string;
	/** Identical-call observations inside the detector's sliding window. */
	repeatCount: number;
	/** Loop blocks accumulated in the current user turn, this one included. */
	blocksThisTurn: number;
	/** Per-turn block budget, carried so renderers never hardcode the threshold. */
	budget: number;
	/** True when the per-turn block budget is exhausted and the turn must stop. */
	interrupted: boolean;
	at: number;
	turnId?: string;
}

/**
 * Payload published on {@link BusChannels.BudgetAlert} when a dispatch enqueue
 * meets ("at") or crosses ("over") the session cost ceiling. Informational in
 * v0.x: scheduling never rejects the enqueue, so the interactive notice is the
 * operator's only signal.
 */
export interface BudgetAlertPayload {
	level: "at" | "over";
	currentUsd: number;
	ceilingUsd: number;
}

/**
 * Payload published on {@link BusChannels.SafetyBlocked} when the safety
 * policy engine blocks a tool call outright. The transcript already carries
 * the rejection text the model sees; this event carries the policy dimension
 * (which rule and action class fired, from which policy source).
 */
export interface SafetyBlockedPayload {
	tool: string;
	actionClass: string;
	ruleId?: string;
	posture?: string;
	rejection?: { short: string; detail: string; hints: ReadonlyArray<string> };
	policySource: string;
	reasonCode: string;
}

/** Where a {@link BusChannels.RunAborted} event originated. */
export type RunAbortSource = "dispatch_abort" | "dispatch_drain" | "stream_cancel";

/**
 * Payload published on {@link BusChannels.RunAborted}. Dispatch emits
 * dispatch_abort/dispatch_drain with run lineage; the chat loop emits
 * stream_cancel with a human-readable reason. Subscribers must not collapse
 * the sources: a drained dispatch run and a user-cancelled stream are
 * different operator situations.
 */
export interface RunAbortedPayload {
	source: RunAbortSource;
	runId: string | null;
	startedAt: string | null;
	elapsedMs: number | null;
	at?: number;
	reason?: string;
}

const RUN_ABORT_SOURCES: ReadonlySet<string> = new Set<RunAbortSource>([
	"dispatch_abort",
	"dispatch_drain",
	"stream_cancel",
]);

export function isRunAbortedPayload(value: unknown): value is RunAbortedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.source !== "string" || !RUN_ABORT_SOURCES.has(p.source)) return false;
	if (p.runId !== null && typeof p.runId !== "string") return false;
	if (p.startedAt !== null && typeof p.startedAt !== "string") return false;
	if (p.elapsedMs !== null && typeof p.elapsedMs !== "number") return false;
	if (p.reason !== undefined && typeof p.reason !== "string") return false;
	return true;
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
