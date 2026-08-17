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
import {
	createMiddlewareToolChoiceControl,
	type MiddlewareContract,
	type MiddlewareToolChoiceControl,
} from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { runtimeTargetSnapshot } from "../domains/providers/index.js";
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
import type { AgentEvent, AgentMessage, ImageContent } from "../engine/types.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import { finalizeAskUserInterview } from "../tools/ask-user.js";
import type { ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";
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
import type { AgentStatusEvent } from "./status/types.js";
import { createTurnContext } from "./turn-context.js";
import { createTurnMiddleware } from "./turn-middleware.js";
import { createTurnPersistence } from "./turn-persistence.js";
import {
	createTurnQueues,
	DEFAULT_STEERING_MODE,
	type QueuedChatMessage,
	type QueuedMessagesSnapshot,
	type SteeringMode,
} from "./turn-queues.js";
import { createTurnRecovery, type RetryStatusEvent, reclassifyStallAbort } from "./turn-recovery.js";
import { type AssistantDeltaEvent, createTurnRuntime } from "./turn-runtime.js";
import { type AgentRuntime, type ChatLoopRunSnapshot, createTurnState } from "./turn-state.js";
import { isWorkerShareNote } from "./worker-share.js";

export type { QueuedChatMessage, QueuedMessageKind, QueuedMessagesSnapshot, SteeringMode } from "./turn-queues.js";
export type { RetryStatusEvent, RetryStatusPayload, RetryStatusPhase } from "./turn-recovery.js";
export type { AssistantDeltaEvent } from "./turn-runtime.js";
export type { ChatLoopRunSnapshot } from "./turn-state.js";

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
export interface ToolApprovalStateEvent {
	type: "tool_approval_state";
	toolCallId: string;
	state: "awaiting-approval" | "resumed";
}

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
}

