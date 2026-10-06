import { createHash } from "node:crypto";
import { ToolNames } from "../../core/tool-names.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	RESOLVED_DISPATCH_PLAN_ARGUMENT,
} from "../../tools/dispatch-plan.js";
import {
	legacyToolResultDigest,
	sanitizeToolResultDigest,
	type ToolResultDigest,
} from "../../tools/result-disposition.js";
import { gatewayChainReceipts } from "../../tools/surface.js";
import type { BackgroundSkipReason } from "../memory/background-budget.js";
import { BACKGROUND_SKIP_REASONS } from "../memory/background-budget.js";
import {
	type MemoryCommitScope,
	MemoryCommitState,
	type MemoryRestorationOffer,
	type SuccessfulMemoryContextCommit,
} from "../memory/commit-state.js";
import { lessonEvidence, recordObservedRead, repositoryRelativePath } from "../memory/lesson-evidence.js";
import type { MemoryRestorationInput } from "../memory/restoration.js";
import { TASK_MEMORY_DEFAULT_PROCEDURAL_CAP, type TaskMemoryBank, type TaskMemoryEntry } from "../memory/task-bank.js";
import {
	runTaskMemoryPolicy,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	type TaskMemoryEnvelope,
	type TaskMemoryModelClient,
	type TaskMemoryPolicyReason,
	type TaskMemoryPolicyResult,
	type TaskMemoryRoute,
	type TaskMemoryStepUsage,
	type TaskMemoryTrajectoryStep,
} from "../memory/task-memory-policy.js";
import type { TaskMemoryActivityEvent } from "../memory/task-memory-status.js";
import {
	type TaskMemoryBankDelta,
	type TaskMemoryTelemetryDecision,
	type TaskMemoryTelemetrySink,
	type TaskMemoryTelemetryTier,
	type TaskMemoryTelemetryTrigger,
	taskMemoryBankDelta,
} from "../memory/task-memory-telemetry.js";
import { MEMORY_CONSOLIDATION_SYSTEM_PROMPT } from "../prompts/memory-intervention.js";
import { hashToolCall } from "../safety/loop-detector.js";
import { redactSecretString } from "../safety/redaction.js";
import { ceilChars } from "../session/context-accounting.js";
import type { MiddlewareHookEvaluationContext, MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

export const MEMORY_INTERVENTION_REGISTRATION_ID = "observer.memory-intervention";
export const MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS = 8;
export const MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS = 2_000;
export const MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS = 10;
/** Two full deadlines are enough evidence to stop spending this session's endpoint. */
export const MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD = 2;

export const MEMORY_INTERVENTION_ACTIVITY_LIMIT = 20;
/**
 * Tool steps a delivered reminder must survive without its failures returning
 * before it counts as held. Held is the absence of a recurrence over that
 * window, never proof the lesson is true, which is why a delivery stays
 * watched afterwards and can still be contradicted.
 */
export const MEMORY_DELIVERY_HELD_MIN_STEPS = 3;
/** Recurrences of a failure that was open at delivery before the reminder counts as contradicted. */
export const MEMORY_DELIVERY_CONTRADICTED_RECURRENCES = 2;
const MEMORY_DELIVERY_WATCH_LIMIT = 16;

/**
 * What the session saw after an llm-tier reminder reached the action agent.
 * This is the only evidence the durable store's approval gate reads, so it is
 * reported once per delivery and only when it is decided.
 */
export interface MemoryDeliveryOutcome {
	/**
	 * The entries as they read when the reminder was delivered. Entry ids are
	 * reused across rewrites, so the content is what binds an outcome to the
	 * fact it is about: an id alone let a late contradiction of a rewritten
	 * entry land on the fact that replaced it.
	 */
	entries: ReadonlyArray<{ id: string; content: string }>;
	kind: "held" | "contradicted";
}

export type MemoryInterventionTriggerReason =
	| "interval"
	| "tool_error_streak"
	| "loop_signal"
	| "turn_end"
	| "idle_review";

/** Reasons a step yielded to occupancy; its triggers stay pending and it runs again when the endpoint has room. */
const YIELDED_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set(["endpoint_busy", "endpoint_preempted"]);

/**
 * The background budget refused the step before it sent anything (spend,
 * quota or time). Its triggers are not re-armed: the next cadence tick decides
 * again, so a refused step is never retried in a loop.
 */
function budgetSkipped(reason: TaskMemoryPolicyReason): boolean {
	return !YIELDED_REASONS.has(reason) && BACKGROUND_SKIP_REASONS.has(reason as BackgroundSkipReason);
}

/** Reasons that mean the model tier cannot run right now; deterministic rules keep working. */
const UNAVAILABLE_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set([
	"no_client",
	"client_error",
	"information_flow_blocked",
	"llm_timeout_backoff",
]);

/** What one detached step launch came to, for the idle guardian's scheduling. */
export type MemoryStepLaunchOutcome =
	/** The model tier answered or timed out; new pending work is up to the next boundary. */
	| "ran"
	/** Occupancy refused or preempted the step; its triggers stay pending. */
	| "yielded"
	/** The model tier cannot run; rules keep working. */
	| "unavailable"
	/** The background budget refused the step; the next cadence tick decides again. */
	| "skipped"
	/** Nothing to do, or the scope changed under the step. */
	| "none";
/**
 * Tool calls since the last lesson pass that make a finished turn worth one.
 * Every other trigger fires mid-turn, so the model never saw how the turn
 * ended: in a live session its last step ran before the passing test and it
 * never learned which of its notes had been right.
 */
export const MEMORY_INTERVENTION_TURN_END_MIN_TOOLS = 2;

export interface MemoryInterventionSettings {
	enabled: boolean;
	everyNTools: number;
	windowSteps: number;
	maxTokens: number;
	timeoutMs: number;
}

const CALL_DESCRIPTION_MAX_CHARS = 180;
const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];
/**
 * Operator wording that asks for the same command to run again. A repeat the
 * operator requested in the current turn is the task, not a repeated mistake
 * (p8/B5), so the failure reminders stay quiet for that turn.
 */
const OPERATOR_REPEAT_REQUEST =
	/\b(?:again|twice|thrice|(?:a|the)\s+(?:second|third)\s+time|second\s+run|once\s+more|one\s+more\s+time|(?:two|three)\s+(?:times|runs))\b/iu;
const OPERATOR_COMMAND_REQUEST =
	/^(?:(?:please|then|and)\s+|(?:can|could|would)\s+you\s+)*(run|execute|invoke|try|re-?run|re-?try|repeat)\b/iu;

