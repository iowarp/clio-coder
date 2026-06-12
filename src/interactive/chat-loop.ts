import { BusChannels, type ContextPrunedPayload, type ContextWarningPayload } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { PendingSkillRequest, PendingSkillToolPolicy } from "../core/skill-activation.js";
import {
	MIDDLEWARE_HOOK_TEXT_MAX_CHARS,
	type MiddlewareContract,
	type MiddlewareEffect,
	type MiddlewareHookInput,
	type MiddlewareMetadataValue,
	type MiddlewareReminderSeverity,
} from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import {
	applyModelCapabilityPatch,
	firstRuntimeResolutionError,
	type ProvidersContract,
	type ResolvedRuntimeTarget,
	type RuntimeDescriptor,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
	type TargetDescriptor,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { LocalModelQuirks } from "../domains/providers/types/local-model-quirks.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import {
	AutoCompactionTrigger,
	DEFAULT_COMPACTION_THRESHOLD,
	shouldCompact,
} from "../domains/session/compaction/auto.js";
import type { CompactResult } from "../domains/session/compaction/compact.js";
import { maskStaleObservations } from "../domains/session/compaction/mask-observations.js";
import {
	appendContextSnapshot,
	type CaptureContextSnapshotInput,
	type ContextSnapshot,
	type ContextUsageBreakdown,
	type ContextUsageSnapshot,
	captureContextSnapshot,
	ceilChars,
	contentChars,
	contextUsageSnapshot,
	estimateAgentContextBreakdown,
	estimateAgentContextTokens,
	getLatestContextSnapshot,
	reconcileSnapshot,
	snapshotInputTokens,
} from "../domains/session/context-accounting.js";
import { buildContextLedger, type ContextLedger, type PromptCacheStats } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { protectedArtifactStateFromSessionEntries } from "../domains/session/protected-artifacts.js";
import {
	computeRetryDelayMs,
	createRetryCountdown,
	isRetryableErrorMessage,
	type RetryCountdownHandle,
	type RetrySettings,
} from "../domains/session/retry.js";
import { createEngineAgent } from "../engine/agent.js";
import { cleanupEngineSessionResources } from "../engine/ai.js";
import { evictOtherOllamaModels } from "../engine/apis/ollama-native.js";
import { resolveReservedOutputTokens } from "../engine/apis/output-budget.js";
import { patchReasoningSummaryPayload } from "../engine/provider-payload.js";
import type { AgentEvent, AgentMessage, ImageContent, Model, MutableAgentState, Usage } from "../engine/types.js";
import type { resolveAgentTools } from "../engine/worker-tools.js";
import { finalizeAskUserInterview } from "../tools/ask-user.js";
import type { AskUserToolPolicy, ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";
import {
	type AssistantCallTiming,
	assistantSessionPayload,
	type BackendCacheVerdict,
	backendCacheVerdict,
	createAskUserToolPolicy,
	createPendingSkillToolPolicy,
	detectOverflowFromState,
	detectTerminalFailureFromState,
	extractText,
	extractThinking,
	extractUserText,
	fallbackIdentityPrompt,
	hasPersistableAssistantContent,
	hasStructuredToolCall,
	isLengthStopAssistantMessage,
	notConfiguredNotice,
	noticeMessage,
	pendingSkillRequestPreamble,
	pruneFailedAssistantFromContext,
	recordValue,
	resolveSessionTools,
	runtimeSupportsTools,
	sumRunUsage,
	type TerminalAssistantFailure,
	terminalFailureFromAssistantMessage,
	toolNamesFromAgentState,
	toolResultSummary,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import { normalizeRetrySettings } from "./chat-loop-policy.js";
import { buildReplayAgentMessagesFromTurns } from "./chat-renderer.js";
import { renderCompactionSummaryLine } from "./renderers/compaction-summary.js";
import type { AgentStatusEvent } from "./status/types.js";
import { assessToolProseLoop } from "./tool-prose-loop.js";

type AssistantDeltaEvent =
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partialText: string;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partialThinking: string;
	  };

export type RetryStatusPhase = "scheduled" | "waiting" | "retrying" | "cancelled" | "exhausted" | "recovered";

export interface RetryStatusPayload {
	phase: RetryStatusPhase;
	attempt: number;
	maxAttempts: number;
	errorMessage?: string;
	delayMs?: number;
	seconds?: number;
}

export interface RetryStatusEvent {
	type: "retry_status";
	status: RetryStatusPayload;
}

/**
 * How a message typed during a run is delivered. "steer" rides the engine
 * steering queue and lands before the next model turn (Enter while
 * streaming); "follow-up" rides the follow-up queue and lands when the run
 * would otherwise stop (alt+enter).
 */
export type QueuedMessageKind = "steer" | "follow-up";

export interface QueuedChatMessage {
	text: string;
	kind: QueuedMessageKind;
}

export interface QueueUpdateEvent {
	type: "queue_update";
	messages: QueuedChatMessage[];
}

export interface ChatNoticeEvent {
	type: "notice";
	level: "info" | "success" | "warning" | "error";
	text: string;
	key?: string;
}

export interface QueuedMessagesSnapshot {
	steer: ReadonlyArray<string>;
	followUp: ReadonlyArray<string>;
}

export type ChatLoopEvent =
	| AgentEvent
	| AssistantDeltaEvent
	| RetryStatusEvent
	| QueueUpdateEvent
	| ChatNoticeEvent
	| AgentStatusEvent;

export interface ChatSubmitOptions {
	images?: ReadonlyArray<ImageContent>;
	/** Skill requests parsed by the harness for this turn. Not recorded as loaded until read_skill succeeds. */
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	/** Internal middleware resubmit; does not reset the per-user-prompt stalled-turn nudge cap. */
	requestContinuation?: boolean;
}

export interface ChatLoop {
	submit(text: string, options?: ChatSubmitOptions): Promise<void>;
	queueFollowUp(text: string): boolean;
	clearQueuedFollowUps(): string[];
	queuedMessages(): QueuedMessagesSnapshot;
	cancel(): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
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
	 * or null when the flow is a no-op (no entries, no cut crossed, no model
	 * configured). Chat-loop invokes this from two sites:
	 *   1. Before every agent.prompt when the threshold is crossed or
	 *      CLIO_FORCE_COMPACT=1 is set.
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
	 * Protected-artifact state handle, backed by the protected-artifacts hook
	 * registration at the composition root. The chat-loop replaces the state
	 * wholesale on session switch so protections follow the active session.
	 */
	protectedArtifacts?: { replace(state: ProtectedArtifactState): void };
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
}

interface ChatLoopTarget {
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	runtimeResolution: ResolvedRuntimeTarget;
}

interface AgentRuntime {
	agent: ReturnType<typeof createEngineAgent>["agent"];
	targetId: string;
	runtimeId: string;
	wireModelId: string;
	runtimeResolution: ResolvedRuntimeTarget;
}

const LOCAL_API_KEY_FALLBACK = "clio-local-target";

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const createAgent = deps.createAgent ?? createEngineAgent;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();
	let runtime: AgentRuntime | null = null;
	let lastTurnId: string | null = null;
	let streaming = false;
	let currentThinkingLevel: ThinkingLevel = deps.getSettings().orchestrator.thinkingLevel ?? "off";
	let replayedContextMessages: AgentMessage[] = [];
	let retryCountdown: RetryCountdownHandle | null = null;
	const persistedAssistantMessages = new WeakSet<object>();
	let currentContextSnapshot: ContextSnapshot | null = null;
	let lastCompactionEvent: { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null = null;
	// Last settled run's provider cache usage plus whether the compiled system
	// prompt was reused. Shown together in /context so "prompt reused" can
	// never imply provider cache reuse the backend did not report.
	let lastPromptCache: PromptCacheStats | null = null;
	let lastSystemPromptReused = false;
	// The session system prompt, compiled once per session. Recompiles happen
	// only on explicit events: the compile key (target, model, safety level,
	// session id) changes, or a config hot-reload invalidates the cache. A
	// recompile that changes the prompt text appends a "promptRecompiled"
	// ledger entry so a cold provider cache is always explainable.
	let sessionPrompt: CompiledSessionPrompt | null = null;
	let sessionPromptKey: string | null = null;
	let pendingPromptLogEntry: { previousHash: string | null; hash: string; tokenEstimate: number } | null = null;
	let activeUserTurnId: string | null = null;
	let toolProseAbortReason: string | null = null;
	// UI mirror of both engine queues, in enqueue order. Entries leave when
	// the engine injects them into the transcript (message_end →
	// appendQueuedUserTurn), when alt+up restores them to the editor, or when
	// a cancel clears the run.
	const queuedMirror: QueuedChatMessage[] = [];
	const persistedUserEchoes: string[] = [];
	const toolStartTimes = new Map<string, number>();
	let turnToolCalls = 0;
	let stalledTurnNudgeSpent = false;
	let pendingRequestContinuation = false;
	let currentPendingSkillPolicy: PendingSkillToolPolicy | undefined;
	let currentAskUserPolicy: AskUserToolPolicy | undefined;

	const emit = (event: ChatLoopEvent): void => {
		for (const listener of listeners) {
			listener(event);
		}
	};

	const emitFooterNotice = (level: ChatNoticeEvent["level"], text: string, key: string): void => {
		emit({ type: "notice", level, text, key });
	};

	// A config hot-reload may change prompt fragments or settings that feed
	// the session prompt; invalidate so the next submit recompiles. If the
	// recompiled text is byte-identical, nothing changes and no ledger entry
	// is written.
	const unsubscribeConfigReload =
		deps.bus?.on(BusChannels.ConfigHotReload, () => {
			sessionPromptKey = null;
		}) ?? null;

	// Cache-disturbance honesty (T3.3). Dispatch traffic and history
	// compaction invalidate a single-slot local backend's prefix cache.
	// Accumulate every disturbance since the last settled run; the next
	// submit consumes the set, stamps `promptCache.expectedColdReasons` on
	// its first assistant entry, and shows one dim notice.
	const pendingColdReasons = new Set<string>();
	let runExpectedColdReasons: string[] = [];
	let stampColdReasonsPending = false;
	const unsubscribeColdReasonSources = [
		...[BusChannels.DispatchStarted, BusChannels.DispatchCompleted, BusChannels.DispatchFailed].map(
			(channel) =>
				deps.bus?.on(channel, () => {
					pendingColdReasons.add("dispatch");
				}) ?? null,
		),
		...[BusChannels.CompactionBegin, BusChannels.CompactionEnd].map(
			(channel) =>
				deps.bus?.on(channel, () => {
					pendingColdReasons.add("compaction");
				}) ?? null,
		),
	];

	/**
	 * Capture a context snapshot from the runtime's live agent state. All
	 * capture sites (turn submit, both compaction paths) flow through this
	 * helper so window resolution and category decomposition stay identical.
	 */
	const captureRuntimeContextSnapshot = (
		agentRuntime: AgentRuntime,
		turnId: string,
		compactionThreshold: number | null,
		extra: Partial<CaptureContextSnapshotInput> = {},
	): ContextSnapshot => {
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		return captureContextSnapshot({
			sessionId: agentRuntime.agent.sessionId ?? "unknown",
			turnId,
			providerId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			systemPrompt: agentRuntime.agent.state.systemPrompt,
			conversationMessages: agentRuntime.agent.state.messages,
			activeToolSchemas: agentRuntime.agent.state.tools,
			desiredContextWindow: details.desiredContextWindow,
			effectiveContextWindow: details.effectiveContextWindow,
			contextWindowSource: details.contextWindowSource,
			compactionThreshold,
			...extra,
		});
	};

	/**
	 * True when the in-memory snapshot has been reconciled against provider
	 * usage since it was last persisted. A tool-calling turn reconciles once
	 * per API call; only the final reconciled state is written to the JSONL
	 * ledger, when the run settles. Any persist (turn submit, compaction,
	 * flush) clears the flag because it writes the current snapshot state.
	 */
	let snapshotPersistPending = false;

	const persistContextSnapshot = (snapshot: ContextSnapshot): void => {
		const currentSession = deps.session?.current();
		if (currentSession) appendContextSnapshot(currentSession, snapshot);
		snapshotPersistPending = false;
	};

	const flushReconciledSnapshot = (): void => {
		if (!snapshotPersistPending || !currentContextSnapshot) return;
		persistContextSnapshot(currentContextSnapshot);
	};

	/**
	 * Output tokens of the in-flight response. While streaming, estimate from
	 * the partial assistant tail; once the turn settles, the reconciled
	 * snapshot carries the provider-reported value.
	 */
	const liveStreamingOutputTokens = (): number => {
		if (!runtime) return 0;
		if (streaming) {
			const messages = runtime.agent.state.messages;
			const lastMsg = messages[messages.length - 1] as { role?: string; payload?: unknown; content?: unknown } | undefined;
			if (lastMsg && lastMsg.role === "assistant") {
				return ceilChars(contentChars(lastMsg.payload ?? lastMsg.content));
			}
			return 0;
		}
		return currentContextSnapshot?.categories.streaming || 0;
	};

	/**
	 * Tokens for the submitted text that the snapshot has not yet counted.
	 * The turn snapshot is captured before the user message joins the
	 * conversation, so until the provider reconciles (or a fresh capture sees
	 * the text in the conversation) the pending input occupies window space
	 * that no category covers. Zero once reconciled or once the text landed.
	 */
	const pendingUserInputTokens = (): number => {
		const snapshot = currentContextSnapshot;
		if (!snapshot?.pendingUserInput) return 0;
		if (snapshot.sources.total === "reconciled") return 0;
		if (snapshot.turnId !== "pending") {
			const pending = snapshot.pendingUserInput;
			const landed = (snapshot.conversationMessages ?? []).some(
				(message) => extractUserText(message as AgentMessage) === pending,
			);
			if (landed) return 0;
		}
		return ceilChars(snapshot.pendingUserInput.length);
	};

	const emitQueueUpdate = (): void => {
		emit({ type: "queue_update", messages: queuedMirror.map((entry) => ({ ...entry })) });
	};

	const removeQueuedMirrorEntry = (text: string): void => {
		const idx = queuedMirror.findIndex((entry) => entry.text === text);
		if (idx < 0) return;
		queuedMirror.splice(idx, 1);
		emitQueueUpdate();
	};

	const clearQueuedMirror = (): QueuedChatMessage[] => {
		const drained = queuedMirror.splice(0, queuedMirror.length);
		if (runtime) {
			runtime.agent.clearAllQueues();
		}
		if (drained.length > 0) emitQueueUpdate();
		return drained;
	};

	const markPersistedUserEcho = async (text: string, prompt: () => Promise<void>): Promise<void> => {
		persistedUserEchoes.push(text);
		try {
			await prompt();
		} finally {
			const idx = persistedUserEchoes.indexOf(text);
			if (idx >= 0) persistedUserEchoes.splice(idx, 1);
		}
	};

	const currentToolInvokeOptions = (): Partial<ToolInvokeOptions> => {
		const options: Partial<ToolInvokeOptions> = {};
		const sessionId = deps.session?.current()?.id ?? null;
		if (sessionId) options.sessionId = sessionId;
		const turnId = activeUserTurnId ?? lastTurnId;
		if (turnId) options.turnId = turnId;
		if (currentPendingSkillPolicy) options.pendingSkillPolicy = currentPendingSkillPolicy;
		if (currentAskUserPolicy) options.askUserPolicy = currentAskUserPolicy;
		return options;
	};

	const appendAssistantTurn = (message: AgentMessage, timing?: AssistantCallTiming | null): void => {
		if (!message || message.role !== "assistant") return;
		const failure = terminalFailureFromAssistantMessage(message);
		const payload = assistantSessionPayload(message, failure);
		if (timing) payload.timing = timing;
		// Per-call prompt-cache record (T3.2): provider-reported numbers only,
		// classified with the same thresholds as scripts/turn-report.mjs. The
		// run's first persisted call also carries any expected-cold reasons.
		const usage = (message as { usage?: Usage }).usage;
		if (usage && typeof usage === "object") {
			const input = typeof usage.input === "number" ? usage.input : 0;
			const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
			const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
			const promptCache: Record<string, unknown> = {
				input,
				cacheRead,
				cacheWrite,
				backendVerdict: backendCacheVerdict(input, cacheRead),
			};
			if (stampColdReasonsPending && runExpectedColdReasons.length > 0) {
				promptCache.expectedColdReasons = [...runExpectedColdReasons];
				stampColdReasonsPending = false;
			}
			payload.promptCache = promptCache;
		}
		if (isLengthStopAssistantMessage(message) && runtime) {
			const contextExhaustion = recordValue(payload.contextExhaustion);
			const contextWindow = runtime.runtimeResolution.capabilityDecisions.contextWindow;
			if (contextExhaustion && contextWindow > 0) contextExhaustion.contextWindow = contextWindow;
		}
		if (!deps.session || !hasPersistableAssistantContent(payload, failure)) return;
		if (message && typeof message === "object") persistedAssistantMessages.add(message as object);
		const turn = deps.session.append({
			kind: "assistant",
			parentId: lastTurnId,
			payload,
		});
		lastTurnId = turn.id;
	};

	const appendQueuedUserTurn = (message: AgentMessage): void => {
		if (!message || message.role !== "user") return;
		const text = extractUserText(message).trim();
		if (text.length === 0) return;
		const persistedEchoIdx = persistedUserEchoes.indexOf(text);
		if (persistedEchoIdx >= 0) {
			persistedUserEchoes.splice(persistedEchoIdx, 1);
			return;
		}
		removeQueuedMirrorEntry(text);
		if (!deps.session) return;
		if (!deps.session.current()) {
			const settings = deps.getSettings();
			const input: { cwd: string; target?: string; model?: string } = { cwd: process.cwd() };
			if (settings.orchestrator.target) input.target = settings.orchestrator.target;
			if (settings.orchestrator.model) input.model = settings.orchestrator.model;
			deps.session.create(input);
		}
		const userTurn = deps.session.append({
			kind: "user",
			parentId: lastTurnId,
			payload: { text },
		});
		lastTurnId = userTurn.id;
		activeUserTurnId = userTurn.id;
	};

	const appendToolCallTurn = (event: Extract<AgentEvent, { type: "tool_execution_start" }>): void => {
		if (!deps.session) return;
		const turn = deps.session.append({
			kind: "tool_call",
			parentId: lastTurnId,
			payload: {
				toolCallId: event.toolCallId,
				name: event.toolName,
				args: event.args,
			},
		});
		lastTurnId = turn.id;
	};

	const appendToolResultTurn = (
		event: Extract<AgentEvent, { type: "tool_execution_end" }> & {
			durationMs?: number;
			resultSummary?: Record<string, unknown>;
		},
	): void => {
		if (!deps.session) return;
		const payload: Record<string, unknown> = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
			resultSummary: event.resultSummary ?? toolResultSummary(event.result),
		};
		if (event.durationMs !== undefined) payload.durationMs = event.durationMs;
		const turn = deps.session.append({
			kind: "tool_result",
			parentId: lastTurnId,
			payload,
		});
		lastTurnId = turn.id;
	};

	const emitNotice = (text: string): void => {
		const message = noticeMessage(text);
		emit({ type: "message_end", message });
		emit({ type: "agent_end", messages: [message] });
	};

	const emitStreamingNotice = (text: string): void => {
		emit({ type: "message_end", message: noticeMessage(text) });
	};

	// Reminders accumulated from middleware `inject_reminder` effects
	// (turn_end advisories, hard-block recovery guidance, turn_start
	// injections). The next accepted prompt flushes them into the model
	// request as one system-reminder block; the buffer clears on session
	// switch.
	const pendingReminders: Array<{ message: string; severity: MiddlewareReminderSeverity }> = [];

	const bufferReminder = (message: string, severity: MiddlewareReminderSeverity): void => {
		if (pendingReminders.some((entry) => entry.message === message && entry.severity === severity)) return;
		pendingReminders.push({ message, severity });
	};

	const flushPendingReminders = (): string => {
		if (pendingReminders.length === 0) return "";
		const messages = pendingReminders.map((entry) => entry.message);
		pendingReminders.length = 0;
		return `<system-reminder>\n${messages.join("\n\n")}\n</system-reminder>`;
	};

	const runMiddlewareTurnHook = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		if (!deps.middleware) return [];
		try {
			return deps.middleware.runHook(input).effects;
		} catch {
			// Per-registration throws are already isolated inside the runtime;
			// anything escaping runHook is a runtime bug and must not break the
			// turn.
			return [];
		}
	};

	const appendMiddlewareReminderEntry = (message: string, severity: MiddlewareReminderSeverity): void => {
		if (!deps.session?.current()) return;
		try {
			deps.session.appendEntry({
				kind: "custom",
				parentTurnId: lastTurnId,
				customType: "middlewareReminder",
				display: true,
				data: { message, severity },
			});
		} catch {
			// Reminder persistence is best-effort; the live notice still
			// reaches the operator through the existing chat event path.
		}
	};

	const fireTurnStart = (agentRuntime: AgentRuntime, promptText: string): void => {
		const sessionId = deps.session?.current()?.id;
		const input: MiddlewareHookInput = {
			hook: "turn_start",
			...(sessionId ? { sessionId } : {}),
			modelId: agentRuntime.wireModelId,
			metadata: { promptChars: promptText.length, queued: false },
		};
		for (const effect of runMiddlewareTurnHook(input)) {
			if (effect.kind !== "inject_reminder") continue;
			bufferReminder(effect.message, effect.severity ?? "info");
		}
	};

	const applyTurnEndReminder = (
		agentRuntime: AgentRuntime,
		message: string,
		severity: MiddlewareReminderSeverity,
	): void => {
		bufferReminder(message, severity);
		if (severity === "hard-block") {
			// Interrupt the turn unless the streaming tool-prose cutoff already
			// aborted it mid-delta; the buffered reminder carries the recovery
			// guidance into the next request either way.
			if (toolProseAbortReason === null) {
				toolProseAbortReason = message;
				agentRuntime.agent.abort();
				emitStreamingNotice(message);
			}
			return;
		}
		appendMiddlewareReminderEntry(message, severity);
		emitNotice(message);
	};

	const applyRequestContinuation = (message: string): void => {
		if (stalledTurnNudgeSpent) {
			emitFooterNotice("warning", "model stalled again after a nudge; waiting for you", "nudge.stalled-turn.spent");
			return;
		}
		stalledTurnNudgeSpent = true;
		pendingRequestContinuation = true;
		bufferReminder(message, "info");
		emitFooterNotice("info", "model announced work without calling tools; nudge sent", "nudge.stalled-turn.sent");
	};

	const lastAssistantMessage = (messages: ReadonlyArray<AgentMessage>): AgentMessage | null => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				return message;
			}
		}
		return null;
	};

	/**
	 * Observe-only lifecycle point fired before each compaction stage, at the
	 * existing CompactionBegin emit sites. Consumers record telemetry or state
	 * ahead of context loss; returned effects are discarded by design.
	 */
	const fireCompactionHook = (
		stage: "mask_observations" | "llm_summary",
		trigger: CompactionTrigger,
		tokensBefore?: number,
	): void => {
		if (!deps.middleware) return;
		const sessionId = deps.session?.current()?.id;
		const metadata: Record<string, MiddlewareMetadataValue> = { stage, trigger };
		if (tokensBefore !== undefined) metadata.tokensBefore = tokensBefore;
		runMiddlewareTurnHook({
			hook: "on_compaction",
			...(sessionId ? { sessionId } : {}),
			...(activeUserTurnId ? { turnId: activeUserTurnId } : {}),
			metadata,
		});
	};

	const fireTurnEnd = (agentRuntime: AgentRuntime, messages: ReadonlyArray<AgentMessage>): void => {
		if (!deps.middleware) return;
		const message = lastAssistantMessage(messages);
		if (message === null) return;
		const text = extractText(message);
		if (text.trim().length === 0) return;
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		const metadata: Record<string, MiddlewareMetadataValue> = {
			assistantTextChars: text.length,
			hasStructuredToolCall: hasStructuredToolCall(message),
			runtimeId: agentRuntime.runtimeId,
			activeToolNames: toolNamesFromAgentState(agentRuntime.agent.state.tools).join(","),
			turnToolCalls,
		};
		if (typeof stopReason === "string") metadata.stopReason = stopReason;
		const sessionId = deps.session?.current()?.id;
		const input: MiddlewareHookInput = {
			hook: "turn_end",
			...(sessionId ? { sessionId } : {}),
			...(lastTurnId ? { turnId: lastTurnId } : {}),
			modelId: agentRuntime.wireModelId,
			text: text.slice(0, MIDDLEWARE_HOOK_TEXT_MAX_CHARS),
			metadata,
		};
		for (const effect of runMiddlewareTurnHook(input)) {
			if (effect.kind === "inject_reminder") {
				applyTurnEndReminder(agentRuntime, effect.message, effect.severity ?? "info");
				continue;
			}
			if (effect.kind === "request_continuation") {
				applyRequestContinuation(effect.message);
			}
		}
	};

	const retrySettings = (): RetrySettings => normalizeRetrySettings(deps.getSettings().retry);

	const emitRetryStatus = (status: RetryStatusPayload): void => {
		emit({ type: "retry_status", status });
	};

	const appendRetryStatus = (status: RetryStatusPayload): void => {
		if (!deps.session?.current()) return;
		deps.session.appendEntry({
			kind: "custom",
			parentTurnId: lastTurnId,
			customType: "retryStatus",
			display: true,
			data: status,
		});
	};

	const recordRetryStatus = (status: RetryStatusPayload, durable = true): void => {
		if (durable) appendRetryStatus(status);
		emitRetryStatus(status);
	};

	const ensureFailureVisibleAndPersisted = (failure: TerminalAssistantFailure): void => {
		const message = failure.message;
		if (!message || typeof message !== "object" || persistedAssistantMessages.has(message as object)) return;
		appendAssistantTurn(message);
		emit({ type: "message_end", message });
	};

	const waitForRetryCountdown = async (status: RetryStatusPayload): Promise<"done" | "cancelled"> => {
		return new Promise((resolve) => {
			let settled = false;
			let currentHandle: RetryCountdownHandle | null = null;
			const handle = createRetryCountdown({
				attempt: status.attempt,
				maxAttempts: status.maxAttempts,
				delayMs: status.delayMs ?? 0,
				onTick: (state) => {
					emitRetryStatus({
						...status,
						phase: "waiting",
						seconds: state.seconds,
					});
				},
				onDone: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					resolve("done");
				},
				onCancel: () => {
					settled = true;
					if (retryCountdown === currentHandle) retryCountdown = null;
					resolve("cancelled");
				},
			});
			currentHandle = handle;
			retryCountdown = settled ? null : handle;
		});
	};

	const readTarget = (): ChatLoopTarget | null => {
		const settings = deps.getSettings();
		const targetId = settings.orchestrator.target?.trim();
		const wireModelId = settings.orchestrator.model?.trim();
		if (!targetId || !wireModelId) return null;
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: settings.orchestrator.thinkingLevel ?? "off",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: true,
		});
		if (!resolved.ok) {
			const message = firstRuntimeResolutionError(resolved.diagnostics) ?? resolved.diagnostics[0]?.message;
			throw new Error(`[Clio Coder] ${message ?? "orchestrator target resolution failed"}`);
		}
		return {
			target: resolved.target.target,
			runtime: resolved.target.runtime,
			wireModelId: resolved.target.wireModelId,
			runtimeResolution: resolved.target,
		};
	};

	/**
	 * Probe a local-native target once per target+model selection, not on
	 * every submit (T3.1). The probe re-runs when the selection key changes
	 * (which is also when the runtime is rebuilt or hot-swapped) or after a
	 * generous TTL. Failures keep the last known target state; the TTL
	 * retries later.
	 */
	const TARGET_PROBE_TTL_MS = 5 * 60 * 1000;
	let lastTargetProbe: { key: string; at: number } | null = null;
	const ensureLiveCapabilitiesForSelectedModel = async (): Promise<void> => {
		const settings = deps.getSettings();
		const targetId = settings.orchestrator.target?.trim();
		const wireModelId = settings.orchestrator.model?.trim();
		if (!targetId || !wireModelId) return;
		const target = deps.providers.getTarget(targetId);
		if (!target) return;
		const runtimeDesc = deps.providers.getRuntime(target.runtime);
		if (runtimeDesc?.tier !== "local-native") return;
		const key = `${targetId}|${wireModelId}`;
		const now = Date.now();
		if (lastTargetProbe?.key === key && now - lastTargetProbe.at < TARGET_PROBE_TTL_MS) return;
		lastTargetProbe = { key, at: now };
		try {
			await deps.providers.probeTarget(targetId);
		} catch {
			// Fall back to the last known target state.
		}
	};

	const synthesizeModel = (target: ChatLoopTarget): Model<never> => {
		const kbHit = deps.providers.knowledgeBase?.lookup(target.wireModelId) ?? null;
		const synth = target.runtime.synthesizeModel(target.target, target.wireModelId, kbHit);
		target.runtimeResolution = refineRuntimeTargetWithModelHints(
			target.runtimeResolution,
			synth,
			deps.providers.knowledgeBase,
		);
		applyModelCapabilityPatch(synth, target.runtimeResolution.capabilities);
		return synth as unknown as Model<never>;
	};
	const ensureReasoningProbe = (target: ChatLoopTarget): void => {
		if (deps.providers.getDetectedReasoning(target.target.id, target.wireModelId) !== null) return;
		void deps.providers
			.probeReasoningForModel(target.target.id, target.wireModelId)
			.then((reasoning) => {
				if (
					reasoning !== null &&
					runtime &&
					runtime.targetId === target.target.id &&
					runtime.wireModelId === target.wireModelId
				) {
					const refreshed = resolveRuntimeTarget(deps.providers, {
						targetId: target.target.id,
						wireModelId: target.wireModelId,
						requestedThinkingLevel: deps.getSettings().orchestrator.thinkingLevel ?? "off",
						use: "orchestrator",
						requireTools: false,
						requireOutputBudget: true,
					});
					if (!refreshed.ok) return;
					const liveModel = runtime.agent.state.model;
					const runtimeResolution = liveModel
						? refineRuntimeTargetWithModelHints(refreshed.target, liveModel, deps.providers.knowledgeBase)
						: refreshed.target;
					if (liveModel) applyModelCapabilityPatch(liveModel, runtimeResolution.capabilities);
					runtime.agent.state.thinkingLevel = runtimeResolution.effectiveThinkingLevel;
					runtime.runtimeResolution = runtimeResolution;
				}
			})
			.catch(() => {
				// Probe failures are non-fatal; the cache stays cold and /thinking
				// keeps showing the runtime defaults until the next probe attempt.
			});
	};

	const cleanupSessionResources = (sessionId: string | undefined): void => {
		try {
			cleanupEngineSessionResources(sessionId);
		} catch (err) {
			emitNotice(`[Clio Coder] session resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/**
	 * Append a `modelChange` session entry so /resume and /fork can replay the
	 * sequence of models a long-running session ran under. Silent no-op when
	 * the session contract is absent or no session is current. The
	 * orchestrator's chat-loop is the only writer; chat-renderer.ts already
	 * knows how to display the entry.
	 */
	const appendModelChangeEntry = (target: ChatLoopTarget): void => {
		if (!deps.session?.current()) return;
		try {
			deps.session.appendEntry({
				kind: "modelChange",
				parentTurnId: lastTurnId,
				provider: target.runtime.id,
				modelId: target.wireModelId,
				target: target.target.id,
			});
		} catch {
			// Persistence failures must not break chat. The marker is a
			// best-effort breadcrumb; absence falls back to current behavior.
		}
	};

	/**
	 * Publish the window-resolution warning only on transitions (appeared,
	 * changed, cleared). ensureRuntime runs on every submit; re-emitting the
	 * same state each turn would spam every ContextWarning subscriber.
	 */
	let lastContextWindowWarning: string | null = null;
	const emitContextWindowWarningTransition = (warning: string | null): void => {
		if (warning === lastContextWindowWarning) return;
		lastContextWindowWarning = warning;
		deps.bus?.emit(BusChannels.ContextWarning, { warning } satisfies ContextWarningPayload);
	};

	const ensureRuntime = (): AgentRuntime | null => {
		const target = readTarget();
		if (!target) return null;
		emitContextWindowWarningTransition(target.runtimeResolution?.contextWindowDetails?.warning ?? null);
		if (!deps.knownTargets().has(target.target.id)) {
			throw new Error(
				`[Clio Coder] orchestrator target=${target.target.id} unknown. Run \`clio targets\` to see configured targets.`,
			);
		}
		if (
			runtime &&
			runtime.targetId === target.target.id &&
			runtime.runtimeId === target.runtime.id &&
			runtime.wireModelId === target.wireModelId
		) {
			// Same target+runtime+model. Settings may still have moved
			// thinkingLevel since the last call (the user invoked /thinking
			// or Alt+T); reconcile the clamped level so the next prompt
			// dispatches under the current intent without forcing a rebuild.
			ensureReasoningProbe(target);
			const runtimeResolution = refineRuntimeTargetWithModelHints(
				target.runtimeResolution,
				runtime.agent.state.model,
				deps.providers.knowledgeBase,
			);
			const desiredLevel = runtimeResolution.effectiveThinkingLevel;
			if (runtime.agent.state.thinkingLevel !== desiredLevel) {
				runtime.agent.state.thinkingLevel = desiredLevel;
			}
			runtime.runtimeResolution = runtimeResolution;
			return runtime;
		}

		// Same target+runtime, new wireModelId: hot-swap the model in place on
		// the live agent. Mirrors the pi-coding-agent setModel pattern (mutate
		// `agent.state.model`, re-clamp thinking level, persist) so the runtime
		// keeps its conversation, subscribers, and pending tool calls. Local
		// runtimes (LM Studio, Ollama) manage their own resident-model lifecycle
		// via JIT load and TTL; Clio does not micromanage server-side eviction.
		if (
			runtime &&
			runtime.targetId === target.target.id &&
			runtime.runtimeId === target.runtime.id &&
			runtime.wireModelId !== target.wireModelId
		) {
			const nextModel = synthesizeModel(target);
			runtime.agent.state.model = nextModel;
			runtime.wireModelId = target.wireModelId;
			const effectiveThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
			runtime.agent.state.thinkingLevel = effectiveThinkingLevel;
			runtime.runtimeResolution = target.runtimeResolution;
			appendModelChangeEntry(target);
			ensureReasoningProbe(target);
			// Ollama pins the active model with keep_alive=-1; fire a one-shot
			// keep_alive=0 sweep against any other resident model so the prior
			// pinned weight releases VRAM. Fire-and-forget so a slow server
			// never blocks the model swap.
			if (target.runtime.id === "ollama-native" && target.target.url) {
				void evictOtherOllamaModels(target.target.url, target.wireModelId, target.target.auth?.headers);
			}
			return runtime;
		}

		const model = synthesizeModel(target);
		const initialThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
		const tools: ReturnType<typeof resolveAgentTools> = [];
		// Seed the system prompt with the fallback identity text. The first
		// submit replaces it with the compiled session prompt; the fallback
		// only shows up when the prompts contract is absent (tests, degraded
		// boot).
		const hadPriorRuntime = runtime !== null;
		const priorMessages = runtime ? [...runtime.agent.state.messages] : [...replayedContextMessages];
		// Drop any in-flight stream on the prior agent before discarding it.
		if (runtime) {
			runtime.agent.abort();
			cleanupSessionResources(runtime.agent.sessionId);
		}
		const handle = createAgent({
			initialState: {
				systemPrompt: fallbackIdentityPrompt(),
				model,
				thinkingLevel: initialThinkingLevel,
				tools,
				messages: priorMessages,
			},
			maxRetryDelayMs: retrySettings().maxDelayMs,
			onPayload: async (payload, currentModel) =>
				patchReasoningSummaryPayload(payload, currentModel as Model<never>, currentThinkingLevel),
			getApiKey: async () => {
				if (!targetRequiresAuth(target.target, target.runtime)) {
					return LOCAL_API_KEY_FALLBACK;
				}
				const resolved = await deps.providers.auth.resolveForTarget(target.target, target.runtime);
				return resolved.apiKey;
			},
		});

		// Build the runtime object before subscribing so the callback closes
		// over the same heap object the hot-swap path mutates. Reading
		// `localRuntime.targetId` / `localRuntime.wireModelId` at event time
		// instead of the captured `target` guarantees per-turn observability
		// rows are tagged with whatever model is active right now, not the
		// model this agent was originally built with.
		const localRuntime: AgentRuntime = {
			agent: handle.agent,
			targetId: target.target.id,
			runtimeId: target.runtime.id,
			wireModelId: target.wireModelId,
			runtimeResolution: target.runtimeResolution,
		};
		handle.agent.prepareNextTurn = async (signal?: AbortSignal) => postToolContinuationGuard(localRuntime, signal);

		let streamStartedAt: number | null = null;
		let firstAssistantDeltaAt: number | null = null;
		// Per-API-call timing (T3.2): one assistant message per provider call,
		// bounded by message_start/message_end; the first delta marks TTFT.
		let apiCallStartedAt: number | null = null;
		let apiCallFirstDeltaAt: number | null = null;
		// First call of the run is the one whose verdict says whether the
		// backend reused the session prefix; later calls in a tool loop are
		// trivially warm.
		let runFirstCallVerdict: BackendCacheVerdict | null = null;

		handle.agent.subscribe(async (event) => {
			const eventAt = Date.now();
			let enrichedEvent = event;
			if (event.type === "tool_execution_start") {
				toolStartTimes.set(event.toolCallId, eventAt);
				turnToolCalls += 1;
			} else if (event.type === "tool_execution_end") {
				const startedAt = toolStartTimes.get(event.toolCallId);
				toolStartTimes.delete(event.toolCallId);
				const durationMs = startedAt === undefined ? undefined : Math.max(0, eventAt - startedAt);
				enrichedEvent = {
					...event,
					...(durationMs !== undefined ? { durationMs } : {}),
					resultSummary: toolResultSummary(event.result),
				} as typeof event;
			}
			const publicEvent = enrichedEvent;
			if (publicEvent?.type === "agent_start") {
				streamStartedAt = eventAt;
				firstAssistantDeltaAt = null;
				apiCallStartedAt = null;
				apiCallFirstDeltaAt = null;
				runFirstCallVerdict = null;
			}
			if (publicEvent?.type === "message_start" && publicEvent.message?.role === "assistant") {
				apiCallStartedAt = eventAt;
				apiCallFirstDeltaAt = null;
			}
			if (publicEvent?.type === "message_update") {
				const assistantEvent = publicEvent.assistantMessageEvent as { type?: string; delta?: unknown };
				const hasDelta =
					assistantEvent.type === "text_delta" ||
					assistantEvent.type === "thinking_delta" ||
					assistantEvent.type === "toolcall_start" ||
					assistantEvent.type === "toolcall_delta";
				if (hasDelta && firstAssistantDeltaAt === null) firstAssistantDeltaAt = eventAt;
				if (hasDelta && apiCallFirstDeltaAt === null) apiCallFirstDeltaAt = eventAt;
			}
			if (publicEvent?.type === "agent_end") {
				const cacheSummary = sumRunUsage(publicEvent.messages);
				if (cacheSummary.hadUsage) {
					lastPromptCache = {
						shellReused: lastSystemPromptReused,
						cacheReadTokens: cacheSummary.cacheRead > 0 || cacheSummary.cacheWrite > 0 ? cacheSummary.cacheRead : null,
						cacheWriteTokens: cacheSummary.cacheRead > 0 || cacheSummary.cacheWrite > 0 ? cacheSummary.cacheWrite : null,
						uncachedInputTokens: cacheSummary.input,
						backendVerdict: runFirstCallVerdict,
					};
				}
			}
			if (publicEvent?.type === "agent_end" && deps.observability) {
				const summary = sumRunUsage(publicEvent.messages);
				if (summary.hadUsage && (summary.tokens > 0 || summary.costUsd > 0)) {
					deps.observability.recordTokens(localRuntime.targetId, localRuntime.wireModelId, summary.tokens, summary.costUsd, {
						input: summary.input,
						output: summary.output,
						cacheRead: summary.cacheRead,
						cacheWrite: summary.cacheWrite,
						reasoningTokens: summary.reasoning,
						totalTokens: summary.tokens,
						apiCalls: summary.apiCalls,
					});
				}
				if (summary.output > 0 && firstAssistantDeltaAt !== null) {
					const durationMs = Math.max(1, eventAt - firstAssistantDeltaAt);
					deps.observability.recordTokenThroughput({
						tokensPerSecond: summary.output / (durationMs / 1000),
						outputTokens: summary.output,
						durationMs,
						...(streamStartedAt !== null ? { ttftMs: firstAssistantDeltaAt - streamStartedAt } : {}),
						providerId: localRuntime.targetId,
						modelId: localRuntime.wireModelId,
						recordedAt: eventAt,
					});
				}
			}
			if (publicEvent) emit(publicEvent);
			if (publicEvent?.type === "message_update") {
				const assistantEvent = publicEvent.assistantMessageEvent as {
					type: string;
					contentIndex?: number;
					delta?: string;
					partial?: AgentMessage;
				};
				if (assistantEvent.type === "text_delta") {
					const partialText = extractText(assistantEvent.partial);
					emit({
						type: "text_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialText,
					});
					const activeToolNames = toolNamesFromAgentState(localRuntime.agent.state.tools);
					const localToolRuntime = localRuntime.runtimeId === "llamacpp" || localRuntime.runtimeId === "lmstudio-native";
					if (localToolRuntime && toolProseAbortReason === null) {
						const assessment = assessToolProseLoop({
							text: partialText,
							activeToolNames,
							hasStructuredToolCall: hasStructuredToolCall(assistantEvent.partial),
						});
						if (assessment.kind === "loop") {
							toolProseAbortReason = `[Clio Coder] aborted local model turn: ${assessment.reason}.`;
							localRuntime.agent.abort();
							emitStreamingNotice(toolProseAbortReason);
						}
					}
				}
				if (assistantEvent.type === "thinking_delta") {
					emit({
						type: "thinking_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialThinking: extractThinking(assistantEvent.partial),
					});
				}
			}
			if (enrichedEvent.type === "message_end") {
				appendQueuedUserTurn(enrichedEvent.message);
				const isAssistant = enrichedEvent.message?.role === "assistant";
				const timing: AssistantCallTiming | null =
					isAssistant && apiCallStartedAt !== null
						? {
								ttftMs: apiCallFirstDeltaAt !== null ? Math.max(0, apiCallFirstDeltaAt - apiCallStartedAt) : null,
								apiMs: Math.max(0, eventAt - apiCallStartedAt),
							}
						: null;
				appendAssistantTurn(enrichedEvent.message, timing);
				if (isAssistant) apiCallStartedAt = null;
				const usage = (enrichedEvent.message as { usage?: Usage }).usage;
				if (isAssistant && usage && typeof usage === "object" && runFirstCallVerdict === null) {
					const input = typeof usage.input === "number" ? usage.input : 0;
					const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
					runFirstCallVerdict = backendCacheVerdict(input, cacheRead);
				}
				if (usage && currentContextSnapshot) {
					// Reconcile in memory on every API call so the live meters
					// track usage; persistence waits for the run to settle.
					currentContextSnapshot = reconcileSnapshot(currentContextSnapshot, usage);
					snapshotPersistPending = true;
				}
			}
			if (enrichedEvent.type === "tool_execution_start") {
				appendToolCallTurn(enrichedEvent);
			}
			if (enrichedEvent.type === "tool_execution_end") {
				appendToolResultTurn(enrichedEvent);
			}
			if (enrichedEvent.type === "agent_end") {
				flushReconciledSnapshot();
				fireTurnEnd(localRuntime, enrichedEvent.messages);
			}
		});

		runtime = localRuntime;
		// Append a modelChange marker only when this rebuild replaces a prior
		// runtime, which is the cross-target swap case (mid-session change of
		// target or runtime id). On the initial build, the session header's
		// `meta.model` (written by `session.create()` in submit()) captures
		// the first model and a marker would be redundant.
		if (hadPriorRuntime) appendModelChangeEntry(target);
		ensureReasoningProbe(target);
		return runtime;
	};

	/**
	 * Shared compact-and-retry worker used by both the post-resolve
	 * (state-based) and catch (throw-based) overflow paths in `submit`.
	 * Emits the "context overflow" notice when compaction is a no-op,
	 * the "compact-on-overflow failed" notice when compaction itself
	 * throws, and a "persisted" notice when the retry still surfaces an
	 * overflow.
	 */
	const runCompactAndRetry = async (
		agentRuntime: AgentRuntime,
		text: string,
		overflow: NonNullable<ReturnType<typeof toContextOverflowError>>,
		images?: ReadonlyArray<ImageContent>,
	): Promise<void> => {
		let compacted = false;
		try {
			pruneFailedAssistantFromContext(agentRuntime.agent);
			const mutableState = agentRuntime.agent.state as MutableAgentState;
			mutableState.errorMessage = undefined;
			compacted = await runAutoCompact(agentRuntime, true, undefined, "overflow");
		} catch (compactErr) {
			emitNotice(
				`[Clio Coder] compact-on-overflow failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
			);
		}
		if (!compacted) {
			emitNotice(`[Clio Coder] context overflow: ${overflow.message}`);
			return;
		}
		try {
			await markPersistedUserEcho(text, () => agentRuntime.agent.prompt(text, images ? [...images] : undefined));
			const stillOverflowed = detectOverflowFromState(agentRuntime.agent);
			if (stillOverflowed) {
				emitNotice(`[Clio Coder] context overflow persisted after compaction: ${stillOverflowed.message}`);
			}
		} catch (retryErr) {
			emitNotice(
				`[Clio Coder] context overflow persisted after compaction: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
			);
		}
	};

	const runTransientRetryChain = async (
		agentRuntime: AgentRuntime,
		text: string,
		initialFailure: TerminalAssistantFailure,
	): Promise<boolean> => {
		const settings = retrySettings();
		if (!settings.enabled || settings.maxRetries <= 0) return false;
		if (initialFailure.stopReason === "aborted" || !isRetryableErrorMessage(initialFailure.errorMessage)) return false;

		let failure = initialFailure;
		for (let attempt = 1; attempt <= settings.maxRetries; attempt += 1) {
			ensureFailureVisibleAndPersisted(failure);
			pruneFailedAssistantFromContext(agentRuntime.agent);

			const scheduled: RetryStatusPayload = {
				phase: "scheduled",
				attempt,
				maxAttempts: settings.maxRetries,
				delayMs: computeRetryDelayMs(attempt, settings),
				errorMessage: failure.errorMessage,
			};
			recordRetryStatus(scheduled);
			const countdown = await waitForRetryCountdown(scheduled);
			if (countdown === "cancelled") {
				recordRetryStatus({
					phase: "cancelled",
					attempt,
					maxAttempts: settings.maxRetries,
					errorMessage: failure.errorMessage,
				});
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}

			recordRetryStatus(
				{
					phase: "retrying",
					attempt,
					maxAttempts: settings.maxRetries,
					errorMessage: failure.errorMessage,
				},
				false,
			);

			try {
				await agentRuntime.agent.continue();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!isRetryableErrorMessage(message) || attempt >= settings.maxRetries) {
					recordRetryStatus({
						phase: "exhausted",
						attempt,
						maxAttempts: settings.maxRetries,
						errorMessage: message,
					});
					emitNotice(message);
					pruneFailedAssistantFromContext(agentRuntime.agent);
					return true;
				}
				failure = { stopReason: "error", errorMessage: message };
				continue;
			}

			const overflow = detectOverflowFromState(agentRuntime.agent);
			if (overflow) {
				await runCompactAndRetry(agentRuntime, text, overflow);
				return true;
			}

			const nextFailure = detectTerminalFailureFromState(agentRuntime.agent);
			if (!nextFailure) {
				recordRetryStatus({
					phase: "recovered",
					attempt,
					maxAttempts: settings.maxRetries,
				});
				return true;
			}
			ensureFailureVisibleAndPersisted(nextFailure);
			if (nextFailure.stopReason === "aborted" || !isRetryableErrorMessage(nextFailure.errorMessage)) {
				pruneFailedAssistantFromContext(agentRuntime.agent);
				return true;
			}
			failure = nextFailure;
		}

		recordRetryStatus({
			phase: "exhausted",
			attempt: settings.maxRetries,
			maxAttempts: settings.maxRetries,
			errorMessage: failure.errorMessage,
		});
		pruneFailedAssistantFromContext(agentRuntime.agent);
		return true;
	};

	/**
	 * Ensure the session system prompt is compiled and applied to the live
	 * agent. Compiles only when the compile key (target, model, safety
	 * level, session id) changes or a config hot-reload invalidated the
	 * cache; every other submit reuses the cached prompt byte-for-byte. A
	 * compile whose text differs from the previous prompt queues a
	 * "promptRecompiled" ledger entry (written once the session exists).
	 */
	const ensureSessionPrompt = async (agentRuntime: AgentRuntime): Promise<CompiledSessionPrompt | null> => {
		if (!deps.prompts) return null;
		const settings = deps.getSettings();
		const autonomy = settings.autonomy ?? "auto-edit";
		const sessionId = deps.session?.current()?.id ?? "";
		const key = `${agentRuntime.targetId}|${agentRuntime.wireModelId}|${autonomy}|${sessionId}`;
		if (sessionPrompt && sessionPromptKey === key) {
			lastSystemPromptReused = true;
			return sessionPrompt;
		}
		const modelState = agentRuntime.agent.state.model as
			| (Model<never> & { clio?: { quirks?: LocalModelQuirks } })
			| undefined;
		const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : null;
		const guidance = modelState?.clio?.quirks?.thinking?.guidance;
		const sessionInputs: SessionPromptInputs = {
			provider: agentRuntime.targetId,
			model: agentRuntime.wireModelId,
			contextWindow,
			providerSupportsTools: runtimeSupportsTools(agentRuntime),
			...(guidance ? { thinkingGuidance: guidance } : {}),
			activeToolNames: toolNamesFromAgentState(agentRuntime.agent.state.tools),
		};
		if (deps.getMemorySection) {
			try {
				const memorySection = deps.getMemorySection();
				if (memorySection.length > 0) sessionInputs.memorySection = memorySection;
			} catch (err) {
				emitNotice(
					`[Clio Coder] memory load failed; continuing without memory injection: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		try {
			const result = await deps.prompts.compileSessionPrompt({
				sessionInputs,
				autonomy,
				cwd: process.cwd(),
			});
			const previousHash = sessionPrompt?.systemPromptHash ?? null;
			const changed = agentRuntime.agent.state.systemPrompt !== result.systemPrompt;
			if (changed) {
				agentRuntime.agent.state.systemPrompt = result.systemPrompt;
				pendingPromptLogEntry = {
					previousHash,
					hash: result.systemPromptHash,
					tokenEstimate: result.tokenEstimate,
				};
			}
			lastSystemPromptReused = !changed;
			sessionPrompt = result;
			sessionPromptKey = key;
			return result;
		} catch (err) {
			emitNotice(
				`[Clio Coder] prompt compile failed; using fallback identity: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	};

	/**
	 * Write the queued prompt-compile ledger entry. Deferred until after the
	 * user turn is appended so the session is guaranteed to exist.
	 */
	const logPromptCompileIfPending = (): void => {
		if (!pendingPromptLogEntry || !deps.session?.current()) return;
		const entry = pendingPromptLogEntry;
		pendingPromptLogEntry = null;
		try {
			deps.session.appendEntry({
				kind: "custom",
				customType: "promptRecompiled",
				parentTurnId: lastTurnId,
				data: {
					previousHash: entry.previousHash,
					hash: entry.hash,
					tokenEstimate: entry.tokenEstimate,
				},
			});
		} catch {
			// Ledger logging is diagnostics, not control flow; never abort a turn.
		}
	};

	const liveContextEstimate = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
	): { tokens: number; contextWindow: number; breakdown: ReturnType<typeof estimateAgentContextBreakdown> } => {
		const contextWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
		const estimateInput = {
			systemPrompt: agentRuntime.agent.state.systemPrompt,
			messages: agentRuntime.agent.state.messages,
			tools: agentRuntime.agent.state.tools,
			...(pendingUserText !== undefined ? { pendingUserText } : {}),
		};
		return {
			tokens: estimateAgentContextTokens(estimateInput),
			contextWindow,
			breakdown: estimateAgentContextBreakdown(estimateInput),
		};
	};

	const refreshAgentMessagesFromSession = (agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry> => {
		const refreshedEntries = deps.readSessionEntries?.() ?? [];
		agentRuntime.agent.state.messages = buildReplayAgentMessagesFromTurns(refreshedEntries);
		replayedContextMessages = [];
		return refreshedEntries;
	};

	/**
	 * Two-mechanism context protection. When pressure crosses the single
	 * threshold, first mask the bodies of tool observations older than
	 * `excludeLastTurns` (cheap, no LLM call). If pressure stays above the
	 * threshold, delegate to the pi-style LLM compaction path: append a
	 * compaction summary entry, then replay from the session view.
	 *
	 * `force = true` skips the pressure check and the mask pre-stage and runs
	 * the LLM summary directly. Used for `/compact`, CLIO_FORCE_COMPACT=1,
	 * and overflow recovery.
	 */
	const runAutoCompact = async (
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
	): Promise<boolean> => {
		if (!deps.autoCompact || !deps.readSessionEntries) return false;
		const settings = deps.getSettings();
		const cfg = settings.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;

		const compactionThreshold = cfg?.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
		const trigger: CompactionTrigger = triggerOverride ?? (force ? "force" : "auto");

		if (!force) {
			const estimate = liveContextEstimate(agentRuntime, pendingUserText);
			const verdict = shouldCompact(estimate.tokens, compactionThreshold, estimate.contextWindow);
			if (!verdict.shouldCompact) return false;

			// Mechanism B pre-stage: mask stale observations before paying for
			// an LLM summary. History rewrites here invalidate the backend
			// prefix cache; the "compaction" expectedColdReasons stamp from the
			// CompactionBegin/End subscription explains the next cold turn.
			if (deps.session?.current()) {
				const beforeSnapshotId = currentContextSnapshot?.snapshotId ?? null;
				const masked = maskStaleObservations(deps.readSessionEntries() ?? [], cfg?.excludeLastTurns ?? 6);
				if (masked.changed) {
					fireCompactionHook("mask_observations", trigger, estimate.tokens);
					deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
					deps.session.replaceEntries(masked.entries);
					refreshAgentMessagesFromSession(agentRuntime);
					deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });

					const postMaskSnapshot = captureRuntimeContextSnapshot(
						agentRuntime,
						activeUserTurnId || "compaction",
						compactionThreshold,
					);
					currentContextSnapshot = postMaskSnapshot;
					persistContextSnapshot(postMaskSnapshot);

					const tokensAfterMask = snapshotInputTokens(postMaskSnapshot);
					lastCompactionEvent = {
						stage: "mask_observations",
						tokensBefore: estimate.tokens,
						tokensAfter: tokensAfterMask,
						trigger,
					};
					deps.bus?.emit(BusChannels.ContextPruned, {
						stage: "mask_observations",
						pressure: verdict.pressure,
						tokensBefore: estimate.tokens,
						tokensAfter: tokensAfterMask,
						maskedObservations: masked.maskedObservations,
						maskedThinkingBlocks: masked.maskedThinkingBlocks,
						maskedThinkingChars: masked.maskedThinkingChars,
						trigger,
						snapshotIdBefore: beforeSnapshotId,
						snapshotIdAfter: postMaskSnapshot.snapshotId,
						at: Date.now(),
					} satisfies ContextPrunedPayload);
					const thinkingNote =
						masked.maskedThinkingBlocks > 0
							? `, ${masked.maskedThinkingBlocks} thinking blocks dropped (~${masked.maskedThinkingChars} chars)`
							: "";
					emitNotice(
						`[context engine] mask_observations: ${masked.maskedObservations} observations masked${thinkingNote}; ~${estimate.tokens} tokens -> ~${tokensAfterMask} tokens`,
					);

					const after = liveContextEstimate(agentRuntime, pendingUserText);
					if (!shouldCompact(after.tokens, compactionThreshold, after.contextWindow).shouldCompact) return true;
				}
			}
		}

		fireCompactionHook("llm_summary", trigger);
		deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
		let result: CompactResult | null = null;
		const beforeSnapshotId = currentContextSnapshot?.snapshotId ?? null;
		try {
			result = await compactionTrigger.fire(() => (deps.autoCompact ?? (async () => null))(instructions, trigger));
		} finally {
			deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });
		}
		if (!result || result.summary.length === 0) return false;

		refreshAgentMessagesFromSession(agentRuntime);

		const postCompactSnapshot = captureRuntimeContextSnapshot(
			agentRuntime,
			activeUserTurnId || "compaction",
			compactionThreshold,
		);
		currentContextSnapshot = postCompactSnapshot;
		persistContextSnapshot(postCompactSnapshot);

		const tokensAfter = snapshotInputTokens(postCompactSnapshot);
		lastCompactionEvent = {
			stage: "llm_summary",
			tokensBefore: result.tokensBefore,
			tokensAfter,
			trigger,
		};
		deps.bus?.emit(BusChannels.ContextPruned, {
			stage: "llm_summary",
			tokensBefore: result.tokensBefore,
			tokensAfter,
			trigger,
			snapshotIdBefore: beforeSnapshotId,
			snapshotIdAfter: postCompactSnapshot.snapshotId,
			at: Date.now(),
		} satisfies ContextPrunedPayload);

		emitNotice(
			renderCompactionSummaryLine({
				messagesSummarized: result.messagesSummarized,
				summaryChars: result.summary.length,
				tokensBefore: result.tokensBefore,
				isSplitTurn: result.isSplitTurn,
			}),
		);
		return true;
	};

	const toolResultTail = (agentRuntime: AgentRuntime): boolean => {
		const messages = agentRuntime.agent.state.messages;
		const tail = messages[messages.length - 1] as AgentMessage | undefined;
		return !!tail && typeof tail === "object" && tail !== null && "role" in tail && tail.role === "toolResult";
	};

	const continuationContextUpdate = (agentRuntime: AgentRuntime) => ({
		context: {
			systemPrompt: agentRuntime.agent.state.systemPrompt,
			messages: [...agentRuntime.agent.state.messages],
			tools: [...agentRuntime.agent.state.tools],
		},
		model: agentRuntime.agent.state.model,
		thinkingLevel: agentRuntime.agent.state.thinkingLevel,
	});

	const postToolContinuationGuard = async (agentRuntime: AgentRuntime, signal?: AbortSignal) => {
		if (signal?.aborted || !toolResultTail(agentRuntime)) return undefined;
		const before = liveContextEstimate(agentRuntime);
		if (before.contextWindow <= 0 || before.tokens <= 0) return undefined;

		const settings = deps.getSettings();
		const threshold = settings.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
		const verdict = shouldCompact(before.tokens, threshold, before.contextWindow);
		let compacted = false;
		if (verdict.shouldCompact) {
			try {
				compacted = await runAutoCompact(agentRuntime, false, undefined, "auto");
			} catch (err) {
				throw new Error(
					`[Clio Coder] post-tool context guard could not compact before continuation: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		const after = liveContextEstimate(agentRuntime);
		if (after.tokens >= after.contextWindow) {
			throw new Error(
				`[Clio Coder] post-tool context guard stopped continuation before provider call: estimated ${after.tokens} tokens exceeds reported context window ${after.contextWindow}. Use /compact, narrower reads, or a follow-up turn with smaller observations.`,
			);
		}
		return compacted ? continuationContextUpdate(agentRuntime) : undefined;
	};

	const appendSubmittedUserTurn = (
		agentRuntime: AgentRuntime,
		text: string,
		images: ReadonlyArray<ImageContent> | undefined,
	): string | null => {
		if (!deps.session) return null;
		if (!deps.session.current()) {
			deps.session.create({
				cwd: process.cwd(),
				target: agentRuntime.targetId,
				model: agentRuntime.wireModelId,
			});
		}
		const userTurn = deps.session.append({
			kind: "user",
			parentId: lastTurnId,
			payload: images ? { content: [{ type: "text", text }, ...images] } : { text },
		});
		lastTurnId = userTurn.id;
		activeUserTurnId = userTurn.id;
		const sessionId = deps.session.current()?.id ?? null;
		if (sessionId) {
			agentRuntime.agent.sessionId = sessionId;
		}
		return userTurn.id;
	};

	/**
	 * Stranded-steer fallback. The engine inner loop drains steering messages
	 * after every tool batch, but the outer loop polls only follow-ups before
	 * `agent_end`, so a steer enqueued in the run's final moments (or during
	 * an error stop) is never injected. When the run settles with unconsumed
	 * steer mirror entries, clear them and resubmit the texts as a fresh
	 * prompt: exactly today's end-of-run delivery. Esc cancel clears both
	 * queues first, so a cancelled run never resubmits.
	 */
	const resubmitStrandedSteers = async (): Promise<boolean> => {
		const stranded = queuedMirror.filter((entry) => entry.kind === "steer");
		if (stranded.length === 0) return false;
		for (const entry of stranded) {
			const idx = queuedMirror.indexOf(entry);
			if (idx >= 0) queuedMirror.splice(idx, 1);
		}
		pendingRequestContinuation = false;
		runtime?.agent.clearSteeringQueue();
		emitQueueUpdate();
		emitNotice("[Clio Coder] steering arrived as the run ended; resubmitting as a fresh prompt.");
		await api.submit(stranded.map((entry) => entry.text).join("\n\n"));
		return true;
	};

	const resubmitRequestContinuation = async (): Promise<void> => {
		if (!pendingRequestContinuation) return;
		pendingRequestContinuation = false;
		await api.submit("", { requestContinuation: true });
	};

	const api: ChatLoop = {
		queueFollowUp(text: string): boolean {
			const trimmed = text.trim();
			if (trimmed.length === 0 || !streaming || !runtime) return false;
			const message = {
				role: "user",
				content: trimmed,
				timestamp: Date.now(),
			} as AgentMessage;
			queuedMirror.push({ text: trimmed, kind: "follow-up" });
			runtime.agent.followUp(message);
			emitQueueUpdate();
			return true;
		},
		clearQueuedFollowUps(): string[] {
			return clearQueuedMirror().map((entry) => entry.text);
		},
		queuedMessages(): QueuedMessagesSnapshot {
			return {
				steer: queuedMirror.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
				followUp: queuedMirror.filter((entry) => entry.kind === "follow-up").map((entry) => entry.text),
			};
		},
		async submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
			if (streaming) {
				const hasImages = options.images !== undefined && options.images.length > 0;
				const trimmed = text.trim();
				if (!hasImages && trimmed.length > 0 && runtime) {
					// Enter while streaming means "correct it now": the engine
					// steering queue drains after every tool batch, so the text
					// lands as a user message before the next model turn.
					// alt+enter (queueFollowUp) keeps the after-this-run intent.
					const message = {
						role: "user",
						content: trimmed,
						timestamp: Date.now(),
					} as AgentMessage;
					queuedMirror.push({ text: trimmed, kind: "steer" });
					runtime.agent.steer(message);
					emitQueueUpdate();
					emitNotice("[Clio Coder] steering the active run; lands before the next model turn. Press Esc to cancel.");
					return;
				}
				emitNotice("[Clio Coder] response already in progress. Press Esc to cancel the active run.");
				return;
			}

			let agentRuntime: AgentRuntime | null;
			try {
				await ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = ensureRuntime();
			} catch (err) {
				emitNotice(err instanceof Error ? err.message : String(err));
				return;
			}
			if (!agentRuntime) {
				emitNotice(notConfiguredNotice());
				return;
			}
			turnToolCalls = 0;
			if (options.requestContinuation !== true) stalledTurnNudgeSpent = false;
			const images = options.images && options.images.length > 0 ? [...options.images] : undefined;
			const pendingSkillRequests = options.pendingSkillRequests ?? [];
			const pendingSkillPolicy = createPendingSkillToolPolicy(pendingSkillRequests);
			// turn_start: the prompt is accepted; registrations may inject
			// context for this request. Accumulated reminders (turn_end
			// advisories from the previous turn plus anything turn_start just
			// emitted) flush into the request as one system-reminder block.
			// Like the skill preamble below, the block is plain visible text in
			// the user message: persisted in the ledger, no hidden prompt
			// machinery.
			fireTurnStart(agentRuntime, text);
			const reminderBlock = flushPendingReminders();
			// Pending skill requests are plain visible text in the user message
			// itself: persisted in the ledger, no hidden prompt machinery.
			const skillPreamble = pendingSkillRequestPreamble(pendingSkillRequests);
			const submittedText = [reminderBlock, skillPreamble, text].filter((part) => part.length > 0).join("\n\n");

			// 1. Resolve the frozen session tool surface: same set, same order,
			// same bytes on every submit so the provider prefix cache holds.
			agentRuntime.agent.state.tools = resolveSessionTools(agentRuntime, deps.toolRegistry, currentToolInvokeOptions);
			const askUserPolicy = createAskUserToolPolicy(agentRuntime.agent.state.tools);

			// 2. Pre-submit auto-compaction trigger
			const forceNow = process.env.CLIO_FORCE_COMPACT === "1";
			try {
				await runAutoCompact(agentRuntime, forceNow, undefined, undefined, submittedText);
			} catch (err) {
				emitNotice(`[Clio Coder] auto-compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
			}

			// 3. Ensure the session prompt (compiles only on explicit events)
			const compiledPrompt = await ensureSessionPrompt(agentRuntime);

			// 4. Preflight overflow check, before the user turn is committed.
			// A blocked request must not leave a dangling user entry that the
			// next replay would treat as an unanswered turn.
			const compactionThreshold = deps.getSettings().compaction?.threshold ?? null;
			const captureTurnSnapshot = (turnId: string): ContextSnapshot =>
				captureRuntimeContextSnapshot(agentRuntime, turnId, compactionThreshold, {
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
				const compacted = await runAutoCompact(agentRuntime, true, undefined, undefined, submittedText);
				if (!compacted) {
					emitNotice(
						"[Clio Coder] Compaction could not reclaim enough space. Request blocked; trim the prompt, reduce active tools, or start a fresh session.",
					);
					return;
				}
				refreshAgentMessagesFromSession(agentRuntime);
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
			// are recorded by read_skill success.
			const userTurnId = appendSubmittedUserTurn(agentRuntime, submittedText, images);
			logPromptCompileIfPending();
			turnSnapshot = { ...turnSnapshot, turnId: userTurnId ?? "unknown" };
			currentContextSnapshot = turnSnapshot;
			persistContextSnapshot(turnSnapshot);

			agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
			currentThinkingLevel = agentRuntime.agent.state.thinkingLevel;
			toolProseAbortReason = null;

			// 6. Cache-disturbance honesty (T3.3): consume disturbances since
			// the last settled run. Only single-slot local backends lose their
			// prefix cache to interleaved work, so only local-native targets
			// stamp reasons and notify; other tiers just clear the set.
			runExpectedColdReasons = [];
			stampColdReasonsPending = false;
			if (pendingColdReasons.size > 0) {
				const reasons = [...pendingColdReasons];
				pendingColdReasons.clear();
				if (deps.providers.getRuntime(agentRuntime.runtimeId)?.tier === "local-native") {
					runExpectedColdReasons = reasons;
					stampColdReasonsPending = true;
					emitStreamingNotice(`[context engine] backend prefix cache likely cold this turn: ${reasons.join(", ")}`);
				}
			}

			streaming = true;
			const priorPendingSkillPolicy = currentPendingSkillPolicy;
			const priorAskUserPolicy = currentAskUserPolicy;
			currentPendingSkillPolicy = pendingSkillPolicy;
			currentAskUserPolicy = askUserPolicy;
			try {
				await markPersistedUserEcho(submittedText, () => agentRuntime.agent.prompt(submittedText, images));
				// pi-agent-core does NOT throw on provider failures:
				// it pushes an assistant message with stopReason="error" and
				// errorMessage="<provider text>" onto state.messages, sets
				// state.errorMessage, emits agent_end, and resolves normally.
				// The overflow-recovery heuristic must inspect the state after
				// a resolve, not only the catch arm.
				const overflowPostResolve = detectOverflowFromState(agentRuntime.agent);
				if (overflowPostResolve) {
					await runCompactAndRetry(agentRuntime, submittedText, overflowPostResolve, images);
				} else {
					const failure = detectTerminalFailureFromState(agentRuntime.agent);
					if (failure) {
						if (toolProseAbortReason && failure.message) {
							(failure.message as { errorMessage?: string }).errorMessage = toolProseAbortReason;
						}
						ensureFailureVisibleAndPersisted(failure);
						await runTransientRetryChain(agentRuntime, submittedText, failure);
					}
				}
			} catch (err) {
				// Genuine throws (network, abort, pre-stream bugs) still land
				// here. The heuristic is the same so a thrown overflow from
				// an older pi-agent-core still routes through compact-retry.
				const overflow = toContextOverflowError(err);
				if (!overflow) {
					const message = toolProseAbortReason ?? (err instanceof Error ? err.message : String(err));
					if (isRetryableErrorMessage(message)) {
						const failureMessage = {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							stopReason: "error",
							errorMessage: message,
							timestamp: Date.now(),
						} as AgentMessage;
						await runTransientRetryChain(agentRuntime, submittedText, {
							stopReason: "error",
							errorMessage: message,
							message: failureMessage,
						});
						return;
					}
					emitNotice(err instanceof Error ? err.message : String(err));
					return;
				}
				await runCompactAndRetry(agentRuntime, submittedText, overflow, images);
			} finally {
				if (askUserPolicy) {
					await finalizeAskUserInterview(askUserPolicy, "turn_finished", currentToolInvokeOptions());
				}
				streaming = false;
				currentPendingSkillPolicy = priorPendingSkillPolicy;
				currentAskUserPolicy = priorAskUserPolicy;
				activeUserTurnId = null;
				// Safety net for thrown paths where agent_end never delivered;
				// no-op when the agent_end flush already ran.
				flushReconciledSnapshot();
				// Runs on every exit path (normal settle, catch-arm returns) so
				// a steer the engine never drained still reaches the model.
				if (!(await resubmitStrandedSteers())) await resubmitRequestContinuation();
			}
		},
		cancel(): void {
			const wasStreaming = streaming;
			retryCountdown?.cancel();
			// Clear both queues before the abort settles the in-flight prompt:
			// a cancelled run must not deliver queued steers or follow-ups, and
			// the stranded-steer fallback must find an empty mirror.
			clearQueuedMirror();
			runtime?.agent.abort();
			if (wasStreaming) {
				emitNotice("[Clio Coder] active response cancelled.");
			}
			if (wasStreaming && deps.bus) {
				deps.bus.emit(BusChannels.RunAborted, {
					source: "stream_cancel",
					runId: null,
					startedAt: null,
					elapsedMs: null,
					at: Date.now(),
					reason: "user cancelled stream",
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
		isStreaming(): boolean {
			return streaming;
		},
		contextUsage(): ContextUsageSnapshot {
			if (!runtime) return contextUsageSnapshot(null, 0);
			const effectiveWindow = runtime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
			if (!currentContextSnapshot) {
				return contextUsageSnapshot(null, effectiveWindow);
			}

			const pendingTokens = pendingUserInputTokens();
			const totalUsed = snapshotInputTokens(currentContextSnapshot) + pendingTokens + liveStreamingOutputTokens();
			const breakdown: ContextUsageBreakdown = {
				systemPromptTokens: currentContextSnapshot.categories.system,
				messageTokens: currentContextSnapshot.categories.messages,
				pendingUserTokens: pendingTokens,
				toolSchemaTokens: currentContextSnapshot.categories.tools,
			};
			return contextUsageSnapshot(totalUsed > 0 ? totalUsed : null, effectiveWindow, breakdown);
		},
		contextLedger(): ContextLedger {
			const settings = deps.getSettings();
			const compactionThreshold = settings.compaction?.threshold ?? null;
			const compactionAuto = settings.compaction?.auto !== false;
			if (!runtime) {
				return buildContextLedger({
					provider: settings.orchestrator?.target ?? null,
					model: settings.orchestrator?.model ?? null,
					contextWindow: 0,
					compactionThreshold,
					compactionAuto,
				});
			}
			const effectiveWindow = runtime.runtimeResolution.contextWindowDetails.effectiveContextWindow;

			const provider = runtime.targetId ?? settings.orchestrator?.target ?? null;
			const model = runtime.wireModelId ?? settings.orchestrator?.model ?? null;

			if (!currentContextSnapshot) {
				return buildContextLedger({
					provider,
					model,
					contextWindow: effectiveWindow,
					toolCount: runtime.agent.state.tools.length,
					compactionThreshold,
					compactionAuto,
					promptCache: lastPromptCache,
				});
			}

			const streamingOutput = liveStreamingOutputTokens();
			const pendingTokens = pendingUserInputTokens();
			const totalUsed = snapshotInputTokens(currentContextSnapshot) + pendingTokens + streamingOutput;
			const measured = currentContextSnapshot.sources.total === "reconciled";

			return buildContextLedger({
				provider,
				model,
				contextWindow: effectiveWindow,
				compactionThreshold,
				compactionAuto,
				systemPromptTokens: currentContextSnapshot.categories.system,
				toolSchemaTokens: currentContextSnapshot.categories.tools,
				// Persisted snapshots strip the captured schemas; fall back to
				// the live agent state after a session resume.
				toolCount: currentContextSnapshot.activeToolSchemas?.length ?? runtime.agent.state.tools.length,
				messageTokens: currentContextSnapshot.categories.messages,
				agentsTokens: currentContextSnapshot.categories.agents,
				skillsTokens: currentContextSnapshot.categories.skills,
				memoryTokens: currentContextSnapshot.categories.memory,
				projectTokens: currentContextSnapshot.categories.project,
				pendingTokens,
				streamingTokens: streamingOutput,
				liveTotalTokens: totalUsed > 0 ? totalUsed : null,
				measured,
				lastCompaction: lastCompactionEvent,
				promptCache: lastPromptCache,
			});
		},
		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			if (runtime) {
				runtime.agent.abort();
				(runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				cleanupSessionResources(runtime.agent.sessionId);
			}
			retryCountdown?.cancel();
			queuedMirror.length = 0;
			persistedUserEchoes.length = 0;
			pendingReminders.length = 0;
			emitQueueUpdate();
			lastTurnId = leafTurnId;
			lastPromptCache = null;
			lastSystemPromptReused = false;
			sessionPromptKey = null;
			pendingPromptLogEntry = null;
			const session = deps.session?.current();
			currentContextSnapshot = session ? getLatestContextSnapshot(session) : null;
			replayedContextMessages = replayMessages ? [...replayMessages] : [];
			if (runtime) {
				runtime.agent.state.messages = [...replayedContextMessages];
			}
			if (deps.protectedArtifacts) {
				try {
					const entries = deps.readSessionEntries ? deps.readSessionEntries() : [];
					deps.protectedArtifacts.replace(protectedArtifactStateFromSessionEntries(entries));
				} catch {
					deps.protectedArtifacts.replace({ artifacts: [] });
				}
			}
		},
		dispose(): void {
			unsubscribeConfigReload?.();
			for (const unsubscribe of unsubscribeColdReasonSources) unsubscribe?.();
			if (runtime) {
				runtime.agent.abort();
				(runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				cleanupSessionResources(runtime.agent.sessionId);
			}
			retryCountdown?.cancel();
			queuedMirror.length = 0;
			emitQueueUpdate();
		},
		async compact(instructions?: string): Promise<void> {
			// Session check runs BEFORE orchestrator-configuration so a fresh
			// TUI with nothing configured still reports the actionable "no
			// current session" message rather than the "not configured"
			// banner.
			// this ordering.
			if (!deps.session?.current()) {
				emitNotice("[/compact] no current session to compact; start one with /new or /resume first");
				return;
			}
			let agentRuntime: AgentRuntime | null;
			try {
				await ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = ensureRuntime();
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
				compacted = await runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				emitNotice(`[/compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!compacted) {
				emitNotice("[/compact] nothing to compact; session is empty or no cut crossed");
			}
		},
	};
	return api;
}
