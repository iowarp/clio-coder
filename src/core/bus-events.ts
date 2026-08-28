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
import type { RunToolBudgetEnvelope } from "../domains/dispatch/budget-envelope.js";
import type {
	DispatchRequestOrigin,
	RunKind,
	RunLineage,
	RunOutcome,
	RunOutcomeCode,
	ToolActivitySummary,
} from "../domains/dispatch/types.js";
import type { MiddlewareHook } from "../domains/middleware/types.js";
import type { TargetStatus } from "../domains/providers/contract.js";
import type { CostProvenance } from "../domains/providers/index.js";
import type { ClioSettings } from "./config.js";
import type { SkillActivation } from "./skill-activation.js";
import type { TerminationPhase } from "./termination.js";

export const BusChannels = {
	SessionStart: "session.start",
	SessionEnd: "session.end",
	SessionParked: "session.parked",
	SessionResumed: "session.resumed",
	SessionTurnSwitched: "session.turn_switched",
	DomainLoaded: "domain.loaded",
	DomainFailed: "domain.failed",
	ConfigHotReload: "config.hotReload",
	ConfigNextTurn: "config.nextTurn",
	ConfigRestartRequired: "config.restartRequired",
	ConfigReloadFailed: "config.reloadFailed",
	PermissionRequested: "permission.requested",
	PermissionResolved: "permission.resolved",
	SafetyClassified: "safety.classified",
	SafetyBlocked: "safety.blocked",
	SafetyAllowed: "safety.allowed",
	LoopBlocked: "safety.loopBlocked",
	ToolBudgetExceeded: "safety.toolBudgetExceeded",
	ProviderHealth: "provider.health",
	RuntimeNotice: "runtime.notice",
	DispatchScopeNotice: "dispatch.scopeNotice",
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
	ContextRecalled: "context.recalled",
	AgentStatusChanged: "agent.status.changed",
	RunAborted: "run.aborted",
	BudgetAlert: "budget.alert",
	ShutdownRequested: "shutdown.requested",
	ShutdownDrained: "shutdown.drained",
	ShutdownTerminated: "shutdown.terminated",
	ShutdownPersisted: "shutdown.persisted",
} as const;

export type BusChannel = (typeof BusChannels)[keyof typeof BusChannels];

/** Collision, capacity, or stress category for a {@link RuntimeNoticePayload}. */
export type RuntimeNoticeKind = "will-not-fit" | "about-to-evict" | "swap" | "co-resident" | "stress" | "degraded";

/**
 * Model-residency notice published on {@link BusChannels.RuntimeNotice} by the
 * capacity-aware residency reconciler (src/engine/apis/residency.ts). Notices
 * are informational and non-blocking: a notice never cancels a turn. `kind` is
 * the collision or stress category, `detail` carries the numeric capacity and
 * footprint facts when the runtime exposed them, and `message` is the rendered
 * operator-facing line. A genuine VRAM miss surfaces a `will-not-fit` notice
 * carrying the same content the turn fails with, instead of a bare SDK error.
 * `degraded` reports a live turn whose token rate collapsed (see
 * src/engine/apis/degraded-inference.ts), which is how a silent spill to CPU
 * becomes visible while it is happening.
 */
export interface RuntimeNoticePayload {
	kind: RuntimeNoticeKind;
	level: "info" | "warning" | "error";
	targetId: string;
	runtimeId: string;
	model: string;
	message: string;
	detail?: Record<string, number | string | boolean>;
}

/**
 * Window-resolution warning published on {@link BusChannels.ContextWarning}.
 * Emitted on transitions only: `warning` carries the text when a warning
 * appears or changes, and `null` when a prior warning clears.
 */
export interface ContextWarningPayload {
	warning: string | null;
}

/** A declared dispatch scope replaced prose inference and omitted candidate paths. */
export interface DispatchScopeNoticePayload {
	code: "typed_scope_replaced_inferred_paths";
	level: "warning";
	agentId: string;
	omittedPaths: ReadonlyArray<string>;
	message: string;
}

