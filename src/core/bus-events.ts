/**
 * Canonical channel names and payload contracts for the Clio event bus.
 *
 * Add new channels here. Downstream code imports from this file rather than
 * hard-coding string literals so renames are a single edit and typos fail fast.
 *
 * Every channel has a payload type registered in {@link BusPayloadMap}; the
 * shared bus types `emit`/`on` against that map, so payload drift between an
 * emitter and this file is a compile error. The types describe what in-process
 * emitters send; the bus performs no runtime validation, so subscribers that
 * consume data which crossed a process boundary (worker/ACP event streams)
 * must keep validating at runtime.
 */

import type { AgentAudience } from "../domains/agents/spec.js";
import type { ConfigDiff } from "../domains/config/classify.js";
import type {
	DispatchRequestOrigin,
	RunKind,
	RunLineage,
	RunOutcome,
	ToolActivitySummary,
} from "../domains/dispatch/types.js";
import type { MiddlewareHook } from "../domains/middleware/types.js";
import type { TargetStatus } from "../domains/providers/contract.js";
import type { ClioSettings } from "./config.js";
import type { TerminationPhase } from "./termination.js";

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
	MiddlewareHookFailed: "middleware.hookFailed",
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
	ruleId?: string | undefined;
	posture?: string | undefined;
	rejection?: { short: string; detail: string; hints: ReadonlyArray<string> } | undefined;
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
	/** Thinking blocks stripped from stale assistant messages; mask stage only. */
	maskedThinkingBlocks?: number;
	maskedThinkingChars?: number;
}

// ---------------------------------------------------------------------------
// Session and domain lifecycle
// ---------------------------------------------------------------------------

/** Published on {@link BusChannels.SessionStart} once the orchestrator boots. */
export interface SessionStartPayload {
	at: number;
}

/** Published on {@link BusChannels.SessionEnd} just before process.exit. */
export interface SessionEndPayload {
	exitCode: number;
}

export type SessionParkReason = "create_new" | "resume_other" | "fork" | "switch_branch" | "close" | "shutdown";
export type SessionResumeVia = "resume" | "switch_branch";

/** Published on {@link BusChannels.SessionParked} when the current session is replaced or closed. */
export interface SessionParkedPayload {
	sessionId: string;
	reason: SessionParkReason;
	at: number;
}

/** Published on {@link BusChannels.SessionResumed} when an existing session is reopened. */
export interface SessionResumedPayload {
	sessionId: string;
	via: SessionResumeVia;
	at: number;
}

/** Published on {@link BusChannels.DomainLoaded} per successfully started domain. */
export interface DomainLoadedPayload {
	name: string;
}