/** Closing notice an operator interrupt leaves in the transcript and the ledger. */
const INTERRUPT_CANCEL_REASON = "[Clio Coder] run interrupted by operator; delivering the new message now.";

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
	 * summary, and emit the standard summary notice. Used by the `/compact`
	 * slash command so the next user turn ships only the bridge plus the new
	 * text to the provider (slice 12.5b bug 4). Silent no-op when no session
	 * or no compaction deps are wired; in both cases emits a user-visible
	 * notice so the `/compact` handler does not have to mirror the logic.
	 */
	compact(instructions?: string): Promise<void>;
	/**
	 * Drop or replace the chat-loop's in-memory state after a session switch
	 * (/resume, /fork, /new). `leafTurnId` is the id the next user turn
	 * should parent under. `replayMessages` is the provider context rebuilt
	 * from the selected session entries; omit it for a fresh session.
	 */
	resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
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
	 * True while an attached `dispatch` call is running. An interrupt is refused
	 * in that state; the composition root wires this from the dispatch
	 * background registry, which holds exactly the attached calls.
	 */
	hasAttachedDispatch?: () => boolean;
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
	const middlewareToolChoice = deps.middlewareToolChoice ?? createMiddlewareToolChoiceControl();
	const state = createTurnState(deps.getSettings().orchestrator.thinkingLevel ?? "off");
	const toolStartTimes = new Map<string, number>();

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
		submit: (text, options) => api.submit(text, options),
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
		promptCachePayloadForAssistant: (usage) => context.promptCachePayloadForAssistant(usage),
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
		emit,
		emitNotice,
		toolStartTimes,
	});

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
						if (mode === "end-of-turn") queues.queueFollowUp(trimmed);
						else queues.steer(trimmed);
						return;
					}
					emitNotice("[Clio Coder] response already in progress. Press Esc to cancel the active run.");
					return;
				}
			}

			state.lastRunSnapshot = null;
			let agentRuntime: AgentRuntime | null;
			try {
				await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = turnRuntime.ensureRuntime();
			} catch (err) {
				emitNotice(err instanceof Error ? err.message : String(err));
				return;
			}
			if (!agentRuntime) {
				emitNotice(notConfiguredNotice());
				return;
			}

			// 1. Accept the prompt: reset per-turn accounting, freeze the tool
			// surface, fire turn_start, and assemble the submitted text.
			state.turnToolCalls = 0;
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
				await context.runAutoCompact(agentRuntime, forceNow, undefined, undefined, submittedText);
			} catch (err) {
				emitNotice(`[Clio Coder] auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`);
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
					toolSignature: toolSignatureFromState(agentRuntime.agent.state.tools),
				});

			const reservedOutput = resolveReservedOutputTokens(agentRuntime.runtimeResolution.capabilityDecisions.maxTokens);
			const effectiveWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
			const pendingInputTokens = ceilChars(submittedText.length);
			let turnSnapshot = captureTurnSnapshot("pending");
			const totalEstimate = snapshotInputTokens(turnSnapshot) + pendingInputTokens + reservedOutput;

			if (effectiveWindow > 0 && totalEstimate > effectiveWindow) {
				emitNotice(
					`[Clio Coder] Estimated request size ${totalEstimate} tokens (input ${snapshotInputTokens(turnSnapshot) + pendingInputTokens} + output budget ${reservedOutput}) exceeds the effective context window of ${effectiveWindow} tokens. Running compaction before sending...`,
				);
				const compacted = await context.runAutoCompact(agentRuntime, true, undefined, undefined, submittedText);
				if (!compacted) {
					emitNotice(
						"[Clio Coder] Compaction could not reclaim enough space. Request blocked; trim the prompt, reduce active tools, or start a fresh session.",
					);
					return;
				}
				context.refreshAgentMessagesFromSession(agentRuntime);
				turnSnapshot = captureTurnSnapshot("pending");
				const postTotalEstimate = snapshotInputTokens(turnSnapshot) + pendingInputTokens + reservedOutput;
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
			turnSnapshot = { ...turnSnapshot, turnId: userTurnId ?? "unknown" };
			context.setCurrentSnapshot(turnSnapshot);
			context.persistContextSnapshot(turnSnapshot);
			const promptHash = compiledPrompt?.systemPromptHash ?? null;
			state.lastRunSnapshot = {
				targetId: agentRuntime.targetId,
				runtimeId: agentRuntime.runtimeId,
				runtimeKind: agentRuntime.runtimeResolution.runtimeKind,
				wireModelId: agentRuntime.wireModelId,
				autonomy: deps.getSettings().autonomy,
				compiledPromptHash: promptHash,
				staticCompositionHash: promptHash,
				promptSignature: promptHash,
				toolSignature: toolSignatureFromState(agentRuntime.agent.state.tools),
				runtimeResolution: runtimeTargetSnapshot(agentRuntime.runtimeResolution),
				sessionId: deps.session?.current()?.id ?? null,
				cwd: process.cwd(),
			};

			agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
			state.currentThinkingLevel = agentRuntime.agent.state.thinkingLevel;
			state.toolProseAbortReason = null;
			state.toolProseAssessedChars = 0;
			state.activeInterruptReason = null;

			// 6. Cache-disturbance honesty (T3.3)
			context.consumeExpectedColdReasons(agentRuntime.runtimeId);

			// 7. Run the prompt, then route the settled state through recovery.
			state.streaming = true;
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
					emitNotice(err instanceof Error ? err.message : String(err));
					return;
				}
				await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflow, images);
			} finally {
				if (askUserPolicy) {
					await finalizeAskUserInterview(askUserPolicy, "turn_finished", currentToolInvokeOptions());
				}
				state.streaming = false;
				if (state.activeInterruptReason !== null) {
					// The loop-guard cancel showed its closing message live; persist
					// the durable closing turn only now, after the aborted run's
					// in-flight tool results have all landed, so the ledger replays
					// as tool_calls → tool_results → closing text.
					persistence.appendAssistantTurn(noticeMessage(state.activeInterruptReason));
					state.activeInterruptReason = null;
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

		contextUsage: () => context.contextUsage(),
		contextLedger: () => context.contextLedger(),
		whenSettled: () => activeSubmit,

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
			context.resetForSession();
			state.replayedContextMessages = replayMessages ? [...replayMessages] : [];
			if (state.runtime) {
				state.runtime.agent.state.messages = [...state.replayedContextMessages];
			}
			if (deps.protectedArtifacts) {
				reloadProtectedArtifactsForSession(deps.protectedArtifacts, deps.readSessionEntries);
			}
		},

		dispose(): void {
			unsubscribeConfigReload?.();
			unsubscribeSynthesisLock?.();
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

		async compact(instructions?: string): Promise<void> {
			// Session check runs BEFORE orchestrator-configuration so a fresh
			// TUI with nothing configured still reports the actionable "no
			// current session" message rather than the "not configured"
			// banner.
			if (!deps.session?.current()) {
				emitNotice("[/compact] no current session to compact; start one with /new or /resume first");
				return;
			}
			let agentRuntime: AgentRuntime | null;
			try {
				await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = turnRuntime.ensureRuntime();
			} catch (err) {
				emitNotice(`[/compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!agentRuntime) {
				emitNotice(`[/compact] ${notConfiguredNotice()}`);
				return;
			}
			let compacted = false;
			try {
				compacted = await context.runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				emitNotice(`[/compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!compacted) {
				emitNotice("[/compact] nothing to compact; session is empty or no cut crossed");
			}
		},
	};

	const submitInner = api.submit.bind(api);
	api.submit = (text, options) => {
		priorSubmit = activeSubmit;
		const run = submitInner(text, options);
		activeSubmit = run.catch(() => {});
		return run;
	};

	return api;
}