export type ContextActivityKind = "context-init" | "context-clear" | "context-refresh" | "context-wiki" | "compaction";
export type ContextActivityPhase = "scan" | "codewiki" | "generate" | "clio-md" | "state" | "done";
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
 * Where a loop block sits on the identical-call escalation:
 * - `"block"`: a per-call block below the per-turn budget. The interactive
 *   layer renders a warn notice; the denial reason flows back to the model.
 * - `"lockout"`: the per-turn budget is reached. Tool use is disabled for the
 *   rest of the turn so the model answers from what it already gathered; the
 *   turn is NOT cancelled. Orchestrator surfaces with the synthesis lockout.
 * - `"stop"`: the post-lockout backstop fired (the model kept calling tools),
 *   or a surface without the synthesis lockout reached the budget. The turn is
 *   cancelled with the durable closing message.
 */
export type LoopBlockedDisposition = "block" | "lockout" | "stop";

/**
 * Payload published on {@link BusChannels.LoopBlocked} when the interactive
 * loop guard blocks a verbatim-repeated tool call before execution. The
 * interactive layer renders a warn notice per block, a distinct notice on
 * `"lockout"`, and cancels the active turn only on `"stop"`. The backend never
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
	/**
	 * True when the turn must stop (equivalently `disposition === "stop"`).
	 * A `"lockout"` sets this false: the turn keeps running with tools disabled
	 * so the model can synthesize a final answer.
	 */
	interrupted: boolean;
	/** Escalation stage of this block; see {@link LoopBlockedDisposition}. */
	disposition: LoopBlockedDisposition;
	at: number;
	turnId?: string;
}

/**
 * Payload published on {@link BusChannels.ToolBudgetExceeded} when the
 * orchestrator loop guard observes too many tool calls inside a single user
 * turn. Unlike {@link LoopBlockedPayload}, which fires only on verbatim-repeated
 * calls, this counts every distinct tool-call attempt in the turn so a weak
 * model spraying near-duplicate commands is caught. At the soft budget the
 * guard injects a re-plan directive and the interactive layer renders a warn
 * notice; when `interrupted` is true the hard ceiling is reached and the layer
 * cancels the active turn with an error notice. The backend never imports TUI
 * code; this event is the only seam between them.
 */