function operatorRequestsCommandRepeat(text: string): boolean {
	// p8/B5 applies to affirmative command requests. A task about a retry
	// handler or a prohibition on running again must retain failure warnings.
	return text.split(/[\n!?;,]+|\.(?:\s+|$)/u).some((clause) => {
		const request = clause.trim();
		const command = OPERATOR_COMMAND_REQUEST.exec(request)?.[1];
		return (
			command !== undefined &&
			(/^(?:re-?run|re-?try|repeat)$/iu.test(command) || OPERATOR_REPEAT_REQUEST.test(request)) &&
			!/\b(?:not|never|avoid|stop|without)\b|\bdon['’]?t\b/iu.test(request)
		);
	});
}

type ToolOutcome = "ok" | "error";

interface PendingToolStep {
	toolName: string;
	operationFingerprint: string;
	callDescription: string;
}

type TrajectoryStep = TaskMemoryTrajectoryStep;

export interface MemoryKnowledgeReview {
	/** Lessons kept on a later look that also quote a command this session saw succeed. */
	kept: ReadonlyArray<TaskMemoryEntry>;
	withdrawn: ReadonlyArray<TaskMemoryEntry>;
	/** Lessons kept on a later look with nothing observed to ground them; filed, never evidence. */
	ungrounded: ReadonlyArray<TaskMemoryEntry>;
}

const TURN_LOG_LIMIT = 40;
const TURN_LOG_CALL_MAX_CHARS = 300;
const VERIFIED_COMMAND_LIMIT = 256;
const TURN_LOG_READ_EXCERPT_CHARS = 240;

/** Reasons that mean the model never produced a usable answer, so the bank it left says nothing. */
const UNANSWERED_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set([
	"unparseable",
	"all_operations_invalid",
	"deadline",
	"timed_out",
	"endpoint_busy",
	"endpoint_preempted",
	"cost_ceiling",
	"quota_window",
	"quota_retry",
	"time_budget",
	"client_error",
	"information_flow_blocked",
	"no_client",
	"no_consumer",
	"step_in_flight",
	"llm_timeout_backoff",
	"scope_changed",
]);

interface DeliveryWatch {
	entries: Array<{ id: string; content: string }>;
	step: number;
	/** Operations that were failing in the window the reminder was written from. */
	fingerprints: Set<string>;
	recurrences: number;
	/** Held was already reported; only a later contradiction is still news. */
	heldReported: boolean;
}

interface FailedAttempt {
	entryId: string;
	attempts: number;
	firstStep: number;
	callDescription: string;
	errorDigest: string;
}

export interface MemoryInterventionDeps {
	bank: TaskMemoryBank;
	enabled?: boolean;
	windowSteps?: number;
	maxTokens?: number;
	timeoutMs?: number;
	everyNTools?: number;
	/** Lazily resolves the dedicated memory route or the active chat route. Null means rules-only. */
	getModelClient?: () => TaskMemoryModelClient | null;
	/** One alternative route after a client error; never used after timeout, cancellation or model output. */
	getFallbackModelClient?: () => TaskMemoryModelClient | null;
	/** Completion budget derived from the resolved background model capability. */
	getModelMaxTokens?: (configuredMaxTokens: number) => number;
	/**
	 * True when known endpoint occupancy exhausts the resolved capacity bound.
	 * A shared gateway URL alone is not evidence that its request slots are full.
	 */
	backgroundEndpointBusy?: () => boolean;
	/**
	 * Provider-reported spend for one completed model step. The composition root
	 * routes it to the cost ledger; the middleware never prices anything.
	 */
	onStepUsage?: (usage: TaskMemoryStepUsage) => void;
	/** Capture immutable accounting ownership at launch, before awaiting inference. */
	captureStepUsage?: () => (usage: TaskMemoryStepUsage, isCurrent: boolean) => void;
	/**
	 * Bank entries an llm-tier reminder cited when it reached the operator. The
	 * composition root proposes them into the durable memory store, which is what
	 * connects the session bank to the records `/memory` and `clio-coder memory`
	 * read. Best effort and content-bearing, exactly like `onEnvelope`.
	 */
	onInjectedEntries?: (entries: ReadonlyArray<TaskMemoryEntry>) => void;
	/**
	 * Decided outcomes for entries `onInjectedEntries` reported earlier. `final`
	 * marks the last call for this session scope: deliveries still undecided at
	 * that point are abandoned, and the entry ids may be reused afterwards.
	 */
	onDeliveryOutcomes?: (outcomes: ReadonlyArray<MemoryDeliveryOutcome>, final: boolean) => void;
	/**
	 * What one answered model step did to knowledge it had already written.
	 * `kept` entries were shown to the model again and left unchanged, which is
	 * the model reaffirming a fact with a newer trajectory in front of it;
	 * `withdrawn` entries were deleted or rewritten. A live session on a local
	 * 27B wrote the one fact worth keeping on its first step and stayed silent
	 * on all three, so a capture path that waits for a delivered reminder
	 * recorded nothing.
	 */
	onKnowledgeReview?: (review: MemoryKnowledgeReview) => void;
	/**
	 * Lessons still in the bank when its session scope ends, with the session
	 * they were written in. A lesson filed on a session's last step never gets a
	 * second look, so it is handed over to be filed as pending instead of being
	 * cleared with the bank.
	 */
	/** Approved lessons for the active repository, shown to the turn-end pass so it does not rewrite them. */
	getKeptLessons?: () => ReadonlyArray<{ id: string; text: string }>;
	/** Kept lessons the turn-end pass deleted because the turn showed them wrong. */
	onKeptLessonsRetired?: (memoryIds: ReadonlyArray<string>) => void;
	onScopeEnd?: (scope: { sessionId: string | undefined; lessons: ReadonlyArray<TaskMemoryEntry> }) => void;
	/** Live next-turn settings view; individual fields above remain test-friendly fallbacks. */
	getSettings?: () => Readonly<MemoryInterventionSettings>;
	/** Best-effort content-free telemetry; sink failures never affect intervention. */
	telemetry?: TaskMemoryTelemetrySink;
	/**
	 * Opt-in raw-envelope observer. Content-bearing, so the composition root only
	 * supplies it when the operator named a trace file.
	 */
	onEnvelope?: (envelope: TaskMemoryEnvelope) => void;
	/**
	 * Delivery channel for a reminder produced after its turn boundary already
	 * closed. The composition root buffers it into the next submitted turn, which
	 * is where a synchronous turn_end reminder would have landed anyway.
	 */
	onDeferredReminder?: (message: string, isCurrent?: () => boolean) => void;
	/**
	 * False when no further turn will be submitted in this process. A background
	 * step is detached from the boundary that triggered it and a local route
	 * measures in tens of seconds, so a headless run exits long before the step
	 * lands: its reminder has no turn to ride into and its bank is discarded with
	 * the process. Starting one only spends a model call to throw the result away.
	 */
	deliversDeferredReminders?: boolean;
	/** Turn lifecycle wake signal for the idle guardian. Synchronous and cheap; it never runs a step. */
	onTurnBoundary?: (kind: "start" | "end") => void;
	/** A detached step started or settled, so read-only status surfaces can refresh. */
	onStepActivity?: () => void;
	/** Checkout source evidence is verified against; defaults to the process workspace. */
	workspaceRoot?: () => string;
}

export interface MemoryPromptedStepInput {
	deterministicTrigger: boolean;
	/** Overrides the most recent turn-start task text when supplied. */
	task?: string;
	/** Keep phase-one writes but yield the visible channel to a synchronous reminder. */
	suppressIntervention?: boolean;
	/** Internal attribution; direct callers default to `manual`. */
	triggerReasons?: ReadonlyArray<TaskMemoryTelemetryTrigger>;
}

export interface MemoryPromptedStepResult extends TaskMemoryPolicyResult {
	effects: ReadonlyArray<MiddlewareEffect>;
}

export interface MemoryInterventionRegistration extends MiddlewareHookRegistration {
	bindCommitScope(scope: MemoryCommitScope): void;
	notifyContextCommitted(input: SuccessfulMemoryContextCommit): void;
	prepareRestoration(
		currentState: MemoryRestorationInput["currentState"],
		maxTokens: number,
	): MemoryRestorationOffer | null;
	acknowledgeRestoration(offer: MemoryRestorationOffer): boolean;
	isContentCurrent(): () => boolean;
	/** Invalidate pending content and discard all transient session/branch state. */
	reset(): void;
	/** Invalidate immediately without waiting for the model; refuse further work. */
	dispose(): void;
	evaluateAsync(
		input: MiddlewareHookInput,
		context?: MiddlewareHookEvaluationContext,
	): Promise<ReadonlyArray<MiddlewareEffect>>;
	/** Serialized model step; the composition root decides which awaited boundary invokes it. */
	runPromptedStep(input: MemoryPromptedStepInput): Promise<MemoryPromptedStepResult>;
	/** Consume the orchestrator loop guard's already-computed verdict. */
	signalLoop(): void;
	/** Most recent completed memory-policy outcome for read-only operator surfaces. */
	lastDecision(): TaskMemoryPolicyResult["decision"] | null;
	/** Bounded newest-first memory-step history for read-only operator surfaces. */
	recentActivity(): ReadonlyArray<TaskMemoryActivityEvent>;
	/** True while a detached background memory step is still running. */
	stepInFlight(): boolean;
	/**
	 * Completed activity no step has reviewed yet: pending triggers, including
	 * ones that yielded to occupancy, or shell work since the last lesson pass.
	 */
	pendingWork(): boolean;
	/**
	 * Run pending work between turns: yielded triggers first, otherwise a lesson
	 * pass over completed activity the turn-end pass did not cover. Detached
	 * from any visible turn; the idle guardian decides when to call it.
	 */
	runIdleStep(): Promise<MemoryStepLaunchOutcome>;
	/**
	 * Resolves when this generation's detached policy settles. Reset/shutdown
	 * release the policy immediately; an abort-ignoring transport can still
	 * finish later, with authority only to report its originating usage.
	 */
	whenIdle(): Promise<void>;
}

/**
 * Rules-only proactive-memory policy. It observes bounded tool history and
 * emits only cited, advisory reminders through the existing visible channel.
 */
export function createMemoryInterventionRegistration(deps: MemoryInterventionDeps): MemoryInterventionRegistration {
	let generation = 0;
	let commitState: MemoryCommitState | null = null;
	let commitScope: MemoryCommitScope | null = null;
	let commitBridgeEnabled = false;
	const captureContentGuard = (): (() => boolean) => {
		const capturedGeneration = generation;
		const owner = commitState;
		const scope = commitScope;
		const stamp = owner?.capture();
		return () =>
			!disposed &&
			generation === capturedGeneration &&
			commitState === owner &&
			(!owner || (!!stamp && !!scope && owner.isCurrent(stamp, scope)));
	};
	let generationController = new AbortController();
	let observedSessionId: string | undefined;
	let disposed = false;
	const pending = new Map<string, PendingToolStep>();
	const trajectory: TrajectoryStep[] = [];
	const failures = new Map<string, FailedAttempt>();
	const deliveries: DeliveryWatch[] = [];
	/** This turn's calls in order, for the turn-end lesson pass. */
	const turnLog: string[] = [];
	/**
	 * Complete commands this session scope executed successfully, each exactly
	 * as the shell tool received it and taken only from that tool's own success
	 * receipt. A lesson is grounded by equality with one of these and by nothing
	 * else.
	 */
	const succeededCommands = new Set<string>();
	/**
	 * Excerpts of successful read results, by repository-relative path, exactly
	 * as the turn log showed them to the lesson pass. A source-cited lesson is
	 * grounded only by a quote inside one of these that the current checkout
	 * still holds (`lessonEvidence`).
	 */
	const observedReads = new Map<string, string[]>();
	const workspaceRoot = (): string => {
		try {
			return deps.workspaceRoot?.() ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};
	const lessonIsGrounded = (entry: TaskMemoryEntry): boolean =>
		lessonEvidence(entry, { succeededCommands, observedReads, workspaceRoot: workspaceRoot() }) !== null;
	let toolStep = 0;
	let lastTurnEndStep = 0;
	/**
	 * Step of the last call that changed the workspace. A failure before it
	 * belongs to an older tree: rerunning the same check after an edit is the
	 * verification the finish contract asks for, not a repeat.
	 */
	let lastWorkspaceChangeStep = 0;
	let reactivateAfterCompaction = false;
	let lastInjectedOperationFingerprint: string | null = null;
	let currentTask = "(current task unavailable)";
	let toolsSinceMemoryStep = 0;
	// Counted apart from the maintenance cadence: an interval step that fired on
	// a turn's last tools left nothing "since the last step" and starved the pass.
	let toolsSinceLessonPass = 0;
	// Shell steps since the last lesson pass. One shell command is enough for an
	// idle lesson pass; reads alone need as many tools as the turn-end pass does.
	let shellStepsSinceLessonPass = 0;
	// The last launch yielded to occupancy. Until the endpoint has room, a new
	// boundary keeps its triggers pending instead of recording another drop.
	let lastLaunchYielded = false;
	// The last launch found the model tier unavailable. Mid-turn boundaries keep
	// their triggers pending; a turn end or the guardian's recovery wake retries.
	let lastLaunchUnavailable = false;
	// The budget refused the last launch. The guardian's idle wake must not ask
	// again before the next turn boundary, or a refused step would loop.
	let lastLaunchSkipped = false;
	let consecutiveErrors = 0;
	let lastPromptedBoundary: string | null = null;
	let lastInjectedMessage: string | null = null;
	let lastDecision: TaskMemoryPolicyResult["decision"] | null = null;
	const pendingTriggers = new Set<MemoryInterventionTriggerReason>();
	const activity: TaskMemoryActivityEvent[] = [];
	const annotatedThisTurn = new Set<string>();
	let operatorAskedRepeat = false;
	let telemetryBankSnapshot = deps.bank.snapshot();
	let promptedStepInFlight = false;
	// The tier of the step currently holding the single in-flight slot, so a
	// dropped boundary can name what it was starved by.
	let promptedStepTier: TaskMemoryTelemetryTier = "rules";
	let outstandingStep: Promise<void> = Promise.resolve();
	let rulesInjectedSincePromptedStep = false;
	let annotatedSinceTurnEnd = false;
	let consecutiveLlmTimeouts = 0;

	return {
		bindCommitScope(scope) {
			commitBridgeEnabled = true;
			if (
				commitScope?.sessionId === scope.sessionId &&
				commitScope.branchAnchorTurnId === scope.branchAnchorTurnId &&
				commitState
			)
				return;
			if (commitState) reset();
			commitScope = { ...scope };
			commitState = new MemoryCommitState(scope, generation);
			observedSessionId = scope.sessionId;
		},
		notifyContextCommitted(input) {
			commitState?.notifyContextCommitted(input, generation);
		},
		prepareRestoration(currentState, maxTokens) {
			if (!commitScope || !settings().enabled) return null;
			return (
				commitState?.prepareRestoration({
					scope: commitScope,
					generation,
					bank: deps.bank.snapshot(),
					currentState,
					maxTokens: Math.min(maxTokens, settings().maxTokens),
				}) ?? null
			);
		},
		acknowledgeRestoration(offer) {
			if (!commitScope || !commitState?.acknowledgeRestoration(offer, commitScope, generation)) return false;
			deps.bank.recordInjection(offer.citedEntryIds);
			return true;
		},
		isContentCurrent: captureContentGuard,
		reset,
		dispose(): void {
			disposed = true;
			reset();
		},
		id: MEMORY_INTERVENTION_REGISTRATION_ID,
		description: "maintain bounded task execution memory and selectively remind after repeated failures or compaction",
		hooks: ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			observeSession(input);
			if (input.hook === "turn_end" || input.hook === "turn_start") lastLaunchSkipped = false;
			if (input.hook === "turn_end") notifyTurnBoundary("end");
			else if (input.hook === "turn_start" && input.metadata?.requestContinuation !== true) notifyTurnBoundary("start");
			if (disposed || !settings().enabled) return NO_EFFECTS;
			try {
				switch (input.hook) {
					case "before_tool":
						observeBeforeTool(input);
						return NO_EFFECTS;
					case "after_tool":
						return observeAfterTool(input);
					case "turn_end": {
						if (input.metadata?.stopReason === "aborted") {
							cancelStoppedTurn();
							return NO_EFFECTS;
						}
						// Middleware continuations can evaluate turn_end again without any
						// completed tools. They are not new memory boundaries and must not
						// replace the prior operator-visible outcome or emit telemetry.
						if (toolStep <= lastTurnEndStep) return NO_EFFECTS;
						settleDeliveries(false);
						// A mid-turn annotation already reported this boundary's rules-tier
						// outcome. Reporting silence again would double-count one decision.
						const alreadyReported = annotatedSinceTurnEnd;
						annotatedSinceTurnEnd = false;
						const started = process.hrtime.bigint();
						const effects = decideRepeatedFailure();
						if (alreadyReported && effects.length === 0) return effects;
						emitTelemetry(
							[effects.length > 0 ? "repeated_failure" : "turn_end"],
							"rules",
							effects.length > 0 ? "injected" : "silent",
							effects.length > 0 ? "intervened" : "no_repeated_failure",
							citedEntryCount(effects[0]?.kind === "inject_reminder" ? effects[0].message : null),
							0,
							0,
							started,
						);
						return effects;
					}
					case "on_compaction":
						// Recall grows the working set; it is an observability point, not
						// context loss that should reactivate compacted task memory.
						if (input.metadata?.stage === "working_set_recall") return NO_EFFECTS;
						if (!commitBridgeEnabled) reactivateAfterCompaction = true;
						return NO_EFFECTS;
					case "turn_start": {
						if (input.metadata?.requestContinuation !== true) {
							operatorAskedRepeat = false;
							turnLog.length = 0;
						}
						if (input.text?.trim()) {
							currentTask = shortText(input.text, 2_000);
							operatorAskedRepeat = operatorRequestsCommandRepeat(input.text);
						}
						// Mid-turn annotations are spent per turn, not per session: the same
						// command failing again in a later turn is news again.
						annotatedThisTurn.clear();
						const shouldReactivate = reactivateAfterCompaction;
						const started = process.hrtime.bigint();
						const effects = reactivateKnowledge();
						if (shouldReactivate) {
							emitTelemetry(
								["post_compaction"],
								"rules",
								effects.length > 0 ? "injected" : "silent",
								effects.length > 0 ? "intervened" : "bank_empty",
								citedEntryCount(effects[0]?.kind === "inject_reminder" ? effects[0].message : null),
								0,
								0,
								started,
							);
						}
						return effects;
					}
				}
			} catch {
				return NO_EFFECTS;
			}
		},
		/**
		 * Kicks off the background memory step and returns immediately. The pi
		 * agent does not go idle until every `agent_end` listener settles, so
		 * awaiting a local memory model here would stall the visible turn for its
		 * full latency. Small local models measure in tens of seconds, which is far
		 * past any tolerable end-of-turn pause and past the policy timeout itself.
		 * The reminder is delivered through `onDeferredReminder` instead, landing
		 * at the next native tool-batch boundary or the next submitted turn.
		 */
		async evaluateAsync(input, context): Promise<ReadonlyArray<MiddlewareEffect>> {
			observeSession(input);
			if (input.hook === "turn_end" && input.metadata?.stopReason === "aborted") {
				cancelStoppedTurn();
				return NO_EFFECTS;
			}
			const boundaryHook =
				input.hook === "turn_end" || (input.hook === "after_tool" && input.metadata?.stage === "tool_batch_end");
			if (
				input.hook === "turn_end" &&
				!disposed &&
				settings().enabled &&
				toolsSinceLessonPass >= MEMORY_INTERVENTION_TURN_END_MIN_TOOLS
			)
				pendingTriggers.add("turn_end");
			if (disposed || !settings().enabled || !boundaryHook || pendingTriggers.size === 0) return NO_EFFECTS;
			const boundary = input.turnId ?? input.metadata?.userTurnId?.toString() ?? `tool-step:${toolStep}`;
			if (boundary === lastPromptedBoundary) return NO_EFFECTS;
			// One row rather than none, so a headless operator reading the log sees
			// why the tier never ran instead of finding nothing and guessing.
			if (deps.deliversDeferredReminders === false) {
				emitTelemetry([...pendingTriggers], "rules", "silent", "no_consumer", 0, 0, 0, process.hrtime.bigint());
				pendingTriggers.clear();
				return NO_EFFECTS;
			}
			// A step slower than the turns that trigger it must not queue: dropping
			// this boundary keeps at most one background call alive per session. The
			// drop is recorded, because a starved cadence and a quiet one are
			// otherwise indistinguishable in the telemetry log. Triggers stay pending
			// so the next free boundary still runs for them.
			if (promptedStepInFlight) {
				emitTelemetry(
					[...pendingTriggers],
					promptedStepTier,
					"dropped",
					"step_in_flight",
					0,
					0,
					0,
					process.hrtime.bigint(),
				);
				return NO_EFFECTS;
			}
			if (lastLaunchYielded && endpointStillBusy()) return NO_EFFECTS;
			if (lastLaunchUnavailable && input.hook !== "turn_end") return NO_EFFECTS;
			lastPromptedBoundary = boundary;
			// The rules tier may already have spoken for this boundary, either as a
			// turn_end reminder in prior effects or as a mid-turn tool annotation.
			const priorRulesReminder =
				context?.priorEffects.some((effect) => effect.kind === "inject_reminder" && effect.message.startsWith("Memory:")) ??
				false;
			void launchPromptedStep(priorRulesReminder);
			return NO_EFFECTS;
		},
		runPromptedStep,
		pendingWork(): boolean {
			if (disposed || !settings().enabled) return false;
			return pendingTriggers.size > 0 || idleLessonWorth();
		},
		async runIdleStep(): Promise<MemoryStepLaunchOutcome> {
			if (disposed || !settings().enabled || promptedStepInFlight) return "none";
			if (deps.deliversDeferredReminders === false) return "none";
			// Checked before arming `idle_review`, which would otherwise wait for the
			// next tool boundary and run a lesson pass mid-turn.
			if (lastLaunchSkipped) return "skipped";
			if (pendingTriggers.size === 0) {
				if (!idleLessonWorth()) return "none";
				pendingTriggers.add("idle_review");
			}
			if (lastLaunchYielded && endpointStillBusy()) return "yielded";
			lastPromptedBoundary = `idle:${toolStep}`;
			return launchPromptedStep(false);
		},
		signalLoop(): void {
			if (!disposed && settings().enabled) pendingTriggers.add("loop_signal");
		},
		lastDecision: () => lastDecision,
		recentActivity: () => [...activity],
		stepInFlight: () => promptedStepInFlight,
		whenIdle: () => outstandingStep,
	};

	/**
	 * Start one detached step for every pending trigger. A step that yielded to
	 * endpoint occupancy puts its triggers back, so the work resumes at the next
	 * boundary or idle wake instead of being lost with the boundary that
	 * started it.
	 */
	function launchPromptedStep(priorRulesReminder: boolean): Promise<MemoryStepLaunchOutcome> {
		const triggers = [...pendingTriggers];
		pendingTriggers.clear();
		const priorToolsSinceMemoryStep = toolsSinceMemoryStep;
		const priorToolsSinceLessonPass = toolsSinceLessonPass;
		const priorShellStepsSinceLessonPass = shellStepsSinceLessonPass;
		const consolidates = triggers.includes("turn_end") || triggers.includes("idle_review");
		toolsSinceMemoryStep = 0;
		if (consolidates) {
			toolsSinceLessonPass = 0;
			shellStepsSinceLessonPass = 0;
		}
		consecutiveErrors = 0;
		const rulesAlreadySpoke = rulesInjectedSincePromptedStep || priorRulesReminder;
		rulesInjectedSincePromptedStep = false;
		const stepGeneration = generation;
		const contentCurrent = captureContentGuard();
		promptedStepInFlight = true;
		notifyStepActivity();
		let outcome: MemoryStepLaunchOutcome = "none";
		const settled = runPromptedStep({
			deterministicTrigger: triggers.some(
				(trigger) => trigger !== "interval" && trigger !== "turn_end" && trigger !== "idle_review",
			),
			suppressIntervention: rulesAlreadySpoke,
			triggerReasons: triggers,
		})
			.then((result) => {
				if (!contentCurrent()) return;
				if (budgetSkipped(result.reason)) {
					// Nothing was reviewed. The lesson counters come back so the next turn
					// end still covers this work; the triggers and the interval count do
					// not, so the cadence decides again instead of every tool step.
					if (consolidates) {
						toolsSinceLessonPass += priorToolsSinceLessonPass;
						shellStepsSinceLessonPass += priorShellStepsSinceLessonPass;
					}
					lastLaunchYielded = false;
					lastLaunchUnavailable = false;
					lastLaunchSkipped = true;
					outcome = "skipped";
					return;
				}
				lastLaunchSkipped = false;
				const yielded = YIELDED_REASONS.has(result.reason);
				const unavailable = UNAVAILABLE_REASONS.has(result.reason);
				if (yielded || unavailable) {
					// Nothing was reviewed: restore the work the step claimed so a later
					// step reviews it. A yielded step retries once the endpoint has room;
					// an unavailable one parks until a turn end or recovery wake.
					for (const trigger of triggers) pendingTriggers.add(trigger);
					toolsSinceMemoryStep += priorToolsSinceMemoryStep;
					if (consolidates) {
						toolsSinceLessonPass += priorToolsSinceLessonPass;
						shellStepsSinceLessonPass += priorShellStepsSinceLessonPass;
					}
					lastPromptedBoundary = null;
					lastLaunchYielded = yielded;
					lastLaunchUnavailable = unavailable;
					outcome = yielded ? "yielded" : "unavailable";
					return;
				}
				lastLaunchYielded = false;
				lastLaunchUnavailable = false;
				outcome = "ran";
				// A rules-only reminder can win the visible boundary while the optional
				// background route resolves to null. Preserve the operator-visible
				// injected outcome instead of overwriting it with that no-client silence.
				if (rulesAlreadySpoke && result.decision === "silent") lastDecision = "injected";
				if (result.reminder === null) return;
				lastInjectedMessage = result.reminder;
				deps.onDeferredReminder?.(result.reminder, contentCurrent);
			})
			.catch(() => {
				// runPromptedStep already resolves failures to silence; this only
				// covers a throwing delivery sink, which must not surface anywhere.
			})
			.finally(() => {
				if (stepGeneration === generation) promptedStepInFlight = false;
				notifyStepActivity();
			});
		outstandingStep = settled;
		return settled.then(() => outcome);
	}

	/**
	 * Completed activity the turn-end pass did not cover is worth an idle lesson
	 * pass: any shell work, or source investigation of the size the turn-end
	 * pass itself requires. A source-only fact is reviewable; its lesson is
	 * filed without a command and waits for the operator.
	 */
	function idleLessonWorth(): boolean {
		return (
			toolsSinceLessonPass > 0 &&
			(shellStepsSinceLessonPass > 0 || toolsSinceLessonPass >= MEMORY_INTERVENTION_TURN_END_MIN_TOOLS)
		);
	}

	function endpointStillBusy(): boolean {
		try {
			return deps.backgroundEndpointBusy?.() === true;
		} catch {
			// Unreadable occupancy fails closed: stay yielded rather than pile on.
			return true;
		}
	}

	function notifyTurnBoundary(kind: "start" | "end"): void {
		try {
			deps.onTurnBoundary?.(kind);
		} catch {
			// A wake signal never affects the turn it was raised from.
		}
	}

	function notifyStepActivity(): void {
		try {
			deps.onStepActivity?.();
		} catch {
			// Status refresh is observability; it never steers a step.
		}
	}

	function observeSession(input: MiddlewareHookInput): void {
		if (input.sessionId === undefined) return;
		if (observedSessionId !== undefined && observedSessionId !== input.sessionId) reset();
		observedSessionId = input.sessionId;
	}

	function cancelStoppedTurn(): void {
		if (!promptedStepInFlight && pendingTriggers.size === 0 && toolStep <= lastTurnEndStep) return;
		const tier = promptedStepInFlight ? promptedStepTier : "rules";
		// Retain completed bank entries, but revoke pending content and delivery
		// authority. Late provider usage still belongs to its captured origin.
		generation += 1;
		commitState?.cancel(generation);
		generationController.abort();
		generationController = new AbortController();
		promptedStepInFlight = false;
		outstandingStep = Promise.resolve();
		pendingTriggers.clear();
		toolsSinceMemoryStep = 0;
		consecutiveErrors = 0;
		lastTurnEndStep = toolStep;
		rulesInjectedSincePromptedStep = false;
		annotatedSinceTurnEnd = false;
		lastDecision = "silent";
		emitTelemetry(["turn_end"], tier, "silent", "scope_changed", 0, 0, 0, process.hrtime.bigint());
	}

	function reset(): void {
		try {
			const lessons = deps.bank.snapshot().knowledge.filter((entry) => entry.durable === true);
			if (lessons.length > 0) deps.onScopeEnd?.({ sessionId: observedSessionId, lessons });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
		settleDeliveries(true);
		commitState?.dispose();
		commitState = null;
		commitScope = null;
		generation += 1;
		generationController.abort();
		generationController = new AbortController();
		deps.bank.clear();
		pending.clear();
		turnLog.length = 0;
		succeededCommands.clear();
		observedReads.clear();
		trajectory.length = 0;
		failures.clear();
		toolStep = 0;
		lastTurnEndStep = 0;
		lastWorkspaceChangeStep = 0;
		reactivateAfterCompaction = false;
		lastInjectedOperationFingerprint = null;
		currentTask = "(current task unavailable)";
		toolsSinceMemoryStep = 0;
		toolsSinceLessonPass = 0;
		shellStepsSinceLessonPass = 0;
		lastLaunchYielded = false;
		lastLaunchUnavailable = false;
		lastLaunchSkipped = false;
		consecutiveErrors = 0;
		lastPromptedBoundary = null;
		lastInjectedMessage = null;
		lastDecision = null;
		pendingTriggers.clear();
		activity.length = 0;
		annotatedThisTurn.clear();
		operatorAskedRepeat = false;
		telemetryBankSnapshot = deps.bank.snapshot();
		promptedStepInFlight = false;
		promptedStepTier = "rules";
		outstandingStep = Promise.resolve();
		rulesInjectedSincePromptedStep = false;
		annotatedSinceTurnEnd = false;
		consecutiveLlmTimeouts = 0;
		observedSessionId = undefined;
	}

	function settings(): MemoryInterventionSettings {
		const live = deps.getSettings?.();
		return {
			enabled: live?.enabled ?? deps.enabled ?? true,
			everyNTools: Math.max(
				2,
				positiveInteger(live?.everyNTools ?? deps.everyNTools, MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS),
			),
			windowSteps: positiveInteger(live?.windowSteps ?? deps.windowSteps, MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS),
			maxTokens: positiveInteger(live?.maxTokens ?? deps.maxTokens, MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS),
			timeoutMs: positiveInteger(live?.timeoutMs ?? deps.timeoutMs, TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS),
		};
	}

	async function runPromptedStep(input: MemoryPromptedStepInput): Promise<MemoryPromptedStepResult> {
		const silent = (reason: TaskMemoryPolicyReason): MemoryPromptedStepResult => ({
			decision: "silent",
			reason,
			bankOperations: 0,
			droppedOperations: 0,
			reminder: null,
			inputTokens: 0,
			outputTokens: 0,
			usage: null,
			presentedEntries: [],
			effects: NO_EFFECTS,
		});
		const live = settings();
		const stepGeneration = generation;
		const isCurrent = captureContentGuard();
		const isUsageCurrent = () => !disposed && stepGeneration === generation;
		const usageSink = deps.captureStepUsage?.();
		if (disposed || !live.enabled) {
			const result = silent("no_client");
			lastDecision = result.decision;
			return result;
		}
		const started = process.hrtime.bigint();
		let attemptStarted = started;
		// The route of the attempt the next telemetry row describes. Fallback swaps it
		// with the client, so a row names the target that actually served the step.
		let attemptRoute: TaskMemoryRoute | undefined;
		const triggers = input.triggerReasons?.length ? input.triggerReasons : ["manual" as const];
		// A finished turn gets the lesson pass in place of bank maintenance: one
		// call either way, and the mid-turn steps already kept the bank current.
		const consolidate =
			input.triggerReasons?.includes("turn_end") === true || input.triggerReasons?.includes("idle_review") === true;
		let tier: TaskMemoryTelemetryTier = "rules";
		promptedStepTier = tier;
		let promptedResult: TaskMemoryPolicyResult;
		// A boundary that never reached the model is a skipped boundary rather than
		// a policy decision, and `dropped` is the telemetry outcome for exactly
		// that. The returned decision stays `silent`, since no reminder was
		// produced and the policy vocabulary has no value for a step that never ran.
		let telemetryDecision: TaskMemoryTelemetryDecision | null = null;
		try {
			if (consecutiveLlmTimeouts >= MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD) {
				promptedResult = silent("llm_timeout_backoff");
			} else {
				const client = deps.getModelClient?.() ?? null;
				if (client === null) {
					promptedResult = silent("no_client");
				} else if (deps.backgroundEndpointBusy?.() === true) {
					tier = "llm";
					promptedStepTier = tier;
					attemptRoute = client.route;
					promptedResult = silent("endpoint_busy");
					telemetryDecision = "dropped";
				} else {
					tier = "llm";
					promptedStepTier = tier;
					const runClient = (selected: TaskMemoryModelClient, timeoutMs: number) => {
						attemptRoute = selected.route;
						return runTaskMemoryPolicy(deps.bank, selected, {
							isCurrent,
							signal: generationController.signal,
							onStepUsage: (usage) => {
								if (usageSink) usageSink(usage, isUsageCurrent());
								else deps.onStepUsage?.(usage);
							},
							task: input.task?.trim() || currentTask,
							trajectory: [...trajectory],
							deterministicTrigger: input.deterministicTrigger,
							maxTokens: live.maxTokens,
							modelMaxTokens: positiveInteger(deps.getModelMaxTokens?.(live.maxTokens), live.maxTokens),
							...(input.suppressIntervention === undefined ? {} : { suppressIntervention: input.suppressIntervention }),
							...(consolidate
								? {
										pass: {
											systemPrompt: MEMORY_CONSOLIDATION_SYSTEM_PROMPT,
											trajectoryText: turnLog.join("\n"),
											keptLessons: keptLessonsForPass(),
										},
									}
								: {}),
							previousReminder: lastInjectedMessage,
							timeoutMs,
							...(deps.onEnvelope === undefined
								? {}
								: {
										onEnvelope: (envelope: TaskMemoryEnvelope) => {
											if (isCurrent()) deps.onEnvelope?.(envelope);
										},
									}),
						});
					};
					const remainingMs = () => Math.floor(live.timeoutMs - Number(process.hrtime.bigint() - started) / 1_000_000);
					const initialTimeoutMs = remainingMs();
					promptedResult =
						initialTimeoutMs <= 0
							? { ...silent("deadline"), decision: "timeout" }
							: await runClient(client, initialTimeoutMs);
					if (
						(promptedResult.reason === "client_error" || promptedResult.reason === "information_flow_blocked") &&
						isCurrent() &&
						remainingMs() > 0
					) {
						let fallback: TaskMemoryModelClient | null = null;
						let fallbackReady = false;
						try {
							fallback = deps.getFallbackModelClient?.() ?? null;
							fallbackReady = fallback !== null && deps.backgroundEndpointBusy?.() !== true;
						} catch {
							/* Fail closed and preserve the original call if routing or capacity is unreadable. */
						}
						const fallbackTimeoutMs = remainingMs();
						if (fallback !== null && fallbackReady && isCurrent() && fallbackTimeoutMs > 0) {
							// Each attempted call keeps its own telemetry and origin usage.
							// The returned policy result describes the final attempt only.
							emitTelemetry(
								triggers,
								tier,
								promptedResult.decision,
								promptedResult.reason,
								0,
								promptedResult.inputTokens,
								promptedResult.outputTokens,
								started,
								{
									bankOperations: promptedResult.bankOperations,
									droppedOperations: promptedResult.droppedOperations,
									...(promptedResult.refusalReason === undefined ? {} : { refusalReason: promptedResult.refusalReason }),
								},
								attemptRoute,
							);
							attemptStarted = process.hrtime.bigint();
							promptedResult = await runClient(fallback, fallbackTimeoutMs);
						}
					}
				}
			}
		} catch (error) {
			// runTaskMemoryPolicy resolves its own failures, so reaching here means
			// resolving the client itself threw. That is still a broken route.
			promptedResult = silent("client_error");
			if (isCurrent())
				deps.onEnvelope?.({
					systemPrompt: "",
					userPrompt: "",
					response: "",
					decision: "silent",
					reason: "client_error",
					bankOperations: 0,
					droppedOperations: 0,
					reminder: null,
					error: error instanceof Error ? error.message : "resolving the background model client failed",
				});
		}
		if (!isCurrent()) return { ...promptedResult, reminder: null, effects: NO_EFFECTS };
		if (YIELDED_REASONS.has(promptedResult.reason) || budgetSkipped(promptedResult.reason)) telemetryDecision = "dropped";
		if (tier === "llm" && promptedResult.decision === "timeout") consecutiveLlmTimeouts += 1;
		else if (tier === "llm" && telemetryDecision !== "dropped") consecutiveLlmTimeouts = 0;
		lastDecision = promptedResult.decision;
		if (promptedResult.decision === "injected") reportInjectedEntries(promptedResult.reminder);
		// Exactly the entries the answered call's prompt was rendered from. An
		// entry cut for budget was never put in front of the model, so its silence
		// about it says nothing.
		if (tier === "llm" && !UNANSWERED_REASONS.has(promptedResult.reason)) {
			reviewKnowledge(promptedResult.presentedEntries.filter((entry) => entry.kind === "knowledge"));
		}
		if (promptedResult.retiredLessonIds !== undefined) {
			try {
				deps.onKeptLessonsRetired?.(promptedResult.retiredLessonIds);
			} catch {
				// Same contract as onInjectedEntries: the store's failure is not the session's.
			}
		}
		emitTelemetry(
			triggers,
			tier,
			telemetryDecision ?? promptedResult.decision,
			promptedResult.reason,
			citedEntryCount(promptedResult.reminder),
			promptedResult.inputTokens,
			promptedResult.outputTokens,
			attemptStarted,
			{
				bankOperations: promptedResult.bankOperations,
				droppedOperations: promptedResult.droppedOperations,
				...(promptedResult.refusalReason === undefined ? {} : { refusalReason: promptedResult.refusalReason }),
				...(promptedResult.resumeAt === undefined ? {} : { resumeAt: promptedResult.resumeAt }),
			},
			attemptRoute,
		);
		return {
			...promptedResult,
			effects:
				promptedResult.reminder === null
					? NO_EFFECTS
					: [
							{
								kind: "inject_reminder",
								message: promptedResult.reminder,
								severity: "advisory",
								source: "memory",
								audience: "model",
							},
						],
		};
	}

	function emitTelemetry(
		triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>,
		tier: TaskMemoryTelemetryTier,
		decision: TaskMemoryTelemetryDecision,
		reason: TaskMemoryPolicyReason,
		citedEntries: number,
		inputTokens: number,
		outputTokens: number,
		started: bigint,
		operations: { bankOperations: number; droppedOperations: number; refusalReason?: string; resumeAt?: string } = {
			bankOperations: 0,
			droppedOperations: 0,
		},
		route?: TaskMemoryRoute,
	): void {
		const next = deps.bank.snapshot();
		const bankDelta = taskMemoryBankDelta(telemetryBankSnapshot, next);
		telemetryBankSnapshot = next;
		const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
		try {
			deps.telemetry?.record({
				triggerReasons,
				tier,
				bankDelta,
				decision,
				reason,
				bankOperations: operations.bankOperations,
				droppedOperations: operations.droppedOperations,
				...(operations.refusalReason === undefined ? {} : { refusalReason: operations.refusalReason }),
				citedEntries,
				inputTokens,
				outputTokens,
				latencyMs,
				...(route === undefined ? {} : { route }),
				...(operations.resumeAt === undefined ? {} : { resumeAt: operations.resumeAt }),
			});
		} catch {
			// Observability must never steer or block the memory policy.
		}
		const event: TaskMemoryActivityEvent = {
			at: new Date().toISOString(),
			triggerReasons: [...new Set(triggerReasons)],
			tier,
			decision,
			reason,
			citedEntries,
			bankWrites: countBankWrites(bankDelta),
			latencyMs,
			...(operations.resumeAt === undefined ? {} : { resumeAt: operations.resumeAt }),
		};
		activity.unshift(event);
		if (activity.length > MEMORY_INTERVENTION_ACTIVITY_LIMIT) activity.length = MEMORY_INTERVENTION_ACTIVITY_LIMIT;
	}

	function citedEntries(message: string | null): TaskMemoryEntry[] {
		if (message === null) return [];
		const snapshot = deps.bank.snapshot();
		return [...snapshot.knowledge, ...snapshot.procedural].filter((entry) => message.includes(`[${entry.id}]`));
	}

	function citedEntryCount(message: string | null): number {
		return citedEntries(message).length;
	}

	/**
	 * Hand the cited entries to the durable store.
	 *
	 * Only the model tier reports here. A rules-tier reminder cites an entry this
	 * middleware wrote itself out of one repeated tool failure, and proposing
	 * every one of those as a durable lesson would fill the operator's review
	 * queue with rows nobody asked for. The model tier's entries are the ones the
	 * background plane produced, which is what #229 asks to be reviewable.
	 */
	function reportInjectedEntries(reminder: string | null): void {
		if (deps.onInjectedEntries === undefined) return;
		const entries = citedEntries(reminder);
		if (entries.length === 0) return;
		try {
			deps.onInjectedEntries(entries);
		} catch {
			// A failing store is the composition root's problem to report, never a
			// reason to fail the step that produced the reminder.
			return;
		}
		deliveries.push({
			entries: entries.map((entry) => ({ id: entry.id, content: entry.content })),
			step: toolStep,
			fingerprints: new Set(
				trajectory.filter((step) => step.outcome === "error").map((step) => step.operationFingerprint),
			),
			recurrences: 0,
			heldReported: false,
		});
		if (deliveries.length > MEMORY_DELIVERY_WATCH_LIMIT) deliveries.shift();
	}

	function keptLessonsForPass(): ReadonlyArray<{ id: string; text: string }> {
		try {
			return deps.getKeptLessons?.() ?? [];
		} catch {
			return [];
		}
	}

	function reviewKnowledge(before: ReadonlyArray<TaskMemoryEntry>): void {
		if (deps.onKnowledgeReview === undefined) return;
		const after = new Map(deps.bank.snapshot().knowledge.map((entry) => [entry.id, entry]));
		// Only entries the model filed as lessons. Plain knowledge is a fact about
		// the task in hand and goes stale with it.
		const lessons = before.filter((entry) => entry.durable === true);
		if (lessons.length === 0) return;
		const unchanged = lessons.filter((entry) => after.get(entry.id)?.content === entry.content);
		// Grounding reads the live entry: the evidence command is part of what the
		// model kept, and it has to equal a command the host ran.
		const kept = unchanged.filter((entry) => {
			const live = after.get(entry.id);
			return live !== undefined && lessonIsGrounded(live);
		});
		const ungrounded = unchanged.filter((entry) => !kept.includes(entry));
		const withdrawn = lessons.filter((entry) => after.get(entry.id)?.content !== entry.content);
		try {
			deps.onKnowledgeReview({ kept, withdrawn, ungrounded });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	/**
	 * Report deliveries whose outcome is decided. A reminder is contradicted when
	 * a failure it was written about keeps recurring, and held once the session
	 * moved on without one. A held delivery stays in the bounded watch list, so
	 * the same failure returning later in the session still contradicts it; an
	 * undecided one is dropped at scope end rather than guessed at.
	 */
	function settleDeliveries(final: boolean): void {
		const outcomes: MemoryDeliveryOutcome[] = [];
		for (let index = deliveries.length - 1; index >= 0; index -= 1) {
			const watch = deliveries[index];
			if (watch === undefined) continue;
			if (watch.recurrences >= MEMORY_DELIVERY_CONTRADICTED_RECURRENCES) {
				deliveries.splice(index, 1);
				outcomes.push({ entries: watch.entries, kind: "contradicted" });
			} else if (
				!watch.heldReported &&
				watch.recurrences === 0 &&
				toolStep - watch.step >= MEMORY_DELIVERY_HELD_MIN_STEPS
			) {
				watch.heldReported = true;
				const bank = deps.bank.snapshot().knowledge;
				const grounded = watch.entries.filter((delivered) => {
					const entry = bank.find((candidate) => candidate.id === delivered.id);
					return entry !== undefined && entry.content === delivered.content && lessonIsGrounded(entry);
				});
				if (grounded.length > 0) outcomes.push({ entries: grounded, kind: "held" });
			}
		}
		if (final) deliveries.length = 0;
		if (outcomes.length === 0 && !final) return;
		try {
			deps.onDeliveryOutcomes?.(outcomes, final);
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	function observeBeforeTool(input: MiddlewareHookInput): void {
		const prepared = prepareToolStep(input);
		if (prepared === null) return;
		setBounded(pending, pendingKey(input, prepared.operationFingerprint), prepared, settings().windowSteps);
	}

	function observeAfterTool(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
		const fallback = prepareToolStep(input);
		if (fallback === null) return NO_EFFECTS;
		const key = pendingKey(input, fallback.operationFingerprint);
		const prepared = pending.get(key) ?? fallback;
		pending.delete(key);
		const outcome = input.metadata?.resultKind === "error" ? "error" : "ok";
		toolStep += 1;
		toolsSinceMemoryStep += 1;
		toolsSinceLessonPass += 1;
		if (prepared.toolName === ToolNames.Bash) shellStepsSinceLessonPass += 1;
		const live = settings();
		if (toolsSinceMemoryStep >= live.everyNTools) pendingTriggers.add("interval");
		if (outcome === "error") {
			for (const watch of deliveries) {
				if (watch.fingerprints.has(prepared.operationFingerprint)) watch.recurrences += 1;
			}
			consecutiveErrors += 1;
			if (consecutiveErrors >= 2 && !operatorAskedRepeat) pendingTriggers.add("tool_error_streak");
		} else {
			consecutiveErrors = 0;
		}
		const digest = resultDigest(input, outcome);
		const step: TrajectoryStep = {
			...prepared,
			step: toolStep,
			outcome,
			resultDigest: digest.text,
			resultDigestProvenance: digest.provenance,
		};
		// The registry passes whatever arguments the model sent, so a `command`
		// field on a read or a write proves nothing ran. Only the shell tool's own
		// success receipt does: its name, an ok result, and a zero exit it reported.
		const command =
			prepared.toolName === ToolNames.Bash && typeof input.toolArgs?.command === "string" ? input.toolArgs.command : null;
		if (
			command !== null &&
			input.metadata?.resultKind === "ok" &&
			input.toolResultDetails?.outcome === "success" &&
			input.toolResultDetails?.exitCode === 0
		) {
			// The complete command and nothing derived from it. Splitting a chain
			// into its parts needs a shell parser to be right: `echo 'a && npm test'`
			// and `true # && npm test` both succeed without running `npm test`.
			rememberSucceededCommand(command);
		}
		const readPath =
			prepared.toolName === ToolNames.Read && outcome === "ok" && typeof input.toolArgs?.path === "string"
				? repositoryRelativePath(input.toolArgs.path, [workspaceRoot()])
				: null;
		// A successful read carries a bounded excerpt of what it returned, so the
		// lesson pass can quote the source a fact came from. The excerpt is also
		// the only text that read can later vouch for.
		const readExcerpt = readPath === null ? "" : shortText(digest.text, TURN_LOG_READ_EXCERPT_CHARS);
		if (readPath !== null) recordObservedRead(observedReads, readPath, readExcerpt);
		const excerpt = outcome === "error" ? ` => ${shortText(digest.text, 160)}` : readExcerpt ? ` => ${readExcerpt}` : "";
		turnLog.push(
			`${toolStep}. ${outcome === "ok" ? "ok" : "FAILED"}: ${shortText(command ?? prepared.callDescription, TURN_LOG_CALL_MAX_CHARS)}${excerpt}`,
		);
		observeChainSteps(prepared.toolName, input);
		while (turnLog.length > TURN_LOG_LIMIT) turnLog.shift();
		trajectory.push(step);
		if (trajectory.length > live.windowSteps) trajectory.splice(0, trajectory.length - live.windowSteps);
		if (outcome === "ok" && WORKSPACE_CHANGING_CLASSES.has(String(input.metadata?.actionClass))) {
			lastWorkspaceChangeStep = toolStep;
		}
		if (input.metadata?.resultKind === "ok") {
			// Only an explicit receipt for this exact operation closes its failure
			// episode. Keep the bank entry and trajectory as history; this does not
			// verify the surrounding task or reinterpret tool exit classifications.
			failures.delete(step.operationFingerprint);
			annotatedThisTurn.delete(step.operationFingerprint);
			if (lastInjectedOperationFingerprint === step.operationFingerprint) lastInjectedOperationFingerprint = null;
		}
		if (outcome !== "error") return NO_EFFECTS;
		rememberFailure(step);
		return annotateRepeatedFailure(step);
	}

	function rememberSucceededCommand(command: string): void {
		succeededCommands.add(command);
		if (succeededCommands.size > VERIFIED_COMMAND_LIMIT) {
			succeededCommands.delete(succeededCommands.values().next().value ?? command);
		}
	}

	/**
	 * A gateway chain ran real steps under one outer call. Its settled, admitted
	 * children (the canonical receipts every other ledger reader expands) add
	 * their own lesson-log lines and evidence: a shell child's exact command when
	 * it reported success with exit 0, a read child's excerpt as shown. The
	 * outer call keeps its single trajectory step, failure episode and
	 * reminder semantics; a failed or blocked child is logged and proves nothing.
	 */
	function observeChainSteps(toolName: string, input: MiddlewareHookInput): void {
		const children = gatewayChainReceipts(toolName, { details: input.toolResultDetails });
		for (const child of children) {
			const details = isPlainRecord(child.result.details) ? child.result.details : {};
			const settled = child.admission.outcome === "ok" && child.admission.decision === "allowed" && details.kind === "ok";
			const label = `${toolStep}.${child.id}`;
			if (child.capability === ToolNames.Bash && typeof child.args.command === "string") {
				shellStepsSinceLessonPass += 1;
				const succeeded = settled && details.outcome === "success" && details.exitCode === 0;
				if (succeeded) rememberSucceededCommand(child.args.command);
				turnLog.push(`${label} ${succeeded ? "ok" : "FAILED"}: ${shortText(child.args.command, TURN_LOG_CALL_MAX_CHARS)}`);
				continue;
			}
			const path =
				settled && child.capability === ToolNames.Read && typeof child.args.path === "string"
					? repositoryRelativePath(child.args.path, [workspaceRoot()])
					: null;
			const excerpt =
				path === null ? "" : shortText(redactSecretString(chainChildText(child.result)), TURN_LOG_READ_EXCERPT_CHARS);
			if (path !== null) recordObservedRead(observedReads, path, excerpt);
			turnLog.push(
				`${label} ${settled ? "ok" : "FAILED"}: ${shortText(`${child.capability}${path === null ? "" : ` ${path}`}`, TURN_LOG_CALL_MAX_CHARS)}${excerpt ? ` => ${excerpt}` : ""}`,
			);
		}
	}

	/**
	 * The turn-end reminder channel cannot reach a model that is still mid-turn,
	 * and a long agentic turn is exactly where a repeated failure burns its
	 * budget. A second identical failure therefore rides back on the tool result
	 * itself, which the model reads on its very next round.
	 */
	function annotateRepeatedFailure(step: TrajectoryStep): ReadonlyArray<MiddlewareEffect> {
		if (operatorAskedRepeat || annotatedThisTurn.has(step.operationFingerprint)) return NO_EFFECTS;
		const failure = failures.get(step.operationFingerprint);
		if (failure === undefined) return NO_EFFECTS;
		const occurrences = trajectory.filter(
			(candidate) =>
				candidate.outcome === "error" &&
				candidate.operationFingerprint === step.operationFingerprint &&
				// The same command failing differently is progress, not a repeat: a
				// live session reran its tests after generating a missing module, got an
				// assertion failure instead of a load error, and was told it had already
				// tried that.
				candidate.resultDigest === step.resultDigest &&
				candidate.step >= failure.firstStep &&
				candidate.step > lastWorkspaceChangeStep,
		).length;
		if (occurrences < 2) return NO_EFFECTS;
		const message = boundedReminder(
			`Memory: [${failure.entryId}] you already tried ${failure.callDescription} at step ${failure.firstStep} and it failed with ${failure.errorDigest}. Change the approach rather than repeating it.`,
			settings().maxTokens,
		);
		if (message.length === 0) return NO_EFFECTS;
		annotatedThisTurn.add(step.operationFingerprint);
		// Claim the turn-end channel too, so one repeated failure is surfaced once.
		lastInjectedOperationFingerprint = step.operationFingerprint;
		lastDecision = "injected";
		rulesInjectedSincePromptedStep = true;
		annotatedSinceTurnEnd = true;
		deps.bank.recordInjection([failure.entryId]);
		emitTelemetry(["repeated_failure"], "rules", "injected", "intervened", 1, 0, 0, process.hrtime.bigint());
		return [{ kind: "annotate_tool_result", message, severity: "warn" }];
	}

	function rememberFailure(step: TrajectoryStep): void {
		const previous = failures.get(step.operationFingerprint);
		const attempts = (previous?.attempts ?? 0) + 1;
		const firstStep = previous?.firstStep ?? step.step;
		const content = proceduralContent(step.callDescription, attempts, firstStep, step.resultDigest);
		let entryId: string;
		if (previous === undefined) {
			entryId = deps.bank.saveProcedural(content).id;
		} else {
			try {
				entryId = deps.bank.saveProcedural(content, { id: previous.entryId }).id;
			} catch {
				entryId = deps.bank.saveProcedural(content).id;
			}
		}
		setBounded(
			failures,
			step.operationFingerprint,
			{
				entryId,
				attempts,
				firstStep,
				callDescription: step.callDescription,
				errorDigest: step.resultDigest,
			},
			TASK_MEMORY_DEFAULT_PROCEDURAL_CAP,
		);
	}

	function decideRepeatedFailure(): ReadonlyArray<MiddlewareEffect> {
		try {
			if (operatorAskedRepeat) {
				lastDecision = "silent";
				return NO_EFFECTS;
			}
			for (let index = trajectory.length - 1; index >= 0; index -= 1) {
				const step = trajectory[index];
				if (
					step === undefined ||
					step.outcome !== "error" ||
					step.step <= lastTurnEndStep ||
					step.operationFingerprint === lastInjectedOperationFingerprint
				) {
					continue;
				}
				const failure = failures.get(step.operationFingerprint);
				if (failure === undefined || step.step < failure.firstStep) continue;
				const occurrences = trajectory.filter(
					(candidate) =>
						candidate.outcome === "error" &&
						candidate.operationFingerprint === step.operationFingerprint &&
						candidate.resultDigest === step.resultDigest &&
						candidate.step >= failure.firstStep &&
						candidate.step > lastWorkspaceChangeStep,
				).length;
				if (occurrences < 2) continue;
				const message = boundedReminder(
					`Memory: [${failure.entryId}] you already tried ${failure.callDescription} at step ${failure.firstStep} and it failed with ${failure.errorDigest}.`,
					settings().maxTokens,
				);
				if (message.length === 0) return NO_EFFECTS;
				lastInjectedOperationFingerprint = step.operationFingerprint;
				lastInjectedMessage = message;
				lastDecision = "injected";
				rulesInjectedSincePromptedStep = true;
				deps.bank.recordInjection([failure.entryId]);
				return [{ kind: "inject_reminder", message, severity: "advisory", source: "memory", audience: "model" }];
			}
			lastDecision = "silent";
			return NO_EFFECTS;
		} finally {
			lastTurnEndStep = toolStep;
		}
	}

	function reactivateKnowledge(): ReadonlyArray<MiddlewareEffect> {
		if (!reactivateAfterCompaction) return NO_EFFECTS;
		reactivateAfterCompaction = false;
		const prefix = "Memory: execution state restored after compaction:\n";
		const maxTokens = settings().maxTokens;
		const prefixTokens = ceilChars(prefix.length);
		const rendered = deps.bank.renderRestoredState(Math.max(0, maxTokens - prefixTokens));
		if (rendered.length === 0) {
			lastDecision = "silent";
			return NO_EFFECTS;
		}
		const message = boundedReminder(`${prefix}${rendered}`, maxTokens);
		if (message.length === 0) {
			lastDecision = "silent";
			return NO_EFFECTS;
		}
		const citedIds = [...message.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]).filter((id) => id !== undefined);
		deps.bank.recordInjection(citedIds);
		lastInjectedMessage = message;
		lastDecision = "injected";
		return [{ kind: "inject_reminder", message, severity: "advisory", source: "memory", audience: "model" }];
	}
}

/** Action classes whose successful call can change what a rerun of a failed check sees. */
const WORKSPACE_CHANGING_CLASSES: ReadonlySet<string> = new Set([
	"write",
	"system_modify",
	"git_destructive",
	"dispatch",
]);

function prepareToolStep(input: MiddlewareHookInput): PendingToolStep | null {
	const toolName = input.toolName?.trim();
	if (!toolName) return null;
	const canonical = hashToolCall(toolName, input.toolArgs ?? {});
	// Host preparation artifacts belong to exact identity, not descriptive
	// context. Keep public arguments so memory can explain what was attempted.
	const publicArgs = Object.fromEntries(
		Object.entries(input.toolArgs ?? {}).filter(
			([key]) => key !== RESOLVED_DISPATCH_PLAN_ARGUMENT && key !== DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
		),
	);
	return {
		toolName,
		operationFingerprint: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
		callDescription: shortText(
			Object.keys(publicArgs).length > 0
				? `${toolName} ${hashToolCall("", publicArgs)}`
				: toolName === "dispatch"
					? "dispatch plan preparation"
					: toolName,
			CALL_DESCRIPTION_MAX_CHARS,
		),
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The model-facing text a settled chain step returned. */
function chainChildText(result: unknown): string {
	const content = isPlainRecord(result) && Array.isArray(result.content) ? result.content : [];
	return content
		.map((block) => (isPlainRecord(block) && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function pendingKey(input: MiddlewareHookInput, operationFingerprint: string): string {
	return input.toolCallId ?? `anonymous:${operationFingerprint}`;
}

function resultDigest(input: MiddlewareHookInput, outcome: ToolOutcome): ToolResultDigest {
	if (input.toolResultDigest !== undefined) return sanitizeToolResultDigest(input.toolResultDigest);
	if (outcome === "error") {
		const metadataMessage = input.metadata?.errorMessage;
		if (typeof metadataMessage === "string" && metadataMessage.trim().length > 0) {
			return legacyToolResultDigest(diagnosticLine(metadataMessage), { outcome });
		}
		for (const key of ["error", "message"] as const) {
			const value = input.toolResultDetails?.[key];
			if (typeof value === "string" && value.trim().length > 0) {
				return legacyToolResultDigest(diagnosticLine(value), { outcome });
			}
		}
		return legacyToolResultDigest("", { outcome });
	}
	const resultFingerprint = input.metadata?.resultFingerprint;
	return legacyToolResultDigest(
		typeof resultFingerprint === "string" ? `ok result ${resultFingerprint.slice(0, 16)}` : "ok",
		{ outcome },
	);
}

const DIAGNOSTIC_HINT =
	/\b(error|failed|failure|cannot|unable|expected|refused|denied|missing|not found|timed out|timeout|fatal)\b/iu;

/**
 * A runtime opens its output with its own frame pointer, not with the diagnosis,
 * and closes it with paths that repeat the command. The bounded digest is the
 * whole advisory a model reads, so it spends that budget on the first line that
 * names a problem and falls back to the first line when none does.
 */
function diagnosticLine(value: string): string {
	const lines = value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.find((line) => DIAGNOSTIC_HINT.test(line)) ?? lines[0] ?? "";
}

function proceduralContent(call: string, attempts: number, firstStep: number, error: string): string {
	return `${call} failed ${attempts} time${attempts === 1 ? "" : "s"}; first observed at step ${firstStep}: ${error}.`;
}

function boundedReminder(message: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (maxChars <= 0) return "";
	const normalized = message.replace(/[^\S\n]+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars).trimEnd();
}

function shortText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function countBankWrites(delta: TaskMemoryBankDelta): number {
	return [delta.status, delta.knowledge, delta.procedural].reduce(
		(total, entry) => total + entry.added + entry.updated + entry.deleted,
		0,
	);
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
	if (!map.has(key) && map.size >= capacity) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}
