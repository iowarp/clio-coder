import type { AgentAudience } from "../../domains/agents/spec.js";
import type { ConfigDiff } from "../../domains/config/classify.js";
import type { RunToolBudgetEnvelope } from "../../domains/dispatch/budget-envelope.js";
import type {
	DispatchRequestOrigin,
	RunKind,
	RunLineage,
	RunOutcome,
	RunOutcomeCode,
	ToolActivitySummary,
} from "../../domains/dispatch/types.js";
import type { MiddlewareHook } from "../../domains/middleware/types.js";
import type { TargetStatus } from "../../domains/providers/contract.js";
import type { CostProvenance } from "../../domains/providers/index.js";
import type { TelemetryRunEvidence } from "../../domains/telemetry/contract.js";
import type { CostAggregate } from "../../domains/telemetry/cost.js";
import type { ClioSettings } from "../config.js";
import type { ContextOperation } from "../context-operation.js";
import type { SkillActivation } from "../skill-activation.js";
import type { TerminationPhase } from "../termination.js";

/**
 * Payload contracts for the live events declared in EVENTS (src/core/telemetry/events.ts). They describe what
 * in-process emitters send; the hub performs no runtime validation, so subscribers that consume data which crossed
 * a process boundary (worker/ACP event streams) keep validating at runtime.
 */

/**
 * Every collision, capacity, or stress category a {@link RuntimeNoticePayload}
 * can carry. Each member must have a declared producer (see
 * declareRuntimeNoticeProducer in src/engine/apis/residency.ts), which a
 * contract test enforces so no kind outlives the code that emits it.
 */
export const RUNTIME_NOTICE_KINDS = [
	"will-not-fit",
	"about-to-evict",
	"swap",
	"co-resident",
	"stress",
	"degraded",
	"route-fallback",
	"memory-flow-blocked",
] as const;

/** Collision, capacity, or stress category for a {@link RuntimeNoticePayload}. */
export type RuntimeNoticeKind = (typeof RUNTIME_NOTICE_KINDS)[number];

/**
 * Model-residency notice published on `runtime.notice_raised` by the
 * capacity-aware residency reconciler (src/engine/apis/residency.ts). Notices
 * are informational and non-blocking: a notice never cancels a turn. `kind` is
 * the collision or stress category, `detail` carries the numeric capacity and
 * footprint facts when the runtime exposed them, and `message` is the rendered
 * operator-facing line. A genuine VRAM miss surfaces a `will-not-fit` notice
 * carrying the same content the turn fails with, instead of a bare SDK error.
 * `degraded` reports a live turn whose token rate collapsed (see
 * src/engine/apis/degraded-inference.ts), which is how a silent spill to CPU
 * becomes visible while it is happening. `route-fallback` reports a background
 * step, such as a memory step, served by the chat target because its own
 * route was unavailable.
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

declare const declaredRuntimeNotice: unique symbol;

/**
 * A {@link RuntimeNoticePayload} minted by an emitter from
 * declareRuntimeNoticeProducer (src/engine/apis/residency.ts). The brand exists
 * only in the type system and is the payload type of
 * `runtime.notice_raised`, so a raw notice emitted on the bus outside
 * a declared producer fails to typecheck.
 */
export type DeclaredRuntimeNotice = RuntimeNoticePayload & { readonly [declaredRuntimeNotice]: true };

/**
 * One completed proactive-memory model step, published on
 * `memory.step_completed`. It carries the endpoint the step
 * called and nothing about what the step decided: the only consumer is the
 * turn context, which stamps an expected-cold reason when a step ran between
 * turns on the endpoint the chat target streams against.
 */
export interface MemoryStepCompletedPayload {
	endpointKey: string;
	targetId: string;
}

/**
 * What the always-on memory guardian is doing now, published on
 * `memory.guardian_changed` when it changes. Operator surfaces
 * (the TUI footer, the ACP memory meta the GUI reads) project this one value.
 */