/** Published on {@link BusChannels.DomainFailed} right before the loader throws. */
export interface DomainFailedPayload {
	name: string;
	/** The caught value as-is; loaders catch unknown and rethrow after emitting. */
	error: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Published on {@link BusChannels.ConfigHotReload}, {@link BusChannels.ConfigNextTurn},
 * and {@link BusChannels.ConfigRestartRequired}. One shape for all three: the
 * channel encodes the change class, the diff says which paths moved, and
 * `settings` is the freshly validated snapshot.
 */
export interface ConfigChangePayload {
	diff: ConfigDiff;
	settings: Readonly<ClioSettings>;
}

// ---------------------------------------------------------------------------
// Safety and permissions
// ---------------------------------------------------------------------------

/**
 * Published on {@link BusChannels.SafetyClassified} for every policy
 * evaluation, regardless of verdict.
 */
export interface SafetyClassifiedPayload {
	tool: string;
	actionClass: string;
	reasons: ReadonlyArray<string>;
	ruleId?: string | undefined;
	posture?: string | undefined;
	policySource: string;
	reasonCode: string;
}

/**
 * Published on {@link BusChannels.PermissionRequested} when policy parks a
 * tool call pending operator confirmation.
 */
export interface PermissionRequestedPayload {
	tool: string;
	actionClass: string;
	ruleId?: string | undefined;
	posture?: string | undefined;
	rejection?: { short: string; detail: string; hints: ReadonlyArray<string> } | undefined;
	policySource: string;
	reasonCode: string;
}

/**
 * Published on {@link BusChannels.PermissionResolved} when a parked call is
 * granted or denied (operator decision, headless auto-deny, or a delegated
 * agent's denial relayed by dispatch). Only `status` is guaranteed; emitters
 * attach whatever provenance they have.
 */
export interface PermissionResolvedPayload {
	status: "granted" | "denied";
	tool?: string | undefined;
	actionClass?: string | undefined;
	reason?: string | undefined;
	requestedBy?: string | undefined;
	at?: number | undefined;
}

/** Published on {@link BusChannels.SafetyAllowed} when policy allows a call outright. */
export interface SafetyAllowedPayload {
	tool: string;
	actionClass: string;
	posture?: string | undefined;
	ruleId?: string | undefined;
	policySource: string;
	reasonCode: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Published on {@link BusChannels.ProviderHealth} after every target probe/disconnect. */
export interface ProviderHealthPayload {
	id: string;
	status: TargetStatus;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Identity fields shared by every dispatch lifecycle event. `agentAudience`
 * is only known on the worker path; the ACP path omits it. `requestOrigin`
 * is always sent by enqueue/start but conditionally by retry/heartbeat.
 */
export interface DispatchRunIdentity {
	runId: string;
	agentId: string;
	agentAudience?: AgentAudience | undefined;
	requestOrigin?: DispatchRequestOrigin | undefined;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
}

/** Published on {@link BusChannels.DispatchEnqueued} once the ledger row exists. */
export interface DispatchEnqueuedPayload extends DispatchRunIdentity {
	requestOrigin: DispatchRequestOrigin;
}

/** Published on {@link BusChannels.DispatchStarted} once the child process is live. */
export interface DispatchStartedPayload extends DispatchEnqueuedPayload {
	pid: number | null;
}

/**
 * Published on {@link BusChannels.DispatchProgress} for every non-heartbeat
 * worker/ACP event plus heartbeat status transitions. Only the run identity
 * core is guaranteed: the dispatch tool and slash commands relay events with
 * just runId/agentId, while the dispatch domain attaches full identity.
 *
 * `event` is intentionally untyped: it is the worker/ACP event stream, which
 * crosses a process boundary, so subscribers must validate its shape.
 */
export interface DispatchProgressPayload {
	runId: string;
	agentId: string;
	agentAudience?: AgentAudience | undefined;
	requestOrigin?: DispatchRequestOrigin | undefined;
	targetId?: string | undefined;
	wireModelId?: string | undefined;
	runtimeId?: string | undefined;
	runtimeKind?: RunKind | undefined;
	event: unknown;
}

/**
 * Telemetry and provenance attached by the two run finalizers (worker and
 * ACP). Required on {@link DispatchCompletedPayload} so dropping a field from
 * one finalizer is a compile error; optional on {@link DispatchFailedPayload}
 * because the retry-denied emitter has no run to report on.
 */
export interface DispatchTerminalStats {
	lineage: RunLineage;
	tokenCount: number;
	inputTokenCount: number;
	outputTokenCount: number;
	cacheReadTokenCount: number;
	cacheWriteTokenCount: number;
	reasoningTokenCount: number;
	staticShellHash: string | null;
	sessionShellHash: string | null;
	dynamicHash: string | null;
	costUsd: number;
	durationMs: number;
	exitCode: number;
	/** Honest activity record aggregated from the run's tool telemetry; null when the receipt predates it. */
	toolActivity: ToolActivitySummary | null;
}

/** Published on {@link BusChannels.DispatchCompleted} when a run finalizes as succeeded. */
export interface DispatchCompletedPayload extends DispatchRunIdentity, DispatchTerminalStats {
	requestOrigin: DispatchRequestOrigin;
	outcome: RunOutcome;
	outcomeDetail: string | null;
}

/**
 * Published on {@link BusChannels.DispatchFailed} for every non-succeeded
 * terminal outcome. `reason` carries the resolved outcome (or the synthetic
 * "retry_denied" when a retry never reached admission); the board maps it to
 * a presentation status, so emitters must not collapse the taxonomy.
 */
export interface DispatchFailedPayload extends DispatchRunIdentity, Partial<DispatchTerminalStats> {
	outcome: RunOutcome;
	outcomeDetail: string | null;
	reason: RunOutcome | "retry_denied";
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** Published on {@link BusChannels.CompactionBegin} and {@link BusChannels.CompactionEnd}. */
export interface CompactionPayload {
	trigger: string;
	at: number;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Published on {@link BusChannels.MiddlewareHookFailed} when a middleware hook
 * registration misbehaves: `hook_failed` for a thrown evaluate (its effects
 * are discarded and the turn proceeds), `budget_exceeded` for a soft
 * wall-time overrun (effects still apply). Diagnostics only; nothing
 * subscribing here may decide anything.
 */
export interface MiddlewareHookFailedPayload {
	kind: "hook_failed" | "budget_exceeded";
	registrationId: string;
	hook: MiddlewareHook;
	at: number;
	/** Error text; hook_failed only. */
	message?: string | undefined;
	/** Measured and allowed wall time in ms; budget_exceeded only. */
	elapsedMs?: number | undefined;
	budgetMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Agent status
// ---------------------------------------------------------------------------

/**
 * Status phases for the interactive agent loop. Owned here (not in
 * src/interactive) because the phase taxonomy rides the bus into the safety
 * domain's audit trail; src/interactive/status/types.ts re-exports it.
 */
export type StatusPhase =
	| "idle"
	| "preparing"
	| "waiting_model"
	| "thinking"
	| "writing"
	| "tool_running"
	| "tool_blocked"
	| "retrying"
	| "compacting"
	| "dispatching"
	| "stuck"
	| "ended";

export type WatchdogTier = 0 | 1 | 2 | 3 | 4;

/** Published on {@link BusChannels.AgentStatusChanged} on every phase transition. */
export interface AgentStatusChangedPayload {
	runId: string | null;
	phase: StatusPhase;
	prevPhase: StatusPhase;
	at: number;
	elapsedFromStart: number;
	watchdogTier: WatchdogTier;
	metadata?: { toolName?: string; attempt?: number; reason?: string; agentName?: string } | undefined;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/** Published on {@link BusChannels.ShutdownRequested} as draining begins. */
export interface ShutdownRequestedPayload {
	phase: TerminationPhase;
}

/** Channels that mark a phase transition and carry no data. */
export type EmptyPayload = Record<string, never>;

// ---------------------------------------------------------------------------
// Payload map
// ---------------------------------------------------------------------------

/**
 * Per-channel payload contract. {@link SafeEventBus} types `emit`/`on`
 * against this map: emitters get payload checking, handlers get a typed
 * parameter. Compile-time only; see the module doc for the runtime-boundary
 * policy.
 */
export type BusPayloadMap = {
	[BusChannels.SessionStart]: SessionStartPayload;
	[BusChannels.SessionEnd]: SessionEndPayload;
	[BusChannels.SessionParked]: SessionParkedPayload;
	[BusChannels.SessionResumed]: SessionResumedPayload;
	[BusChannels.DomainLoaded]: DomainLoadedPayload;
	[BusChannels.DomainFailed]: DomainFailedPayload;
	[BusChannels.ConfigHotReload]: ConfigChangePayload;
	[BusChannels.ConfigNextTurn]: ConfigChangePayload;
	[BusChannels.ConfigRestartRequired]: ConfigChangePayload;
	[BusChannels.PermissionRequested]: PermissionRequestedPayload;
	[BusChannels.PermissionResolved]: PermissionResolvedPayload;
	[BusChannels.SafetyClassified]: SafetyClassifiedPayload;
	[BusChannels.SafetyBlocked]: SafetyBlockedPayload;
	[BusChannels.SafetyAllowed]: SafetyAllowedPayload;
	[BusChannels.LoopBlocked]: LoopBlockedPayload;
	[BusChannels.ProviderHealth]: ProviderHealthPayload;
	[BusChannels.DispatchEnqueued]: DispatchEnqueuedPayload;
	[BusChannels.DispatchStarted]: DispatchStartedPayload;
	[BusChannels.DispatchProgress]: DispatchProgressPayload;
	[BusChannels.DispatchCompleted]: DispatchCompletedPayload;
	[BusChannels.DispatchFailed]: DispatchFailedPayload;
	[BusChannels.CompactionBegin]: CompactionPayload;
	[BusChannels.CompactionEnd]: CompactionPayload;
	[BusChannels.MiddlewareHookFailed]: MiddlewareHookFailedPayload;
	[BusChannels.ContextActivity]: ContextActivityPayload;
	[BusChannels.ContextWarning]: ContextWarningPayload;
	[BusChannels.ContextPruned]: ContextPrunedPayload;
	[BusChannels.AgentStatusChanged]: AgentStatusChangedPayload;
	[BusChannels.RunAborted]: RunAbortedPayload;
	[BusChannels.BudgetAlert]: BudgetAlertPayload;
	[BusChannels.ShutdownRequested]: ShutdownRequestedPayload;
	[BusChannels.ShutdownDrained]: EmptyPayload;
	[BusChannels.ShutdownTerminated]: EmptyPayload;
	[BusChannels.ShutdownPersisted]: EmptyPayload;
};

type AssertNever<T extends never> = T;
/**
 * Compile-time exhaustiveness tripwire: adding a member to BusChannels
 * without registering its payload in BusPayloadMap fails to typecheck here.
 */
export type BusPayloadMapCoversAllChannels = AssertNever<Exclude<BusChannel, keyof BusPayloadMap>>;
