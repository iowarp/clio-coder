/**
 * The chat loop: one turn's state machine.
 *
 * Composition of single-owner turn modules:
 *   - turn-runtime.ts      target resolution, hot-swap, agent + event pipeline
 *   - turn-context.ts      prompt compile cache, snapshots, compaction
 *   - turn-persistence.ts  session-ledger appends
 *   - turn-queues.ts       steer/follow-up mirror, stranded-steer resubmit
 *   - turn-recovery.ts     overflow compact-and-retry, transient retry chain
 *   - turn-middleware.ts   turn hooks and the reminder buffer
 *
 * This file owns the ChatLoop public surface, the submit/cancel state
 * machine, and the shared ChatTurnState the modules coordinate through.
 */

import { BusChannels, type RunAbortSource } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { PendingSkillRequest } from "../core/skill-activation.js";
import { clioStateDir } from "../core/xdg.js";
import {
	createMiddlewareToolChoiceControl,
	type MiddlewareContract,
	type MiddlewareToolChoiceControl,
} from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { CostEntryLabel } from "../domains/observability/cost.js";
import { appendOutOfTurnUsageRow, type OutOfTurnUsageRow } from "../domains/observability/out-of-turn-usage.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import {
	canonicalEndpointKey,
	normalizeCostProvenance,
	registerForegroundStream,
	runtimeTargetSnapshot,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import type { CompactResult } from "../domains/session/compaction/compact.js";