export interface MemoryGuardianChangedPayload {
	sessionId: string | null;
	state: "off" | "idle" | "reviewing" | "waiting-capacity" | "unavailable";
}

/** A successful model load or eviction on one residency-managed endpoint. */
export interface ResidencyMutationPayload {
	targetKey: string;
	targetId: string;
	runtimeId: string;
	model: string;
	operation: "load" | "evict";
	at: number;
}

/**
 * Window-resolution warning published on `context.warning_raised`.
 * Emitted on transitions only: `warning` carries the text when a warning
 * appears or changes, and `null` when a prior warning clears.
 */
export interface ContextWarningPayload {
	warning: string | null;
}

/** A dispatch path-scope decision that must remain visible in the operator transcript. */
export type DispatchScopeNoticePayload =
	| {
			/**
			 * Write scope changes the tools available for this dispatch, or the
			 * worker sandbox leaves its admitted MCP servers without network.
			 */
			code: "write_root_dot_unconfined" | "write_roots_checks_withheld" | "mcp_sandbox_no_network";
			level: "warning";
			message: string;
	  }
	| {
			code: "typed_scope_replaced_inferred_paths";
			level: "warning";
			agentId: string;
			omittedPaths: ReadonlyArray<string>;
			message: string;
	  }
	| {
			code: "legacy_scope_inferred" | "legacy_scope_empty";
			level: "warning";
			agentId: string;
			paths: ReadonlyArray<{
				path: string;
				policy: "working-context" | "write-boundary";
				provenance: "declared" | "derived" | "inferred";
				source: "intent.read_roots" | "intent.write_roots" | "intent.relevant_paths" | "writeRoots" | "task" | "briefing";
				confidence: "certain" | "high" | "medium" | "low";
			}>;
			message: string;
	  };

/** Explicit context boundary: published prompt sources changed or could not be inspected. */
export interface ContextSourcesChangedPayload {
	/** Absolute workspace root; its sessions and descendant sessions must recapture disk sources. */
	cwd: string;
}

export type ContextActivityKind =
	| "context-init"
	| "context-clear"
	| "context-refresh"
	| "context-recall"
	| "context-recover"
	| "compaction";
export type ContextActivityPhase =
	| "scan"
	| "codewiki"
	| "generate"
	| "clio-md"
	| "state"
	| "compact"
	| "summarize"
	| "done";
export type ContextActivityStatus = "started" | "running" | "completed" | "failed";

