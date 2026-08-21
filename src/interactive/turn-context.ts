/**
 * Turn context ownership: the session-prompt compile cache, context-snapshot
 * accounting, prompt-cache honesty, and compaction. `runAutoCompact` is the
 * one compaction entry point; the pre-submit trigger, the preflight overflow
 * guard, overflow recovery, `/context compact`, and the post-tool continuation guard
 * all flow through it.
 */

import {
	BusChannels,
	type ContextActivityStatus,
	type ContextPrunedPayload,
	type ContextRecalledPayload,
	type ContextWarningPayload,
} from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ToolName } from "../core/tool-names.js";
import { buildEvictionFields, planEviction } from "../domains/context/working-set/engine.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import { selectVisibleEntries } from "../domains/context/working-set/visible.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { LocalModelQuirks } from "../domains/providers/types/local-model-quirks.js";
import {
	AutoCompactionTrigger,
	DEFAULT_COMPACTION_THRESHOLD,
	shouldCompact,
} from "../domains/session/compaction/auto.js";
import type { CompactResult } from "../domains/session/compaction/compact.js";
import { maskStaleObservations } from "../domains/session/compaction/mask-observations.js";
import { estimateTokens } from "../domains/session/compaction/tokens.js";
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
import { appendPromptCompileRecord, type SessionPromptCompileRecord } from "../domains/session/prompt-manifest.js";
import type { AgentMessage, Usage } from "../engine/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
	type BackendCacheVerdict,
	backendCacheVerdict,
	extractUserText,
	runtimeSupportsTools,
	sumRunUsage,
	toolNamesFromAgentState,
} from "./chat-loop-messages.js";
import { buildModelReplayAgentMessagesFromTurns } from "./model-session-replay.js";
import { renderCompactionSummaryLine } from "./renderers/compaction-summary.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { AgentRuntime, ChatTurnState } from "./turn-state.js";

export interface TurnContextDeps {
	state: ChatTurnState;
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	session?: SessionContract | undefined;
	prompts?: PromptsContract | undefined;
	toolRegistry?: ToolRegistry | undefined;
	observability?: ObservabilityContract | undefined;
	bus?: SafeEventBus | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	autoCompact?: ((instructions?: string, trigger?: CompactionTrigger) => Promise<CompactResult | null>) | undefined;
	/** Test seam for the eviction planner; production uses `planEviction` from the working-set engine. */
	planEviction?: typeof planEviction;
	getMemorySection?: (() => string) | undefined;
	middleware: TurnMiddleware;
	emitNotice: (text: string) => void;
}

export interface LiveContextEstimate {
	tokens: number;
	contextWindow: number;
	breakdown: ReturnType<typeof estimateAgentContextBreakdown>;
}