import type { ContextSnapshot, ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import { ceilChars, snapshotInputTokens } from "../domains/session/context-accounting.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { protectedArtifactStateFromSessionEntries } from "../domains/session/protected-artifacts.js";
import { isRetryableErrorMessage, type RetrySettings } from "../domains/session/retry.js";
import { createEngineAgent } from "../engine/agent.js";
import { resolveReservedOutputTokens } from "../engine/apis/output-budget.js";
import { cwdHash } from "../engine/session.js";
import type { AgentEvent, AgentMessage, ImageContent, Usage } from "../engine/types.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import { finalizeAskUserInterviewForHost } from "../tools/ask-user.js";
import type { AskUserToolPolicy, ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";
import {
	createAskUserToolPolicy,
	createPendingSkillToolPolicy,
	detectOverflowFromState,
	detectTerminalFailureFromState,
	notConfiguredNotice,
	noticeMessage,
	pendingSkillRequestPreamble,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import { normalizeRetrySettings } from "./chat-loop-policy.js";
import { type HandoffRepairInput, runHandoffRound } from "./handoff-round.js";
import type { ApprovalRequestView } from "./permission-overlay.js";
import type { runPrewarmRound } from "./prewarm.js";
import { runSideQuestion, type SideQuestionResult, sideQuestionUsage } from "./side-question.js";
import type { AgentStatusEvent } from "./status/types.js";
import { createTurnContext } from "./turn-context.js";
import { createTurnMiddleware } from "./turn-middleware.js";
import { createTurnPersistence } from "./turn-persistence.js";
import { createTurnPrewarm, type PrewarmOutcome, subscribePrewarmToCompaction } from "./turn-prewarm.js";
import {
	createTurnQueues,
	DEFAULT_STEERING_MODE,
	type QueuedChatMessage,
	type QueuedMessagesSnapshot,
	type SteeringMode,
} from "./turn-queues.js";
import {
	createTurnRecovery,
	type RetryStatusEvent,
	reclassifyStallAbort,
	rewriteStallAbortMessage,
} from "./turn-recovery.js";
import { type AssistantDeltaEvent, createTurnRuntime, TurnAdmissionError } from "./turn-runtime.js";
import {
	type AgentRuntime,
	type ChatLoopRunSnapshot,
	createTurnState,
	type TurnPreparationPhase,
} from "./turn-state.js";
import { isWorkerShareNote } from "./worker-share.js";

export type { QueuedChatMessage, QueuedMessageKind, QueuedMessagesSnapshot, SteeringMode } from "./turn-queues.js";
export type { RetryStatusEvent, RetryStatusPayload, RetryStatusPhase } from "./turn-recovery.js";
export type { AssistantDeltaEvent } from "./turn-runtime.js";
export type { ChatLoopRunSnapshot, TurnPreparationPhase } from "./turn-state.js";

export interface QueueUpdateEvent {
	type: "queue_update";
	messages: QueuedChatMessage[];
}

/**
 * A queued steer or follow-up the engine just injected into the run. Emitted
 * at injection time (never at enqueue time) so the transcript shows the user
 * turn exactly when the model sees it, mirroring the pi-coding-agent flow
 * where a pending message leaves the queue panel and enters the chat in the
 * same beat. Enqueue time shows the text only in the steering-queue panel.
 */
export interface QueuedUserTurnEvent {
	type: "queued_user_turn";
	text: string;
	/** `interrupt` marks a message that cancelled the run and was submitted as a fresh prompt. */
	kind: QueuedChatMessage["kind"] | "interrupt";
}

/**
 * First-class advisory event. `surface` says where the notice belongs:
 * "transcript" notices are turn-adjacent chat lines (cancellations,
 * compaction summaries, configuration errors) and "footer" notices are
 * ambient status (nudge chips). Notices are never assistant messages: they
 * carry no `message_end`, cannot become a headless turn's answer, and never
 * end a run.
 */
export interface ChatNoticeEvent {
	type: "notice";
	level: "info" | "success" | "warning" | "error";
	surface: "footer" | "transcript";
	text: string;
	key?: string;
	/**
	 * Present only on a notice that reports a turn Clio refused to start. The
	 * `reason` is a closed-set code, not prose: protocol surfaces (the ACP
	 * server) fail the turn with it instead of returning an empty success, and
	 * every other surface renders the notice exactly as before.
	 */
	admission?: { reason: string };
}

/**
 * Approval-lifecycle signal for a tool call that pi already started
 * (`tool_execution_start` fires before admission parks the body). The
 * interactive composition root emits it from the registry's
 * permission-required signal ("awaiting-approval") and from the operator's
 * one-shot grant ("resumed") so the chat panel can restyle the exact parked
 * segment instead of leaving a counting running line. Deny/cancel needs no
 * state here: the parked promise resolves blocked and the segment settles
 * through its ordinary `tool_execution_end`.
 */
export type ToolApprovalStateEvent =
	| {
			type: "tool_approval_state";
			toolCallId: string;
			state: "awaiting-approval";
			/**
			 * Already-redacted facts shown by the permission overlay. This payload
			 * exists only on the live event and is never written to the session
			 * ledger; the transcript renderer must not reconstruct safety facts
			 * from raw tool arguments.
			 */
			view: ApprovalRequestView;
	  }
	| {
			type: "tool_approval_state";
			toolCallId: string;
			state: "resumed";
	  };

export type ChatLoopEvent =
	| AgentEvent
	| AssistantDeltaEvent
	| RetryStatusEvent
	| QueueUpdateEvent
	| QueuedUserTurnEvent
	| ChatNoticeEvent
	| AgentStatusEvent
	| ToolApprovalStateEvent;

export interface ChatSubmitOptions {
	images?: ReadonlyArray<ImageContent>;
	/** Files already expanded into this session's working context. */
	workingContextPaths?: ReadonlyArray<string>;
	/** Skill requests parsed by the harness for this turn. Not recorded as loaded until the skill body loads. */
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	/** Internal middleware resubmit; does not reset the per-user-prompt stalled-turn nudge cap. */
	requestContinuation?: boolean;
	/**
	 * Delivery mode when a run is active; ignored when idle. Defaults to
	 * `next-slot`. `interrupt` cancels the run, waits for it to settle, and
	 * submits the text as a fresh prompt; see {@link ChatLoop.interruptRefusal}
	 * for the two states in which it degrades to `next-slot` instead.
	 */
	steering?: SteeringMode;
	/**
	 * Fires once this submit owns the live turn (`isStreaming()` is true) and
	 * the next queued submit may use streaming queue routing. Stage 0 replay
	 * awaits it; the loop's own admission gate releases on it.
	 */
	onAdmitted?: () => void;
}

/**
 * Placeholder key a target that needs no auth still has to be handed. Mirrors
 * the turn runtime's own local fallback, so a `/btw` round against a local
 * server authenticates exactly the way a turn against it does.
 */
const LOCAL_SIDE_QUESTION_API_KEY = "clio-local-target";

/** Closing notice an operator interrupt leaves in the transcript and the ledger. */
const INTERRUPT_CANCEL_REASON = "[Clio Coder] run interrupted by operator; delivering the new message now.";
const ENGINE_ACTIVE_PROMPT_ERROR =
	"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.";
const ACTIVE_PROMPT_NOTICE =
	"[Clio Coder] another response was already active, so this response could not start. Wait for it to finish, then submit again.";

function operatorFacingEngineError(message: string): string {
	return message.includes(ENGINE_ACTIVE_PROMPT_ERROR) ? ACTIVE_PROMPT_NOTICE : message;
}

/**
 * Options for {@link ChatLoop.cancel}. A bare cancel is an operator Esc/Ctrl+C
 * that ends the in-flight turn as an empty aborted message. Passing a `reason`
 * marks the cancel as an explained interrupt (the loop guard, or an operator
 * interrupt-with-message): the chat loop persists a durable, visible assistant
 * turn carrying that reason in place of the empty aborted turn, and tags the
 * audit trail with `source`.
 */
export interface ChatCancelOptions {
	/** Operator-facing explanation for a system-initiated stop. */
	reason?: string;
	/** Audit source for the emitted RunAborted event. Defaults to "stream_cancel". */
	source?: RunAbortSource;
	/** Short audit reason string. Defaults to a source-appropriate phrase. */
	auditReason?: string;
}

export interface SideQuestionOptions {
	/** Cancels the round. Esc and Ctrl+C in the overlay abort through it. */
	signal?: AbortSignal;
	/** Streamed answer text so the overlay fills as the provider produces it. */
	onDelta?: (partialText: string) => void;
}

export interface HandoffRoundOptions extends SideQuestionOptions {
	/**
	 * Run the second and last extraction round, quoting the parser's complaint
	 * and what the first round returned. Both rounds bill through the same
	 * out-of-turn usage store (issue #223).
	 */
	repair?: HandoffRepairInput;
}

/**
 * How a `/btw` round ended. `refused` is a round that never started (a turn was
 * in flight, or no orchestrator target is configured); `failed` is a round that
 * started and the provider rejected.
 */
export type SideQuestionOutcome =
	| { status: "answered"; text: string }
	| { status: "aborted"; text: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

export interface ChatLoop {
	submit(text: string, options?: ChatSubmitOptions): Promise<void>;
	steer(text: string): boolean;
	queueFollowUp(text: string): boolean;
	/**
	 * Why an interrupt would be refused right now, or null when it would
	 * cancel the run. An attached dispatch is refused because the parent's abort
	 * kills the worker's run and discards its work with no receipt; a parked
	 * permission ask is refused because it is already waiting on the operator.
	 * In both cases `submit(text, { steering: "interrupt" })` says so and
	 * queues the text for the next slot instead.
	 */
	interruptRefusal(): string | null;
	clearQueuedFollowUps(): string[];
	queuedMessages(): QueuedMessagesSnapshot;
	cancel(options?: ChatCancelOptions): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
	lastRunSnapshot?(): ChatLoopRunSnapshot | null;
	isStreaming(): boolean;
	/**
	 * Where a consumed prompt currently is between the editor and the stream.
	 * The composer and the footer read it so the window in which the prompt has
	 * been taken but the turn has not been admitted is never rendered as idle
	 * (issue #251).
	 */
	turnPreparation(): { phase: TurnPreparationPhase; since: number };
	/** Fires on every preparation transition, including back to `idle`. */
	onTurnPreparation(handler: (phase: TurnPreparationPhase) => void): () => void;
	contextUsage(): ContextUsageSnapshot;
	/**
	 * Categorized context-window ledger for the `/context` overlay: where every
	 * occupied token lives (system prompt, tools, agents, skills, memory,
	 * messages), the autocompact reserve, and free space. Composes the live
	 * estimate with the current turn's prompt segment manifest.
	 */
	contextLedger(): ContextLedger;
	/**
	 * Force-run the compaction flow for the current session, swap the agent's
	 * in-memory `state.messages` for a single bridge message carrying the
	 * summary, and emit the standard summary notice. Used by `/context compact`
	 * slash command so the next user turn ships only the bridge plus the new
	 * text to the provider (slice 12.5b bug 4). Silent no-op when no session
	 * or no compaction deps are wired; in both cases emits a user-visible
	 * notice so the `/context compact` handler does not have to mirror the logic.
	 */
	compact(instructions?: string): Promise<void>;
	/**
	 * `/btw`: answer one side question against the session's active target,
	 * model, and compiled message history without starting a turn.
	 *
	 * Nothing this produces reaches the session ledger, the transcript, the
	 * context ledger, or the footer token counters; the message history is read,
	 * never mutated. The round's provider usage is still reported to `/cost`,
	 * labeled as a side question, because money was spent. Refused outright
	 * while a turn is in flight rather than queued.
	 */
	askSideQuestion(question: string, options?: SideQuestionOptions): Promise<SideQuestionOutcome>;
	/**
	 * `/handoff`: run the extraction round for a goal against the same target,
	 * model, and compiled message history, and return its raw JSON answer.
	 *
	 * Like a side question this is out of turn: no tools are sent, the message
	 * history is read and never mutated, and nothing the round produces reaches
	 * the ledger. Validating, bounding, and reviewing the answer belong to the
	 * caller; this method only owns the provider call. Refused outright while a
	 * turn is in flight rather than queued.
	 */
	extractHandoff(goal: string, options?: HandoffRoundOptions): Promise<SideQuestionOutcome>;
	/**
	 * Drop or replace the chat-loop's in-memory state after a session switch
	 * (/resume, /fork, /new). `leafTurnId` is the id the next user turn
	 * should parent under. `replayMessages` is the provider context rebuilt
	 * from the selected session entries; omit it for a fresh session.
	 */
	resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
	/**
	 * Resolves once the queued or in-flight session pre-warm has settled, with
	 * the outcome, or null when none ran. Diagnostics and contracts only: no
	 * turn path waits on a pre-warm.
	 */
	whenPrewarmSettled(): Promise<PrewarmOutcome | null>;
	/** Abort the live agent and release pi-ai session-scoped resources before shutdown. */
	dispose(): void;
	/**
	 * Resolves once the in-flight submit (if any) has fully settled, including
	 * the aborted run's tool results and their ledger appends. Shutdown awaits
	 * this after dispose() so domains (the session writer among them) never
	 * stop while the turn is still persisting: `session.append` after session
	 * stop is impossible by ordering.
	 */
	whenSettled(): Promise<void>;
}

export interface CreateChatLoopDeps {
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	/**
	 * Whitelist of target ids that the chat-loop is allowed to drive. The
	 * orchestrator composes this from `providers.list()` so an unknown
	 * `settings.orchestrator.target` surfaces a configuration error before
	 * the agent is constructed.
	 */
	knownTargets: () => ReadonlySet<string>;
	session?: SessionContract;
	/**
	 * Prompt compiler. When wired, the session system prompt is compiled once
	 * per session and written into `state.systemPrompt`; recompiles happen
	 * only on explicit events (model/target change, safety-level change,
	 * config hot-reload, session switch).
	 *
	 * Optional so unit tests can inject stubs and a degraded boot (prompts
	 * failed to load) still runs with the built-in identity fallback below.
	 * In production this is always wired by `entry/orchestrator.ts`.
	 */
	prompts?: PromptsContract;
	createAgent?: typeof createEngineAgent;
	/**
	 * The `/btw` round. Defaults to the real provider call; contracts inject a
	 * stub so they can assert what a side question does to the session without
	 * standing up a provider, exactly as `createAgent` does for a turn.
	 */
	runSideQuestion?: typeof runSideQuestion;
	/** The `/handoff` extraction round. Injectable for the same reason. */
	runHandoffRound?: typeof runHandoffRound;
	/**
	 * Append one priced out-of-turn call to the durable out-of-turn usage store.
	 * Defaults to the real writer under the state dir. Contracts inject a spy so
	 * they can assert the row was written without touching a real state dir.
	 */
	recordOutOfTurnUsageRow?: (row: OutOfTurnUsageRow) => void;
	/**
	 * Return the current session's entries for token estimation. The chat-loop
	 * calls this on every submit so the auto-compaction threshold sees the
	 * latest transcript. Returns an empty array when there is no current
	 * session or when the session contract is absent.
	 */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/**
	 * Run the compaction flow end-to-end (read entries, resolve model,
	 * summarize, persist a compactionSummary entry) and return the result,
	 * or null when the flow is a legitimate no-op (no entries or no cut
	 * crossed). Configuration, provider, read, and persistence failures reject
	 * so the activity path can report them as failures. Chat-loop invokes this from two sites:
	 *   1. Before every agent.prompt when the threshold is crossed or
	 *      CLIO_CODER_FORCE_COMPACT=1 is set.
	 *   2. After catching a ContextOverflowError, as the first half of the
	 *      one-shot compact-and-retry recovery path.
	 * Both sites share an AutoCompactionTrigger so two fires in the same tick
	 * coalesce onto one summarization call.
	 */
	autoCompact?: (instructions?: string, trigger?: CompactionTrigger) => Promise<CompactResult | null>;
	/** Optional observability sink for orchestrator chat token usage. */
	observability?: ObservabilityContract;
	/**
	 * Production tool admission path. When wired, every agent-facing tool runs
	 * through `ToolRegistry.invoke(...)` so safety classification and
	 * confirmation admission happen on the actual execution path.
	 */
	toolRegistry?: ToolRegistry;
	/**
	 * Middleware hook surface. When wired, the chat-loop fires `turn_start`
	 * when a prompt is accepted (flushing accumulated `inject_reminder`
	 * effects into the request as a system-reminder block) and `turn_end`
	 * when the final assistant message of a run lands (finish contract,
	 * tool-prose loop). Optional so unit tests that exercise neither stay
	 * minimal.
	 */
	middleware?: MiddlewareContract;
	/**
	 * Shared next-round provider routing. The registry applies effects emitted
	 * by before_tool/after_tool; the chat loop applies turn hooks and consumes
	 * the resulting choice in onPayload.
	 */
	middlewareToolChoice?: MiddlewareToolChoiceControl;
	/**
	 * Protected-artifact state handle, backed by the protected-artifacts hook
	 * registration at the composition root. The chat-loop replaces the state
	 * wholesale on session switch so protections follow the active session.
	 */
	protectedArtifacts?: {
		replace(state: ProtectedArtifactState): void;
		markDegraded(reason: string): void;
	};
	/**
	 * Shared event bus. When wired, `cancel()` fans a `BusChannels.RunAborted`
	 * payload with `source: "stream_cancel"` so the safety audit subscriber
	 * persists a kind: "abort" row for every Esc-on-stream / Ctrl+C cancel.
	 * Optional so unit tests that drive chat-loop in isolation do not need
	 * to construct a bus.
	 */
	bus?: SafeEventBus;
	/**
	 * Build the approved-memory prompt section for the current turn. Returns
	 * the empty string when no approved, evidence-linked, in-scope memory
	 * applies; otherwise returns a compact markdown section that the prompt
	 * compiler injects via the memory dynamic fragment. Optional so unit
	 * tests omit it when memory is irrelevant.
	 */
	getMemorySection?: () => string;
	/** Structured, redacted task-bank export supplied only to an explicit context-handoff skill request. */
	getTaskMemoryHandoffSource?: () => string;
	/**
	 * Hand the composition root a delivery path for reminders that background
	 * observers produce after their turn boundary closed. Called once during
	 * composition; the loop owns the buffer the reminder lands in.
	 */
	registerDeferredReminderSink?: (sink: (message: string) => void) => void;
	/**
	 * The same seam for findings that are for the operator rather than the model.
	 * The watchdog uses it: its run settles after the turn it reviewed, and its
	 * blockers become one transcript notice that never enters model context.
	 */
	registerDeferredNoticeSink?: (sink: (text: string) => void) => void;
	/**
	 * Host-finalizer seam for branch-anchored interview snapshots. Called once,
	 * after the ask-user host finalizer has settled the policy and its transcript.
	 */
	onAskUserFinalized?: (policy: AskUserToolPolicy) => void;
	/**
	 * True while an attached `dispatch` call is running. An interrupt is refused
	 * in that state; the composition root wires this from the dispatch
	 * background registry, which holds exactly the attached calls.
	 */
	hasAttachedDispatch?: () => boolean;
	/**
	 * True while any dispatched worker run is outstanding, attached or detached.
	 * The session pre-warm stands down in that state so it never competes for the
	 * endpoint a worker is already using. Defaults to `hasAttachedDispatch`, which
	 * is the narrower fact a bare composition has.
	 */
	hasActiveDispatch?: () => boolean;
	/**
	 * True on a surface where a person is about to type the next turn. The
	 * orchestrator wires this false for headless `run`: the pre-warm buys latency
	 * that an unattended run never spends. Defaults to true.
	 */
	isLatencySurface?: () => boolean;
	/** The session pre-warm round. Injectable for the same reason `runSideQuestion` is. */
	runPrewarm?: typeof runPrewarmRound;
	/**
	 * Whether a submit aborts the in-flight pre-warm's request or only lets go of
	 * it. Defaults to what the measured local backend does with a cancelled
	 * request; see `ABORT_ROUND_ON_SUBMIT` in `turn-prewarm.ts`.
	 */
	abortPrewarmOnSubmit?: boolean;
	/**
	 * Claim one in-flight request on the pre-warm's endpoint for the duration of
	 * the round. Wired from the endpoint-capacity registry once #250 lands, so a
	 * pre-warm counts against the same per-endpoint bound the orchestrator's
	 * streaming turn does; see `registerEndpointSlot` in `turn-prewarm.ts`.
	 */
	registerPrewarmEndpointSlot?: (runtime: AgentRuntime) => (() => void) | null;
}

export function reloadProtectedArtifactsForSession(
	protectedArtifacts: NonNullable<CreateChatLoopDeps["protectedArtifacts"]>,
	readSessionEntries: (() => ReadonlyArray<SessionEntry>) | undefined,
): void {
	try {
		const entries = readSessionEntries ? readSessionEntries() : [];
		protectedArtifacts.replace(protectedArtifactStateFromSessionEntries(entries));
	} catch (error) {
		protectedArtifacts.markDegraded(
			`session protection history could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const createAgent = deps.createAgent ?? createEngineAgent;
	const sideQuestionRound = deps.runSideQuestion ?? runSideQuestion;
	const handoffRound = deps.runHandoffRound ?? runHandoffRound;
	const middlewareToolChoice = deps.middlewareToolChoice ?? createMiddlewareToolChoiceControl();
	const state = createTurnState(deps.getSettings().orchestrator.thinkingLevel ?? "off");
	const toolStartTimes = new Map<string, number>();

	const preparationListeners = new Set<(phase: TurnPreparationPhase) => void>();
	/**
	 * Move the consumed prompt to a new preparation phase and tell everything
	 * that renders it. Idempotent, so the two compaction sites and the two
	 * clearing sites (admission and settlement, because a refusal never reaches
	 * admission) can all set the phase they mean without ordering rules.
	 */
	const setTurnPreparation = (phase: TurnPreparationPhase): void => {
		if (state.turnPreparation === phase) return;
		// `since` is the age of the whole window, not of its current sub-state:
		// what the operator is judging is how long ago they pressed Enter.
		if (state.turnPreparation === "idle") state.turnPreparationSince = Date.now();
		if (phase === "idle") state.turnPreparationSince = 0;
		state.turnPreparation = phase;
		for (const listener of preparationListeners) {
			try {
				listener(phase);
			} catch {
				// Preparation observers are presentation only and cannot fail a turn.
			}
		}
	};

	/**
	 * Submits currently holding a consumed prompt. The FIFO gate lets a second
	 * submit open its window while the first is still settling, so the phase is
	 * refcounted rather than owned: the last one out turns the light off.
	 */
	let preparingSubmits = 0;
	const enterPreparation = (): void => {
		preparingSubmits += 1;
		// Opening a window never narrows one that is already open: a second submit
		// arriving while the first is compacting must not flip the composer from
		// COMPACTING back to PREPARING while the compaction is still running.
		if (state.turnPreparation === "idle") setTurnPreparation("preparing");
	};
	const leavePreparation = (): void => {
		preparingSubmits = Math.max(0, preparingSubmits - 1);
		if (preparingSubmits === 0) setTurnPreparation("idle");
	};
	/**
	 * Return to the plain preparing state after a compaction inside the window.
	 * Refcount-aware, because two submits share the window and the slower one's
	 * compaction can finish after the window has already closed; restoring
	 * `preparing` there would re-open it with nothing left to prepare.
	 */
	const endPreparationCompaction = (): void => {
		setTurnPreparation(preparingSubmits > 0 ? "preparing" : "idle");
	};

	const emit = (event: ChatLoopEvent): void => {
		for (const listener of listeners) {
			listener(event);
		}
	};

	const emitFooterNotice = (level: ChatNoticeEvent["level"], text: string, key: string): void => {
		emit({ type: "notice", level, surface: "footer", text, key });
	};

	/**
	 * Transcript notices are first-class `notice` events, never fake
	 * `message_end` assistant messages: a notice can never become a headless
	 * turn's answer, never carries usage, and never ends a run. Run closure is
	 * the engine's job (handleRunFailure delivers agent_end on abort and
	 * provider-failure paths) and RunAborted carries abort provenance to the
	 * status reducer.
	 */
	const emitNotice = (text: string, level: ChatNoticeEvent["level"] = "info", key?: string): void => {
		emit({ type: "notice", level, surface: "transcript", text, ...(key === undefined ? {} : { key }) });
	};

	/**
	 * The same transcript notice every admission exit already emitted, carrying
	 * the reason the turn never started. Text, level, and surface are unchanged,
	 * so the TUI and headless paths render exactly what they rendered before.
	 */
	const emitAdmissionNotice = (text: string, reason: string): void => {
		emit({ type: "notice", level: "info", surface: "transcript", text, admission: { reason } });
	};

	/**
	 * Which of the two settings is actually missing when the runtime resolves to
	 * null. Both halves produce the same operator-facing notice, but a machine
	 * consumer of the reason (the ACP server reports it as `data.reason`) needs
	 * to tell "no orchestrator at all" from "a target that names no model", and
	 * collapsing them sent a client with a configured target to the wrong fix.
	 */
	const nullRuntimeAdmissionReason = (): string => {
		const orchestrator = deps.getSettings().orchestrator;
		const target = orchestrator.target?.trim() ?? "";
		const model = orchestrator.model?.trim() ?? "";
		return target.length > 0 && model.length === 0 ? "model-not-configured" : "orchestrator-not-configured";
	};

	const retrySettings = (): RetrySettings => normalizeRetrySettings(deps.getSettings().retry);

	const currentToolInvokeOptions = (): Partial<ToolInvokeOptions> => {
		const options: Partial<ToolInvokeOptions> = {};
		const sessionId = deps.session?.current()?.id ?? null;
		if (sessionId) options.sessionId = sessionId;
		const turnId = state.activeUserTurnId ?? state.lastTurnId;
		if (turnId) options.turnId = turnId;
		if (state.currentPendingSkillPolicy) options.pendingSkillPolicy = state.currentPendingSkillPolicy;
		if (state.currentAskUserPolicy) options.askUserPolicy = state.currentAskUserPolicy;
		return options;
	};

	// --- module composition -------------------------------------------------

	const queues = createTurnQueues({
		state,
		emitQueueUpdateEvent: (messages) => emit({ type: "queue_update", messages }),
		emitQueuedUserTurn: (entry) => emit({ type: "queued_user_turn", text: entry.text, kind: entry.kind }),
		emitNotice,
		// The loop's own resubmits (stranded steers, continuation requests) run
		// from submit's finally and bypass the admission gate: an interrupt that
		// holds the gate while awaiting that same run would otherwise deadlock.
		submit: (text, options) => submitTracked(text, options),
	});

	const middleware = createTurnMiddleware({
		state,
		middleware: deps.middleware,
		session: deps.session,
		middlewareToolChoice,
		emitNotice,
		emitFooterNotice,
	});

	try {
		deps.registerDeferredReminderSink?.((message) => middleware.injectDeferredReminder(message));
		deps.registerDeferredNoticeSink?.((text) => middleware.emitDeferredNotice(text));
	} catch {
		// A background observer losing its delivery path must not stop the loop
		// from starting; it simply stays silent.
	}

	const context = createTurnContext({
		state,
		getSettings: deps.getSettings,
		providers: deps.providers,
		session: deps.session,
		prompts: deps.prompts,
		toolRegistry: deps.toolRegistry,
		observability: deps.observability,
		bus: deps.bus,
		readSessionEntries: deps.readSessionEntries,
		autoCompact: deps.autoCompact,
		getMemorySection: deps.getMemorySection,
		middleware,
		emitNotice,
	});

	const persistence = createTurnPersistence({
		state,
		session: deps.session,
		getSettings: deps.getSettings,
		middlewareToolChoice,
		consumePersistedEcho: (text) => queues.consumePersistedEcho(text),
		removeQueuedMirrorEntry: (text) => queues.removeQueuedMirrorEntry(text),
		promptCachePayloadForAssistant: (usage, backend) => context.promptCachePayloadForAssistant(usage, backend),
		promptSideTokens: () => context.promptSideTokens(),
		observability: deps.observability,
	});

	const recovery = createTurnRecovery({
		state,
		persistence,
		context,
		retrySettings,
		markPersistedUserEcho: (text, prompt) => queues.markPersistedUserEcho(text, prompt),
		emitRetryStatus: (status) => emit({ type: "retry_status", status }),
		emitFailureMessage: (message) => emit({ type: "message_end", message }),
		emitNotice,
	});
	const emitRuntimeEvent = (event: AgentEvent | AssistantDeltaEvent): void => {
		if (event.type === "message_end") rewriteStallAbortMessage(state, event.message);
		emit(event as ChatLoopEvent);
	};

	const turnRuntime = createTurnRuntime({
		state,
		getSettings: deps.getSettings,
		providers: deps.providers,
		knownTargets: deps.knownTargets,
		observability: deps.observability,
		createAgent,
		middlewareToolChoice,
		persistence,
		context,
		middleware,
		retrySettings,
		emit: emitRuntimeEvent,
		emitNotice,
		toolStartTimes,
	});
	// A fresh ledger and footer render before the first submit. Start the same
	// live capability probe that submit and resume use so those boot surfaces
	// refresh to the probed model window as soon as provider discovery lands.
	// The turn runtime coalesces the first submit onto this request, then its
	// target and model TTL keeps later submits from repeating it.
	void turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});

	// --- bus subscriptions --------------------------------------------------

	// A config hot-reload may change prompt fragments or settings that feed
	// the session prompt; invalidate so the next submit recompiles. If the
	// recompiled text is byte-identical, nothing changes and no ledger entry
	// is written.
	const unsubscribeConfigReload =
		deps.bus?.on(BusChannels.ConfigHotReload, () => {
			context.invalidateSessionPromptCache();
		}) ?? null;

	const unsubscribeSynthesisLock =
		deps.bus?.on(BusChannels.LoopBlocked, (payload) => {
			const disposition = (payload as { disposition?: unknown } | null)?.disposition;
			if (disposition === "lockout") state.synthesisToolLock = true;
		}) ?? null;

	// --- the state machine --------------------------------------------------

	// Settlement tracking for whenSettled(): the latest submit's promise,
	// coerced to never reject so shutdown ordering cannot throw. `priorSubmit`
	// is the promise `activeSubmit` held before the latest submit replaced it,
	// which is the run an interrupt has to wait out.
	let activeSubmit: Promise<void> = Promise.resolve();
	let priorSubmit: Promise<void> = Promise.resolve();

	const interruptRefusalReason = (): string | null => {
		if (deps.hasAttachedDispatch?.() === true) {
			return "an attached dispatch is running and the interrupt would kill the worker's run with no receipt; use @<agent> to steer it or Esc to cancel it";
		}
		if (deps.toolRegistry?.hasParkedCalls() === true) {
			return "a permission ask is parked and already waiting on you; answer it or press Esc";
		}
		return null;
	};

	/**
	 * Everything an out-of-turn round needs, or the reason it cannot run.
	 *
	 * `/btw` and `/handoff` are the two callers. Both read the compiled history
	 * the next turn would see, both authenticate exactly the way a turn against
	 * the same target does, and both are refused rather than queued while a turn
	 * is in flight, so the admission decision is made once here.
	 */
	type OutOfTurnPreparation =
		| { ok: true; runtime: AgentRuntime; apiKey: string | undefined }
		| { ok: false; reason: string };

	const prepareOutOfTurnRound = async (inFlightRefusal: string, signal?: AbortSignal): Promise<OutOfTurnPreparation> => {
		if (state.streaming) return { ok: false, reason: inFlightRefusal };
		let agentRuntime: AgentRuntime | null;
		try {
			agentRuntime = turnRuntime.ensureRuntime();
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
		if (!agentRuntime) return { ok: false, reason: notConfiguredNotice() };
		const resolution = agentRuntime.runtimeResolution;
		try {
			const apiKey = targetRequiresAuth(resolution.target, resolution.runtime)
				? (
						await deps.providers.auth.resolveForTarget(resolution.target, resolution.runtime, signal ? { signal } : undefined)
					).apiKey
				: LOCAL_SIDE_QUESTION_API_KEY;
			return { ok: true, runtime: agentRuntime, apiKey };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	};

	/**
	 * Run one out-of-turn round while holding a slot on the endpoint it streams
	 * to, exactly as the turn and the pre-warm do. A `/btw` or `/handoff` round
	 * is a full request against the same inference scheduler, so endpoint
	 * capacity (#250) has to count it for as long as it is out, and the
	 * background-memory tier has to read that endpoint as busy (#229).
	 */
	const withEndpointSlot = async <T>(runtime: AgentRuntime, round: () => Promise<T>): Promise<T> => {
		const endpointKey = canonicalEndpointKey(runtime.runtimeResolution.target);
		const release = endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
		try {
			return await round();
		} finally {
			release();
		}
	};

	const writeOutOfTurnUsageRow =
		deps.recordOutOfTurnUsageRow ?? ((row: OutOfTurnUsageRow): void => appendOutOfTurnUsageRow(clioStateDir(), row));

	/**
	 * Report an out-of-turn round's provider usage. Money was spent, so `/cost`
	 * says so under its own label; turn persistence, the working-set ledger,
	 * compaction inputs, and the footer counters never see it.
	 *
	 * The same call is also appended to the out-of-turn usage store under the
	 * state dir. That store exists because `/cost` only knows what this process
	 * spent: the round appends nothing to the session JSONL by design, so an
	 * archive reader such as `clio-coder usage report` had no record of the
	 * spend at all once the process exited. The session ledger stays untouched.
	 */
	const recordOutOfTurnUsage = (
		runtime: AgentRuntime,
		usage: SideQuestionResult["usage"],
		label: CostEntryLabel,
	): void => {
		if (!usage) return;
		const costProvenance = runtime.runtimeResolution.costProvenance;
		deps.observability?.recordTokens(
			runtime.targetId,
			runtime.wireModelId,
			usage.totalTokens,
			usage.costUsd,
			{
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				reasoningTokens: usage.reasoning,
				totalTokens: usage.totalTokens,
				apiCalls: 1,
			},
			costProvenance,
			undefined,
			label,
		);
		const meta = deps.session?.current() ?? null;
		writeOutOfTurnUsageRow({
			label,
			sessionId: meta?.id ?? null,
			// The identity the session ledger is filed under, so `usage report
			// --repo` selects these rows with the same hash it selects ledgers with.
			repoIdentity: meta ? meta.cwdHash || cwdHash(meta.cwd || process.cwd()) : null,
			timestamp: new Date().toISOString(),
			target: runtime.targetId,
			attributedModelId: runtime.wireModelId,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				reasoning: usage.reasoning,
				totalTokens: usage.totalTokens,
				costUsd: usage.costUsd,
				costProvenance: normalizeCostProvenance(costProvenance),
			},
		});
	};

	// A submit owns the turn state machine from the moment it starts running,
	// which is well before `state.streaming` flips: the probe, auto-compaction,
	// and the prompt compile all happen first. The pre-warm reads this flag, not
	// `streaming`, so it can never be the request the operator's turn queues
	// behind.
	let turnActive = false;

	const prewarm = createTurnPrewarm({
		state,
		getSettings: deps.getSettings,
		providers: deps.providers,
		context,
		bus: deps.bus,
		...(deps.session ? { session: deps.session } : {}),
		isLatencySurface: () => deps.isLatencySurface?.() !== false,
		isTurnActive: () => turnActive,
		hasActiveDispatch: () => (deps.hasActiveDispatch ?? deps.hasAttachedDispatch)?.() === true,
		prepareRuntime: async (signal) => {
			// The same probe a submit awaits, so the pre-warm resolves the model the
			// next turn will resolve rather than a stale catalog entry.
			await turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});
			return prepareOutOfTurnRound("a turn is in flight", signal);
		},
		applySessionTools: (runtime) => {
			runtime.agent.state.tools = resolveSessionTools(
				runtime,
				deps.toolRegistry,
				currentToolInvokeOptions,
				turnRuntime.toolTelemetry,
			);
		},
		recordUsage: (runtime, usage: Usage | null) => {
			recordOutOfTurnUsage(runtime, sideQuestionUsage(usage), "prewarm");
		},
		...(deps.runPrewarm ? { runPrewarm: deps.runPrewarm } : {}),
		...(deps.abortPrewarmOnSubmit === undefined ? {} : { abortRoundOnSubmit: deps.abortPrewarmOnSubmit }),
		...(deps.registerPrewarmEndpointSlot ? { registerEndpointSlot: deps.registerPrewarmEndpointSlot } : {}),
	});
	const unsubscribePrewarmCompaction = subscribePrewarmToCompaction(deps.bus, prewarm);
	// The prompt this process will send is known now: the session prompt compiles
	// against the configured target, and a boot-time resume rebuilds the message
	// array in the same tick, which the scheduler collapses onto one round.
	prewarm.schedule("session-start");

	const api: ChatLoop = {
		steer: (text) => queues.steer(text),
		queueFollowUp: (text) => queues.queueFollowUp(text),
		interruptRefusal: () => (state.streaming ? interruptRefusalReason() : null),
		clearQueuedFollowUps: () => queues.clearQueuedMirror().map((entry) => entry.text),
		queuedMessages: () => queues.queuedMessages(),

		async submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
			let interrupted = false;
			if (state.streaming) {
				let mode: SteeringMode = options.steering ?? DEFAULT_STEERING_MODE;
				const trimmed = text.trim();
				if (mode === "interrupt" && trimmed.length > 0) {
					const refusal = interruptRefusalReason();
					if (refusal !== null) {
						emitNotice(`[Clio Coder] interrupt refused: ${refusal}. Queued for the next slot instead.`, "warning");
						mode = "next-slot";
					} else {
						// Cancel, then wait for the cancelled run to settle (its in-flight
						// tool results and closing ledger turn), then fall through to the
						// fresh-prompt path below. `priorSubmit` is the run being cancelled;
						// `activeSubmit` already points at this call.
						const prior = priorSubmit;
						api.cancel({
							reason: INTERRUPT_CANCEL_REASON,
							auditReason: "operator interrupted the run with a message",
						});
						await prior;
						if (!state.streaming) {
							interrupted = true;
						} else {
							// Something restarted a run while the cancel settled (a
							// continuation resubmit); do not fight it, deliver at the next slot.
							emitNotice(
								"[Clio Coder] a run restarted before the interrupt landed. Queued for the next slot instead.",
								"warning",
							);
							mode = "next-slot";
						}
					}
				}
				if (!interrupted) {
					const hasImages = options.images !== undefined && options.images.length > 0;
					if (!hasImages && trimmed.length > 0 && state.runtime) {
						// Enter while streaming means "correct it now": the engine
						// steering queue drains after every tool batch, so the text
						// lands as a user message before the next model turn.
						// alt+enter (queueFollowUp) keeps the after-this-run intent.
						if (isWorkerShareNote(trimmed)) state.turnSharedWorkerNote = true;
						// The queue carries the submitted bytes, not the trimmed copy the
						// guard above reads: a steer is a model-facing turn and the
						// payload contract applies to it too (issue #244).
						if (mode === "end-of-turn") queues.queueFollowUp(text);
						else queues.steer(text);
						return;
					}
					emitNotice("[Clio Coder] response already in progress. Press Esc to cancel the active run.");
					return;
				}
			}

			const previousRunSnapshot = state.lastRunSnapshot;
			let agentRuntime: AgentRuntime | null;
			try {
				await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = turnRuntime.ensureRuntime();
			} catch (err) {
				emitAdmissionNotice(
					err instanceof Error ? err.message : String(err),
					err instanceof TurnAdmissionError ? err.reason : "admission-failed",
				);
				return;
			}
			if (!agentRuntime) {
				emitAdmissionNotice(notConfiguredNotice(), nullRuntimeAdmissionReason());
				return;
			}

			// 1. Accept the prompt: reset per-turn accounting, freeze the tool
			// surface, fire turn_start, and assemble the submitted text.
			state.turnToolCalls = 0;
			state.turnToolNames = [];
			state.turnSharedWorkerNote = isWorkerShareNote(text);
			middlewareToolChoice.reset();
			if (options.requestContinuation !== true) state.stalledTurnNudgeSpent = false;
			const images = options.images && options.images.length > 0 ? [...options.images] : undefined;
			const pendingSkillRequests = options.pendingSkillRequests ?? [];
			context.addWorkingContextPaths(options.workingContextPaths ?? []);
			const pendingSkillPolicy = createPendingSkillToolPolicy(pendingSkillRequests);
			// Resolve the frozen session tool surface before turn_start so intent
			// middleware sees the exact tools this request can actually call.
			agentRuntime.agent.state.tools = resolveSessionTools(
				agentRuntime,
				deps.toolRegistry,
				currentToolInvokeOptions,
				turnRuntime.toolTelemetry,
			);
			const toolSignature = toolSignatureFromState(agentRuntime.agent.state.tools);
			const askUserPolicy = createAskUserToolPolicy(agentRuntime.agent.state.tools);
			// turn_start: the prompt is accepted; registrations may inject
			// context for this request. Accumulated reminders (turn_end
			// advisories from the previous turn plus anything turn_start just
			// emitted) flush into the request as one system-reminder block.
			// Like the skill preamble below, the block is plain visible text in
			// the user message: persisted in the ledger, no hidden prompt
			// machinery.
			middleware.fireTurnStart(agentRuntime, text, pendingSkillRequests.length, options.requestContinuation === true);
			const reminderBlock = middleware.flushPendingReminders();
			// Pending skill requests are plain visible text in the user message
			// itself: persisted in the ledger, no hidden prompt machinery.
			const skillPreamble = pendingSkillRequestPreamble(pendingSkillRequests);
			let taskMemoryHandoffSource = "";
			if (pendingSkillRequests.some((request) => request.name.trim() === "context-handoff")) {
				try {
					taskMemoryHandoffSource = deps.getTaskMemoryHandoffSource?.() ?? "";
				} catch {
					// Handoff export is supplemental; a snapshot failure must not block
					// the explicitly requested skill turn.
				}
			}
			const submittedText = [reminderBlock, skillPreamble, taskMemoryHandoffSource, text]
				.filter((part) => part.length > 0)
				.join("\n\n");

			// 2. Pre-submit auto-compaction trigger
			const forceNow = process.env.CLIO_CODER_FORCE_COMPACT === "1";
			try {
				setTurnPreparation("compacting");
				await context.runAutoCompact(agentRuntime, forceNow, undefined, undefined, submittedText);
			} catch (err) {
				emitNotice(`[Clio Coder] auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				endPreparationCompaction();
			}

			// 3. Ensure the session prompt (compiles only on explicit events)
			const compiledPrompt = await context.ensureSessionPrompt(agentRuntime);

			// 4. Preflight overflow check, before the user turn is committed.
			// A blocked request must not leave a dangling user entry that the
			// next replay would treat as an unanswered turn.
			const compactionThreshold = deps.getSettings().compaction?.threshold ?? null;
			const captureTurnSnapshot = (turnId: string): ContextSnapshot =>
				context.captureRuntimeContextSnapshot(agentRuntime, turnId, compactionThreshold, {
					promptSegments: compiledPrompt
						? compiledPrompt.sections.map((s) => ({ id: s.id, tokenEstimate: s.tokenEstimate }))
						: undefined,
					pendingUserInput: submittedText,
					images,
					promptHash: compiledPrompt?.systemPromptHash,
					toolSignature,
				});

			const reservedOutput = resolveReservedOutputTokens(agentRuntime.runtimeResolution.capabilityDecisions.maxTokens);
			const effectiveWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
			const pendingInputTokens = ceilChars(submittedText.length);
			let turnSnapshot = captureTurnSnapshot("pending");
			// The snapshot prices the prompt at chars/4. When the provider has
			// already attested a larger prompt for this conversation, that figure
			// is what the request will actually cost, so the overflow guard reads
			// the higher of the two (issue #227). Both already carry the pending
			// user text and the tool schema estimate.
			const budgetedPromptTokens = (snapshot: ContextSnapshot): number =>
				Math.max(
					snapshotInputTokens(snapshot) + pendingInputTokens,
					context.liveContextEstimate(agentRuntime, submittedText).tokens,
				);
			const totalEstimate = budgetedPromptTokens(turnSnapshot) + reservedOutput;

			if (effectiveWindow > 0 && totalEstimate > effectiveWindow) {
				emitNotice(
					`[Clio Coder] Estimated request size ${totalEstimate} tokens (input ${totalEstimate - reservedOutput} + output budget ${reservedOutput}) exceeds the effective context window of ${effectiveWindow} tokens. Running compaction before sending...`,
				);
				setTurnPreparation("compacting");
				const compacted = await context
					.runAutoCompact(agentRuntime, true, undefined, undefined, submittedText)
					.finally(endPreparationCompaction);
				if (!compacted) {
					emitNotice(
						"[Clio Coder] Compaction could not reclaim enough space. Request blocked; trim the prompt, reduce active tools, or start a fresh session.",
					);
					return;
				}
				context.refreshAgentMessagesFromSession(agentRuntime);
				turnSnapshot = captureTurnSnapshot("pending");
				const postTotalEstimate = budgetedPromptTokens(turnSnapshot) + reservedOutput;
				if (postTotalEstimate > effectiveWindow) {
					emitNotice(
						`[Clio Coder] Request still exceeds the effective window after compaction (${postTotalEstimate} > ${effectiveWindow}). Request blocked.`,
					);
					return;
				}
				emitNotice(
					`[Clio Coder] Context budget check passed post-compaction (${postTotalEstimate} <= ${effectiveWindow}). Proceeding.`,
				);
			}

			// 5. Append the user turn, then stamp and persist the snapshot.
			// PendingSkillRequest is intent only; SkillActivation ledger entries
			// are recorded on skill-load success.
			const userTurnId = persistence.appendSubmittedUserTurn(
				agentRuntime,
				submittedText,
				images,
				options.requestContinuation === true,
				text,
			);
			// An interrupt was submitted while a run was active, so no caller drew
			// it in the transcript; render it here, after the cancel notice and the
			// cancelled run's leftovers, which is the order the ledger has.
			if (interrupted) emit({ type: "queued_user_turn", text, kind: "interrupt" });
			context.logPromptCompileIfPending();
			const previousThinkingLevel = previousRunSnapshot?.runtimeResolution?.effectiveThinkingLevel;
			if (
				previousThinkingLevel !== undefined &&
				previousThinkingLevel !== agentRuntime.runtimeResolution.effectiveThinkingLevel
			) {
				context.noteColdReason("thinking_change");
			}
			if (typeof previousRunSnapshot?.toolSignature === "string" && previousRunSnapshot.toolSignature !== toolSignature) {
				context.noteColdReason("tool_surface_change");
			}
			turnSnapshot = { ...turnSnapshot, turnId: userTurnId ?? "unknown" };
			context.setCurrentSnapshot(turnSnapshot);
			context.persistContextSnapshot(turnSnapshot);
			const promptHash = compiledPrompt?.systemPromptHash ?? null;
			state.lastRunSnapshot = {
				targetId: agentRuntime.targetId,
				targetUrl: agentRuntime.runtimeResolution.target.url ?? null,
				runtimeId: agentRuntime.runtimeId,
				runtimeKind: agentRuntime.runtimeResolution.runtimeKind,
				wireModelId: agentRuntime.wireModelId,
				autonomy: deps.getSettings().autonomy,
				compiledPromptHash: promptHash,
				staticCompositionHash: promptHash,
				promptSignature: promptHash,
				toolSignature,
				runtimeResolution: runtimeTargetSnapshot(agentRuntime.runtimeResolution),
				sessionId: deps.session?.current()?.id ?? null,
				cwd: process.cwd(),
			};

			agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
			state.currentThinkingLevel = agentRuntime.agent.state.thinkingLevel;
			state.toolProseAbortReason = null;
			state.toolProseAssessedChars = 0;
			state.activeInterruptReason = null;
			state.interruptedUsage = null;

			// 6. Cache-disturbance honesty (T3.3)
			context.consumeExpectedColdReasons(agentRuntime.runtimeId);

			// 7. Run the prompt, then route the settled state through recovery.
			state.streaming = true;
			const endpointKey = canonicalEndpointKey(agentRuntime.runtimeResolution.target);
			const releaseForeground = endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
			try {
				options.onAdmitted?.();
			} catch {
				// Admission observers are bookkeeping only and cannot affect the turn.
			}
			const runtimePromptText = submittedText;
			const priorPendingSkillPolicy = state.currentPendingSkillPolicy;
			const priorAskUserPolicy = state.currentAskUserPolicy;
			state.currentPendingSkillPolicy = pendingSkillPolicy;
			state.currentAskUserPolicy = askUserPolicy;
			try {
				await queues.markPersistedUserEcho(runtimePromptText, () => agentRuntime.agent.prompt(runtimePromptText, images));
				// pi-agent-core does NOT throw on provider failures:
				// it pushes an assistant message with stopReason="error" and
				// errorMessage="<provider text>" onto state.messages, sets
				// state.errorMessage, emits agent_end, and resolves normally.
				// The overflow-recovery heuristic must inspect the state after
				// a resolve, not only the catch arm.
				const overflowPostResolve = detectOverflowFromState(agentRuntime.agent);
				if (overflowPostResolve) {
					await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflowPostResolve, images);
				} else {
					const settled = detectTerminalFailureFromState(agentRuntime.agent);
					if (settled) {
						if (state.toolProseAbortReason && settled.message) {
							(settled.message as { errorMessage?: string }).errorMessage = state.toolProseAbortReason;
						}
						// A stalled stream settles here, not in the catch arm: the engine's
						// runWithLifecycle swallows the abort and resolves with an aborted
						// assistant message. Reclassify before the ladder's gate so the
						// watchdog's abort retries and an operator cancel still does not.
						const failure = reclassifyStallAbort(state, settled);
						recovery.ensureFailureVisibleAndPersisted(failure);
						await recovery.runTransientRetryChain(agentRuntime, runtimePromptText, failure);
					}
				}
			} catch (err) {
				// Genuine throws (network, abort, pre-stream bugs) still land
				// here. The heuristic is the same so a thrown overflow from
				// an older pi-agent-core still routes through compact-retry.
				const overflow = toContextOverflowError(err);
				if (!overflow) {
					const message = state.toolProseAbortReason ?? (err instanceof Error ? err.message : String(err));
					if (isRetryableErrorMessage(message)) {
						const failureMessage = {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							stopReason: "error",
							errorMessage: message,
							timestamp: Date.now(),
						} as AgentMessage;
						await recovery.runTransientRetryChain(agentRuntime, runtimePromptText, {
							stopReason: "error",
							errorMessage: message,
							message: failureMessage,
						});
						return;
					}
					emitNotice(operatorFacingEngineError(message));
					return;
				}
				await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflow, images);
			} finally {
				releaseForeground();
				if (askUserPolicy) {
					try {
						await finalizeAskUserInterviewForHost(
							askUserPolicy,
							"turn_finished",
							currentToolInvokeOptions(),
							deps.onAskUserFinalized,
						);
					} catch (error) {
						emitNotice(
							`[Clio Coder] interview decisions could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
							`decision-ledger:${askUserPolicy.id}`,
						);
					}
				}
				state.streaming = false;
				if (state.activeInterruptReason !== null) {
					// The loop-guard cancel showed its closing message live; persist
					// the durable closing turn only now, after the aborted run's
					// in-flight tool results have all landed, so the ledger replays
					// as tool_calls → tool_results → closing text.
					// A thinking-only abort never reaches the ledger, so its estimated
					// spend rides on the closing turn; persistence computes nothing
					// further for a message that already reports positive usage.
					const closing = noticeMessage(state.activeInterruptReason);
					if (state.interruptedUsage !== null) {
						(closing as { usage?: unknown }).usage = state.interruptedUsage;
					}
					persistence.appendAssistantTurn(closing);
					state.activeInterruptReason = null;
					state.interruptedUsage = null;
				}
				state.currentPendingSkillPolicy = priorPendingSkillPolicy;
				state.currentAskUserPolicy = priorAskUserPolicy;
				state.activeUserTurnId = null;
				// Safety net for thrown paths where agent_end never delivered;
				// no-op when the agent_end flush already ran.
				context.flushReconciledSnapshot();
				// Runs on every exit path (normal settle, catch-arm returns) so
				// a steer the engine never drained still reaches the model.
				if (!(await queues.resubmitStrandedSteers())) await queues.resubmitRequestContinuation();
			}
		},

		cancel(options?: ChatCancelOptions): void {
			const wasStreaming = state.streaming;
			recovery.cancelRetryCountdown();
			// Clear both queues before the abort settles the in-flight prompt:
			// a cancelled run must not deliver queued steers or follow-ups, and
			// the stranded-steer fallback must find an empty mirror.
			queues.clearQueuedMirror();
			const requestedReason = options?.reason?.trim();
			if (wasStreaming) {
				// Show the stop reason immediately, but persist the durable closing
				// turn only when the run settles (submit's finally). The abort below
				// still lets the in-flight tool results land; persisting here would
				// interleave an assistant turn between a tool-call message and its
				// results, which strict chat templates reject on replay.
				// `activeInterruptReason` meanwhile suppresses the empty aborted
				// messages the abort leaves behind, in both the ledger and the live
				// transcript. Operator cancels take the same path with the default
				// text, so they no longer render a redundant "[aborted] Request was
				// aborted" turn on top of the cancellation notice.
				state.activeInterruptReason =
					requestedReason && requestedReason.length > 0 ? requestedReason : "[Clio Coder] active response cancelled.";
				emitNotice(state.activeInterruptReason, "warning", "turn.interrupted");
			}
			state.runtime?.agent.abort();
			if (wasStreaming && deps.bus) {
				deps.bus.emit(BusChannels.RunAborted, {
					source: options?.source ?? "stream_cancel",
					runId: null,
					startedAt: null,
					elapsedMs: null,
					at: Date.now(),
					reason: options?.auditReason ?? (requestedReason ? "loop guard stopped a runaway turn" : "user cancelled stream"),
				});
			}
		},

		onEvent(handler: (event: ChatLoopEvent) => void): () => void {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},

		getSessionId(): string | null {
			return deps.session?.current()?.id ?? null;
		},

		lastRunSnapshot(): ChatLoopRunSnapshot | null {
			return state.lastRunSnapshot ? structuredClone(state.lastRunSnapshot) : null;
		},

		isStreaming(): boolean {
			return state.streaming;
		},

		turnPreparation() {
			return { phase: state.turnPreparation, since: state.turnPreparationSince };
		},

		onTurnPreparation(handler) {
			preparationListeners.add(handler);
			return () => {
				preparationListeners.delete(handler);
			};
		},

		contextUsage: () => context.contextUsage(),
		contextLedger: () => context.contextLedger(),
		whenSettled: () => activeSubmit,
		whenPrewarmSettled: () => prewarm.settled(),

		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			queues.reset();
			middleware.clearPendingReminders();
			middlewareToolChoice.reset();
			state.lastTurnId = leafTurnId;
			state.lastRunSnapshot = null;
			context.resetForSession();
			// The resumed ledger renders before the first new turn (issue #189),
			// and the window it renders against should be the probed one rather
			// than the catalog's, so the live capability probe the first submit
			// would run runs now, under the same TTL; the footer refreshes on the
			// provider-health event the probe publishes.
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});
			state.replayedContextMessages = replayMessages ? [...replayMessages] : [];
			if (state.runtime) {
				state.runtime.agent.state.messages = [...state.replayedContextMessages];
			}
			if (deps.protectedArtifacts) {
				reloadProtectedArtifactsForSession(deps.protectedArtifacts, deps.readSessionEntries);
			}
			// A resume replays a history the backend has never seen; a fresh session
			// replays nothing but still compiles a prompt and a tool surface. Both
			// leave a prefix the next turn will pay for unless it is sent now.
			prewarm.schedule(replayMessages && replayMessages.length > 0 ? "resume" : "session-start");
		},

		dispose(): void {
			unsubscribeConfigReload?.();
			unsubscribeSynthesisLock?.();
			unsubscribePrewarmCompaction();
			prewarm.dispose();
			context.dispose();
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			queues.reset();
			middlewareToolChoice.reset();
		},

		async askSideQuestion(question: string, options: SideQuestionOptions = {}): Promise<SideQuestionOutcome> {
			const text = question.trim();
			if (text.length === 0) {
				return { status: "refused", reason: "a side question needs a question" };
			}
			// Never queued. A side question exists to be answered now, beside a run
			// the operator is watching; holding it until the run settles would
			// deliver it after the moment it was asked in had passed.
			const prepared = await prepareOutOfTurnRound(
				"a turn is in flight; /btw runs beside the session, not in its queue",
				options.signal,
			);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			let result: SideQuestionResult;
			try {
				result = await withEndpointSlot(prepared.runtime, () =>
					sideQuestionRound({
						model: prepared.runtime.agent.state.model,
						// Read-only: runSideQuestion copies before appending its own
						// message, so the live agent's history is untouched.
						messages: prepared.runtime.agent.state.messages,
						question: text,
						...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.onDelta ? { onDelta: options.onDelta } : {}),
					}),
				);
			} catch (err) {
				return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
			}
			recordOutOfTurnUsage(prepared.runtime, result.usage, "side-question");
			return result.aborted ? { status: "aborted", text: result.text } : { status: "answered", text: result.text };
		},

		async extractHandoff(goal: string, options: HandoffRoundOptions = {}): Promise<SideQuestionOutcome> {
			const text = goal.trim();
			if (text.length === 0) {
				return { status: "refused", reason: "a handoff needs a goal" };
			}
			// Refused, never queued: a handoff describes a session that has stopped
			// working, and a turn still in flight is about to change what the
			// document would say.
			const prepared = await prepareOutOfTurnRound(
				"a turn is in flight; /handoff cannot summarize a session that is still moving",
				options.signal,
			);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			let result: SideQuestionResult;
			try {
				result = await withEndpointSlot(prepared.runtime, () =>
					handoffRound({
						model: prepared.runtime.agent.state.model,
						// Read-only, exactly as the side-question round treats it.
						messages: prepared.runtime.agent.state.messages,
						goal: text,
						// The runtime id is what decides whether the schema can be bound
						// on the wire rather than only stated in the prompt.
						runtimeId: prepared.runtime.runtimeResolution.runtime.id,
						...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.repair ? { repair: options.repair } : {}),
					}),
				);
			} catch (err) {
				return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
			}
			recordOutOfTurnUsage(prepared.runtime, result.usage, "handoff");
			return result.aborted ? { status: "aborted", text: result.text } : { status: "answered", text: result.text };
		},

		async compact(instructions?: string): Promise<void> {
			// Session check runs BEFORE orchestrator-configuration so a fresh
			// TUI with nothing configured still reports the actionable "no
			// current session" message rather than the "not configured"
			// banner.
			if (!deps.session?.current()) {
				emitNotice("[/context compact] no current session to compact; start one with /new or /resume first");
				return;
			}
			let agentRuntime: AgentRuntime | null;
			try {
				await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = turnRuntime.ensureRuntime();
			} catch (err) {
				emitNotice(`[/context compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!agentRuntime) {
				emitNotice(`[/context compact] ${notConfiguredNotice()}`);
				return;
			}
			let compacted = false;
			try {
				compacted = await context.runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				emitNotice(`[/context compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!compacted) {
				emitNotice("[/context compact] nothing to compact; session is empty or no cut crossed");
			}
		},
	};

	const submitInner = api.submit.bind(api);
	const submitTracked: ChatLoop["submit"] = (text, options) => {
		priorSubmit = activeSubmit;
		// The flag brackets the whole submit, including the early returns an
		// admission failure takes, so a refused turn does not leave the pre-warm
		// believing a turn is still running.
		turnActive = true;
		const run = submitInner(text, options).finally(() => {
			turnActive = false;
		});
		activeSubmit = run.catch(() => {});
		return run;
	};

	// FIFO admission gate. Between entry and `state.streaming = true` a fresh
	// submit awaits the target probe, auto-compaction, and the session prompt
	// compile; a second submit arriving in that window used to run the same
	// pipeline concurrently, skip the probe the first one was still awaiting,
	// append its user turn first, and leave the first to fail on the engine's
	// active-prompt invariant after its turn was already in the ledger. Each
	// submit now waits for the previous one to either own the stream or return,
	// then re-evaluates `state.streaming`, so a prompt typed during boot lands
	// as the next steer or follow-up in the order it was typed. The gate is
	// released at admission, not settlement, so steering stays immediate.
	let admissionTail: Promise<void> | null = null;
	api.submit = (text, options = {}) => {
		// The operator owns the slot from the keystroke, not from admission. The
		// prefix the pre-warm already pushed through stays in it either way, so
		// aborting here costs nothing and stops the real turn from queueing behind
		// a request nobody is waiting on.
		prewarm.cancel();
		const previous = admissionTail;
		let release: () => void = () => {};
		const ticket = new Promise<void>((resolve) => {
			release = resolve;
		});
		admissionTail = ticket;
		const releaseTicket = (): void => {
			release();
			if (admissionTail === ticket) admissionTail = null;
		};
		// The window opens here, not at admission: the caller has already cleared
		// the editor and painted the prompt, and a submit that queues behind the
		// FIFO gate is still a prompt Clio is holding. It closes once, at
		// whichever of admission and settlement comes first, so a refused probe
		// and a blocked overflow preflight close it as reliably as a turn that
		// reaches the stream.
		enterPreparation();
		let leftPreparation = false;
		const leaveOnce = (): void => {
			if (leftPreparation) return;
			leftPreparation = true;
			leavePreparation();
		};
		const start = (): Promise<void> =>
			submitTracked(text, {
				...options,
				onAdmitted: () => {
					releaseTicket();
					leaveOnce();
					options.onAdmitted?.();
				},
			}).finally(releaseTicket);
		const run = previous ? previous.then(start) : start();
		return run.finally(leaveOnce);
	};

	return api;
}