export interface ToolBudgetExceededPayload {
	tool: string;
	/** Distinct tool-call attempts observed in the current user turn, this one included. */
	callsThisTurn: number;
	/** Soft per-turn budget that triggers the re-plan nudge. */
	softBudget: number;
	/** Hard per-turn ceiling that interrupts the turn. */
	hardCeiling: number;
	/** True when the hard ceiling is reached and the turn must stop. */
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
export type RunAbortSource = "dispatch_abort" | "dispatch_drain" | "stream_cancel" | "loop_guard";

/**
 * Payload published on {@link BusChannels.RunAborted}. Dispatch emits
 * dispatch_abort/dispatch_drain with run lineage; the chat loop emits
 * stream_cancel for an operator Esc/Ctrl+C and loop_guard when the loop guard
 * stops a runaway turn. Subscribers must not collapse the sources: a drained
 * dispatch run, a user-cancelled stream, and a guard-stopped loop are different
 * operator situations.
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
	"loop_guard",
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

/** Payload published on {@link BusChannels.ContextPruned} after projected or summarized context shrinks. */
export interface ContextPrunedPayload {
	stage: "mask_observations" | "working_set" | "llm_summary";
	tokensBefore: number;
	tokensAfter: number;
	trigger: string;
	snapshotIdBefore: string | null;
	snapshotIdAfter: string;
	at: number;
	/** Used/window ratio at trigger time; working-set and legacy-mask stages only. */
	pressure?: number | null;
	/** Legacy destructive-mask count. */
	maskedObservations?: number;
	/** Thinking blocks stripped from stale assistant messages; legacy mask only. */
	maskedThinkingBlocks?: number;
	maskedThinkingChars?: number;
	/** Working-set policy that selected an applied eviction event. */
	policyId?: string;
	/** Number of working-set units evicted by the event. */
	evictedItems?: number;
}

/** Payload published on {@link BusChannels.ContextRecalled} after an exact working-set recall. */
export interface ContextRecalledPayload {
	ref: string;
	trigger: "tool" | "operator";
	tokensReadmitted: number;
	at: number;
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

/**
 * Published on {@link BusChannels.SessionTurnSwitched} when `/tree` moves the
 * active append point inside the current session without changing which
 * session is open. Nothing else observes that move: unlike resume/fork, the
 * session id in `getSessionId()` callbacks stays the same, so anything keyed
 * on session id alone (the task board cache among them) needs this signal to
 * know its fold is stale.
 */
export interface SessionTurnSwitchedPayload {
	sessionId: string;
	turnId: string;
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

/**
 * Published on {@link BusChannels.ConfigReloadFailed} when a settings file
 * change is rejected at runtime and the previous good snapshot stays active.
 * Emitted on transitions only, like {@link ContextWarningPayload}: `message`
 * carries one already-formatted operator line while the failure stands, and
 * `null` once a later reload succeeds and the prior failure clears.
 *
 * The message is pre-formatted by `formatSettingsFailure` (core/config.ts)
 * because the config domain must not import TUI code and the renderer must
 * not learn the settings schema. One line, no stack, no error dump: this
 * event exists so nothing writes an inspected Error over the live frame.
 */
export interface ConfigReloadFailedPayload {
	message: string | null;
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
	origin?: string | undefined;
	axis?: string | undefined;
	reasons?: ReadonlyArray<string> | undefined;
	ruleId?: string | undefined;
	posture?: string | undefined;
	rejection?: { short: string; detail: string; hints: ReadonlyArray<string> } | undefined;
	policySource?: string | undefined;
	reasonCode?: string | undefined;
	/**
	 * Worker permission escalation provenance. Present only when dispatch
	 * republishes an escalate-posture worker's parked ask; absent for
	 * main-agent asks. `requestedBy` carries the worker run id so the
	 * interactive layer can label the overlay and route the operator decision
	 * back through resolveWorkerPermission.
	 */
	requestedBy?: string | undefined;
	requestId?: string | undefined;
	agentId?: string | undefined;
	summary?: string | undefined;
	/** Sanitized one-line preview of the call's object (command, path, or compact args). */
	target?: string | undefined;
	timeoutMs?: number | undefined;
	escalation?: boolean | undefined;
}

/**
 * Published on {@link BusChannels.PermissionResolved} when a parked call is
 * granted, denied, or expires internally (operator decision, headless
 * auto-deny, delegated-agent denial, or internal expiry). Only `status` is
 * guaranteed; emitters attach whatever provenance they have.
 */
export interface PermissionResolvedPayload {
	status: "granted" | "denied" | "expired";
	requestId?: string | undefined;
	origin?: string | undefined;
	decidedBy?: string | undefined;
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
	/** Exact dispatched task. UI projections must sanitize and bound it before rendering. */
	task?: string | undefined;
	agentAudience?: AgentAudience | undefined;
	requestOrigin?: DispatchRequestOrigin | undefined;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	/** Admitted invocation budget provenance for native workers. */
	budget?: RunToolBudgetEnvelope | undefined;
	/** Fleet node id the run was placed on; absent renders as the local node. */
	node?: string | undefined;
	/** Review/compete gate role and cycle, for fleet board badges. */
	gate?: { role: string; cycle: number } | undefined;
	/** Council group presentation data for the Fleet Runs board. */
	council?: { group: string; label: string; color?: string; round: number } | undefined;
	/** Dead-node failover hops recorded on this run's chain so far. */
	rerouteCount?: number | undefined;
	/** Model context window in tokens, for the per-worker context meter. */
	contextWindow?: number | undefined;
}

/** Published on {@link BusChannels.DispatchEnqueued} once the ledger row exists. */
export interface DispatchEnqueuedPayload extends DispatchRunIdentity {
	requestOrigin: DispatchRequestOrigin;
}

/**
 * Published on {@link BusChannels.DispatchStarted} once the child process is
 * live.
 *
 * `assignmentId` and `attempt` are required, on the same terms as
 * {@link DispatchTerminalStats}: a surface that draws one entry per logical
 * work item has to key on the assignment, and a spawn path that forgot to send
 * it would silently split a failover into two entries. Both come straight off
 * the run's {@link RunLineage} (`rootRunId` / `attempt`), so no emitter has to
 * derive them.
 */
export interface DispatchStartedPayload extends DispatchEnqueuedPayload {
	pid: number | null;
	/** Exact spawned argv encoded as JSON, for safe pid/command identity checks. */
	processCommand?: string | undefined;
	/** Logical work item this attempt belongs to; retries and failovers share it. */
	assignmentId: string;
	/** 0 on the first attempt, incremented once per retry. */
	attempt: number;
	/**
	 * Tool call whose execution spawned this run. Present only on agent-origin
	 * runs whose caller knew its own call id, which is what lets a transcript
	 * nest the worker under the tool segment that started it instead of
	 * appending it wherever the turn happens to be.
	 */
	parentToolCallId?: string | undefined;
}

/**
 * Published on {@link BusChannels.DispatchProgress} for every non-heartbeat
 * worker/ACP event plus heartbeat status transitions. The dispatch domain
 * owns publication so attached, detached, batched, and retry runs expose the
 * same live stream exactly once. Lightweight contract fakes may still omit
 * all identity fields except runId/agentId.
 *
 * `event` is intentionally untyped: it is the worker/ACP event stream, which
 * crosses a process boundary, so subscribers must validate its shape.
 */
export interface DispatchProgressPayload {
	runId: string;
	agentId: string;
	task?: string | undefined;
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
	costProvenance?: CostProvenance;
	durationMs: number;
	exitCode: number;
	/** Honest activity record aggregated from the run's tool telemetry; null when the receipt predates it. */
	toolActivity: ToolActivitySummary | null;
	/** Host-run declared verification status when the request included checks. */
	hostVerification?: "verified" | "rejected" | "skipped";
}

/** Published on {@link BusChannels.DispatchCompleted} when a run finalizes as succeeded. */
export interface DispatchCompletedPayload extends DispatchRunIdentity, DispatchTerminalStats {
	requestOrigin: DispatchRequestOrigin;
	outcome: RunOutcome;
	outcomeCode: RunOutcomeCode | null;
	outcomeDetail: string | null;
	/**
	 * Worker skill activations collected into the run receipt. Present only
	 * when the run activated at least one skill (native/subprocess runners;
	 * ACP delegation collects none). The orchestrator folds these into the
	 * session ledger tagged with the runId.
	 */
	skillActivations?: ReadonlyArray<SkillActivation>;
}

/**
 * Published on {@link BusChannels.DispatchFailed} for every non-succeeded
 * terminal outcome. `reason` carries the resolved outcome (or the synthetic
 * "retry_denied" when a retry never reached admission); the board maps it to
 * a presentation status, so emitters must not collapse the taxonomy.
 */
export interface DispatchFailedPayload extends DispatchRunIdentity, Partial<DispatchTerminalStats> {
	outcome: RunOutcome;
	outcomeCode?: RunOutcomeCode | null;
	outcomeDetail: string | null;
	reason: RunOutcome | "retry_denied";
	/**
	 * Worker skill activations collected into the run receipt, on the same
	 * terms as {@link DispatchCompletedPayload}. A run that loaded a skill and
	 * then failed is exactly when the operator needs to know which skill and
	 * which copy of it, so the failing path records them too.
	 */
	skillActivations?: ReadonlyArray<SkillActivation>;
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
	/**
	 * budget_exceeded only. True when the overrun is steady-state slowness (≥N of
	 * the last M post-warmup calls over budget), not a lone spike. The interactive
	 * notice surfaces only on steady-state; every post-warmup overrun is still
	 * published for telemetry regardless.
	 */
	steadyStateWarn?: boolean | undefined;
	/** Rolling-window stats; budget_exceeded only. */
	p50Ms?: number | undefined;
	p95Ms?: number | undefined;
	overCount?: number | undefined;
	windowSamples?: number | undefined;
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
	[BusChannels.SessionTurnSwitched]: SessionTurnSwitchedPayload;
	[BusChannels.DomainLoaded]: DomainLoadedPayload;
	[BusChannels.DomainFailed]: DomainFailedPayload;
	[BusChannels.ConfigHotReload]: ConfigChangePayload;
	[BusChannels.ConfigNextTurn]: ConfigChangePayload;
	[BusChannels.ConfigRestartRequired]: ConfigChangePayload;
	[BusChannels.ConfigReloadFailed]: ConfigReloadFailedPayload;
	[BusChannels.PermissionRequested]: PermissionRequestedPayload;
	[BusChannels.PermissionResolved]: PermissionResolvedPayload;
	[BusChannels.SafetyClassified]: SafetyClassifiedPayload;
	[BusChannels.SafetyBlocked]: SafetyBlockedPayload;
	[BusChannels.SafetyAllowed]: SafetyAllowedPayload;
	[BusChannels.LoopBlocked]: LoopBlockedPayload;
	[BusChannels.ToolBudgetExceeded]: ToolBudgetExceededPayload;
	[BusChannels.ProviderHealth]: ProviderHealthPayload;
	[BusChannels.RuntimeNotice]: RuntimeNoticePayload;
	[BusChannels.DispatchScopeNotice]: DispatchScopeNoticePayload;
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
	[BusChannels.ContextRecalled]: ContextRecalledPayload;
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