/** Structured progress for context operations, rendered above the composer. */
export interface ContextActivityPayload {
	operation?: ContextOperation;
	/** Render-time elapsed and deadline facts for a dispatched context helper. */
	timing?: { runId: string; startedAtMs: number; timeoutMs: number };
	kind: ContextActivityKind;
	phase: ContextActivityPhase;
	status: ContextActivityStatus;
	message: string;
	at: number;
	current?: number;
	total?: number;
	detail?: string;
	stages?: ReadonlyArray<ContextActivityPhase>;
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
 * Payload published on `safety.loop_blocked` when the interactive
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
 * Payload published on `safety.tool_budget_exceeded` when the
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
 * Payload published on `budget.alerted` when priced session spend
 * meets ("at") or crosses ("over") the cost ceiling. Paid requests wait for an
 * operator increase in interactive mode.
 */
export interface BudgetAlertPayload {
	level: "at" | "over";
	currentUsd: number;
	ceilingUsd: number;
	/**
	 * Estimated input tokens of the paid request that is parked, when the caller
	 * knows them. Context re-sent per call is what drains a subscription window,
	 * so the stop names it beside the dollars (#423).
	 */
	contextTokens?: number;
	/** How `currentUsd` was priced, so the stop marks estimated or partly unpriced spend (#434 §6.3). */
	pricing?: { estimated: boolean; unpriced: boolean };
}

/**
 * Payload published on `safety.blocked` when the safety
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

/** Where a `run.aborted` event originated. */
export type RunAbortSource = "dispatch_abort" | "dispatch_drain" | "stream_cancel" | "loop_guard";

/**
 * Payload published on `run.aborted`. Dispatch emits
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

/** Payload published on `context.pruned` after projected or summarized context shrinks. */
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

/** Payload published on `context.recalled` after an exact working-set recall. */
export interface ContextRecalledPayload {
	ref: string;
	trigger: "tool" | "operator" | "reread";
	tokensReadmitted: number;
	at: number;
}

// ---------------------------------------------------------------------------
// Session and domain lifecycle
// ---------------------------------------------------------------------------

/** Published on `session.started` once the orchestrator boots. */
export interface SessionStartPayload {
	at: number;
}

/** Published on `session.ended` just before process.exit. */
export interface SessionEndPayload {
	exitCode: number;
}

export type SessionParkReason = "create_new" | "resume_other" | "fork" | "switch_branch" | "close" | "shutdown";
export type SessionResumeVia = "resume" | "switch_branch";

/** Published on `session.created` when a new or forked session becomes current; a fork's lineage is its journal's session.forked. */
export interface SessionOpenedPayload {
	sessionId: string;
	/** The session directory's workspace hash, so a journal can be opened for it (#434). */
	cwdHash: string;
	at: number;
}

/** Published on `session.parked` when the current session is replaced or closed. */
export interface SessionParkedPayload {
	sessionId: string;
	reason: SessionParkReason;
	at: number;
	cwdHash?: string;
}

/** Published on `session.resume_started` after a load validates, immediately before replacing the current session. */
export interface SessionResumingPayload {
	sessionId: string;
	at: number;
}

/** Published on `session.reattached` when an existing session is reopened. */
export interface SessionResumedPayload {
	sessionId: string;
	via: SessionResumeVia;
	at: number;
	cwdHash?: string;
}

/**
 * Published on `session.turn_switched` when `/tree` moves the
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

/** Published on `domain.loaded` per successfully started domain. */
export interface DomainLoadedPayload {
	name: string;
}

/** Published on `domain.failed` right before the loader throws. */
export interface DomainFailedPayload {
	name: string;
	/** The caught value as-is; loaders catch unknown and rethrow after emitting. */
	error: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Published on `config.hot_reloaded`, `config.next_turn_scheduled`,
 * and `config.restart_required`. One shape for all three: the
 * channel encodes the change class, the diff says which paths moved, and
 * `settings` is the freshly validated snapshot.
 */
/** Who changed the settings: a file write the watcher saw, or an in-process edit that named its surface (#434). */
export type ConfigChangeSource = "file" | "settings-ui" | "slash-command" | "keybinding" | "acp" | "gui";
/** The layer a change landed in: this session only, the workspace's private settings, or the user's (#434). */
export type ConfigChangeScope = "session" | "project" | "user";

export interface ConfigChangePayload {
	diff: ConfigDiff;
	settings: Readonly<ClioSettings>;
	/** The settings the change replaced. */
	previous?: Readonly<ClioSettings>;
	source: ConfigChangeSource;
	/** Absent for a file reload, which cannot tell which layer's file changed. */
	scope?: ConfigChangeScope;
}

/**
 * Published on `config.session_changed` when an edit moves only the current session's effective
 * settings. The saved layers did not change, so the config domain's change events do not fire for it (#434).
 */
export interface ConfigSessionChangePayload extends ConfigChangePayload {
	sessionId: string;
	previous: Readonly<ClioSettings>;
	source: ConfigChangeSource;
	scope: "session";
}

/**
 * Published on `config.reload_failed` when a settings file
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
 * Published on `approval.requested` when policy parks a
 * tool call pending operator confirmation.
 */
export interface PermissionRequestedPayload {
	tool: string;
	actionClass: string;
	sessionId?: string | undefined;
	turnId?: string | undefined;
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
	/**
	 * What a bash command would do, one sentence per step, written by the worker
	 * from the full command it holds. Card text only; admission never reads it.
	 */
	consequence?: ReadonlyArray<string> | undefined;
	timeoutMs?: number | undefined;
	/** Admitted timeout fallback, so the operator surface can name what an expired ask became. */
	fallback?: "deny" | "fail" | undefined;
	escalation?: boolean | undefined;
	/**
	 * Who may discharge a worker ask routed through the main agent (Phase D):
	 * `main` for an ordinary ask, `operator` for a rail only a person clears.
	 */
	approvalAuthority?: "main" | "operator" | undefined;
	/** Set when the main agent approved and, below yolo, asks the operator to decide. */
	forwardedByMain?: boolean | undefined;
}

/** Live-grant facts carried on a worker permission resolution (Phase D). */
export interface PermissionGrantFacts {
	attempt: number;
	authority: "main" | "operator";
	issuer?: "main" | "operator" | undefined;
	execution: "not_executed" | "executing" | "executed" | "unknown";
	state: string;
}

/**
 * Published on `approval.resolved` when a parked call is
 * granted, denied, or expires internally (operator decision, headless
 * auto-deny, delegated-agent denial, or internal expiry). Only `status` is
 * guaranteed; emitters attach whatever provenance they have.
 */
export interface PermissionResolvedPayload {
	status: "granted" | "denied" | "expired";
	sessionId?: string | undefined;
	turnId?: string | undefined;
	requestId?: string | undefined;
	origin?: string | undefined;
	decidedBy?: string | undefined;
	tool?: string | undefined;
	actionClass?: string | undefined;
	reason?: string | undefined;
	requestedBy?: string | undefined;
	/** Effective fallback applied to an expired worker escalation. */
	fallback?: "deny" | "fail" | undefined;
	/** Present when the resolution settles a live-grant request. */
	grant?: PermissionGrantFacts | undefined;
	at?: number | undefined;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Published on `provider.health_changed` after every target probe/disconnect. */
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
	/** Session captured when this dispatch was requested; never the currently selected UI session (#434). */
	sessionId?: string | null;
	agentId: string;
	/** Exact dispatched task. UI projections must sanitize and bound it before rendering. */
	task?: string | undefined;
	agentAudience?: AgentAudience | undefined;
	requestOrigin?: DispatchRequestOrigin | undefined;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	/** Canonical inference scheduler and its resolved request-slot bound. */
	endpoint?: { key: string; label: string; limit: number } | undefined;
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

/** Published on `run.enqueued` once the ledger row exists. */
export interface DispatchEnqueuedPayload extends DispatchRunIdentity {
	requestOrigin: DispatchRequestOrigin;
}

/**
 * Published on `run.started` once the child process is
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
 * Published on `run.progressed` for every non-heartbeat
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
	sessionId?: string | null;
	apiCalls?: number;
	missingTokenCalls?: number;
	costSummary?: CostAggregate;
	lineage: RunLineage;
	tokenCount: number;
	inputTokenCount: number;
	outputTokenCount: number;
	cacheReadTokenCount: number;
	cacheWriteTokenCount: number;
	cacheWrite1hTokenCount?: number;
	reasoningTokenCount: number;
	costUsd: number;
	costProvenance?: CostProvenance;
	durationMs: number;
	exitCode: number;
	/** Honest activity record aggregated from the run's tool telemetry; null when the receipt predates it. */
	toolActivity: ToolActivitySummary | null;
	/** Host-run declared verification status when the request included checks; `not_implicated` is a batch member the failure was charged away from. */
	hostVerification?: "verified" | "rejected" | "skipped" | "not_implicated";
}

/** Published on `run.completed` when a run finalizes as succeeded. */
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
	/** The run's information-flow label from its receipt; a FlowRestrictionSet, kept opaque to core. */
	flowRestrictions?: unknown;
}

/**
 * Published on `run.failed` for every non-succeeded
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
// Accountability
// ---------------------------------------------------------------------------

/**
 * Published on `evidence.assessed` by the
 * telemetry extension once a finalized run's evidence bundle and its
 * sidecar index row have landed. The evidence fields are exactly
 * {@link TelemetryRunEvidence}, the shape the projection already attaches
 * to the run summary, so the bus and the snapshot cannot describe the same
 * moment two ways. A failed build publishes nothing here: the projection's
 * notice is the failure surface, and a client that never receives this event
 * has learned only that no bundle is ready, which is the truth.
 */
export interface AccountabilityEvidenceReadyPayload extends TelemetryRunEvidence {
	runId: string;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** Published on `compaction.started` and `compaction.ended`. */
export interface CompactionPayload {
	trigger: string;
	at: number;
	outcome?: "completed" | "unchanged" | "failed" | "cancelled";
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

/** Data-only plugin generation publication, independent of extension hook generations. */
export interface PluginsReloadedPayload {
	generation: number;
	previousGeneration: number;
	changed: boolean;
	/** Content identity of the committed snapshot. */
	digest: string;
}

/** Operator diagnostics for skipped extension or project-hook configuration. */
export interface ExtensionsLoadIssuePayload {
	message: string;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Published on `middleware.hook_failed` when a middleware hook
 * registration misbehaves: `hook_failed` for a thrown evaluate (its effects
 * are discarded and the turn proceeds), `budget_exceeded` for a soft
 * wall-time overrun (effects still apply), `registration_conflict` when an
 * owned registration set (user hooks) offered an id a builtin or host
 * registration holds, or a host registration evicted an owned one.
 * Diagnostics only; nothing subscribing here may decide anything.
 */
export interface MiddlewareHookFailedPayload {
	kind: "hook_failed" | "budget_exceeded" | "registration_conflict";
	registrationId: string;
	hook: MiddlewareHook;
	at: number;
	/** Error text for hook_failed; one formatted line for registration_conflict. */
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
 * domain's audit trail; src/session-control/status-types.ts re-exports it.
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

/** Published on `agent.status_changed` on every phase transition. */
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

/**
 * Published on `safety.git_hooks_changed` the first time the git hook
 * drift guard sees a hook file added or changed since the operator's
 * baseline (src/domains/safety/hook-drift.ts). `message` is the notice line.
 */
export interface GitHooksChangedPayload {
	message: string;
	changes: ReadonlyArray<{
		path: string;
		kind: "added" | "changed" | "removed";
		/** The config key, for an executable git config value. */
		key?: string;
		size: number;
		firstLine: string;
	}>;
}

/**
 * Published on `safety.internal_git_drifted` when git Clio runs itself
 * (a task worktree's `git worktree add`, a merge landing a worker's result)
 * meets hook or executable config drift (src/domains/safety/internal-git-policy.ts).
 * `hardened` is true when it ran with hooks off and the changed config
 * overridden; false at yolo, where it ran as configured. `message` is the
 * notice line, shown when `announce` marks the first operation that met these
 * changes.
 */
export interface InternalGitDriftPayload {
	message: string;
	announce: boolean;
	operation: string;
	hardened: boolean;
	/** `hooks-off` and `yolo` for a mutation; `overridden` or `skipped` for Clio's read-only git. */
	outcome: "hooks-off" | "overridden" | "skipped" | "yolo";
	changes: ReadonlyArray<{ path: string; kind: "added" | "changed" | "removed"; key?: string }>;
}

/** Published on `shutdown.requested` as draining begins. */
export interface ShutdownRequestedPayload {
	phase: TerminationPhase;
}

/** Channels that mark a phase transition and carry no data. */
export type EmptyPayload = Record<string, never>;