export interface TurnContext {
	ensureSessionPrompt(agentRuntime: AgentRuntime): Promise<CompiledSessionPrompt | null>;
	logPromptCompileIfPending(): void;
	invalidateSessionPromptCache(): void;
	addWorkingContextPaths(paths: ReadonlyArray<string>): void;
	captureRuntimeContextSnapshot(
		agentRuntime: AgentRuntime,
		turnId: string,
		compactionThreshold: number | null,
		extra?: Partial<CaptureContextSnapshotInput>,
	): ContextSnapshot;
	setCurrentSnapshot(snapshot: ContextSnapshot): void;
	persistContextSnapshot(snapshot: ContextSnapshot): void;
	flushReconciledSnapshot(): void;
	/** Reconcile the live snapshot against one API call's provider usage. */
	reconcileUsage(usage: Usage): void;
	/**
	 * Prompt-side tokens the current snapshot accounts for. The prompt of an
	 * in-flight call is spent whatever the operator does next, so an interrupted
	 * turn records this rather than zero. 0 when no snapshot exists yet.
	 */
	promptSideTokens(): number;
	liveContextEstimate(agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate;
	refreshAgentMessagesFromSession(agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry>;
	runAutoCompact(
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
	): Promise<boolean>;
	postToolContinuationGuard(
		agentRuntime: AgentRuntime,
		signal?: AbortSignal,
	): Promise<
		| {
				context: { systemPrompt: string; messages: AgentMessage[]; tools: AgentRuntime["agent"]["state"]["tools"] };
				model: AgentRuntime["agent"]["state"]["model"];
				thinkingLevel: AgentRuntime["agent"]["state"]["thinkingLevel"];
		  }
		| undefined
	>;
	contextUsage(): ContextUsageSnapshot;
	contextLedger(): ContextLedger;
	emitContextWindowWarningTransition(warning: string | null): void;
	/** Consume disturbances since the last settled run (T3.3 honesty). */
	consumeExpectedColdReasons(runtimeId: string): void;
	/** Prompt-cache record for one persisted assistant call, with cold-reason stamp. */
	promptCachePayloadForAssistant(usage: Usage): Record<string, unknown>;
	/** Record the settled run's cache summary for /context. */
	noteRunCacheSummary(messages: ReadonlyArray<AgentMessage>, runFirstCallVerdict: BackendCacheVerdict | null): void;
	resetForSession(): void;
	dispose(): void;
}

export function createTurnContext(deps: TurnContextDeps): TurnContext {
	const { state, middleware } = deps;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();

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
	const sessionWorkingContextPaths = new Set<string>();
	let pendingPromptLogEntry: SessionPromptCompileRecord | null = null;
	// A post-tool guard can run after every tool result in one model turn. Once
	// both automatic stages report that they have nothing to do, remember that
	// stable user-turn id so the remaining results do not repeat the same plan
	// and summary probes. A new submitted user turn gets a new id naturally.
	let emptyAutoCompactTurnId: string | null = null;

	// Cache-disturbance honesty (T3.3). Dispatch traffic and history
	// compaction invalidate a single-slot local backend's prefix cache.
	// Accumulate every disturbance since the last settled run; the next
	// submit consumes the set, stamps `promptCache.expectedColdReasons` on
	// its first assistant entry, and shows one dim notice.
	const pendingColdReasons = new Set<string>();
	let runExpectedColdReasons: string[] = [];
	let nextAssistantColdReasons: string[] = [];
	// A working-set eviction changes the prefix itself, so it cools every
	// tier's cache, not only a single-slot local one. Dispatch and compaction
	// disturbances keep the local-native gate below.
	const TIER_INDEPENDENT_COLD_REASONS: ReadonlySet<string> = new Set(["working_set_evict"]);
	const stampsOnTier = (reason: string, runtimeId: string | undefined): boolean =>
		TIER_INDEPENDENT_COLD_REASONS.has(reason) ||
		(runtimeId !== undefined && deps.providers.getRuntime(runtimeId)?.tier === "local-native");
	const noteColdReason = (reason: string): void => {
		if (!state.streaming) {
			pendingColdReasons.add(reason);
			return;
		}
		if (!stampsOnTier(reason, state.runtime?.runtimeId)) return;
		if (!runExpectedColdReasons.includes(reason)) runExpectedColdReasons.push(reason);
		if (nextAssistantColdReasons.includes(reason)) return;
		nextAssistantColdReasons.push(reason);
		deps.emitNotice(`[context engine] backend prefix cache likely cold this turn: ${reason}`);
	};
	const unsubscribeColdReasonSources = [
		...[BusChannels.DispatchStarted, BusChannels.DispatchCompleted, BusChannels.DispatchFailed].map(
			(channel) =>
				deps.bus?.on(channel, () => {
					noteColdReason("dispatch");
				}) ?? null,
		),
		...[BusChannels.CompactionBegin, BusChannels.CompactionEnd].map(
			(channel) =>
				deps.bus?.on(channel, () => {
					noteColdReason("compaction");
				}) ?? null,
		),
		deps.bus?.on(BusChannels.ContextRecalled, (payload: ContextRecalledPayload) => {
			middleware.fireCompactionHook("working_set_recall", payload.trigger);
		}) ?? null,
	];

	/**
	 * True when the in-memory snapshot has been reconciled against provider
	 * usage since it was last persisted. A tool-calling turn reconciles once
	 * per API call; only the final reconciled state is written to the JSONL
	 * ledger, when the run settles. Any persist (turn submit, compaction,
	 * flush) clears the flag because it writes the current snapshot state.
	 */
	let snapshotPersistPending = false;

	/**
	 * Publish the window-resolution warning only on transitions (appeared,
	 * changed, cleared). ensureRuntime runs on every submit; re-emitting the
	 * same state each turn would spam every ContextWarning subscriber.
	 */
	let lastContextWindowWarning: string | null = null;

	const persistContextSnapshot = (snapshot: ContextSnapshot): void => {
		const currentSession = deps.session?.current();
		if (currentSession) appendContextSnapshot(currentSession, snapshot);
		snapshotPersistPending = false;
	};

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
		// The snapshot row belongs to the named Clio session whose ledger it is
		// appended to; the engine agent's own sessionId is unset in practice.
		return captureContextSnapshot({
			sessionId: deps.session?.current()?.id ?? agentRuntime.agent.sessionId ?? "unknown",
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
	 * Output tokens of the in-flight response. While streaming, estimate from
	 * the partial assistant tail; once the turn settles, the reconciled
	 * snapshot carries the provider-reported value.
	 */
	const liveStreamingOutputTokens = (): number => {
		if (!state.runtime) return 0;
		if (state.streaming) {
			const messages = state.runtime.agent.state.messages;
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

	const liveContextEstimate = (agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate => {
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
		agentRuntime.agent.state.messages = buildModelReplayAgentMessagesFromTurns(refreshedEntries, {
			...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
		});
		state.replayedContextMessages = [];
		return refreshedEntries;
	};

	// Compaction rides the context island as a single-phase "compaction"
	// activity (rendered as "Context Compact"). Each stage brackets its work
	// with a started/completed pair; a throwing summary emits failed. The
	// island already knows this kind and phase, and `deps.bus` is optional.
	const emitCompactionActivity = (status: ContextActivityStatus, message: string): void => {
		deps.bus?.emit(BusChannels.ContextActivity, {
			kind: "compaction",
			phase: "done",
			status,
			message,
			at: Date.now(),
		});
	};
	const compactionFailureMessage = (error: unknown): string =>
		`compaction failed: ${error instanceof Error ? error.message : String(error)}`;

	const recordCompactionUsage = (agentRuntime: AgentRuntime, result: CompactResult): void => {
		const usage = result.usage;
		if (!usage || !deps.observability) return;
		if (usage.totalTokens <= 0 && usage.cost.total <= 0) return;
		deps.observability.recordTokens(
			agentRuntime.targetId,
			agentRuntime.wireModelId,
			usage.totalTokens,
			usage.cost.total,
			{
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				reasoningTokens: usage.reasoning,
				totalTokens: usage.totalTokens,
				apiCalls: Math.max(1, Math.round(usage.apiCalls)),
			},
			agentRuntime.runtimeResolution.costProvenance,
		);
	};

	/**
	 * Two-mechanism context protection. When pressure crosses the single
	 * threshold, first apply a non-destructive working-set eviction. If pressure
	 * stays above the threshold, delegate to the pi-style LLM compaction path:
	 * append a compaction summary entry, then replay from the session view. The
	 * destructive observation mask remains only as a one-release escape hatch.
	 *
	 * `force = true` skips the pressure check and every pre-stage and runs
	 * the LLM summary directly. Used for `/context compact`, CLIO_CODER_FORCE_COMPACT=1,
	 * and overflow recovery.
	 */
	const runAutoCompact = async (
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
	): Promise<boolean> => {
		if (!deps.readSessionEntries) return false;
		const activeAutoTurnId = force ? null : state.activeUserTurnId;
		if (activeAutoTurnId && emptyAutoCompactTurnId === activeAutoTurnId) return false;
		const settings = deps.getSettings();
		const cfg = settings.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;
		let preSummaryStageActed = false;
		const rememberEmptyAutomaticAttempt = (): void => {
			if (!force && !preSummaryStageActed && activeAutoTurnId) emptyAutoCompactTurnId = activeAutoTurnId;
		};

		const compactionThreshold = cfg?.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
		const trigger: CompactionTrigger = triggerOverride ?? (force ? "force" : "auto");

		if (!force) {
			const estimate = liveContextEstimate(agentRuntime, pendingUserText);
			const verdict = shouldCompact(estimate.tokens, compactionThreshold, estimate.contextWindow);
			if (!verdict.shouldCompact) return false;

			// One-release compatibility escape hatch. This is the destructive
			// pre-stage that working-set eviction replaces; keep it byte-for-byte
			// reachable only when explicitly requested.
			if (deps.session?.current()) {
				const beforeSnapshotId = currentContextSnapshot?.snapshotId ?? null;
				if (process.env.CLIO_CODER_LEGACY_MASK === "1") {
					let masked: ReturnType<typeof maskStaleObservations>;
					try {
						masked = maskStaleObservations(deps.readSessionEntries() ?? [], cfg?.excludeLastTurns ?? 6);
					} catch (error) {
						middleware.fireCompactionHook("mask_observations", trigger, estimate.tokens);
						deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
						emitCompactionActivity("started", "compacting context (mask stage)");
						emitCompactionActivity("failed", compactionFailureMessage(error));
						deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });
						throw error;
					}
					if (masked.changed) {
						preSummaryStageActed = true;
						middleware.fireCompactionHook("mask_observations", trigger, estimate.tokens);
						deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
						emitCompactionActivity("started", "compacting context (mask stage)");
						deps.session.replaceEntries(masked.entries);
						refreshAgentMessagesFromSession(agentRuntime);
						deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });

						const postMaskSnapshot = captureRuntimeContextSnapshot(
							agentRuntime,
							state.activeUserTurnId || "compaction",
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
						emitCompactionActivity("completed", `${masked.maskedObservations} observations masked`);
						const thinkingNote =
							masked.maskedThinkingBlocks > 0
								? `, ${masked.maskedThinkingBlocks} thinking blocks dropped (~${masked.maskedThinkingChars} chars)`
								: "";
						deps.emitNotice(
							`[context engine] mask_observations: ${masked.maskedObservations} observations masked${thinkingNote}; ~${estimate.tokens} tokens -> ~${tokensAfterMask} tokens`,
						);

						const after = liveContextEstimate(agentRuntime, pendingUserText);
						if (!shouldCompact(after.tokens, compactionThreshold, after.contextWindow).shouldCompact) return true;
					}
				} else if (settings.context.workingSet.enabled) {
					let planned: ReturnType<typeof planEviction>;
					try {
						const entries = deps.readSessionEntries() ?? [];
						const view = foldWorkingSet(entries, state.lastTurnId ?? undefined);
						const policy = resolveWorkingSetPolicy(settings.context.workingSet.policy);
						planned = (deps.planEviction ?? planEviction)(policy, {
							entries: selectVisibleEntries(entries, state.lastTurnId ?? undefined),
							view,
							cwd: deps.session.current()?.cwd ?? null,
							settings: settings.context.workingSet,
							pressure: {
								tokens: estimate.tokens,
								contextWindow: estimate.contextWindow,
								threshold: compactionThreshold,
								target: settings.context.workingSet.target,
							},
							estimateTokens,
						});
					} catch (error) {
						middleware.fireCompactionHook("working_set_evict", "pressure", estimate.tokens);
						emitCompactionActivity("started", "compacting context (working-set eviction)");
						emitCompactionActivity("failed", compactionFailureMessage(error));
						throw error;
					}
					if (planned) {
						preSummaryStageActed = true;
						middleware.fireCompactionHook("working_set_evict", "pressure", estimate.tokens);
						emitCompactionActivity("started", "compacting context (working-set eviction)");
						try {
							deps.session.appendEntry({
								...buildEvictionFields(planned, {
									trigger: "pressure",
									pressureBefore: verdict.pressure,
									snapshotIdBefore: beforeSnapshotId,
								}),
								// appendEntry does not infer this anchor; the interactive
								// cursor is the leaf the next message will extend.
								parentTurnId: state.lastTurnId,
							});
							noteColdReason("working_set_evict");
							refreshAgentMessagesFromSession(agentRuntime);

							const postEvictionSnapshot = captureRuntimeContextSnapshot(
								agentRuntime,
								state.activeUserTurnId || "compaction",
								compactionThreshold,
							);
							currentContextSnapshot = postEvictionSnapshot;
							persistContextSnapshot(postEvictionSnapshot);

							// Every surface that describes this event (the notice, the toast
							// ContextPruned feeds, the overlay's last-compaction line, the
							// ledger entry) quotes the plan: the same chars/4 pricing over the
							// same visible slice. The live estimate prices the agent message
							// list and differs by the tool schemas and replay text; it stays
							// what the meter and the re-check below read, not what the event
							// reports about itself.
							lastCompactionEvent = {
								stage: "working_set",
								tokensBefore: planned.tokensBefore,
								tokensAfter: planned.tokensAfter,
								trigger,
							};
							deps.bus?.emit(BusChannels.ContextPruned, {
								stage: "working_set",
								pressure: verdict.pressure,
								tokensBefore: planned.tokensBefore,
								tokensAfter: planned.tokensAfter,
								trigger,
								snapshotIdBefore: beforeSnapshotId,
								snapshotIdAfter: postEvictionSnapshot.snapshotId,
								policyId: planned.policyId,
								evictedItems: planned.items.length,
								at: Date.now(),
							} satisfies ContextPrunedPayload);
							const itemsWord = planned.items.length === 1 ? "item" : "items";
							emitCompactionActivity("completed", `${planned.items.length} working-set ${itemsWord} evicted`);
							deps.emitNotice(
								`[context engine] working set: ${planned.items.length} ${itemsWord} evicted by ${planned.policyId}; ~${planned.tokensBefore} -> ~${planned.tokensAfter} tokens, recall by ref with context(scope="recall")`,
							);

							const after = liveContextEstimate(agentRuntime, pendingUserText);
							if (!shouldCompact(after.tokens, compactionThreshold, after.contextWindow).shouldCompact) return true;
						} catch (error) {
							emitCompactionActivity("failed", compactionFailureMessage(error));
							throw error;
						}
					}
				}
			}
		}

		if (!deps.autoCompact) {
			rememberEmptyAutomaticAttempt();
			return false;
		}
		let summaryLifecycleStarted = false;
		const startSummaryLifecycle = (): void => {
			middleware.fireCompactionHook("llm_summary", trigger);
			deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
			emitCompactionActivity("started", "compacting context (summary)");
			summaryLifecycleStarted = true;
		};
		if (force) startSummaryLifecycle();
		let result: CompactResult | null = null;
		const beforeSnapshotId = currentContextSnapshot?.snapshotId ?? null;
		try {
			result = await compactionTrigger.fire(() => (deps.autoCompact ?? (async () => null))(instructions, trigger));
		} catch (error) {
			if (!summaryLifecycleStarted) startSummaryLifecycle();
			emitCompactionActivity("failed", compactionFailureMessage(error));
			deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });
			throw error;
		}
		if (!result || result.summary.length === 0) {
			if (summaryLifecycleStarted) {
				deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });
				emitCompactionActivity("completed", "nothing to compact");
			} else {
				rememberEmptyAutomaticAttempt();
			}
			return false;
		}
		if (!summaryLifecycleStarted) startSummaryLifecycle();
		deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });

		// The summarization call spends tokens on the same target the turn would
		// have. The ledger entry carries its usage for a later reseed; this is the
		// live sink, so `/cost` and the footer move the moment /context compact
		// returns instead of staying byte-identical to before it ran.
		recordCompactionUsage(agentRuntime, result);

		refreshAgentMessagesFromSession(agentRuntime);

		const postCompactSnapshot = captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
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
		emitCompactionActivity("completed", `compacted ~${result.tokensBefore} -> ~${tokensAfter} tokens`);

		deps.emitNotice(
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

	return {
		captureRuntimeContextSnapshot,
		persistContextSnapshot,
		liveContextEstimate,
		refreshAgentMessagesFromSession,
		runAutoCompact,

		setCurrentSnapshot(snapshot: ContextSnapshot): void {
			currentContextSnapshot = snapshot;
		},

		flushReconciledSnapshot(): void {
			if (!snapshotPersistPending || !currentContextSnapshot) return;
			persistContextSnapshot(currentContextSnapshot);
		},

		reconcileUsage(usage: Usage): void {
			if (!currentContextSnapshot) return;
			// Reconcile in memory on every API call so the live meters
			// track usage; persistence waits for the run to settle.
			currentContextSnapshot = reconcileSnapshot(currentContextSnapshot, usage);
			snapshotPersistPending = true;
		},

		promptSideTokens(): number {
			return currentContextSnapshot ? snapshotInputTokens(currentContextSnapshot) : 0;
		},

		/**
		 * Ensure the session system prompt is compiled and applied to the live
		 * agent. Compiles only when the compile key (target, model, safety
		 * level, session id) changes or a config hot-reload invalidated the
		 * cache; every other submit reuses the cached prompt byte-for-byte. A
		 * compile whose text differs from the previous prompt queues a
		 * "promptRecompiled" ledger entry (written once the session exists).
		 */
		async ensureSessionPrompt(agentRuntime: AgentRuntime): Promise<CompiledSessionPrompt | null> {
			if (!deps.prompts) return null;
			const settings = deps.getSettings();
			const autonomy = settings.autonomy ?? "auto-edit";
			const sessionId = deps.session?.current()?.id ?? "";
			const workingContextKey = [...sessionWorkingContextPaths].sort().join("\0");
			const key = `${agentRuntime.targetId}|${agentRuntime.wireModelId}|${autonomy}|${sessionId}|${workingContextKey}`;
			if (sessionPrompt && sessionPromptKey === key) {
				lastSystemPromptReused = true;
				return sessionPrompt;
			}
			const modelState = agentRuntime.agent.state.model as
				| (typeof agentRuntime.agent.state.model & { clio?: { quirks?: LocalModelQuirks } })
				| undefined;
			const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : null;
			const guidance = modelState?.clio?.quirks?.thinking?.guidance;
			// Per-tool prompt hints come from registry metadata, derived once from
			// the frozen surface per compile. The compiler renders them sorted by
			// tool name, so the compiled text stays byte-stable for a given surface.
			const toolNames = toolNamesFromAgentState(agentRuntime.agent.state.tools);
			const toolPromptHints = toolNames.flatMap((name) => {
				const hint = deps.toolRegistry?.get(name as ToolName)?.metadata?.promptHint;
				return hint ? [{ tool: name, hint }] : [];
			});
			const sessionInputs: SessionPromptInputs = {
				provider: agentRuntime.targetId,
				model: agentRuntime.wireModelId,
				contextWindow,
				providerSupportsTools: runtimeSupportsTools(agentRuntime),
				toolNames,
				...(guidance ? { thinkingGuidance: guidance } : {}),
				...(toolPromptHints.length > 0 ? { toolPromptHints } : {}),
			};
			if (deps.getMemorySection) {
				try {
					const memorySection = deps.getMemorySection();
					if (memorySection.length > 0) sessionInputs.memorySection = memorySection;
				} catch (err) {
					deps.emitNotice(
						`[Clio Coder] memory load failed; continuing without memory injection: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			try {
				const result = await deps.prompts.compileSessionPrompt({
					sessionInputs,
					autonomy,
					cwd: process.cwd(),
					workingContextPaths: [...sessionWorkingContextPaths],
				});
				const previousHash = sessionPrompt?.systemPromptHash ?? null;
				const changed = agentRuntime.agent.state.systemPrompt !== result.systemPrompt;
				if (changed) {
					agentRuntime.agent.state.systemPrompt = result.systemPrompt;
					pendingPromptLogEntry = {
						at: new Date().toISOString(),
						previousHash,
						systemPromptHash: result.systemPromptHash,
						tokenEstimate: result.tokenEstimate,
						thinkingLevel: agentRuntime.agent.state.thinkingLevel ?? null,
						projectPreload: result.projectPreload ?? null,
						sections: result.sections.map((s) => ({ id: s.id, tokenEstimate: s.tokenEstimate })),
						fragments: result.fragmentManifest.map((f) => ({
							id: f.id,
							relPath: f.relPath,
							contentHash: f.contentHash,
							dynamic: f.dynamic,
						})),
					};
				}
				lastSystemPromptReused = !changed;
				sessionPrompt = result;
				sessionPromptKey = key;
				return result;
			} catch (err) {
				deps.emitNotice(
					`[Clio Coder] prompt compile failed; using fallback identity: ${err instanceof Error ? err.message : String(err)}`,
				);
				return null;
			}
		},

		/**
		 * Write the queued prompt-compile ledger entry and its full manifest
		 * record. Deferred until after the user turn is appended so the session
		 * is guaranteed to exist. The current.jsonl entry stays hash-only; the
		 * section/fragment breakdown goes to the prompt-manifest.jsonl sibling.
		 */
		logPromptCompileIfPending(): void {
			const currentMeta = deps.session?.current();
			if (!pendingPromptLogEntry || !currentMeta) return;
			const entry = pendingPromptLogEntry;
			pendingPromptLogEntry = null;
			try {
				deps.session?.appendEntry({
					kind: "custom",
					customType: "promptRecompiled",
					parentTurnId: state.lastTurnId,
					data: {
						previousHash: entry.previousHash,
						hash: entry.systemPromptHash,
						tokenEstimate: entry.tokenEstimate,
					},
				});
			} catch {
				// Ledger logging is diagnostics, not control flow; never abort a turn.
			}
			appendPromptCompileRecord(currentMeta, entry);
		},

		invalidateSessionPromptCache(): void {
			sessionPromptKey = null;
		},

		addWorkingContextPaths(paths: ReadonlyArray<string>): void {
			for (const path of paths) sessionWorkingContextPaths.add(path);
		},

		async postToolContinuationGuard(agentRuntime: AgentRuntime, signal?: AbortSignal) {
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
					`[Clio Coder] post-tool context guard stopped continuation before provider call: estimated ${after.tokens} tokens exceeds reported context window ${after.contextWindow}. Use /context compact, narrower reads, or a follow-up turn with smaller observations.`,
				);
			}
			return compacted ? continuationContextUpdate(agentRuntime) : undefined;
		},

		contextUsage(): ContextUsageSnapshot {
			if (!state.runtime) return contextUsageSnapshot(null, 0);
			const effectiveWindow = state.runtime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
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
			if (!state.runtime) {
				return buildContextLedger({
					provider: settings.orchestrator?.target ?? null,
					model: settings.orchestrator?.model ?? null,
					contextWindow: 0,
					compactionThreshold,
					compactionAuto,
				});
			}
			const windowDetails = state.runtime.runtimeResolution.contextWindowDetails;
			const effectiveWindow = windowDetails.effectiveContextWindow;

			const provider = state.runtime.targetId ?? settings.orchestrator?.target ?? null;
			const model = state.runtime.wireModelId ?? settings.orchestrator?.model ?? null;

			if (!currentContextSnapshot) {
				return buildContextLedger({
					provider,
					model,
					contextWindow: effectiveWindow,
					contextWindowSource: windowDetails.contextWindowSource,
					toolCount: state.runtime.agent.state.tools.length,
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
				contextWindowSource: windowDetails.contextWindowSource,
				compactionThreshold,
				compactionAuto,
				systemPromptTokens: currentContextSnapshot.categories.system,
				toolSchemaTokens: currentContextSnapshot.categories.tools,
				// Persisted snapshots strip the captured schemas; fall back to
				// the live agent state after a session resume.
				toolCount: currentContextSnapshot.activeToolSchemas?.length ?? state.runtime.agent.state.tools.length,
				messageTokens: currentContextSnapshot.categories.messages,
				agentsTokens: currentContextSnapshot.categories.agents,
				skillsTokens: currentContextSnapshot.categories.skills,
				memoryTokens: currentContextSnapshot.categories.memory,
				projectTokens: currentContextSnapshot.categories.project,
				projectPreload: sessionPrompt?.projectPreload?.label ?? null,
				projectHandbookFiles: sessionPrompt?.projectHandbookFiles ?? null,
				pendingTokens,
				streamingTokens: streamingOutput,
				liveTotalTokens: totalUsed > 0 ? totalUsed : null,
				measured,
				lastCompaction: lastCompactionEvent,
				promptCache: lastPromptCache,
			});
		},

		emitContextWindowWarningTransition(warning: string | null): void {
			if (warning === lastContextWindowWarning) return;
			lastContextWindowWarning = warning;
			deps.bus?.emit(BusChannels.ContextWarning, { warning } satisfies ContextWarningPayload);
		},

		consumeExpectedColdReasons(runtimeId: string): void {
			// Cache-disturbance honesty (T3.3): consume disturbances since
			// the last settled run. Only single-slot local backends lose their
			// prefix cache to interleaved work, so dispatch and compaction
			// stamp only on local-native targets; a working-set eviction moved
			// the prefix itself and stamps on every tier (see stampsOnTier).
			runExpectedColdReasons = [];
			nextAssistantColdReasons = [];
			if (pendingColdReasons.size > 0) {
				const reasons = [...pendingColdReasons].filter((reason) => stampsOnTier(reason, runtimeId));
				pendingColdReasons.clear();
				if (reasons.length > 0) {
					runExpectedColdReasons = reasons;
					nextAssistantColdReasons = reasons;
					deps.emitNotice(`[context engine] backend prefix cache likely cold this turn: ${reasons.join(", ")}`);
				}
			}
		},

		promptCachePayloadForAssistant(usage: Usage): Record<string, unknown> {
			// Per-call prompt-cache record (T3.2): provider-reported numbers only,
			// classified by backendCacheVerdict in chat-loop-messages.ts. The
			// run's first persisted call also carries any expected-cold reasons.
			const input = typeof usage.input === "number" ? usage.input : 0;
			const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
			const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
			const promptCache: Record<string, unknown> = {
				input,
				cacheRead,
				cacheWrite,
				backendVerdict: backendCacheVerdict(input, cacheRead),
			};
			if (nextAssistantColdReasons.length > 0) {
				promptCache.expectedColdReasons = [...nextAssistantColdReasons];
				nextAssistantColdReasons = [];
			}
			return promptCache;
		},

		noteRunCacheSummary(messages, runFirstCallVerdict): void {
			const cacheSummary = sumRunUsage(messages);
			if (cacheSummary.hadUsage) {
				lastPromptCache = {
					shellReused: lastSystemPromptReused,
					cacheReadTokens: cacheSummary.cacheRead > 0 || cacheSummary.cacheWrite > 0 ? cacheSummary.cacheRead : null,
					cacheWriteTokens: cacheSummary.cacheRead > 0 || cacheSummary.cacheWrite > 0 ? cacheSummary.cacheWrite : null,
					uncachedInputTokens: cacheSummary.input,
					backendVerdict: runFirstCallVerdict,
					...(runExpectedColdReasons.length > 0 ? { expectedColdReasons: [...runExpectedColdReasons] } : {}),
				};
			}
		},

		resetForSession(): void {
			lastPromptCache = null;
			lastSystemPromptReused = false;
			sessionPromptKey = null;
			sessionWorkingContextPaths.clear();
			pendingPromptLogEntry = null;
			emptyAutoCompactTurnId = null;
			const session = deps.session?.current();
			currentContextSnapshot = session ? getLatestContextSnapshot(session) : null;
		},

		dispose(): void {
			for (const unsubscribe of unsubscribeColdReasonSources) unsubscribe?.();
		},
	};
}
