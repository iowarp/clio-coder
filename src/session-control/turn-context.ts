import { assistantOutputChars } from "../core/assistant-output.js";
import { semanticUsable } from "../core/config.js";
import type { ContextOperationFact } from "../core/context-operation.js";
import { CONTEXT_OPERATION_CUSTOM_TYPE, createContextOperation } from "../core/context-operation.js";
import { isHostPolicyMessage } from "../core/host-policy-message.js";
import { providerCheckpointFromMessage, providerFallbackDigests } from "../core/provider-checkpoint-handle.js";
import { mainAgent, sessionTelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { factKnownValue } from "../core/telemetry/known.js";
import type { CallMessageObserver } from "../core/telemetry/producer.js";
import type { SuccessfulMemoryContextCommit } from "../domains/memory/commit-state.js";
import type { MemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import { compactionBudget, getCatalogModelForRuntime } from "../domains/providers/catalog.js";
import { getLatestContextSnapshot } from "../domains/session/context-history.js";
import {
	appendEnginePolicyMessage,
	compactEngineCodex,
	engineCodexConfiguration,
	engineCodexUserTurn,
	engineInitialSystemPrompt,
	replaceEngineMessages,
	setEngineCodexConfiguration,
	setEngineCodexUserTurn,
	setEngineProviderCheckpointObserver,
	setEngineProviderCompactionPolicy,
	setEngineProviderReplayFallback,
	setEngineSystemPrompt,
} from "../engine/agent.js";
import { providerCheckpointCompatibility } from "../engine/ai.js";
import { contextOperationAwareness } from "./context-operation-awareness.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
import type { MessageListDigests } from "./message-list-digest.js";
import { createMessageListDigests } from "./message-list-digest.js";
import {
	effectivePosture,
	POSTURE_GENERATION,
	POSTURE_UPDATE,
	type PostureGeneration,
	postureCheckpoint,
	readPostureGeneration,
} from "./posture-policy.js";
/**
 * Turn context ownership: the session-prompt compile cache, context-snapshot
 * accounting, prompt-cache honesty, and compaction. `runAutoCompact` is the
 * one compaction entry point; the pre-submit trigger, the preflight overflow
 * guard, overflow recovery, `/context compact`, and the post-tool continuation guard
 * all flow through it.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
	BackendCacheVerdict,
	BackendCompletionTimings,
	CacheCallBaseline,
	CacheCallTransport,
	CacheRequestFingerprint,
} from "../core/cache-telemetry.js";
import { buildCacheCallObservation, firstChangedSection, uncachedPrefillTokens } from "../core/cache-telemetry.js";
import type { ClioSettings } from "../core/config.js";
import type { PrecomputedRanking } from "../core/precomputed-rank.js";
import { hostFramedTexts } from "../core/reminder-framing.js";
import { residencyTargetKey } from "../core/residency-target-key.js";
import type { RouteName, RouteSource } from "../core/route-provenance.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type {
	CompactionPayload,
	ContextActivityPhase,
	ContextActivityStatus,
	ContextPrunedPayload,
	ContextRecalledPayload,
	ContextWarningPayload,
	MemoryStepCompletedPayload,
	ResidencyMutationPayload,
} from "../core/telemetry/live-events.js";
import type { CallSettled } from "../core/telemetry/schemas.js";
import { isBuiltinToolName, ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { BudgetInspection } from "../domains/context/budget/inspection.js";
import {
	createLiveBudgetProducer,
	type LiveBudgetBreakdown,
	type LiveBudgetHandoffProjection,
	type LiveBudgetInput,
	type LiveBudgetOutcomeProjection,
	type LiveBudgetView,
	resolveLiveBudgetPolicy,
} from "../domains/context/budget/live-view.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import { withinRearmBand } from "../domains/context/working-set/checkpoint.js";
import { buildEvictionFields, planEviction } from "../domains/context/working-set/engine.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { isTurnStart, protectionCutoffIndex } from "../domains/context/working-set/horizon.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import { selectVisibleEntries } from "../domains/context/working-set/visible.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import { memorySectionBlocks, memorySectionDelta } from "../domains/memory/prompt-section.js";
import type { MemoryStatus } from "../domains/memory/types.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import {
	type ContextWindowDetails,
	type ContextWindowSource,
	canonicalEndpointKey,
	isOrchestratorEligibleRuntime,
	modelEndpointKey,
	type ProvidersContract,
	resolveRuntimeTarget,
} from "../domains/providers/index.js";
import type { LocalModelQuirks } from "../domains/providers/types/local-model-quirks.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import {
	AutoCompactionTrigger,
	DEFAULT_COMPACTION_THRESHOLD,
	shouldCompact,
} from "../domains/session/compaction/auto.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import { DEFAULT_KEEP_RECENT_TOKENS } from "../domains/session/compaction/defaults.js";
import { maskStaleObservations } from "../domains/session/compaction/mask-observations.js";
import { createTokenEstimator } from "../domains/session/compaction/tokens.js";
import {
	type CaptureContextSnapshotInput,
	type ContextSnapshot,
	type ContextUsageSnapshot,
	captureContextSnapshot,
	ceilChars,
	contextUsageSnapshot,
	estimateAgentContextBreakdown,
	estimateAgentContextTokens,
	estimateAgentMessageTokens,
	reconcileSnapshot,
	snapshotInputTokens,
} from "../domains/session/context-accounting.js";
import {
	buildContextLedger,
	type ContextLedger,
	type PrewarmStats,
	type PromptCacheStats,
} from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import {
	type CompactionTrigger,
	mainSkillContextState,
	type SessionEntry,
	withProviderCheckpointMeasurements,
} from "../domains/session/entries.js";
import {
	PROMPT_MANIFEST_VERSION,
	readPromptCompileRecords,
	type SessionPromptCompileRecord,
} from "../domains/session/prompt-manifest.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import { cacheLifetimeSeconds } from "../engine/cache-keepalive.js";
import type {
	AgentMessage,
	AnthropicResponseObservation,
	CodexConfiguration,
	CodexTransportObservation,
	Usage,
} from "../engine/types.js";
import { capabilityArgumentShape, capabilityStarterArgs } from "../tools/gateway/guidance.js";
import { TOOL_PLANES } from "../tools/policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
	backendCacheVerdict,
	extractUserText,
	recordValue,
	runtimeSupportsTools,
	sumRunUsage,
	toolNamesFromAgentState,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import { coldReasonText } from "./cold-reasons.js";
import { renderCompactionSummaryLine, renderEvictionSkipLine } from "./compaction-lines.js";
import { buildModelReplayAgentMessagesFromTurns, continuityContextFromSession } from "./model-session-replay.js";
import { resolveTurnOutputReserve } from "./output-reserve.js";
import { attachedToolSchemasFromState, mainPromptCacheIdentity } from "./prompt-cache-identity.js";
import { createReplayMessageConverter, extractTurnText } from "./session-replay-messages.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { AgentRuntime, ChatTurnState } from "./turn-state.js";

const AUTO_COMPACT_FAILURE_LIMIT = 3;

export interface TurnContextDeps {
	getAutonomy?: () => AutonomyLevel;
	turnSignal?: () => AbortSignal | undefined;
	/**
	 * The session's standing tool limits (operator flags, an ACP ceiling). The
	 * session prompt compiles from these alone; a turn's own scope rides in its
	 * reminder, so a scope change never recompiles the prompt (#422).
	 */
	standingTurnConstraints?: () => TurnConstraints | undefined;
	memoryCommitBridge?: MemoryInterventionRegistration | undefined;
	interactiveGuidance?: boolean;
	/** An ACP client that advertised interviews: ask_user guidance without the TUI-only demo tips. */
	operatorInterviews?: boolean;
	/** True for a headless `clio-coder run`, whose approval asks are always denied. */
	headless?: boolean;
	/** False when no operator message can arrive mid-run; the prompt then omits steering guidance. */
	liveSteering?: boolean;
	state: ChatTurnState;
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	session?: SessionContract | undefined;
	prompts?: PromptsContract | undefined;
	toolRegistry?: ToolRegistry | undefined;
	telemetry?: TelemetryContract | undefined;
	bus?: TelemetryHub | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	autoCompact?:
		| ((
				instructions?: string,
				trigger?: CompactionTrigger,
				budget?: Pick<
					CompactInput,
					| "providerCompaction"
					| "providerFallbackReason"
					| "keepRecentTokens"
					| "preserveUserTurnId"
					| "pendingOperatorTurn"
					| "skillContextState"
					| "signal"
					| "beforeSummaryCall"
					| "checkpointForSummary"
					| "checkpointTokenFigures"
					| "skipSummaryDigest"
				>,
		  ) => Promise<CompactResult | null>)
		| undefined;
	/** Test seam for the eviction planner; production uses `planEviction` from the working-set engine. */
	planEviction?: typeof planEviction;
	getMemorySection?: ((request: MemoryPromptRequest) => string) | undefined;
	getMemoryRecordStatuses?: ((ids: readonly string[]) => ReadonlyMap<string, MemoryStatus | "deleted">) | undefined;
	/**
	 * Memory scores for the section this request builds, or undefined when the
	 * `relevance` site is unbound, ranking could not change the section, or the
	 * ranking failed. Awaited while the prompt is composed, so it is asked only
	 * when the order decides what the prompt carries.
	 */
	getMemoryRelevance?:
		| ((request: MemoryPromptRequest) => Promise<PrecomputedRanking | undefined> | PrecomputedRanking | undefined)
		| undefined;
	getReadySkillCount?: (() => number) | undefined;
	/** Live source of each active route for the attended prompt; absent for headless runs. */
	getRouteSources?: (() => Readonly<Record<RouteName, RouteSource>>) | undefined;
	/**
	 * Optional continuity projections carried into the live budget view. They
	 * are injected interfaces: this module never reads, writes, or validates the
	 * durable records behind them, and a throwing reader degrades to null rather
	 * than failing a budget publication.
	 */
	getPendingHandoff?: (() => LiveBudgetHandoffProjection | null) | undefined;
	getLastOutcome?: (() => LiveBudgetOutcomeProjection | null) | undefined;
	middleware: TurnMiddleware;
	emitNotice: (text: string) => void;
	/**
	 * Report that the next response's prompt cache may be cold, and why. It is
	 * telemetry about the run rather than the conversation: the footer's notice
	 * slot shows it, and the Detailed receipt names the reasons beside the reuse
	 * the provider reported. A host without it gets the old transcript notice.
	 */
	emitCacheNotice?: (reasons: ReadonlyArray<string>) => void;
	emitCacheReuseNotice?: (text: string) => void;
}

export interface LiveContextEstimate {
	/**
	 * The figure to budget against: the reconciled total when the provider has
	 * attested one for this conversation, otherwise the estimate. Never below
	 * the estimate, because the estimate covers material the last provider call
	 * did not see.
	 */
	tokens: number;
	/** Structural projection; includes the legacy usage floor when no live anchor is trusted. */
	estimatedTokens: number;
	/**
	 * Provider-attested prompt tokens for the messages up to the last reconciled
	 * call, plus a chars/4 estimate of everything appended since. Null before the
	 * first reconcile of a session and after a summary compaction rewrites the
	 * history the attestation described.
	 */
	reconciledTokens: number | null;
	contextWindow: number;
	breakdown: ReturnType<typeof estimateAgentContextBreakdown>;
}

/**
 * Known causes that make the next provider prefix cache miss expected: the journal's closed vocabulary, so the host
 * records no reason a call record cannot carry. `background_memory` is a proactive-memory step on the endpoint this
 * session streams against, whose trajectory prompt displaces a local server's single prefix cache (#229).
 */
export type ExpectedColdReason = CallSettled["cache"]["expectedColdReasons"][number];

export type LiveContextUsage = ContextUsageSnapshot &
	Pick<LiveBudgetView, "revision" | "inputSource" | "historical" | "breakdownSource">;

export interface TurnContext {
	notifyMemoryCommit(
		commitId: string,
		kind: SuccessfulMemoryContextCommit["kind"],
		outcome: SuccessfulMemoryContextCommit["outcome"],
	): void;
	installMemoryRestoration(runtime: AgentRuntime, pendingUserText?: string): boolean;
	/** Prepare an attempt before preflight; rejected attempts never freeze the next submit. */
	prepareMemoryTurn(
		runtime: AgentRuntime,
		input: { taskText: string; continuation: boolean; images?: ReadonlyArray<unknown> | undefined },
	): void;
	/** Bind first-session creation after append without rereading the prepared snapshot. */
	commitMemoryTurn(runtime: AgentRuntime): void;
	ensureSessionPrompt(
		agentRuntime: AgentRuntime,
		beforeSend?: boolean,
		pendingUserText?: string,
		skipProviderFallback?: boolean,
	): Promise<CompiledSessionPrompt | null>;
	thinkingUsesConfigurationUpdate(): boolean;
	commitSessionPosture(agentRuntime: AgentRuntime, userTurnId: string): void;
	/**
	 * Host-framed text the last `ensureSessionPrompt` left for the turn's
	 * reminder: what changed in frozen prompt inputs since the compile (#423).
	 */
	sessionPromptDelta(): string;
	promptCompileRecord?(): SessionPromptCompileRecord | null;
	compiledSessionPrompt?(): CompiledSessionPrompt | null;
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
	/** `call` names the journal call the usage came from, so the persisted snapshot can cite it (#434). */
	reconcileUsage(usage: Usage, call?: { callId: string; attemptId: string }): void;
	/**
	 * Prompt-side tokens the current snapshot accounts for. The prompt of an
	 * in-flight call is spent whatever the operator does next, so an interrupted
	 * turn records this rather than zero. 0 when no snapshot exists yet.
	 */
	promptSideTokens(): number;
	liveContextEstimate(agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate;
	/**
	 * Recompute and publish the live budget view.
	 *
	 * Called at the seams that change the next request (capture, reconcile,
	 * reduction, the mid-run tool-batch boundary, run settlement) and by any
	 * consumer about to make a decision from it. The only thing it mutates is
	 * the accounting cache: no
	 * persistence, no model call, and no reduction happens because something
	 * asked what the budget is.
	 */
	refreshLiveBudget(pendingUserText?: string): LiveBudgetView;
	/**
	 * The published live budget view. A pure getter for renderers and tools:
	 * it never rescans the conversation or reprices the footer. The first call
	 * of a session publishes once, because a view has to exist before it can be
	 * read.
	 */
	liveBudget(): LiveBudgetView;
	/** Inspect only when the native engine owns the request; never initialize it. */
	inspectLiveBudget(): BudgetInspection;
	refreshAgentMessagesFromSession(agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry>;
	runAutoCompact(
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
		pendingSkillPolicy?: PendingSkillToolPolicy,
		signal?: AbortSignal,
		handoff?: ContinuityReductionHooks,
		pendingUserIsOperator?: boolean,
		providerFallbackReason?: string,
	): Promise<boolean>;
	lastCompactionWasNoGain(): boolean;
	cancelCompaction(): void;
	postToolContinuationGuard(
		agentRuntime: AgentRuntime,
		signal?: AbortSignal,
		/** A completed background reminder was just appended to the context tail. */
		contextChanged?: boolean,
	): Promise<
		| {
				context: { messages: AgentMessage[]; tools: AgentRuntime["agent"]["state"]["tools"] };
				model: AgentRuntime["agent"]["state"]["model"];
				thinkingLevel: AgentRuntime["agent"]["state"]["thinkingLevel"];
		  }
		| undefined
	>;
	contextUsage(): LiveContextUsage;
	contextLedger(): ContextLedger;
	emitContextWindowWarningTransition(warning: string | null): void;
	/** Record one known cache disturbance for the current or next call. */
	noteColdReason(reason: ExpectedColdReason): void;
	/** Record a disturbance the running loop never sends, for the first request of the next run (#434). */
	noteNextRunColdReason(reason: ExpectedColdReason): void;
	/** The tool choice a request sends; `afterRejection` marks the #426 retry of a request the provider rejected. */
	noteCacheRequestToolChoice(toolChoice: string, afterRejection?: boolean): void;
	/** Consume disturbances since the last settled run (T3.3 honesty). */
	consumeExpectedColdReasons(runtimeId: string): void;
	/** Disturbances since the last main request was sent; the journal stamps them on the next one (#434). */
	takeCallColdReasons?(): ExpectedColdReason[];
	/** Advances whenever cache comparison restarts: a committed compaction or a session reset (#423, #434). */
	cacheGeneration?(): number;
	/** Prompt-cache record for one persisted assistant call, with cold-reason stamp. */
	promptCachePayloadForAssistant(
		usage: Usage,
		backend?: BackendCompletionTimings,
		anthropicResponse?: AnthropicResponseObservation,
		transport?: CodexTransportObservation,
	): Record<string, unknown>;
	/** Record the settled run's cache summary for /context. */
	noteRunCacheSummary(messages: ReadonlyArray<AgentMessage>, runFirstCallVerdict: BackendCacheVerdict | null): void;
	/**
	 * Record one pre-warm for `/context`. It contributes no tokens to the context
	 * estimate and is never an expected-cold reason: a pre-warm is the opposite
	 * of a disturbance, it is the prefix the next turn wants already resident.
	 */
	notePrewarm(prewarm: PrewarmStats): void;
	/**
	 * Drop per-session accounting. `branchAnchorTurnId` is the leaf the incoming
	 * session's next turn parents under; it becomes the advisory branch identity,
	 * which is why it is supplied only here. Ordinary appends advance the leaf
	 * without re-arming an advisory; real navigation re-arms it.
	 */
	resetForSession(branchAnchorTurnId?: string | null): void;
	navigationRevision(): number;
	dispose(): void;
}

/**
 * Why the working-set stage declined, said in the terms the operator can act
 * on. The two cases are worth separating: a session whose every turn is inside
 * `protectLastTurns` was never offered a candidate, while a longer one was
 * offered candidates the policy refused. The first is the shape smoke pass 2
 * found (G1), and the setting it names is the one that changes it.
 */
function evictionSkipMessage(
	visibleEntries: ReadonlyArray<SessionEntry>,
	workingSet: Readonly<{ protectLastTurns: number; protectLastSteps: number; policy: string }>,
	policyId: string,
): string {
	const turns = visibleEntries.filter(isTurnStart).length;
	// The window is the narrower of the turn and step horizons, so only the
	// cutoff itself says whether the policy was offered anything at all.
	const allProtected = protectionCutoffIndex(visibleEntries, workingSet) === 0;
	return renderEvictionSkipLine({
		reason: allProtected ? "all-protected" : "nothing-evictable",
		turns,
		protectLastTurns: workingSet.protectLastTurns,
		protectLastSteps: workingSet.protectLastSteps,
		policyId,
	});
}

/**
 * The token and route facts of one budget publication, separate from the
 * identity fields that name it. Split out so the live and pre-runtime paths
 * produce the same shape and the reduction basis can be keyed over it after it
 * is resolved rather than before.
 */
type LiveBudgetAccounting = Pick<
	LiveBudgetInput,
	| "targetId"
	| "runtimeId"
	| "modelId"
	| "modelApi"
	| "effectiveWindow"
	| "windowSource"
	| "estimatedInputTokens"
	| "anchoredInputTokens"
	| "inputTokens"
	| "inputSource"
	| "historical"
	| "breakdown"
	| "breakdownSource"
	| "outputReserveTokens"
>;

/**
 * Content identity of a message list.
 *
 * The one serialization used for both jobs that need to know whether the same
 * message objects still hold the same bytes: validating a provider anchor's
 * attested prefix, and fingerprinting the live request. Token counts cannot do
 * either, because `estimateAgentMessageTokens` prices by character count and a
 * same-length replacement leaves every figure identical.
 */
function messageListDigest(messages: ReadonlyArray<AgentMessage>): string {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

// #423: five idle minutes warrants a reminder, without claiming a provider cache lifetime.
const CACHE_REUSE_IDLE_NOTICE_MS = 5 * 60 * 1000;

const tokenCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/** The persisted snapshot's split as a journal record, under the real session and turn (#434). */
function recordContextSnapshot(sessionId: string, snapshot: ContextSnapshot): void {
	const split = snapshot.categories;
	telemetryHub().emit(
		"context.snapshotted",
		{
			snapshotId: snapshot.snapshotId,
			providerId: snapshot.providerId,
			runtimeId: snapshot.runtimeId,
			modelId: snapshot.modelId,
			splits: snapshot.sources.splits,
			...(snapshot.promptSegments ? { promptSegments: snapshot.promptSegments } : {}),
			...(snapshot.promptHash ? { promptHash: snapshot.promptHash } : {}),
			...(snapshot.toolSignature ? { toolSignature: snapshot.toolSignature } : {}),
			...(snapshot.messageRange ? { messageRange: snapshot.messageRange } : {}),
			...(snapshot.divergenceRatio !== undefined ? { divergenceRatio: snapshot.divergenceRatio } : {}),
			categories: {
				system: tokenCount(split.system),
				tools: tokenCount(split.tools),
				...(split.toolResults !== undefined ? { toolResults: tokenCount(split.toolResults) } : {}),
				agents: tokenCount(split.agents),
				skills: tokenCount(split.skills),
				memory: tokenCount(split.memory),
				project: tokenCount(split.project),
				messages: tokenCount(split.messages),
				reserve: tokenCount(split.reserve),
				free: tokenCount(split.free),
				streaming: tokenCount(split.streaming),
			},
			window: {
				desired: tokenCount(snapshot.desiredContextWindow),
				effective: tokenCount(snapshot.effectiveContextWindow),
				source: snapshot.contextWindowSource || "unknown",
			},
			source: snapshot.sources.total,
			...(snapshot.estimatedTokens !== undefined ? { estimatedTokens: tokenCount(snapshot.estimatedTokens) } : {}),
			...(snapshot.reconciledTokens !== undefined ? { reconciledTokens: tokenCount(snapshot.reconciledTokens) } : {}),
		},
		{
			sessionId,
			agent: mainAgent(sessionId),
			...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
			...(snapshot.callId && snapshot.attemptId ? { callId: snapshot.callId, attemptId: snapshot.attemptId } : {}),
		},
	);
}

export function createTurnContext(deps: TurnContextDeps): TurnContext {
	const { state, middleware } = deps;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();
	let compactionController: AbortController | null = null;
	let disposed = false;

	let currentContextSnapshot: ContextSnapshot | null = null;
	/**
	 * The last provider-attested prompt size, and how many agent messages it
	 * covered (issue #227).
	 *
	 * `tokens` is the provider's own prompt count for that call plus the output
	 * it produced, which together are what the next call's prompt carries for
	 * the same messages. The anchored message prefix identifies that history,
	 * so anything appended since is priced by estimate and added on top.
	 * Unlike the per-message usage anchor inside
	 * `estimateAgentContextTokens`, this survives `contextUsageInvalidated`:
	 * a working-set projection subtracts the tokens it removed rather than
	 * throwing the attestation away.
	 */
	let reconciledAnchor: {
		tokens: number;
		anchoredMessages: ReadonlyArray<AgentMessage>;
		/**
		 * Content identity of `anchoredMessages` when the attestation was taken.
		 * Object identity alone cannot detect an in-place edit: rewriting a
		 * message's text with a different string of the same length leaves the
		 * reference, the length, and therefore every chars/4 figure unchanged,
		 * while the provider counted different tokens. Without this the anchor
		 * would keep lending its authority to a prefix the provider never saw.
		 */
		contentDigest: string;
		runtime: AgentRuntime;
		model: AgentRuntime["agent"]["state"]["model"];
		modelKey: string;
		targetId: string;
		runtimeId: string;
		wireModelId: string;
		systemPromptTokens: number;
		toolSchemaTokens: number;
	} | null = null;
	let lastCompactionNoGain = false;
	let lastCompactionEvent: { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null = null;
	// Last settled run's provider cache usage plus whether the compiled system
	// prompt was reused. Shown together in /context so "prompt reused" can
	// never imply provider cache reuse the backend did not report.
	let lastPromptCache: PromptCacheStats | null = null;
	let lastSystemPromptReused = false;
	// The last pre-warm, shown by /context until the next settled run answers the
	// question it was asked about: did the prefix the next turn needs get there
	// before the operator did.
	let lastPrewarm: PrewarmStats | null = null;
	// The session system prompt, compiled once per session. Recompiles happen
	// only when the canonical identity of every live compile input changes, or
	// a config hot-reload invalidates compiler-owned inputs. A
	// recompile that changes the prompt text appends a "promptRecompiled"
	// ledger entry so a cold provider cache is always explainable.
	let sessionPrompt: CompiledSessionPrompt | null = null;
	let sessionPromptKey: string | null = null;
	let sessionPromptInvalidated = false;
	let postureGeneration: PostureGeneration | null = null;
	let postureGenerationPersisted = false;
	let pendingPosture: { inputs: SessionPromptInputs; effectiveAutonomy: string; rendered: Map<string, string> } | null =
		null;
	const pendingPolicyText = (): string | null => {
		if (!pendingPosture || !deps.prompts?.renderSessionPostureUpdate) return null;
		const autonomy = deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy ?? "default";
		if (autonomy === pendingPosture.effectiveAutonomy) return null;
		let text = pendingPosture.rendered.get(autonomy);
		if (text === undefined) {
			text = deps.prompts.renderSessionPostureUpdate(autonomy, pendingPosture.inputs);
			pendingPosture.rendered.set(autonomy, text);
		}
		return text;
	};
	// #423: the memory section compiled into the live prompt (null until the
	// first compile, a session switch, or a completed compaction), and the
	// reminder text carrying what the live section added since.
	let frozenMemorySection: string | null = null;
	let frozenRouteSources: SessionPromptInputs["routeSources"];
	let frozenRouteIdentity = "";
	let thinkingUsesConfigurationUpdate = false;
	let frozenMemorySessionId = "";
	let sessionPromptDelta = "";
	let announcedProjectPreloadSession: string | null = null;
	// The hash this process compiled *for the session that is current now*, and
	// the manifest's `previousHash` whenever it is set. It is not read off
	// `sessionPrompt`: an in-process `/resume` leaves that compile in place so
	// the ledger keeps its project-preload labels until the next compile, but
	// manifest provenance follows the session, so a switch drops the hash here
	// and the next compile falls through to the incoming session's own manifest
	// exactly as a cold-start resume does (#249).
	let sessionPromptHash: string | null = null;
	// Whether this process has already looked up the resumed session's last
	// recorded prompt hash. The lookup reads the manifest file, so it happens
	// once, on the first compile, and never on the reuse path.
	let resumedPromptHashRead = false;
	let resumedPromptHash: string | null = null;
	const sessionWorkingContextPaths = new Set<string>();
	let memoryTurnSequence = 0;
	let memoryAuthorityEpoch = 0;
	let memoryTurn: {
		id: string;
		sessionId: string | null;
		sessionAuthority: string;
		origin: string;
		taskText: string;
		activePaths: readonly string[];
	} | null = null;
	const memoryOrigin = (runtime: AgentRuntime): string =>
		JSON.stringify([process.cwd(), runtime.targetId, runtime.runtimeId, runtime.wireModelId]);
	let pendingPromptLogEntry: SessionPromptCompileRecord | null = null;
	let latestPromptCompile: SessionPromptCompileRecord | null = null;
	// Reuse an empty automatic attempt only for identical ledger and provider
	// context. Same-turn tool growth or same-length content replacement must
	// get a fresh cut; ordinary below-threshold checks never fingerprint it.
	let emptyAutoCompactContextKey: string | null = null;
	// A summarizer that fails deterministically (a summary request too large for
	// the window, a broken route) would otherwise be called again after every
	// tool batch, because each batch changes the attempt key. Count consecutive
	// automatic failures and pause the automatic path at the limit until a
	// compaction succeeds or the session changes. /compact and overflow recovery
	// are forced and still run.
	let autoCompactFailures = 0;
	// The summarizer request of the last automatic attempt whose checkpoint
	// would not reduce context. The attempt key above changes with every tool
	// batch, while a cut held behind a protected turn sends the same request
	// each time, so without this every request above the threshold paid one
	// summary call that was discarded (#422). Forced runs neither read nor set it.
	let noGainSummaryDigest: string | null = null;

	// The live budget view and the identity that decides when an advisory
	// re-arms. `branchAnchorTurnId` moves only on real branch navigation, so two
	// tool batches advancing `state.lastTurnId` under the same branch keep one
	// advisory epoch; `navigationEpoch` separates two visits to the same leaf id.
	const budgetProducer = createLiveBudgetProducer();
	let branchAnchorTurnId: string | null = null;
	let navigationEpoch = 0;
	// Reduction-basis key of the last automatic attempt that produced nothing.
	// It is the post-accounting identity, so a recalibrated anchor or a
	// different resolved output cap clears the refusal even when the
	// conversation, the route, and the configuration are byte-identical. The
	// pressure policy reuses a refusal only for this exact key.
	let noUsefulCutBasisKey: string | null = null;

	// Cache-disturbance honesty (T3.3). Accumulate every known local-runtime
	// disturbance and prefix-byte change since the last settled run. The next
	// submit consumes the set, stamps `promptCache.expectedColdReasons` on its
	// first assistant entry, and shows one dim notice.
	const pendingColdReasons = new Set<ExpectedColdReason>();
	let runExpectedColdReasons: ExpectedColdReason[] = [];
	let nextAssistantColdReasons: ExpectedColdReason[] = [];
	// The journal stamps each disturbance on the first request sent after it, hidden retries included, while the
	// ledger above stamps the first persisted reply; the two lists are consumed independently (#434).
	let callColdReasons: ExpectedColdReason[] = [];
	let cacheGeneration = 0;
	let cacheCallBaseline: CacheCallBaseline | null = null;
	let cacheCallBaselineLoaded = false;
	let cacheRequestToolChoice = "auto";
	// The tool choice of the last request on its target and wire model, and of the one before it, which a #426 retry
	// compares with because the provider rejected the request between them (#434).
	let sentToolChoice: { route: string; toolChoice: string } | undefined;
	let priorSentToolChoice: { route: string; toolChoice: string } | undefined;
	let nextChangedSection: string | undefined;
	let previousPromptSections: SessionPromptCompileRecord["sections"] | null = null;
	let idleReuseNoticeStamp: string | null = null;
	let recompileReuseNoticeStamp: string | null = null;
	const loadCacheCallBaseline = (): void => {
		if (!cacheCallBaselineLoaded) {
			cacheCallBaselineLoaded = true;
			// #423: a fresh process resumes only the active branch's last persisted call.
			const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (!entry) continue;
				if (entry.kind === "compactionSummary" || entry.kind === "contextEviction") break;
				if (entry.kind !== "message" || entry.role !== "assistant") continue;
				const payload = entry.payload as {
					promptCache?: {
						input?: number;
						cacheRead?: number;
						cacheWrite?: number;
						observation?: { requestFingerprint?: CacheRequestFingerprint; transport?: CacheCallTransport };
					};
				} | null;
				const prior = payload?.promptCache;
				const endedAt = Date.parse(entry.timestamp);
				if (typeof prior?.input === "number" && Number.isFinite(endedAt)) {
					const transportRequest = prior.observation?.transport?.request;
					cacheCallBaseline = {
						inclusiveInputTokens: prior.input + (prior.cacheRead ?? 0) + (prior.cacheWrite ?? 0),
						endedAt,
						...(prior.observation?.requestFingerprint ? { requestFingerprint: prior.observation.requestFingerprint } : {}),
						...(transportRequest ? { transportRequest } : {}),
					};
				}
				break;
			}
		}
	};
	const resetCacheCallBaseline = (): void => {
		cacheCallBaseline = null;
		// #423: a generation reset must not reload the pre-reduction ledger baseline.
		cacheCallBaselineLoaded = true;
		cacheGeneration += 1;
	};
	// #423: prefix-byte and reasoning changes can cool every tier. Residency,
	// dispatch traffic, and compaction retain the local-native disturbance gate.
	const TIER_INDEPENDENT_COLD_REASONS: ReadonlySet<ExpectedColdReason> = new Set([
		"working_set_evict",
		"thinking_change",
		"model_changed",
		"input_changed",
		"tool_choice_change",
		"tool_surface_change",
		"prompt_recompiled",
	]);
	const stampsOnTier = (reason: ExpectedColdReason, runtimeId: string | undefined): boolean =>
		TIER_INDEPENDENT_COLD_REASONS.has(reason) ||
		(runtimeId !== undefined && deps.providers.getRuntime(runtimeId)?.tier === "local-native");
	// An expected cold cache is telemetry about the next response: it goes to
	// the footer's notice slot, and the Detailed receipt names the reasons with
	// the reuse the provider actually reported.
	const noteExpectedCold = (reasons: ReadonlyArray<string>): void => {
		if (deps.emitCacheNotice) deps.emitCacheNotice(reasons);
		else deps.emitNotice(`[context engine] cache may be cold: ${reasons.map(coldReasonText).join(", ")}`);
	};
	const noteColdReason = (reason: ExpectedColdReason): void => {
		if (!state.streaming) {
			pendingColdReasons.add(reason);
			return;
		}
		if (!stampsOnTier(reason, state.runtime?.runtimeId)) return;
		if (!callColdReasons.includes(reason)) callColdReasons.push(reason);
		if (!runExpectedColdReasons.includes(reason)) runExpectedColdReasons.push(reason);
		if (nextAssistantColdReasons.includes(reason)) return;
		nextAssistantColdReasons.push(reason);
		noteExpectedCold(nextAssistantColdReasons);
	};
	const unsubscribeColdReasonSources = [
		...(["run.started", "run.completed", "run.failed"] as const).map(
			(channel) =>
				deps.bus?.subscribe(channel, () => {
					noteColdReason("dispatch");
				}) ?? null,
		),
		...(["compaction.started", "compaction.ended"] as const).map(
			(channel) =>
				deps.bus?.subscribe(channel, () => {
					noteColdReason("compaction");
				}) ?? null,
		),
		// A completed compaction rebuilds the context, so the next compile takes
		// the live memory section instead of the frozen one (#423).
		deps.bus?.subscribe("compaction.ended", (payload: CompactionPayload) => {
			if (payload.outcome === "completed") {
				frozenMemorySection = null;
				resetCacheCallBaseline();
				frozenRouteSources = undefined;
			}
		}) ?? null,
		deps.bus?.subscribe("residency.mutated", (payload: ResidencyMutationPayload) => {
			const runtime = state.runtime;
			const model = runtime?.agent.state.model as { baseUrl?: unknown } | undefined;
			const baseUrl = typeof model?.baseUrl === "string" ? model.baseUrl : null;
			if (payload.targetKey !== residencyTargetKey(runtime?.runtimeId ?? "", baseUrl)) return;
			noteColdReason("residency");
		}) ?? null,
		// A memory step on another endpoint disturbs nothing here, so the stamp is
		// gated on the step having called the very server this session streams to.
		deps.bus?.subscribe("memory.step_completed", (payload: MemoryStepCompletedPayload) => {
			const target = state.runtime?.runtimeResolution.target;
			if (target === undefined) return;
			// Behind a model-routed gateway only a step on this session's own model shares its backend.
			const own = [canonicalEndpointKey(target), modelEndpointKey(target, state.runtime?.wireModelId)];
			if (!own.includes(payload.endpointKey)) return;
			noteColdReason("background_memory");
		}) ?? null,
		deps.bus?.subscribe("context.recalled", (payload: ContextRecalledPayload) => {
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
		if (!currentSession) {
			snapshotPersistPending = true;
			return;
		}
		if (snapshot.sessionId !== null && snapshot.sessionId !== currentSession.id) return;
		snapshot.sessionId = currentSession.id;
		recordContextSnapshot(currentSession.id, snapshot);
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
			sessionId: deps.session?.current()?.id ?? null,
			turnId,
			providerId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			conversationMessages: agentRuntime.agent.state.messages.filter(
				(message) => message.role !== "system" || isHostPolicyMessage(message),
			),
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
			const partial = state.runtime.agent.state.streamingMessage;
			if (partial?.role === "assistant") {
				return ceilChars(assistantOutputChars(partial));
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

	/**
	 * The window the next turn will resolve to, read the way ensureRuntime
	 * reads it but without building an agent. Before the first turn of a
	 * process, /resume included, state.runtime is null, and the ledger and the
	 * footer meter said `context window unknown · 0 tokens` until a turn ran
	 * (issue #189). Null when no target is configured or it does not resolve,
	 * and the overlay's "unknown" is then true.
	 */
	/**
	 * The prompt hash this session last recorded, for the first compile of a
	 * resumed process. Without it a resume reports `previousHash: null`, which
	 * reads as "there was no prompt before" when in fact there was one and it
	 * is exactly what a reader needs to attribute the cold cache to: a layout
	 * bump, a fragment edit, or a moved context window (issue #249).
	 */
	const lastRecordedPromptHash = (): string | null => {
		if (resumedPromptHashRead) return resumedPromptHash;
		resumedPromptHashRead = true;
		const currentSession = deps.session?.current();
		if (!currentSession) {
			// No session to read; leave the lookup open for the next compile.
			resumedPromptHashRead = false;
			return null;
		}
		const records = readPromptCompileRecords(currentSession);
		const previous = records[records.length - 1];
		resumedPromptHash = previous?.systemPromptHash ?? null;
		previousPromptSections = previous?.sections ?? null;
		return resumedPromptHash;
	};

	const resolveWindowWithoutRuntime = (): ContextWindowDetails | null => {
		const settings = deps.getSettings();
		const targetId = settings.chat?.target?.trim();
		const wireModelId = settings.chat?.model?.trim();
		if (!targetId || !wireModelId) return null;
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: settings.chat?.thinkingLevel ?? "off",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: true,
		});
		return resolved.ok ? resolved.target.contextWindowDetails : null;
	};

	const CONTEXT_WINDOW_SOURCES: ReadonlySet<string> = new Set<ContextWindowSource>([
		"catalog",
		"probe",
		"loaded",
		"target-override",
		"model-hint",
		"descriptor-default",
		"unknown",
	]);

	/** The snapshot stores its source as a plain string; only a known label is worth repeating. */
	const snapshotWindowSource = (snapshot: ContextSnapshot): ContextWindowSource | null =>
		CONTEXT_WINDOW_SOURCES.has(snapshot.contextWindowSource)
			? (snapshot.contextWindowSource as ContextWindowSource)
			: null;

	/**
	 * Window facts while no runtime exists come only from the current route's
	 * provider status. A resumed snapshot retains historical accounting, but
	 * cannot claim its old loaded window is still serving.
	 */
	const windowWithoutRuntime = (): {
		contextWindow: number;
		contextWindowSource: ContextWindowSource | null;
		contextWindowSlots: ContextWindowDetails["contextWindowSlots"];
	} => {
		const details = resolveWindowWithoutRuntime();
		if (details) {
			return {
				contextWindow: details.effectiveContextWindow,
				contextWindowSource: details.contextWindowSource,
				contextWindowSlots: details.contextWindowSlots,
			};
		}
		return { contextWindow: 0, contextWindowSource: null, contextWindowSlots: null };
	};

	const anchorModelKey = (agentRuntime: AgentRuntime): string => {
		const model = agentRuntime.agent.state.model;
		return JSON.stringify([model?.id, model?.provider, model?.api, model?.baseUrl]);
	};

	/** Price appended history separately so eviction can retain it without folding in static growth twice. */
	const reconciledHistoryTokens = (agentRuntime: AgentRuntime, history?: MessageListDigests): number | null => {
		const anchor = reconciledAnchor;
		if (!anchor) return null;
		const messages =
			history?.messages ??
			agentRuntime.agent.state.messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message));
		// The identity, route, and length checks are cheap and run first; `||`
		// short-circuits, so the content digest is only computed for a prefix that
		// still looks like the attested one. The digest covers the attested prefix
		// and never the tail, so an append does not invalidate the anchor; the
		// prefix bytes are captured anew on every publication, sharing the full
		// fingerprint serialization while still detecting every in-place edit.
		if (
			anchor.runtime !== agentRuntime ||
			anchor.model !== agentRuntime.agent.state.model ||
			anchor.modelKey !== anchorModelKey(agentRuntime) ||
			anchor.targetId !== agentRuntime.targetId ||
			anchor.runtimeId !== agentRuntime.runtimeId ||
			anchor.wireModelId !== agentRuntime.wireModelId ||
			anchor.anchoredMessages.length > messages.length ||
			anchor.anchoredMessages.some((message, index) => message !== messages[index]) ||
			(history?.digest(anchor.anchoredMessages.length) ??
				messageListDigest(messages.slice(0, anchor.anchoredMessages.length))) !== anchor.contentDigest
		) {
			reconciledAnchor = null;
			return null;
		}
		let tail = 0;
		for (let i = anchor.anchoredMessages.length; i < messages.length; i += 1) {
			const message = messages[i];
			if (message === undefined) continue;
			tail += estimateAgentMessageTokens(message);
		}
		return anchor.tokens + tail;
	};

	let pendingUserImages: ReadonlyArray<unknown> = [];
	const liveContextEstimate = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		replayMessages?: ReadonlyArray<AgentMessage>,
		history?: MessageListDigests,
	): LiveContextEstimate => {
		const contextWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
		const estimateInput = {
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages:
				replayMessages === undefined && history
					? history.messages
					: (replayMessages ?? agentRuntime.agent.state.messages).filter(
							(message) => message.role !== "system" || isHostPolicyMessage(message),
						),
			tools: agentRuntime.agent.state.tools,
			...(pendingUserText !== undefined ? { pendingUserText, pendingUserImages } : {}),
		};
		const breakdown = estimateAgentContextBreakdown(estimateInput);
		const policyText = pendingUserText === undefined ? null : pendingPolicyText();
		const pendingPolicyTokens =
			policyText === null ? 0 : estimateAgentMessageTokens({ role: "system", content: policyText });
		breakdown.pendingUserTokens += pendingPolicyTokens;
		const historyTokens = replayMessages === undefined ? reconciledHistoryTokens(agentRuntime, history) : null;
		const anchor = reconciledAnchor;
		// Provider usage already includes the old system prompt and schemas.
		// Price only positive growth, separately: shrinking one must not hide
		// growth in the other when the measured prompt exceeds chars/4.
		const reconciledTokens =
			historyTokens !== null && anchor
				? historyTokens +
					breakdown.pendingUserTokens +
					Math.max(0, breakdown.systemPromptTokens - anchor.systemPromptTokens) +
					Math.max(0, breakdown.toolSchemaTokens - anchor.toolSchemaTokens)
				: null;
		const estimatedTokens =
			reconciledTokens === null
				? estimateAgentContextTokens(estimateInput) + pendingPolicyTokens
				: breakdown.systemPromptTokens + breakdown.messageTokens + breakdown.pendingUserTokens + breakdown.toolSchemaTokens;
		return {
			// The estimate is a floor, not a competing verdict: it prices material
			// the attested call never saw, so a provider count below it would be
			// answering about a smaller conversation.
			tokens: Math.max(estimatedTokens, reconciledTokens ?? 0),
			estimatedTokens,
			reconciledTokens,
			contextWindow,
			breakdown,
		};
	};

	const sha256Json = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

	/**
	 * Identity of the exact material the next request would carry, plus the
	 * settings that decide its reserve and whether a reduction is even eligible.
	 * This is the pre-accounting half: the reduction basis adds the resolved
	 * estimate, cap, and reservation on top of it.
	 *
	 * Token counts alone cannot do this job: `estimateAgentMessageTokens` prices
	 * by character count, so replacing a message with another of the same length
	 * leaves every figure identical while the request is a different one. The
	 * conversation is therefore hashed by content, not by length or count.
	 */
	const liveBudgetContentFingerprint = (
		agentRuntime: AgentRuntime | null,
		pendingUserText: string | undefined,
		promptFingerprint: string | null,
		toolSignature: string | null,
		history?: MessageListDigests,
	): string => {
		const settings = deps.getSettings();
		const eligibility = {
			compaction: settings.context.compaction ?? null,
			workingSet: settings.context.workingSet ?? null,
			maxOutputTokens: settings.chat?.maxOutputTokens ?? null,
		};
		if (!agentRuntime) {
			const snapshot = currentContextSnapshot;
			return sha256Json([
				"historical/1",
				settings.chat?.target ?? null,
				settings.chat?.model ?? null,
				snapshot?.snapshotId ?? null,
				snapshot ? snapshotInputTokens(snapshot) : null,
				snapshot?.sources.total ?? null,
				windowWithoutRuntime().contextWindow,
				promptFingerprint,
				toolSignature,
				eligibility,
			]);
		}
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		return sha256Json([
			"live/1",
			agentRuntime.targetId,
			agentRuntime.runtimeId,
			agentRuntime.wireModelId,
			agentRuntime.agent.state.model?.api ?? null,
			details.effectiveContextWindow,
			details.contextWindowSource,
			promptFingerprint,
			toolSignature,
			// Same serialization the anchor validates its attested prefix with, so
			// the two cannot disagree about whether the conversation changed.
			history?.digest() ??
				messageListDigest(
					agentRuntime.agent.state.messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
				),
			pendingUserText ?? null,
			pendingUserText === undefined ? null : pendingUserImages,
			eligibility,
		]);
	};

	/**
	 * A captured decomposition, labelled as one. The mapping is the same the
	 * `/context` overlay already uses, so the two cannot disagree; it is not a
	 * fresh measurement of the live agent state and is never presented as one.
	 */
	const capturedBreakdown = (snapshot: ContextSnapshot, pendingTokens: number): LiveBudgetBreakdown => ({
		systemPromptTokens: snapshot.categories.system,
		messageTokens: snapshot.categories.messages + (snapshot.categories.toolResults ?? 0),
		pendingUserTokens: pendingTokens,
		toolSchemaTokens: snapshot.categories.tools,
	});

	const optionalProjection = <T>(read: (() => T | null) | undefined): T | null => {
		if (!read) return null;
		try {
			return read();
		} catch {
			// A continuity projection is supplemental. Losing it must not stop the
			// budget from being published.
			return null;
		}
	};

	/**
	 * Token facts of the live next request, all from one `liveContextEstimate`
	 * call: the same one admission budgets against. Old snapshot categories are
	 * never summed to reconstruct the total, and streaming output is never added
	 * on top, because the live next-request message list already carries the
	 * completed assistant turn and the estimate already carries the pending
	 * text. Each is charged exactly once.
	 */
	const liveRuntimeAccounting = (
		agentRuntime: AgentRuntime,
		pendingUserText: string | undefined,
		history?: MessageListDigests,
	): LiveBudgetAccounting => {
		const estimate = liveContextEstimate(agentRuntime, pendingUserText, undefined, history);
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		return {
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			modelApi: agentRuntime.agent.state.model?.api ?? null,
			effectiveWindow: details.effectiveContextWindow > 0 ? details.effectiveContextWindow : null,
			windowSource: details.contextWindowSource,
			estimatedInputTokens: estimate.estimatedTokens,
			anchoredInputTokens: estimate.reconciledTokens,
			inputTokens: estimate.tokens,
			inputSource: estimate.reconciledTokens === null ? "estimated" : "anchored-plus-estimated-tail",
			historical: false,
			breakdown: { ...estimate.breakdown },
			breakdownSource: "live",
			outputReserveTokens: resolveTurnOutputReserve(agentRuntime, estimate.tokens),
		};
	};

	/** Token facts before this process built a runtime: a persisted measurement, labelled as one. */
	const historicalAccounting = (
		snapshot: ContextSnapshot | null,
		settings: Readonly<ClioSettings>,
	): LiveBudgetAccounting => {
		// Inspection uses already-loaded capture facts, never a diagnostic-ledger scan.
		const sameRoute =
			!snapshot || (snapshot.providerId === settings.chat?.target && snapshot.modelId === settings.chat?.model);
		// A saved request from model A cannot acquire model B's window while
		// retaining A's identity and input measurement. Keep that capture coherent.
		const window =
			snapshot && !sameRoute
				? {
						contextWindow: snapshot.effectiveContextWindow,
						contextWindowSource: snapshotWindowSource(snapshot),
					}
				: windowWithoutRuntime();
		const pendingTokens = pendingUserInputTokens();
		return {
			targetId: snapshot?.providerId ?? settings.chat?.target ?? null,
			runtimeId: snapshot?.runtimeId ?? null,
			modelId: snapshot?.modelId ?? settings.chat?.model ?? null,
			modelApi: null,
			effectiveWindow: window.contextWindow > 0 ? window.contextWindow : null,
			windowSource: window.contextWindowSource,
			estimatedInputTokens: snapshot?.estimatedTokens ?? null,
			anchoredInputTokens: snapshot?.reconciledTokens ?? null,
			inputTokens: snapshot ? snapshotInputTokens(snapshot) + pendingTokens : null,
			inputSource: snapshot ? "historical" : "unknown",
			historical: true,
			breakdown: snapshot ? capturedBreakdown(snapshot, pendingTokens) : null,
			breakdownSource: snapshot ? "captured" : null,
			// No resolved route means no honest output reservation, and an unpriced
			// reserve is unknown rather than zero.
			outputReserveTokens: null,
		};
	};

	/**
	 * Assemble one publication from the live runtime, or from the persisted
	 * capture when this process has not built a runtime yet.
	 */
	const liveBudgetInput = (pendingUserText?: string, capturedHistory?: MessageListDigests): LiveBudgetInput => {
		const settings = deps.getSettings();
		const agentRuntime = state.runtime;
		const history = agentRuntime
			? (capturedHistory ??
				createMessageListDigests(
					agentRuntime.agent.state.messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
				))
			: undefined;
		const snapshot = currentContextSnapshot;
		const promptFingerprint = agentRuntime
			? sha256Json(engineInitialSystemPrompt(agentRuntime.agent) ?? null)
			: (snapshot?.promptHash ?? null);
		const toolSignature = agentRuntime
			? toolSignatureFromState(agentRuntime.agent.state.tools)
			: (snapshot?.toolSignature ?? null);
		const contentFingerprint = liveBudgetContentFingerprint(
			agentRuntime,
			pendingUserText,
			promptFingerprint,
			toolSignature,
			history,
		);
		// Two independent existing settings, not one derived from the other: the
		// reduce point is `context.compaction.threshold` and the working-set
		// target is `context.workingSet.target`. A pair the policy refuses is
		// reported as a refusal rather than repaired into a fabricated setting.
		const policyResolution = resolveLiveBudgetPolicy(
			settings.context.compaction?.threshold,
			settings.context.workingSet?.target,
		);

		// Accounting first, then the identity that describes it. A reduction
		// refusal is only reusable for the request the reducer actually saw, and
		// the resolved anchor, cap, and reservation are part of that request even
		// when not a byte of the conversation moved.
		const accounting = agentRuntime
			? liveRuntimeAccounting(agentRuntime, pendingUserText, history)
			: historicalAccounting(snapshot, settings);
		const economic = compactionBudget(
			accounting.effectiveWindow ?? 0,
			policyResolution.policy.reduce,
			settings.context.compaction.maxTokens,
			agentRuntime?.agent.state.model ??
				getCatalogModelForRuntime(
					accounting.runtimeId ?? settings.targets.find((target) => target.id === accounting.targetId)?.runtime ?? "",
					accounting.modelId ?? "",
				),
		);
		const configured = policyResolution.policy;
		const policy = {
			...configured,
			notice: configured.notice * (economic.threshold / configured.reduce),
			prepare: configured.prepare * (economic.threshold / configured.reduce),
			reduce: economic.threshold,
			target: configured.target * economic.fractionScale,
		};
		const reductionBasisKey = sha256Json([
			"reduction-basis/1",
			contentFingerprint,
			accounting.effectiveWindow,
			accounting.estimatedInputTokens,
			accounting.anchoredInputTokens,
			accounting.inputTokens,
			accounting.inputSource,
			accounting.outputReserveTokens,
			// The resolved cap can move without moving the reservation, because a
			// route clamp may be the binding constraint. Both belong in the key.
			agentRuntime?.runtimeResolution.capabilityDecisions?.maxTokens ?? null,
			snapshot?.categories.reserve ?? null,
			policy.reduce,
			policy.target,
		]);

		return {
			...accounting,
			sessionId: deps.session?.current()?.id ?? snapshot?.sessionId ?? null,
			branchAnchorTurnId,
			activeLeafTurnId: state.lastTurnId,
			activeUserTurnId: state.activeUserTurnId,
			capturedSnapshotId: snapshot?.snapshotId ?? null,
			// Compaction headroom recorded by the capture. Carried under its own
			// name so nothing can mistake it for the output reserve.
			thresholdReserveTokens: snapshot?.categories.reserve ?? null,
			policy,
			policyRejection: policyResolution.rejection,
			// Reduction has not been asked about unless an automatic attempt for
			// this exact basis already came back empty.
			reduction: noUsefulCutBasisKey !== null && noUsefulCutBasisKey === reductionBasisKey ? "no-useful-cut" : "unknown",
			reductionBasisKey,
			promptFingerprint,
			toolSignature,
			navigationEpoch,
			lastReduction: lastCompactionEvent ? { ...lastCompactionEvent } : null,
			pendingHandoff: optionalProjection(deps.getPendingHandoff),
			lastOutcome: optionalProjection(deps.getLastOutcome),
		};
	};

	const refreshLiveBudget = (pendingUserText?: string, history?: MessageListDigests): LiveBudgetView =>
		budgetProducer.publish(liveBudgetInput(pendingUserText, history));

	/**
	 * A working-set projection removes tokens from messages the attestation
	 * covered; it does not make the attestation wrong about the rest. Subtract
	 * what the planner priced out against the same projection and re-anchor on
	 * the refreshed list, instead of discarding the figure and falling back to
	 * pure chars/4 exactly when the accounting matters most (issue #227).
	 * Materialize history before rebuilding the list; otherwise advancing the
	 * anchor would lose tool results appended since the last measured call.
	 * Static baselines stay tied to that call until the next reconciliation.
	 */
	const carryReconciledAnchorThroughProjection = (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): void => {
		if (!reconciledAnchor || historyTokens === null) return;
		const anchoredMessages = [
			...agentRuntime.agent.state.messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
		];
		reconciledAnchor = {
			...reconciledAnchor,
			tokens: Math.max(0, historyTokens - Math.max(0, tokensRemoved)),
			anchoredMessages,
			// Re-anchoring on the projected list is the point of this carry, so its
			// content identity is retaken here. Keeping the old digest would fail
			// the next validation and discard the attestation this preserves.
			contentDigest: messageListDigest(anchoredMessages),
		};
	};

	const bindProviderCompaction = (runtime: AgentRuntime): void => {
		setEngineProviderCompactionPolicy(
			runtime.agent,
			() => deps.getSettings().context.compaction.provider === "native" && runtime.runtimeId === "openai-codex",
		);
		const origin = deps.session?.current()?.id;
		setEngineProviderReplayFallback(runtime.agent, async (reason) => {
			if (origin !== deps.session?.current()?.id) throw new DOMException("Replay ownership changed", "AbortError");
			await resolveProviderReplay(runtime, reason);
		});
		setEngineProviderCheckpointObserver(runtime.agent, (handle, inputTokens) => {
			if (origin !== deps.session?.current()?.id) return;
			const entries = withProviderCheckpointMeasurements(
				filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined),
			);
			const checkpoint = entries.find(
				(entry) => entry.kind === "compactionSummary" && entry.providerCheckpoint?.digest === handle.digest,
			);
			if (checkpoint?.kind !== "compactionSummary" || checkpoint.providerCheckpoint?.replayInputTokens !== undefined)
				return;
			// The full inclusive request is a measured upper bound; it never underprices opaque input (#423).
			deps.session?.appendEntry({
				kind: "custom",
				parentTurnId: state.lastTurnId,
				customType: "clio_coder_provider_checkpoint_input",
				data: { version: 1, checkpointDigest: handle.digest, inputTokens, measurement: "inclusive-request-upper-bound" },
			});
			deps.session?.flushAppends?.();
			runtime.agent.state.messages = runtime.agent.state.messages.map((message) => {
				const marker = providerCheckpointFromMessage(message);
				return marker?.digest === handle.digest
					? { ...message, clioProviderCheckpoint: { ...marker, replayInputTokens: inputTokens } }
					: message;
			});
		});
	};

	// Ledger boundaries, rather than request retries, own Codex effort changes (#423).
	const syncCodexConfiguration = (runtime: AgentRuntime): void => {
		bindProviderCompaction(runtime);
		const model = runtime.agent.state.model;
		thinkingUsesConfigurationUpdate = false;
		if (model?.api !== "openai-codex-responses") {
			setEngineCodexConfiguration(runtime.agent, undefined);
			return;
		}
		const effortFor = (level: string): string => {
			const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
			return map?.[level] ?? (level === "off" ? "none" : level);
		};
		const currentEffort = effortFor(runtime.runtimeResolution.effectiveThinkingLevel);
		const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
		let start = 0;
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (entry?.kind === "compactionSummary" || entry?.kind === "contextEviction" || entry?.kind === "modelChange")
				start = index + 1;
		}
		const generation = entries.slice(start);
		const baseline = generation.find((entry) => entry.kind === "thinkingLevelChange" && entry.configurationInitial);
		let initialEffort = baseline?.kind === "thinkingLevelChange" ? baseline.effectiveEffort : undefined;
		if (initialEffort === undefined) {
			const meta = deps.session?.current();
			const firstCompile = start === 0 && meta ? readPromptCompileRecords(meta)[0] : undefined;
			initialEffort = firstCompile?.thinkingLevel ? effortFor(firstCompile.thinkingLevel) : currentEffort;
			if (meta) {
				deps.session?.appendEntry({
					kind: "thinkingLevelChange",
					parentTurnId: state.lastTurnId,
					thinkingLevel: runtime.runtimeResolution.effectiveThinkingLevel,
					effectiveEffort: initialEffort,
					configurationInitial: true,
				});
			}
		}
		const available = new Set<string>();
		const usersByTime = new Map<number, Array<SessionEntry>>();
		for (const entry of entries) {
			if (entry.kind !== "message" || entry.role !== "user") continue;
			const time = Date.parse(entry.timestamp);
			const group = usersByTime.get(time) ?? [];
			group.push(entry);
			usersByTime.set(time, group);
		}
		// Resume/refresh already built these messages; never construct another replay (#423).
		for (const message of runtime.agent.state.messages) {
			if (message.role !== "user") continue;
			const bound = engineCodexUserTurn(message);
			if (bound) {
				available.add(bound);
				continue;
			}
			const text = extractUserText(message);
			const entry = usersByTime.get(message.timestamp)?.find((candidate) => {
				if (candidate.kind !== "message" || available.has(candidate.turnId)) return false;
				const original = extractTurnText(candidate.payload);
				return text === original;
			});
			if (entry) {
				setEngineCodexUserTurn(message, entry.turnId);
				available.add(entry.turnId);
			}
		}
		// The admitted user is appended to Pi after commitMemoryTurn; message_end binds it (#423).
		if (state.activeUserTurnId) available.add(state.activeUserTurnId);
		const updates: Array<{ position: string; effort: string }> = [];
		let desired = initialEffort;
		let effective = initialEffort;
		for (const entry of generation) {
			if (entry.kind === "thinkingLevelChange" && !entry.configurationInitial) {
				desired = entry.effectiveEffort ?? effortFor(entry.thinkingLevel);
			}
			if (entry.kind !== "message" || entry.role !== "user") continue;
			if (!available.has(entry.turnId)) continue;
			const position = entry.turnId;
			if (desired === effective) continue;
			updates.push({ position, effort: desired });
			effective = desired;
		}
		const configuration: CodexConfiguration = { initialEffort, updates };
		setEngineCodexConfiguration(runtime.agent, configuration);
		thinkingUsesConfigurationUpdate = updates.at(-1)?.position === state.activeUserTurnId;
	};

	const refreshAgentMessagesFromSession = (agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry> => {
		const refreshedEntries = deps.readSessionEntries?.() ?? [];
		replaceEngineMessages(
			agentRuntime.agent,
			buildModelReplayAgentMessagesFromTurns(refreshedEntries, {
				...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
				// The post-compaction rebuild is where an accepted note has to
				// survive: wiring continuity only into /fork would lose it on the
				// very refresh the reduction triggers.
				continuity: continuityContextFromSession(deps.session),
			}),
		);
		state.replayedContextMessages = [];
		syncCodexConfiguration(agentRuntime);
		return refreshedEntries;
	};

	let compactionOperation: ReturnType<typeof createContextOperation> | null = null;
	let compactionLifecycleStarted = false;
	let compactionLifecycleTrigger: CompactionTrigger = "auto";
	let compactionFacts: ContextOperationFact[] = [];
	let compactionTokens: { before: number; after: number; basis: "runtime-estimate" } | undefined;
	let compactionConclusion = "Context compaction finished";
	let compactionActivityPhase: ContextActivityPhase = "compact";
	const emitCompactionActivity = (
		status: ContextActivityStatus,
		message: string,
		phase: ContextActivityPhase = status === "completed"
			? "done"
			: status === "failed"
				? compactionActivityPhase
				: "compact",
	): void => {
		if (status === "started" && !compactionLifecycleStarted) {
			compactionLifecycleStarted = true;
			deps.bus?.emit("compaction.started", { trigger: compactionLifecycleTrigger, at: Date.now() });
		}
		compactionActivityPhase = phase;
		if (status === "completed" || status === "failed") {
			compactionConclusion = message;
			return;
		}
		compactionOperation?.progress({
			phase,
			status,
			message,
			...(phase === "summarize" ? { stages: ["compact", "summarize", "state"] as const } : {}),
		});
	};
	const compactionFailureMessage = (error: unknown): string =>
		`compaction failed: ${error instanceof Error ? error.message : String(error)}`;

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
	const performAutoCompact = async (
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
		pendingSkillPolicy?: PendingSkillToolPolicy,
		signal?: AbortSignal,
		handoff?: ContinuityReductionHooks,
		pendingUserIsOperator = true,
		providerFallbackReason?: string,
	): Promise<boolean> => {
		bindProviderCompaction(agentRuntime);
		lastCompactionNoGain = false;
		if (!deps.readSessionEntries) return false;
		// A fresh prompt has no history to shrink; request admission reports its budget (#438).
		if (deps.session && !deps.session.current()) return false;
		const originSession = deps.session?.current()?.id;
		const originNavigation = navigationEpoch;
		// A known window lets overflow recovery force a fit attempt. With an
		// unknown window, summarize directly and let the server judge the retry.
		const knownWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow > 0;
		const requiredFit = triggerOverride === "overflow" && knownWindow;
		const useRequestBudget = !force || requiredFit || handoff !== undefined || providerFallbackReason !== undefined;
		const activeAutoTurnId = useRequestBudget ? state.activeUserTurnId : null;
		const skillContextState = mainSkillContextState(
			filterEntriesToActivePath(deps.readSessionEntries(), state.lastTurnId ?? undefined),
			pendingSkillPolicy ?? state.currentPendingSkillPolicy ?? state.activeSkillSurface,
		);
		const settings = deps.getSettings();
		const cfg = settings.context.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;
		if (!force && autoCompactFailures >= AUTO_COMPACT_FAILURE_LIMIT) return false;
		const economic = compactionBudget(
			agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
			cfg?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
			cfg?.maxTokens,
			agentRuntime.agent.state.model,
		);
		const compactionThreshold = economic.threshold;
		const compactionWindow = economic.triggerWindow;
		const workingSetTarget = settings.context.workingSet.target * economic.fractionScale;
		const pressureEstimate = force && !requiredFit ? null : liveContextEstimate(agentRuntime, pendingUserText);
		if (
			pressureEstimate &&
			!requiredFit &&
			!shouldCompact(pressureEstimate.tokens, compactionThreshold, compactionWindow).shouldCompact
		)
			return false;
		// The hysteresis band. A checkpoint runs before every request, so without
		// it a policy with unconditional rungs fires an event per step and
		// cold-starts the prefix cache each time. Inside the band the automatic
		// path does nothing at all, summary included; the overflow path still
		// forces a fit, and the request-fit admission remains the safety net. The
		// replay runner gates identically. It holds before the operation exists, so
		// a held checkpoint shows no rail activity and records no operation (#422).
		if (
			pressureEstimate &&
			!requiredFit &&
			deps.session?.current() &&
			!(process.env.CLIO_CODER_LEGACY_MASK === "1" && !handoff) &&
			settings.context.workingSet.enabled
		) {
			let held = false;
			try {
				const entries = deps.readSessionEntries() ?? [];
				const view = foldWorkingSet(entries, state.lastTurnId ?? undefined);
				resolveWorkingSetPolicy(settings.context.workingSet.policy);
				held = withinRearmBand({
					projectedTokens: pressureEstimate.tokens,
					contextWindow: economic.budgetWindow,
					rearmFraction: settings.context.workingSet.rearmFraction,
					lastEvictionTokensAfter: view.lastEvictionTokensAfter,
				});
			} catch {
				// Safe to ignore here: the eviction stage repeats this read inside the
				// operation and surfaces the same error with its activity.
			}
			if (held) return false;
		}
		// Empty cuts are reusable only while their source and provider context
		// remain unchanged. Tools can grow the same user turn into a useful cut.
		const attemptKey =
			!force && activeAutoTurnId
				? createHash("sha256")
						.update(
							JSON.stringify({
								turn: activeAutoTurnId,
								leaf: state.lastTurnId,
								entries: deps
									.readSessionEntries()
									.filter((entry) => entry.kind !== "custom" || entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE),
								context: {
									systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
									messages: agentRuntime.agent.state.messages.filter(
										(message) => message.role !== "system" || isHostPolicyMessage(message),
									),
									tools: agentRuntime.agent.state.tools,
									model: agentRuntime.agent.state.model,
									thinkingLevel: agentRuntime.agent.state.thinkingLevel,
								},
								pendingUserText,
								skillContextState,
								estimate: pressureEstimate,
								compaction: cfg,
								workingSet: settings.context.workingSet,
								output: settings.chat.maxOutputTokens,
							}),
						)
						.digest("hex")
				: null;
		if (attemptKey && emptyAutoCompactContextKey === attemptKey) return false;
		let preSummaryStageActed = false;
		// G1 from smoke pass 2: a short session generates all its pressure inside
		// the protection window, the non-destructive layer finds nothing, and the
		// destructive summary ran with nothing in the transcript saying eviction
		// was considered and declined. Held here and emitted only if a summary
		// actually follows.
		let evictionSkipNotice: string | null = null;
		const rememberEmptyAutomaticAttempt = (): void => {
			if (force || preSummaryStageActed || !attemptKey) return;
			emptyAutoCompactContextKey = attemptKey;
			// The reducer was actually asked and found nothing. Record the request
			// it was asked about, so the pressure policy can suppress a repeat
			// advisory for that exact request and no other.
			noUsefulCutBasisKey = liveBudgetInput(pendingUserText).reductionBasisKey;
		};

		const trigger: CompactionTrigger = triggerOverride ?? (force ? "force" : "auto");
		compactionLifecycleTrigger = trigger;
		const operationCwd = process.cwd();
		compactionFacts = [];
		compactionTokens = undefined;
		compactionConclusion = "No useful reduction available";
		compactionOperation = createContextOperation(
			{
				kind: "compaction",
				sessionId: originSession ?? null,
				cwd: operationCwd,
				origin: trigger === "force" ? "operator" : "automatic",
				reason: trigger === "auto" ? "automatic threshold" : trigger === "overflow" ? "request overflow" : "manual request",
			},
			(event) => {
				if (
					originSession !== deps.session?.current()?.id ||
					originNavigation !== navigationEpoch ||
					operationCwd !== process.cwd()
				)
					return;
				deps.bus?.emit("context.activity_changed", event);
				if (event.operation?.outcome && originSession && deps.session)
					deps.session.appendEntry({
						kind: "custom",
						customType: CONTEXT_OPERATION_CUSTOM_TYPE,
						parentTurnId: state.lastTurnId,
						data: event.operation,
					});
			},
		);
		compactionOperation.start("compact", `${compactionOperation.operation.reason}; preparing context`);
		// Give the host a render opportunity before route discovery or the reducer awaits.
		await new Promise<void>((resolve) => setImmediate(resolve));
		signal?.throwIfAborted();
		if (
			originSession !== deps.session?.current()?.id ||
			originNavigation !== navigationEpoch ||
			operationCwd !== process.cwd()
		)
			throw new Error("Context ownership changed before compaction.");

		if (pressureEstimate) {
			const estimate = pressureEstimate;
			const verdict = shouldCompact(estimate.tokens, compactionThreshold, compactionWindow);

			// One-release compatibility escape hatch. This is the destructive
			// pre-stage that working-set eviction replaces; keep it byte-for-byte
			// reachable only when explicitly requested.
			if (deps.session?.current()) {
				const beforeSnapshotId = currentContextSnapshot?.snapshotId ?? null;
				if (process.env.CLIO_CODER_LEGACY_MASK === "1" && !handoff) {
					let masked: ReturnType<typeof maskStaleObservations>;
					try {
						masked = maskStaleObservations(deps.readSessionEntries() ?? [], 6);
					} catch (error) {
						middleware.fireCompactionHook("mask_observations", trigger, estimate.tokens);
						emitCompactionActivity("started", "compacting context (mask stage)");
						emitCompactionActivity("failed", compactionFailureMessage(error));
						throw error;
					}
					if (masked.changed) {
						preSummaryStageActed = true;
						middleware.fireCompactionHook("mask_observations", trigger, estimate.tokens);
						emitCompactionActivity("started", "compacting context (mask stage)");
						deps.session.replaceEntries(masked.entries);
						resetCacheCallBaseline();
						refreshAgentMessagesFromSession(agentRuntime);
						// The masked history is not the one the provider counted.
						reconciledAnchor = null;

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
						deps.bus?.emit(
							"context.pruned",
							{
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
							} satisfies ContextPrunedPayload,
							sessionTelemetryContext(originSession),
						);
						compactionFacts.push({ kind: "omitted", unit: "observations", count: masked.maskedObservations });
						compactionTokens = { before: estimate.tokens, after: tokensAfterMask, basis: "runtime-estimate" };
						emitCompactionActivity("completed", `${masked.maskedObservations} observations masked`);
						const thinkingNote =
							masked.maskedThinkingBlocks > 0
								? `, ${masked.maskedThinkingBlocks} thinking blocks dropped (~${masked.maskedThinkingChars} chars)`
								: "";
						deps.emitNotice(
							`[context engine] mask_observations: ${masked.maskedObservations} observations masked${thinkingNote}; ~${estimate.tokens} tokens -> ~${tokensAfterMask} tokens`,
						);

						refreshLiveBudget(pendingUserText);
						const after = liveContextEstimate(agentRuntime, pendingUserText);
						if (
							requiredFit
								? requestFits(after.tokens, resolveTurnOutputReserve(agentRuntime, after.tokens), after.contextWindow)
								: !shouldCompact(after.tokens, compactionThreshold, compactionWindow).shouldCompact
						)
							return true;
					}
				} else if (settings.context.workingSet.enabled) {
					let planned: ReturnType<typeof planEviction>;
					let visibleEntries: ReadonlyArray<SessionEntry> = [];
					let policyId = settings.context.workingSet.policy;
					try {
						const entries = deps.readSessionEntries() ?? [];
						const view = foldWorkingSet(entries, state.lastTurnId ?? undefined);
						const policy = resolveWorkingSetPolicy(settings.context.workingSet.policy);
						policyId = policy.id;
						visibleEntries = selectVisibleEntries(entries, state.lastTurnId ?? undefined);
						const estimator = createTokenEstimator(
							visibleEntries,
							createReplayMessageConverter(entries, {
								...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
							}),
						);
						planned = (deps.planEviction ?? planEviction)(policy, {
							entries: visibleEntries,
							view,
							cwd: deps.session.current()?.cwd ?? null,
							settings: settings.context.workingSet,
							pressure: {
								tokens: liveContextEstimate(agentRuntime, pendingUserText).tokens,
								contextWindow: compactionWindow,
								threshold: requiredFit
									? Math.min(
											compactionThreshold,
											Math.max(0, 1 - resolveTurnOutputReserve(agentRuntime, estimate.tokens) / estimate.contextWindow),
										)
									: compactionThreshold,
								target: requiredFit
									? Math.min(
											workingSetTarget,
											Math.max(0, 1 - resolveTurnOutputReserve(agentRuntime, estimate.tokens) / estimate.contextWindow),
										)
									: workingSetTarget,
							},
							estimateTokens: estimator.estimateEntry,
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
							const historyTokens = reconciledHistoryTokens(agentRuntime);
							const evictionEntry = deps.session.appendEntry({
								...buildEvictionFields(planned, {
									trigger: "pressure",
									pressureBefore: verdict.pressure,
									snapshotIdBefore: beforeSnapshotId,
								}),
								// appendEntry does not infer this anchor; the interactive
								// cursor is the leaf the next message will extend.
								parentTurnId: state.lastTurnId,
							});
							if (deps.session.flushAppends) {
								deps.session.flushAppends();
								if (!handoff) notifyMemoryCommit(evictionEntry.turnId, "summary", "evicted");
							}
							resetCacheCallBaseline();
							noteColdReason("working_set_evict");
							refreshAgentMessagesFromSession(agentRuntime);
							carryReconciledAnchorThroughProjection(agentRuntime, historyTokens, planned.tokensBefore - planned.tokensAfter);

							const postEvictionSnapshot = captureRuntimeContextSnapshot(
								agentRuntime,
								state.activeUserTurnId || "compaction",
								compactionThreshold,
							);
							currentContextSnapshot = postEvictionSnapshot;
							persistContextSnapshot(postEvictionSnapshot);

							// All event surfaces quote the request anchor less the priced
							// bodies; the live re-check below remains authoritative (#422).
							lastCompactionEvent = {
								stage: "working_set",
								tokensBefore: planned.tokensBefore,
								tokensAfter: planned.tokensAfter,
								trigger,
							};
							deps.bus?.emit(
								"context.pruned",
								{
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
								} satisfies ContextPrunedPayload,
								sessionTelemetryContext(originSession),
							);
							compactionFacts.push({ kind: "omitted", unit: "observations", count: planned.items.length });
							const itemsWord = planned.items.length === 1 ? "item" : "items";
							emitCompactionActivity("completed", `${planned.items.length} working-set ${itemsWord} evicted`);
							deps.emitNotice(
								`[context engine] working set: ${planned.items.length} ${itemsWord} evicted by ${planned.policyId}; ~${planned.tokensBefore} -> ~${planned.tokensAfter} tokens, recall by ref with context(scope="recall")`,
							);

							// Published only after the carried anchor and the post-eviction
							// capture are both in place: `liveContextEstimate` clears an
							// anchor whose message prefix no longer matches, so pricing the
							// rebuilt list any earlier would discard the attestation the
							// projection carry exists to preserve.
							refreshLiveBudget(pendingUserText);
							const after = liveContextEstimate(agentRuntime, pendingUserText);
							compactionTokens = { before: estimate.tokens, after: after.tokens, basis: "runtime-estimate" };
							if (
								requiredFit
									? requestFits(after.tokens, resolveTurnOutputReserve(agentRuntime, after.tokens), after.contextWindow)
									: !shouldCompact(after.tokens, compactionThreshold, compactionWindow).shouldCompact
							)
								return true;
						} catch (error) {
							emitCompactionActivity("failed", compactionFailureMessage(error));
							throw error;
						}
					} else {
						evictionSkipNotice = evictionSkipMessage(visibleEntries, settings.context.workingSet, policyId);
					}
				} else {
					evictionSkipNotice = renderEvictionSkipLine({
						reason: "disabled",
						turns: 0,
						protectLastTurns: settings.context.workingSet.protectLastTurns,
						protectLastSteps: settings.context.workingSet.protectLastSteps,
						policyId: settings.context.workingSet.policy,
					});
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
			emitCompactionActivity("started", "summarizing session history", "summarize");
			summaryLifecycleStarted = true;
		};
		// Started lazily, in beforeSummaryCall, for forced runs too. Starting it here
		// made a forced compaction with no older history fire the llm_summary hook
		// and end its activity rail on a success tick labelled complete (p8/B2).
		// Said before the summary call, not after it: the operator is about to wait
		// on a destructive stage, and the reason the cheap one was skipped is only
		// useful ahead of it.
		if (evictionSkipNotice) deps.emitNotice(evictionSkipNotice);
		let result: CompactResult | null = null;
		// Compare full runtime estimates on both sides. The current snapshot and
		// result.tokensBefore may instead carry provider-calibrated history usage.
		const snapshotMetadata =
			currentContextSnapshot && currentContextSnapshot.systemPrompt === engineInitialSystemPrompt(agentRuntime.agent)
				? { promptSegments: currentContextSnapshot.promptSegments, promptHash: currentContextSnapshot.promptHash }
				: {};
		const preCompactSnapshot = captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
			compactionThreshold,
			snapshotMetadata,
		);
		// The footer's own figure, taken before the summary replaces the messages,
		// so the transcript row and the footer name one number (p6/U1: the
		// snapshot said 5590 beside a footer that read 28.6K).
		const footerTokensBefore = liveContextEstimate(agentRuntime, pendingUserText).tokens;
		let budget:
			| Pick<
					CompactInput,
					| "providerCompaction"
					| "providerFallbackReason"
					| "keepRecentTokens"
					| "preserveUserTurnId"
					| "pendingOperatorTurn"
					| "skillContextState"
					| "signal"
					| "beforeSummaryCall"
					| "checkpointForSummary"
					| "checkpointTokenFigures"
			  >
			| undefined = skillContextState !== undefined ? { skillContextState } : undefined;
		if (pendingUserText !== undefined && state.activeUserTurnId === null && pendingUserIsOperator)
			budget = { ...budget, pendingOperatorTurn: true };
		if (useRequestBudget) {
			const estimate = liveContextEstimate(agentRuntime, pendingUserText);
			const output = resolveTurnOutputReserve(agentRuntime, estimate.tokens);
			const inputTarget = knownWindow
				? Math.min(compactionWindow * compactionThreshold, estimate.contextWindow - output)
				: economic.ceilingTokens;
			const staticTokens = estimate.breakdown.systemPromptTokens + estimate.breakdown.toolSchemaTokens;
			const calibration = Math.max(
				0,
				estimate.tokens - staticTokens - estimate.breakdown.messageTokens - estimate.breakdown.pendingUserTokens,
			);
			// Split available history space between the recent suffix and the
			// checkpoint (including verbatim active instructions). The cut remains
			// structural, so the unchanged continuation guard verifies the result.
			const historyBudget = inputTarget - staticTokens - estimate.breakdown.pendingUserTokens - calibration;
			budget = {
				...budget,
				keepRecentTokens: Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.max(1, Math.floor(historyBudget / 2))),
				...(activeAutoTurnId ? { preserveUserTurnId: activeAutoTurnId } : {}),
			};
		}
		let summarySignal = compactionController?.signal;
		const automaticSummary = trigger === "auto" && !force;
		// An unchanged or summary-less settle still names the measured context
		// and the specific reason nothing was reduced (#422).
		const settleWithoutSummary = (reason: string | null): void => {
			if (reason !== null) compactionConclusion = preSummaryStageActed ? `${compactionConclusion}; ${reason}` : reason;
			compactionTokens = {
				before: compactionTokens?.before ?? footerTokensBefore,
				after: liveContextEstimate(agentRuntime, pendingUserText).tokens,
				basis: "runtime-estimate",
			};
		};
		try {
			result = await compactionTrigger.fire(async () => {
				summarySignal = signal;
				summarySignal?.throwIfAborted();
				return (
					(await deps.autoCompact?.(instructions, trigger, {
						...budget,
						...handoff,
						...(providerFallbackReason ? { providerFallbackReason } : {}),
						...(settings.context.compaction.provider === "native" &&
						agentRuntime.runtimeId === "openai-codex" &&
						providerFallbackReason === undefined
							? {
									providerCompaction: async (observe: CompactInput["onCall"], callTelemetry?: CallMessageObserver) => {
										// A fresh process has history before its first prompt compile; native must use the main prefix (#423).
										await controller.ensureSessionPrompt(agentRuntime, false, undefined, true);
										syncCodexConfiguration(agentRuntime);
										const timestamp = new Date().toISOString();
										const sessionId = deps.session?.current()?.id;
										return compactEngineCodex(agentRuntime.agent, {
											...(callTelemetry ? { callTelemetry } : {}),
											...(sessionId ? { sessionId } : {}),
											...(summarySignal ? { signal: summarySignal } : {}),
											onUsage: (usage, outcome, failure) =>
												observe?.({ usage, outcome, timestamp, ...(failure ? { failure } : {}) }),
										});
									},
								}
							: {}),
						...(summarySignal ? { signal: summarySignal } : {}),
						...(automaticSummary && noGainSummaryDigest !== null ? { skipSummaryDigest: noGainSummaryDigest } : {}),
						checkpointTokenFigures: (entry) => {
							const messages = buildModelReplayAgentMessagesFromTurns(
								[...(deps.readSessionEntries?.() ?? []), { ...entry, timestamp: new Date().toISOString() }],
								{
									...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
									continuity: continuityContextFromSession(deps.session),
								},
							);
							return {
								tokensBefore: footerTokensBefore,
								tokensAfter: liveContextEstimate(agentRuntime, pendingUserText, messages).tokens,
							};
						},
						beforeSummaryCall: async (hold) => {
							await (handoff?.beforeSummaryCall ?? budget?.beforeSummaryCall)?.(hold);
							if (!summaryLifecycleStarted) startSummaryLifecycle();
							emitCompactionActivity("running", "summarizing session history", "summarize");
						},
					})) ?? null
				);
			});
		} catch (error) {
			if (!summaryLifecycleStarted) startSummaryLifecycle();
			emitCompactionActivity("failed", compactionFailureMessage(error));
			summarySignal?.throwIfAborted();
			if (!force && ++autoCompactFailures === AUTO_COMPACT_FAILURE_LIMIT)
				deps.emitNotice(
					`automatic compaction paused after ${AUTO_COMPACT_FAILURE_LIMIT} consecutive failures; run /compact to retry`,
				);
			throw error;
		}
		if (
			originSession !== deps.session?.current()?.id ||
			originNavigation !== navigationEpoch ||
			operationCwd !== process.cwd()
		)
			throw new Error("Context ownership changed during compaction.");
		summarySignal?.throwIfAborted();
		if (result?.providerFallbackReason)
			deps.emitNotice(`Native compaction used Clio's portable path: ${result.providerFallbackReason}.`);
		if (result?.noGain) {
			lastCompactionNoGain = true;
			// Remembered even when eviction acted in this pass: the summary request
			// is what repeats, and eviction already changed what it would read.
			if (automaticSummary && result.summaryDigest !== undefined) noGainSummaryDigest = result.summaryDigest;
			deps.emitNotice("compaction would not reduce context; checkpoint discarded (usage recorded)");
			settleWithoutSummary("summary would not reduce context (usage recorded)");
			rememberEmptyAutomaticAttempt();
			return false;
		}
		if (!result || result.summary.length === 0) {
			if (summaryLifecycleStarted) {
				emitCompactionActivity("completed", "nothing to compact");
				settleWithoutSummary(null);
			} else {
				settleWithoutSummary(
					result?.emptyReason === "repeat-no-gain"
						? "same history as the last summary without gain; no call made"
						: result?.emptyReason === "protected-skill"
							? "nothing older than the protected skill turn to summarize"
							: result?.emptyReason === "protected-recent"
								? "nothing older than the protected recent window to summarize"
								: "nothing to summarize",
				);
				rememberEmptyAutomaticAttempt();
			}
			return false;
		}
		if (!summaryLifecycleStarted) startSummaryLifecycle();
		emitCompactionActivity("running", "saving checkpoint and rebuilding context", "state");

		if (deps.memoryCommitBridge && !handoff && deps.session?.flushAppends) {
			deps.session.flushAppends();
			await deps.session.checkpoint("context-summary");
			if (originSession !== deps.session.current()?.id || originNavigation !== navigationEpoch || signal?.aborted)
				throw new Error("Context ownership changed during checkpoint.");
			const summary = [...deps.readSessionEntries()].reverse().find((entry) => entry.kind === "compactionSummary");
			if (summary) notifyMemoryCommit(summary.turnId, "summary", "summarized");
		}

		resetCacheCallBaseline();
		refreshAgentMessagesFromSession(agentRuntime);
		if (postureGeneration) {
			await controller.ensureSessionPrompt(agentRuntime);
			controller.logPromptCompileIfPending();
		}
		// A summary replaces the conversation the attestation described, so no
		// arithmetic carries it forward; the next call re-anchors it.
		reconciledAnchor = null;

		const postCompactSnapshot = captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
			compactionThreshold,
			snapshotMetadata,
		);
		currentContextSnapshot = postCompactSnapshot;
		persistContextSnapshot(preCompactSnapshot);
		persistContextSnapshot(postCompactSnapshot);

		const tokensBefore = footerTokensBefore;
		const tokensAfter = liveContextEstimate(agentRuntime, pendingUserText).tokens;
		lastCompactionEvent = {
			stage: "llm_summary",
			tokensBefore,
			tokensAfter,
			trigger,
		};
		deps.bus?.emit(
			"context.pruned",
			{
				stage: "llm_summary",
				tokensBefore,
				tokensAfter,
				trigger,
				snapshotIdBefore: preCompactSnapshot.snapshotId,
				snapshotIdAfter: postCompactSnapshot.snapshotId,
				at: Date.now(),
			} satisfies ContextPrunedPayload,
			sessionTelemetryContext(originSession),
		);
		// The reducer reports selected ledger rows, not just message rows.
		compactionFacts.push({ kind: "summarized", unit: "entries", count: result.messagesSummarized });
		compactionTokens = { before: tokensBefore, after: tokensAfter, basis: "runtime-estimate" };
		emitCompactionActivity("completed", "context compaction complete");
		autoCompactFailures = 0;
		noGainSummaryDigest = null;

		deps.emitNotice(
			renderCompactionSummaryLine({
				messagesSummarized: result.messagesSummarized,
				summaryChars: result.summary.length,
				tokensBefore,
				tokensAfter,
				isSplitTurn: result.isSplitTurn,
			}),
		);
		refreshLiveBudget(pendingUserText);
		return true;
	};

	let reductionInFlight: Promise<boolean> | null = null;
	const runAutoCompact: TurnContext["runAutoCompact"] = (...args) => {
		if (reductionInFlight) {
			if (args[7]) return Promise.reject(new Error("Another context reduction is already in progress."));
			return reductionInFlight;
		}
		const controller = new AbortController();
		compactionController = controller;
		const operationArgs: Parameters<TurnContext["runAutoCompact"]> = [...args];
		operationArgs[6] = args[6] ? AbortSignal.any([args[6], controller.signal]) : controller.signal;
		const operation = performAutoCompact(...operationArgs)
			.then(
				(changed) => {
					const outcome = changed || compactionFacts.length > 0 ? "completed" : "unchanged";
					compactionOperation?.finish(outcome, compactionConclusion, {
						facts: compactionFacts,
						...(compactionTokens ? { tokens: compactionTokens } : {}),
					});
					if (compactionLifecycleStarted)
						deps.bus?.emit("compaction.ended", { trigger: compactionLifecycleTrigger, at: Date.now(), outcome });
					return changed;
				},
				(error: unknown) => {
					const outcome =
						operationArgs[6]?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failed";
					compactionOperation?.finish(outcome, compactionFailureMessage(error), {
						facts: compactionFacts,
						...(compactionTokens ? { tokens: compactionTokens } : {}),
					});
					if (compactionLifecycleStarted)
						deps.bus?.emit("compaction.ended", { trigger: compactionLifecycleTrigger, at: Date.now(), outcome });
					throw error;
				},
			)
			.finally(() => {
				compactionOperation = null;
				compactionLifecycleStarted = false;
				if (compactionController === controller) compactionController = null;
			});
		reductionInFlight = operation;
		void operation
			.finally(() => {
				if (reductionInFlight === operation) reductionInFlight = null;
			})
			.catch(() => {});
		return operation;
	};

	const bindMemoryScope = () => {
		const sessionId = deps.session?.current()?.id;
		if (!sessionId) return null;
		const scope = { sessionId, branchAnchorTurnId };
		deps.memoryCommitBridge?.bindCommitScope(scope);
		return scope;
	};
	const notifyMemoryCommit: TurnContext["notifyMemoryCommit"] = (commitId, kind, outcome) => {
		const scope = bindMemoryScope();
		if (scope) {
			const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			const summary = entries.find(
				(entry) =>
					entry.kind === "compactionSummary" &&
					(entry.turnId === commitId || (kind === "continuity" && entry.continuity?.commit?.entry.turnId === commitId)),
			);
			deps.memoryCommitBridge?.notifyContextCommitted({
				...scope,
				commitId,
				kind,
				outcome,
				...(summary?.kind === "compactionSummary" && summary.memoryReceipt ? { memoryReceipt: summary.memoryReceipt } : {}),
			});
		}
	};
	const installMemoryRestoration: TurnContext["installMemoryRestoration"] = (runtime, pendingText) => {
		const bridge = deps.memoryCommitBridge;
		if (!bridge || !bindMemoryScope()) return false;
		const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
		const latest = [...entries]
			.reverse()
			.find((entry) => entry.kind === "continuityCommit" || entry.kind === "compactionSummary");
		const currentState =
			latest?.kind === "continuityCommit"
				? { kind: "handoff" as const, text: latest.continuity.accepted.note }
				: latest?.kind === "compactionSummary"
					? { kind: "summary" as const, text: latest.summary }
					: null;
		const view = refreshLiveBudget(pendingText);
		const available = Math.max(
			0,
			(view.effectiveWindow ?? 0) - (view.outputReserveTokens ?? 0) - (view.inputTokens ?? 0) - 64,
		);
		const offer = bridge.prepareRestoration(currentState, available);
		if (!offer) return false;
		if (!offer.message) {
			bridge.acknowledgeRestoration(offer);
			return false;
		}
		const message: AgentMessage = {
			role: "user",
			content: `<system-reminder>\n${offer.message}\n</system-reminder>`,
			timestamp: Date.now(),
		};
		const cost = estimateAgentMessageTokens(message);
		if (!requestFits((view.inputTokens ?? Infinity) + cost, view.outputReserveTokens, view.effectiveWindow)) return false;
		const prior = [...runtime.agent.state.messages];
		replaceEngineMessages(runtime.agent, [...prior, message]);
		if (!bridge.acknowledgeRestoration(offer)) {
			replaceEngineMessages(runtime.agent, prior);
			return false;
		}
		refreshLiveBudget(pendingText);
		return true;
	};

	const toolResultTail = (agentRuntime: AgentRuntime): boolean => {
		const messages = agentRuntime.agent.state.messages.filter(
			(message) => message.role !== "system" || isHostPolicyMessage(message),
		);
		const tail = messages[messages.length - 1] as AgentMessage | undefined;
		return !!tail && typeof tail === "object" && tail !== null && "role" in tail && tail.role === "toolResult";
	};

	const continuationContextUpdate = (agentRuntime: AgentRuntime) => ({
		context: {
			messages: [...agentRuntime.agent.state.messages],
			tools: [...agentRuntime.agent.state.tools],
		},
		model: agentRuntime.agent.state.model,
		thinkingLevel: agentRuntime.agent.state.thinkingLevel,
	});

	const resolveProviderReplay = async (
		runtime: AgentRuntime,
		reason: string,
		pendingUserText?: string,
		pendingIsOperator = true,
	): Promise<void> => {
		const origin = deps.session?.current()?.id;
		const navigation = navigationEpoch;
		const signal = deps.turnSignal?.();
		const active = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
		const checkpoint = [...active].reverse().find((entry) => entry.kind === "compactionSummary");
		if (checkpoint?.kind !== "compactionSummary" || !checkpoint.providerCheckpoint) {
			refreshAgentMessagesFromSession(runtime);
			return;
		}
		if (!providerFallbackDigests(active).has(checkpoint.providerCheckpoint.digest)) {
			let changed = false;
			let resolutionReason = reason;
			try {
				changed = await runAutoCompact(
					runtime,
					true,
					undefined,
					"force",
					pendingUserText,
					undefined,
					signal,
					undefined,
					pendingIsOperator,
					reason,
				);
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				resolutionReason = `${reason}:portable-summary-failed`;
				deps.emitNotice("Portable compaction failed; continuing from the original session history.");
			}
			if (signal?.aborted || origin !== deps.session?.current()?.id || navigation !== navigationEpoch)
				throw new DOMException("Replay ownership changed", "AbortError");
			if (!changed) {
				deps.session?.appendEntry({
					kind: "custom",
					parentTurnId: state.lastTurnId,
					customType: "clio_coder_provider_fallback",
					data: {
						version: 1,
						checkpointDigest: checkpoint.providerCheckpoint.digest,
						providerFallbackReason: resolutionReason,
					},
				});
				deps.session?.flushAppends?.();
			}
		}
		refreshAgentMessagesFromSession(runtime);
	};

	const controller: TurnContext = {
		thinkingUsesConfigurationUpdate: () => thinkingUsesConfigurationUpdate,
		notifyMemoryCommit,
		installMemoryRestoration,
		prepareMemoryTurn(runtime, input): void {
			const scope = bindMemoryScope();
			const observations = deps.memoryCommitBridge?.observations;
			if (scope && observations) {
				const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
				// Only committed receipts matter here; the source units are memory's to build when it needs them.
				const commits = entries.flatMap((entry) =>
					entry.kind === "compactionSummary" &&
					entry.memoryReceipt &&
					(entry.continuity?.commit?.summaryRef !== entry.turnId ||
						entries.some(
							(candidate) =>
								candidate.kind === "continuityCommit" && candidate.turnId === entry.continuity?.commit?.entry.turnId,
						))
						? [{ commitId: entry.turnId, receipt: entry.memoryReceipt }]
						: [],
				);
				if (commits.length > 0) observations.recoverConsumption(scope, commits);
			}
			pendingUserImages = [...(input.images ?? [])];
			if (input.continuation && memoryTurn !== null) return;
			// A prewarm has not chosen the first operator turn's memory. Freeze
			// only after preparation has loaded that turn's evidence. Sessionless
			// loops retain their submitted turns in engine history instead (#423).
			if (
				!input.continuation &&
				state.lastTurnId === null &&
				!runtime.agent.state.messages.some((message) => message.role === "user") &&
				!(deps.readSessionEntries?.() ?? []).some((entry) => entry.kind === "message" && entry.role === "user")
			) {
				frozenMemorySection = null;
				sessionPromptKey = null;
				if (!postureGenerationPersisted) postureGeneration = null;
			}
			const sessionId = deps.session?.current()?.id ?? null;
			memoryTurnSequence += 1;
			memoryTurn = {
				id: String(memoryTurnSequence),
				sessionId,
				sessionAuthority: JSON.stringify([memoryAuthorityEpoch, sessionId ?? `pending:${memoryTurnSequence}`]),
				origin: memoryOrigin(runtime),
				taskText: input.taskText,
				activePaths: Object.freeze([...sessionWorkingContextPaths]),
			};
		},

		commitMemoryTurn(runtime): void {
			syncCodexConfiguration(runtime);
			pendingUserImages = [];
			// appendSubmittedUserTurn creates the first session synchronously.
			// Only that null -> bound transition with unchanged origin can alias
			// its prepared authority; navigation never uses this exception.
			if (memoryTurn?.sessionId === null && memoryTurn.origin === memoryOrigin(runtime)) {
				memoryTurn.sessionId = deps.session?.current()?.id ?? null;
			}
		},

		captureRuntimeContextSnapshot,
		persistContextSnapshot,
		liveContextEstimate,
		refreshLiveBudget,
		refreshAgentMessagesFromSession,
		runAutoCompact,
		lastCompactionWasNoGain: () => lastCompactionNoGain,
		navigationRevision: () => navigationEpoch,
		cancelCompaction: () => compactionController?.abort(),

		liveBudget: (): LiveBudgetView => budgetProducer.current() ?? refreshLiveBudget(),
		inspectLiveBudget(): BudgetInspection {
			const targetId = deps.getSettings().chat?.target;
			const target = !state.runtime && targetId ? deps.providers.getTarget(targetId) : null;
			const runtime =
				state.runtime?.runtimeResolution.runtime ?? (target ? deps.providers.getRuntime(target.runtime) : null);
			if (runtime && (!isOrchestratorEligibleRuntime(runtime) || runtime.externalAgentLoop))
				return {
					status: "unsupported",
					reason: "The external agent owns its context; native request accounting is unavailable.",
				};
			if (!runtime)
				return {
					status: "unavailable",
					reason: "No native runtime descriptor is resolved. Inspection does not initialize a runtime.",
				};
			return { status: "available", capability: "native", view: refreshLiveBudget() };
		},

		setCurrentSnapshot(snapshot: ContextSnapshot): void {
			currentContextSnapshot = snapshot;
			refreshLiveBudget(snapshot.pendingUserInput);
		},

		flushReconciledSnapshot(): void {
			if (snapshotPersistPending && currentContextSnapshot) persistContextSnapshot(currentContextSnapshot);
			// Run settlement. Its callers are `agent_end` and submit's finally, so
			// this is where the finished run's accounting is published, not the
			// mid-run tool-batch boundary; that one is `postToolContinuationGuard`.
			refreshLiveBudget();
		},

		reconcileUsage(usage: Usage, call?: { callId: string; attemptId: string }): void {
			// Cached prompt tokens still occupy the window; providers report them
			// outside `input`, so the attested prompt is the three summed.
			const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			const runtime = state.runtime;
			const history = runtime
				? createMessageListDigests(
						runtime.agent.state.messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
					)
				: undefined;
			if (promptTokens > 0 && runtime) {
				const breakdown = estimateAgentContextBreakdown({ ...runtime.agent.state, messages: [] });
				const anchoredMessages = [...(history?.messages ?? [])];
				// The output of this call is part of the next call's prompt for the
				// same messages, which is why it is folded in here.
				reconciledAnchor = {
					tokens: promptTokens + (usage.output || 0),
					anchoredMessages,
					contentDigest: history?.digest() ?? messageListDigest(anchoredMessages),
					runtime,
					model: runtime.agent.state.model,
					modelKey: anchorModelKey(runtime),
					targetId: runtime.targetId,
					runtimeId: runtime.runtimeId,
					wireModelId: runtime.wireModelId,
					systemPromptTokens: breakdown.systemPromptTokens,
					toolSchemaTokens: breakdown.toolSchemaTokens,
				};
			}
			if (!currentContextSnapshot) {
				// The anchor still moved, and it is what the next request budgets
				// against, so the view is republished with or without a snapshot.
				refreshLiveBudget(undefined, history);
				return;
			}
			// Reconcile in memory on every API call so the live meters
			// track usage; persistence waits for the run to settle.
			if (runtime) {
				const messages = runtime.agent.state.messages.filter(
					(message) => message.role !== "system" || isHostPolicyMessage(message),
				);
				// The just-completed response is output, not part of its own prompt.
				const promptMessages = messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages;
				currentContextSnapshot = captureRuntimeContextSnapshot(
					runtime,
					currentContextSnapshot.turnId,
					deps.getSettings().context.compaction?.threshold ?? null,
					{
						conversationMessages: promptMessages,
						promptSegments: currentContextSnapshot.promptSegments,
						promptHash: currentContextSnapshot.promptHash,
						toolSignature: currentContextSnapshot.toolSignature,
					},
				);
			}
			currentContextSnapshot = {
				...reconcileSnapshot(currentContextSnapshot, usage),
				callId: call?.callId,
				attemptId: call?.attemptId,
			};
			snapshotPersistPending = true;
			// A reconcile moves the anchor and therefore the figure the next
			// request budgets against, so it is a publication point of its own.
			refreshLiveBudget(undefined, history);
		},

		promptSideTokens(): number {
			return currentContextSnapshot ? snapshotInputTokens(currentContextSnapshot) : 0;
		},

		/**
		 * Ensure the session system prompt is compiled and applied to the live
		 * agent. Compiles only when the canonical live-input identity changes
		 * or a config hot-reload invalidated compiler-owned inputs in the
		 * cache; every other submit reuses the cached prompt byte-for-byte. A
		 * compile whose text differs from the previous prompt queues a
		 * "promptRecompiled" ledger entry (written once the session exists).
		 */
		async ensureSessionPrompt(
			agentRuntime: AgentRuntime,
			beforeSend = false,
			pendingUserText?: string,
			skipProviderFallback = false,
		): Promise<CompiledSessionPrompt | null> {
			const signal = deps.turnSignal?.();
			const originNavigation = navigationEpoch;
			const originSession = deps.session?.current()?.id;
			bindProviderCompaction(agentRuntime);
			const current = (): boolean =>
				!disposed &&
				!signal?.aborted &&
				originNavigation === navigationEpoch &&
				originSession === deps.session?.current()?.id;
			if (!current()) return null;
			// A route switch materializes portable context only when it is first needed (#423).
			const active = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			const checkpoint = [...active].reverse().find((entry) => entry.kind === "compactionSummary");
			if (
				!skipProviderFallback &&
				checkpoint?.kind === "compactionSummary" &&
				checkpoint.providerCheckpoint &&
				!providerFallbackDigests(active).has(checkpoint.providerCheckpoint.digest)
			) {
				const key =
					agentRuntime.runtimeId === "openai-codex"
						? await agentRuntime.agent.getApiKey?.(agentRuntime.agent.state.model.provider)
						: undefined;
				const reason =
					deps.getSettings().context.compaction.provider !== "native"
						? "setting-off"
						: providerCheckpointCompatibility(checkpoint.providerCheckpoint, agentRuntime.agent.state.model, key);
				if (!current()) return null;
				if (reason !== null) {
					await resolveProviderReplay(agentRuntime, reason, pendingUserText, beforeSend);
					if (!current()) return null;
				}
			}
			if (!deps.prompts) return null;
			const settings = deps.getSettings();
			const autonomy = deps.getAutonomy?.() ?? settings.safety.autonomy ?? "default";
			const sessionId = deps.session?.current()?.id ?? "";
			const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			const checkpointId = postureCheckpoint(entries);
			// #423: a posture update is a later system message, which Pi folds into the leading instructions for a
			// model without this compat flag (collapseSystemMessages), so it would rewrite the prefix anyway; such a
			// route recompiles instead. gpt-5.3-codex-spark has no row in Pi's openai-codex catalog and so no flag;
			// measured 2026-10-30, the ChatGPT Codex backend refuses the model outright ("not supported when using
			// Codex with a ChatGPT account"), so nothing vouches for mid-conversation developer items there.
			const supportsPolicyUpdates =
				deps.prompts.renderSessionPostureUpdate !== undefined &&
				(agentRuntime.agent.state.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
					?.supportsMidConvoSystemMessages === true;
			const routeKey = createHash("sha256")
				.update(
					JSON.stringify([
						agentRuntime.targetId,
						agentRuntime.runtimeId,
						agentRuntime.wireModelId,
						attachedToolSchemasFromState(agentRuntime.agent.state.tools),
					]),
				)
				.digest("hex");
			if (
				postureGeneration &&
				(postureGeneration.checkpointId !== checkpointId || postureGeneration.routeKey !== routeKey)
			) {
				postureGeneration = null;
				postureGenerationPersisted = false;
				sessionPromptKey = null;
			}
			if (!supportsPolicyUpdates) {
				postureGeneration = null;
				pendingPosture = null;
				if (agentRuntime.agent.state.messages.some(isHostPolicyMessage))
					replaceEngineMessages(
						agentRuntime.agent,
						agentRuntime.agent.state.messages.filter((message) => !isHostPolicyMessage(message)),
					);
			}
			const recordedGeneration = supportsPolicyUpdates ? readPostureGeneration(entries) : null;
			const restoringGeneration = !postureGeneration && recordedGeneration?.routeKey === routeKey;
			if (restoringGeneration) {
				postureGeneration = recordedGeneration;
				postureGenerationPersisted = true;
				frozenMemorySection = recordedGeneration.memorySection;
				frozenMemorySessionId = sessionId;
			}
			const compiledAutonomy = supportsPolicyUpdates ? (postureGeneration?.compiledAutonomy ?? autonomy) : autonomy;
			const cwd = process.cwd();
			const modelState = agentRuntime.agent.state.model as
				| (typeof agentRuntime.agent.state.model & { clioCoder?: { quirks?: LocalModelQuirks } })
				| undefined;
			// `Context window: N` is the window the backend will actually serve
			// this session, taken from the resolution the turn already ran rather
			// than from the model descriptor's copy of it (issue #249). The
			// ranking that puts a loaded figure ahead of a probed one lives in
			// `resolveContextWindowDetails`, which tests `loadedContextWindow`
			// first and only then `probedContextWindow`, so `effectiveContextWindow`
			// already is the loaded window whenever one is known and the source
			// already reads "loaded"; brief #227's carry-forward is what puts that
			// figure in reach on a resume. The source rides into the prompt
			// manifest, so a recompile after the loaded window is first observed
			// is explained by the record.
			const windowDetails = agentRuntime.runtimeResolution.contextWindowDetails;
			const resolvedWindow = windowDetails.effectiveContextWindow;
			const contextWindow = typeof resolvedWindow === "number" && resolvedWindow > 0 ? resolvedWindow : null;
			const contextWindowSource: ContextWindowSource | null =
				contextWindow === null ? null : windowDetails.contextWindowSource;
			const guidance = modelState?.clioCoder?.quirks?.thinking?.guidance;
			const toolNames = toolNamesFromAgentState(agentRuntime.agent.state.tools);
			const attachedToolSchemas = attachedToolSchemasFromState(agentRuntime.agent.state.tools);
			const builtinTools =
				deps.toolRegistry
					?.listAll()
					.filter((spec) => isBuiltinToolName(spec.name) && spec.metadata?.startupPrompt !== false) ?? [];
			const toolDiscoveryHints = builtinTools
				.flatMap((spec) => {
					const hint = spec.metadata?.discoveryHint;
					if (!hint) return [];
					const starterArgs = capabilityStarterArgs(spec);
					return [{ tool: spec.name, hint, ...(starterArgs ? { starterArgs } : {}) }];
				})
				.sort((a, b) => a.tool.localeCompare(b.tool));
			// Every builtin's registry objective, grouped by plane in the pinned map.
			// The compiler filters it to what this surface reaches.
			const capabilityMap = builtinTools.flatMap((spec) => {
				const plane = isBuiltinToolName(spec.name) ? TOOL_PLANES[spec.name]?.plane : undefined;
				return plane === undefined
					? []
					: [
							{
								tool: spec.name,
								objective: spec.metadata?.objective ?? "",
								plane,
								argumentShape: capabilityArgumentShape(spec, 1),
							},
						];
			});
			// Only the bound session ceiling shapes compiled guidance; prompt and
			// template scope arrives in the current turn reminder (#423).
			const standingConstraints = deps.standingTurnConstraints?.();
			const routeIdentity = JSON.stringify([agentRuntime.targetId, agentRuntime.runtimeId, agentRuntime.wireModelId]);
			if (frozenRouteIdentity !== routeIdentity || (frozenMemorySessionId !== "" && frozenMemorySessionId !== sessionId)) {
				frozenRouteSources = undefined;
			}
			// A thinking-only override must not rewrite the cached Routes line (#423).
			frozenRouteSources ??= deps.getRouteSources?.();
			frozenRouteIdentity = routeIdentity;
			const sessionInputs: SessionPromptInputs = {
				...(standingConstraints ? { turnConstraints: standingConstraints } : {}),
				...(deps.getReadySkillCount ? { readySkillCount: deps.getReadySkillCount() } : {}),
				demo: deps.interactiveGuidance === true && settings.interface.demo,
				provider: agentRuntime.targetId,
				model: agentRuntime.wireModelId,
				...(frozenRouteSources ? { routeSources: frozenRouteSources } : {}),
				contextWindow,
				providerSupportsTools: runtimeSupportsTools(agentRuntime),
				semanticSearchAvailable: semanticUsable(settings.context.semantic),
				toolNames,
				// Builtin presence gates prompt guidance. Learning an MCP schema
				// mid-turn changes discovery results, not the immutable prefix.
				coordinatorCapabilities: builtinTools.map((spec) => spec.name).sort(),
				...(toolDiscoveryHints.length > 0 ? { toolDiscoveryHints } : {}),
				...(capabilityMap.length > 0 ? { capabilityMap } : {}),
				...(guidance ? { thinkingGuidance: guidance } : {}),
				...(deps.toolRegistry?.get(ToolNames.ConfigureClio) ? { canConfigureClio: true } : {}),
				...(deps.headless === true ? { headless: true } : {}),
				...(deps.liveSteering === false ? { liveSteering: false } : {}),
				...(deps.interactiveGuidance === true || deps.operatorInterviews === true ? { operatorInterviews: true } : {}),
			};
			if (deps.getMemorySection) {
				try {
					if (memoryTurn !== null && memoryTurn.sessionId !== (sessionId || null)) {
						memoryAuthorityEpoch += 1;
						memoryTurn = null;
					}
					const memoryRequest: MemoryPromptRequest = {
						turnId: memoryTurn?.id ?? null,
						sessionAuthority: memoryTurn?.sessionAuthority ?? JSON.stringify([memoryAuthorityEpoch, sessionId]),
						cwd,
						targetId: agentRuntime.targetId,
						runtimeId: agentRuntime.runtimeId,
						modelId: agentRuntime.wireModelId,
						taskText: memoryTurn?.taskText ?? "",
						activePaths: memoryTurn?.activePaths ?? [],
					};
					// The scores rank the records; they never admit one. Every
					// eligibility gate still runs inside the selection below.
					let relevance: PrecomputedRanking | undefined;
					try {
						relevance = await deps.getMemoryRelevance?.(memoryRequest);
					} catch {
						// A ranking that cannot be produced leaves memory in its base order.
						relevance = undefined;
					}
					if (!current()) return null;
					const memorySection = deps.getMemorySection({
						...memoryRequest,
						...(relevance === undefined ? {} : { precomputedRelevance: relevance }),
					});
					if (memorySection.length > 0) sessionInputs.memorySection = memorySection;
				} catch (err) {
					deps.emitNotice(
						`[Clio Coder] memory load failed; continuing without memory injection: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			sessionInputs.contextOperationUpdate = contextOperationAwareness(deps.readSessionEntries?.() ?? [], sessionId, cwd);
			// #423: the memory section this session's prompt was compiled with stays
			// put. A record approved later reaches the model as a reminder on the
			// next turn; recompiling for it re-billed the whole conversation.
			const liveMemorySection = sessionInputs.memorySection ?? "";
			// A first compile runs before its session exists; the session created
			// next inherits that freeze, any other session starts its own.
			if (frozenMemorySessionId === "") frozenMemorySessionId = sessionId;
			else if (frozenMemorySessionId !== sessionId) frozenMemorySection = null;
			const frozenMemory = frozenMemorySection ?? liveMemorySection;
			const withMemory = (section: string): SessionPromptInputs => {
				const inputs = { ...sessionInputs };
				delete inputs.memorySection;
				return section.length > 0 ? { ...inputs, memorySection: section } : inputs;
			};
			const prompts = deps.prompts;
			const promptInputEpoch = prompts.inputEpoch();
			const promptKey = (inputs: SessionPromptInputs): string =>
				mainPromptCacheIdentity({
					targetId: agentRuntime.targetId,
					runtimeId: agentRuntime.runtimeId,
					wireModelId: agentRuntime.wireModelId,
					autonomy: compiledAutonomy,
					sessionId,
					cwd,
					workingContextPaths: [...sessionWorkingContextPaths],
					contextWindowSource,
					promptInputEpoch,
					sessionInputs: inputs,
					attachedToolSchemas,
				});
			const memoryDelta = (compiled: string): string => {
				const framed = hostFramedTexts(agentRuntime.agent.state.messages);
				const ids = [
					...new Set(
						[compiled, ...framed.filter((text) => text.includes("# Memory update"))].flatMap((section) =>
							memorySectionBlocks(section).map((block) => block.id),
						),
					),
				];
				const statuses = ids.length > 0 ? deps.getMemoryRecordStatuses?.(ids) : undefined;
				return memorySectionDelta(compiled, liveMemorySection, framed, statuses);
			};
			const frozenInputs = withMemory(frozenMemory);
			const key = promptKey(frozenInputs);
			// #423: compare the already-resolved key before compiling; this query makes no provider call.
			// A new session's first compile keys on an empty session id, so its
			// second turn changes key with identical bytes; the recompile reason
			// waits for the compile to show whether the prompt moved.
			let noteCacheReuse: ((recompiled: boolean) => void) | undefined;
			if (beforeSend) {
				loadCacheCallBaseline();
				if (cacheCallBaseline) {
					const { endedAt, inclusiveInputTokens } = cacheCallBaseline;
					const elapsedMs = Math.max(0, Date.now() - endedAt);
					const idleStamp = JSON.stringify([navigationEpoch, sessionId, endedAt]);
					const recompileStamp = JSON.stringify([navigationEpoch, sessionId, endedAt, key]);
					const idle = elapsedMs >= CACHE_REUSE_IDLE_NOTICE_MS && idleReuseNoticeStamp !== idleStamp;
					// #423: a resumed process has no prior key to compare; unknown is not changed.
					const pendingRecompile =
						sessionPromptKey !== null && sessionPromptKey !== key && recompileReuseNoticeStamp !== recompileStamp;
					if (idle || pendingRecompile) {
						noteCacheReuse = (recompiled) => {
							const recompile = pendingRecompile && recompiled;
							if (!idle && !recompile) return;
							if (idle) idleReuseNoticeStamp = idleStamp;
							if (recompile) recompileReuseNoticeStamp = recompileStamp;
							const elapsed = elapsedMs < 60_000 ? `${Math.floor(elapsedMs / 1000)}s` : `${Math.floor(elapsedMs / 60_000)}m`;
							const reason = [idle ? "idle" : "", recompile ? "prompt recompile pending" : ""].filter(Boolean).join(", ");
							const text = `reuse uncertain: last use ${elapsed} ago; estimated re-prefill ${inclusiveInputTokens.toLocaleString("en-US")} tokens (previous call input; ${reason})`;
							if (deps.emitCacheReuseNotice) deps.emitCacheReuseNotice(text);
							else deps.emitNotice(text);
						};
					}
				}
			}
			const preparePosture = (): void => {
				pendingPosture =
					supportsPolicyUpdates && postureGeneration
						? { inputs: sessionInputs, effectiveAutonomy: effectivePosture(entries, postureGeneration), rendered: new Map() }
						: null;
			};
			if (sessionPrompt && !sessionPromptInvalidated && sessionPromptKey === key) {
				lastSystemPromptReused = true;
				sessionPromptDelta = memoryDelta(frozenMemory);
				preparePosture();
				noteCacheReuse?.(false);
				return sessionPrompt;
			}
			try {
				const sessionStartedAt = deps.session?.current()?.createdAt;
				const compileWith = (inputs: SessionPromptInputs) =>
					prompts.compileSessionPrompt({
						sessionId,
						sessionInputs: inputs,
						autonomy: compiledAutonomy,
						cwd,
						workingContextPaths: [...sessionWorkingContextPaths],
						...(sessionStartedAt ? { sessionStartedAt } : {}),
					});
				let result = await compileWith(frozenInputs);
				let compiledKey = promptKey(frozenInputs);
				let compiledMemory = frozenMemory;
				const previousHash = postureGeneration?.promptHash ?? sessionPromptHash ?? lastRecordedPromptHash();
				// A prompt that changes for another reason is cold already, so it
				// takes the live memory instead of carrying a reminder for it.
				if (previousHash !== null && result.systemPromptHash !== previousHash && frozenMemory !== liveMemorySection) {
					if (!current()) return null;
					const liveInputs = withMemory(liveMemorySection);
					result = await compileWith(liveInputs);
					compiledKey = promptKey(liveInputs);
					compiledMemory = liveMemorySection;
				}
				if (!current()) return null;
				const compiledAt = new Date().toISOString();
				const changed = engineInitialSystemPrompt(agentRuntime.agent) !== result.systemPrompt;
				noteCacheReuse?.(changed);
				if (supportsPolicyUpdates && (!postureGeneration || result.systemPromptHash !== postureGeneration.promptHash)) {
					postureGeneration = {
						version: 1,
						origin: "host",
						id: randomUUID(),
						checkpointId,
						routeKey,
						compiledAutonomy,
						memorySection: compiledMemory,
						promptHash: result.systemPromptHash,
					};
					postureGenerationPersisted = false;
					replaceEngineMessages(
						agentRuntime.agent,
						agentRuntime.agent.state.messages.filter((message) => !isHostPolicyMessage(message)),
					);
				}
				setEngineSystemPrompt(agentRuntime.agent, result.systemPrompt, result.pinnedPrefix);
				if (changed) {
					pendingPromptLogEntry = latestPromptCompile = {
						version: PROMPT_MANIFEST_VERSION,
						at: compiledAt,
						previousHash,
						systemPromptHash: result.systemPromptHash,
						tokenEstimate: result.tokenEstimate,
						thinkingLevel: agentRuntime.agent.state.thinkingLevel ?? null,
						contextWindow,
						contextWindowSource,
						projectPreload: result.projectPreload ?? null,
						sections: result.sections.map((s) => ({
							id: s.id,
							tokenEstimate: s.tokenEstimate,
							...(s.contentHash === undefined ? {} : { contentHash: s.contentHash }),
						})),
						fragments: result.fragmentManifest.map((f) => ({
							id: f.id,
							relPath: f.relPath,
							contentHash: f.contentHash,
							dynamic: f.dynamic,
						})),
					};
				}
				lastSystemPromptReused = !changed;
				const preload = result.projectPreload;
				if (preload?.mode === "partial" && !deps.headless && !deps.interactiveGuidance) {
					// A provisional first compile belongs to the id created after it.
					if (announcedProjectPreloadSession === "" && sessionId) announcedProjectPreloadSession = sessionId;
					if (announcedProjectPreloadSession !== sessionId) {
						announcedProjectPreloadSession = sessionId;
						deps.emitNotice(`Project instructions: ${preload.label}`);
					}
				}

				sessionPrompt = result;
				sessionPromptHash = result.systemPromptHash;
				sessionPromptKey = compiledKey;
				sessionPromptInvalidated = false;
				frozenMemorySection = compiledMemory;
				frozenMemorySessionId = sessionId;
				sessionPromptDelta = memoryDelta(compiledMemory);
				preparePosture();
				return result;
			} catch (err) {
				if (!current()) return null;
				// The engine keeps the prompt it already had.
				noteCacheReuse?.(false);
				deps.emitNotice(
					`[Clio Coder] prompt compile failed; using fallback identity: ${err instanceof Error ? err.message : String(err)}`,
				);
				return null;
			}
		},

		commitSessionPosture(agentRuntime, userTurnId): void {
			const pending = pendingPosture;
			pendingPosture = null;
			if (!pending || !postureGeneration || !deps.session?.current() || !deps.prompts?.renderSessionPostureUpdate) return;
			const autonomy = deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy ?? "default";
			const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], userTurnId);
			if (effectivePosture(entries, postureGeneration) === autonomy) return;
			const text = deps.prompts.renderSessionPostureUpdate(autonomy, pending.inputs);
			const entry = deps.session.appendEntry({
				kind: "custom",
				customType: POSTURE_UPDATE,
				parentTurnId: userTurnId,
				data: { version: 1, origin: "host", generationId: postureGeneration.id, userTurnId, autonomy, text },
			});
			deps.session.flushAppends?.();
			appendEnginePolicyMessage(agentRuntime.agent, entry.turnId, text, Date.parse(entry.timestamp));
		},

		/**
		 * Write the queued prompt-compile ledger entry and its full manifest
		 * record. The journal captures the structure when the request cites it (#434).
		 * Deferred until after the user turn is appended so the session exists.
		 */
		logPromptCompileIfPending(): void {
			const currentMeta = deps.session?.current();
			if (currentMeta && postureGeneration && !postureGenerationPersisted) {
				deps.session?.appendEntry({
					kind: "custom",
					customType: POSTURE_GENERATION,
					parentTurnId: state.lastTurnId,
					data: postureGeneration,
				});
				deps.session?.flushAppends?.();
				postureGenerationPersisted = true;
			}
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
				// A resumed process names the session's last recorded hash as previousHash (#249), so
				// the stamp requires the hash to have moved, not merely to have a predecessor.
				if (entry.previousHash !== null && entry.previousHash !== entry.systemPromptHash) {
					noteColdReason("prompt_recompiled");
					if (previousPromptSections) {
						nextChangedSection ??= firstChangedSection(previousPromptSections, entry.sections);
					}
				}
			} catch {
				// Ledger logging is diagnostics, not control flow; never abort a turn.
			}
			previousPromptSections = entry.sections;
		},

		compiledSessionPrompt: () => sessionPrompt,
		promptCompileRecord: () => latestPromptCompile,
		sessionPromptDelta(): string {
			return sessionPromptDelta;
		},

		invalidateSessionPromptCache(): void {
			// #423: retain the known key for the dry comparison while forcing a fresh compile.
			sessionPromptInvalidated = true;
		},

		addWorkingContextPaths(paths: ReadonlyArray<string>): void {
			for (const path of paths) sessionWorkingContextPaths.add(path);
		},

		async postToolContinuationGuard(agentRuntime: AgentRuntime, signal?: AbortSignal, contextChanged = false) {
			if (signal?.aborted || (!contextChanged && !toolResultTail(agentRuntime))) return undefined;
			// A background reminder has its own middleware receipt, not a user
			// ledger turn. Preserve its newly appended context tail if compaction
			// rebuilds messages from the ledger, and count it in both estimates.
			const reminder = contextChanged ? agentRuntime.agent.state.messages.at(-1) : undefined;
			// The tool batch appended results the last publication predates, and the
			// guard is about to decide on them. Publish before that inspection, not
			// after it.
			const beforeView = refreshLiveBudget();
			const before = liveContextEstimate(agentRuntime);
			const settings = deps.getSettings();
			const economic = compactionBudget(
				before.contextWindow,
				settings.context.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
				settings.context.compaction?.maxTokens,
				agentRuntime.agent.state.model,
			);
			const knownWindow = before.contextWindow > 0;
			const verdict = shouldCompact(before.tokens, economic.threshold, economic.triggerWindow);
			let compacted = false;
			const mustFit =
				knownWindow && !requestFits(beforeView.inputTokens, beforeView.outputReserveTokens, beforeView.effectiveWindow);
			if (mustFit || verdict.shouldCompact) {
				try {
					compacted = await runAutoCompact(
						agentRuntime,
						mustFit,
						undefined,
						mustFit ? "overflow" : "auto",
						undefined,
						undefined,
						signal,
					);
				} catch (err) {
					throw new Error(
						`[Clio Coder] post-tool context guard could not compact before continuation: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			if (reminder && !agentRuntime.agent.state.messages.includes(reminder)) {
				agentRuntime.agent.state.messages.push(reminder);
			}
			// The mid-run settled tool-batch boundary: whatever the guard did or
			// declined to do, this is the context the continuation will send.
			const afterView = refreshLiveBudget();
			if (knownWindow && !requestFits(afterView.inputTokens, afterView.outputReserveTokens, afterView.effectiveWindow)) {
				throw new Error(
					`[Clio Coder] post-tool context guard stopped continuation before provider call: estimated input ${afterView.inputTokens} plus reserved output ${afterView.outputReserveTokens} tokens does not fit context window ${afterView.effectiveWindow}. Use /context compact, narrower reads, or a follow-up turn with smaller observations.`,
				);
			}
			return compacted ? continuationContextUpdate(agentRuntime) : undefined;
		},

		contextUsage(): LiveContextUsage {
			// Footer reads project the last publication. They never rescan the
			// ledger or add streaming output to the next-request message estimate.
			const view = budgetProducer.current() ?? refreshLiveBudget();
			// Occupancy includes the active response. Admission still reads the
			// published next-request input, so generated output is not charged a
			// second time when it becomes settled history.
			const tokens =
				view.inputTokens === null ? null : view.inputTokens + (state.streaming ? liveStreamingOutputTokens() : 0);
			return {
				...contextUsageSnapshot(tokens, view.effectiveWindow, view.breakdown ?? undefined),
				revision: view.revision,
				inputSource: view.inputSource,
				historical: view.historical,
				breakdownSource: view.breakdownSource,
			};
		},

		contextLedger(): ContextLedger {
			const settings = deps.getSettings();
			// Without a runtime (before the first turn of this process, /resume
			// included) the window comes from the live resolution or the resumed
			// snapshot, and the token facts from the snapshot: the resumed
			// messages are the ones it measured.
			const window = state.runtime
				? {
						contextWindow: state.runtime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
						contextWindowSource: state.runtime.runtimeResolution.contextWindowDetails.contextWindowSource,
						contextWindowSlots: state.runtime.runtimeResolution.contextWindowDetails.contextWindowSlots,
					}
				: windowWithoutRuntime();
			const compactionThreshold = window.contextWindow > 0 ? (settings.context.compaction?.threshold ?? null) : null;
			const compactionAuto = settings.context.compaction?.auto !== false;
			const economic = compactionBudget(
				window.contextWindow,
				compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
				settings.context.compaction.maxTokens,
				state.runtime?.agent.state.model ??
					getCatalogModelForRuntime(
						state.runtime?.runtimeId ??
							currentContextSnapshot?.runtimeId ??
							settings.targets.find((target) => target.id === settings.chat.target)?.runtime ??
							"",
						state.runtime?.wireModelId ?? settings.chat.model ?? "",
					),
			);
			const compactionCeilingTokens = economic.ceilingTokens;
			const provider = state.runtime?.targetId ?? settings.chat?.target ?? null;
			const model = state.runtime?.wireModelId ?? settings.chat?.model ?? null;
			const liveToolCount = state.runtime?.agent.state.tools.length ?? 0;

			if (!currentContextSnapshot) {
				return buildContextLedger({
					provider,
					model,
					...window,
					toolCount: liveToolCount,
					compactionThreshold: compactionThreshold === null ? null : economic.threshold,
					compactionCeilingTokens,
					compactionAuto,
					promptCache: lastPromptCache,
					prewarm: lastPrewarm,
				});
			}

			const streamingOutput = liveStreamingOutputTokens();
			const pendingTokens = pendingUserInputTokens();
			const totalUsed = snapshotInputTokens(currentContextSnapshot) + pendingTokens + streamingOutput;
			const measured = currentContextSnapshot.sources.total === "reconciled";

			return buildContextLedger({
				provider,
				model,
				...window,
				compactionThreshold: compactionThreshold === null ? null : economic.threshold,
				compactionCeilingTokens,
				compactionAuto,
				systemPromptTokens: currentContextSnapshot.categories.system,
				toolSchemaTokens: currentContextSnapshot.categories.tools,
				// Persisted snapshots strip the captured schemas; fall back to
				// the live agent state after a session resume.
				toolCount: currentContextSnapshot.activeToolSchemas?.length ?? liveToolCount,
				messageTokens: currentContextSnapshot.categories.messages,
				toolResultTokens: currentContextSnapshot.categories.toolResults ?? 0,
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
				prewarm: lastPrewarm,
			});
		},

		emitContextWindowWarningTransition(warning: string | null): void {
			if (warning === lastContextWindowWarning) return;
			lastContextWindowWarning = warning;
			deps.bus?.emit(
				"context.warning_raised",
				{ warning } satisfies ContextWarningPayload,
				sessionTelemetryContext(deps.session?.current()?.id),
			);
		},

		noteColdReason,

		noteNextRunColdReason(reason): void {
			pendingColdReasons.add(reason);
		},

		consumeExpectedColdReasons(runtimeId: string): void {
			// Cache-disturbance honesty (T3.3): consume disturbances since
			// the last settled run. Only single-slot local backends lose their
			// prefix cache to interleaved work, so residency, dispatch, and
			// compaction stamp only on local-native targets. Prefix-byte and
			// reasoning changes stamp every tier (#423; see stampsOnTier).
			runExpectedColdReasons = [];
			nextAssistantColdReasons = [];
			if (pendingColdReasons.size > 0) {
				const reasons = [...pendingColdReasons].filter((reason) => stampsOnTier(reason, runtimeId));
				pendingColdReasons.clear();
				if (reasons.length > 0) {
					runExpectedColdReasons = reasons;
					nextAssistantColdReasons = reasons;
					callColdReasons = [...new Set([...callColdReasons, ...reasons])];
					noteExpectedCold(reasons);
				}
			}
		},

		takeCallColdReasons(): ExpectedColdReason[] {
			const reasons = callColdReasons;
			callColdReasons = [];
			return reasons;
		},

		cacheGeneration: () => cacheGeneration,

		noteCacheRequestToolChoice(toolChoice, afterRejection = false): void {
			cacheRequestToolChoice = toolChoice;
			const route = JSON.stringify([state.runtime?.targetId, state.runtime?.wireModelId]);
			const previous = afterRejection ? priorSentToolChoice : sentToolChoice;
			if (previous?.route === route && previous.toolChoice !== toolChoice) noteColdReason("tool_choice_change");
			if (!afterRejection) priorSentToolChoice = sentToolChoice;
			sentToolChoice = { route, toolChoice };
		},

		promptCachePayloadForAssistant(
			usage: Usage,
			backend?: BackendCompletionTimings,
			anthropicResponse?: AnthropicResponseObservation,
			transport?: CodexTransportObservation,
		): Record<string, unknown> {
			// Per-call prompt-cache record (T3.2) keeps normalized provider usage
			// beside any timings captured from the server response. The run's first
			// persisted call also carries any expected-cold reasons.
			const input = typeof usage.input === "number" ? usage.input : 0;
			const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
			const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
			loadCacheCallBaseline();
			// #423: fingerprint only truncations verified against their durable operator text.
			// A later fresh connection with the same replayed bytes is not another rewrite.
			const truncated: string[] = [];
			for (const message of state.runtime?.agent.state.messages ?? []) {
				if (message.role !== "user") continue;
				const text = extractUserText(message);
				const marker = /\n\n\[\.\.\. (\d+) more characters truncated from replay context\]$/.exec(text);
				if (!marker) continue;
				const prefix = text.slice(0, marker.index);
				const original = (deps.readSessionEntries?.() ?? []).find(
					(entry) => entry.kind === "message" && entry.role === "user" && Date.parse(entry.timestamp) === message.timestamp,
				);
				if (original?.kind !== "message") continue;
				const source = extractTurnText(original.payload);
				if (source.startsWith(prefix) && source.length === prefix.length + Number(marker[1])) truncated.push(text);
			}
			const replayTruncationHash =
				truncated.length > 0 ? createHash("sha256").update(JSON.stringify(truncated)).digest("hex") : undefined;
			const now = Date.now();
			// #423: on Codex the wire effort is the generation's initial effort for every call; a /thinking change
			// travels as a configuration_update item and keeps the cache (measured 2026-10-30), so it is no break cause.
			const wireEffort = state.runtime ? engineCodexConfiguration(state.runtime.agent)?.initialEffort : undefined;
			// #423: the lifetime the keepalive would have refreshed against is the one idle is judged by.
			const model = state.runtime?.agent.state.model;
			const lifetimeSeconds = model ? cacheLifetimeSeconds(model, undefined) : undefined;
			// A server that omits cache reads from its usage but reports cache_n in its timings is judged by those
			// timings, as the journal judges it, so doctor and /usage count the same breaks (#434).
			const evaluated = usage.cacheReadReported === false ? uncachedPrefillTokens(backend) : null;
			const observation = buildCacheCallObservation(
				evaluated !== null && backend
					? { input: evaluated, cacheRead: backend.promptTokens - evaluated, cacheWrite: 0 }
					: { input, cacheRead: usage.cacheReadReported === false ? null : cacheRead, cacheWrite },
				cacheCallBaseline,
				nextAssistantColdReasons,
				now,
				state.runtime
					? {
							targetId: state.runtime.targetId,
							modelId: state.runtime.wireModelId,
							thinkingLevel: wireEffort ?? state.runtime.runtimeResolution.effectiveThinkingLevel,
							toolChoice: cacheRequestToolChoice,
							...(replayTruncationHash === undefined ? {} : { replayTruncationHash }),
						}
					: undefined,
				{
					ttlMs: lifetimeSeconds === undefined ? null : lifetimeSeconds * 1000,
					...(transport
						? {
								transport: {
									mode: transport.mode,
									request: transport.request,
									...(transport.reason ? { reason: transport.reason } : {}),
									...(transport.recovery ? { recovery: true } : {}),
								},
							}
						: {}),
				},
			);
			// #423: named provider misses outrank host attribution; pending diagnostics preserve no-break.
			const messageStart = anthropicResponse?.messageStart;
			const miss = recordValue(
				recordValue(messageStart?.diagnostics)?.cache_miss_reason ?? messageStart?.cache_miss_reason,
			);
			if (typeof miss?.type === "string") {
				observation.providerDiagnostic = {
					provider: "anthropic",
					type: miss.type,
					...(typeof miss.cache_missed_input_tokens === "number"
						? { missedInputTokens: miss.cache_missed_input_tokens }
						: {}),
				};
				const causes = {
					model_changed: "model_changed",
					system_changed: "prompt_recompiled",
					tools_changed: "tools_changed",
					messages_changed: "input_changed",
				} as const;
				if (Object.hasOwn(causes, miss.type)) {
					observation.cause = causes[miss.type as keyof typeof causes];
					observation.causeBasis = "provider";
				}
			} else if (Array.isArray(messageStart?.input_transformations) && messageStart.input_transformations.length > 0) {
				const types = messageStart.input_transformations.flatMap((value) => {
					const transformation = recordValue(value);
					return typeof transformation?.type === "string" ? [transformation.type] : [];
				});
				observation.providerDiagnostic = { provider: "anthropic", type: `input_transformations:${types.join(",")}` };
			}
			if (observation.cause === "prompt_recompiled" && nextChangedSection !== undefined) {
				observation.changedSection = nextChangedSection;
			}
			nextChangedSection = undefined;
			cacheCallBaseline = {
				inclusiveInputTokens: observation.inclusiveInputTokens,
				endedAt: now,
				...(observation.requestFingerprint ? { requestFingerprint: observation.requestFingerprint } : {}),
				...(observation.transport ? { transportRequest: observation.transport.request } : {}),
			};
			const promptCache: Record<string, unknown> = {
				input,
				cacheRead,
				cacheWrite,
				backendVerdict: backendCacheVerdict(input, cacheRead, backend, usage.cacheReadReported),
				observation,
			};
			if (backend !== undefined) promptCache.backend = { ...backend };
			if (nextAssistantColdReasons.length > 0) {
				promptCache.expectedColdReasons = [...nextAssistantColdReasons];
				nextAssistantColdReasons = [];
			}
			return promptCache;
		},

		notePrewarm(prewarm: PrewarmStats): void {
			lastPrewarm = prewarm;
		},

		noteRunCacheSummary(messages, runFirstCallVerdict): void {
			// The settled run is the answer to the pre-warm's question, so the
			// pre-warm line stops being the newest fact about the prefix here.
			lastPrewarm = null;
			const cacheSummary = sumRunUsage(messages);
			if (cacheSummary.hadUsage) {
				let lastBackend: BackendCompletionTimings | null = null;
				for (let index = messages.length - 1; index >= 0; index -= 1) {
					const message = messages[index];
					if (message?.role !== "assistant") continue;
					lastBackend = (message as { backendTimings?: BackendCompletionTimings }).backendTimings ?? null;
					break;
				}
				const cacheRead = factKnownValue(cacheSummary.totals.usage.cacheRead);
				const cacheWrite = factKnownValue(cacheSummary.totals.usage.cacheWrite);
				const cacheReported = cacheRead > 0 || cacheWrite > 0;
				lastPromptCache = {
					shellReused: lastSystemPromptReused,
					cacheReadTokens: cacheReported ? cacheRead : null,
					cacheWriteTokens: cacheReported ? cacheWrite : null,
					uncachedInputTokens: factKnownValue(cacheSummary.totals.usage.input),
					backend: lastBackend,
					uncachedPrefillTokens: uncachedPrefillTokens(lastBackend),
					backendVerdict: runFirstCallVerdict,
					...(runExpectedColdReasons.length > 0 ? { expectedColdReasons: [...runExpectedColdReasons] } : {}),
				};
			}
		},

		resetForSession(incomingBranchAnchorTurnId: string | null = null): void {
			cacheCallBaseline = null;
			cacheCallBaselineLoaded = false;
			cacheGeneration += 1;
			if (state.runtime) setEngineCodexConfiguration(state.runtime.agent, undefined);
			thinkingUsesConfigurationUpdate = false;
			cacheRequestToolChoice = "auto";
			sentToolChoice = undefined;
			priorSentToolChoice = undefined;
			nextChangedSection = undefined;
			previousPromptSections = null;
			postureGeneration = null;
			postureGenerationPersisted = false;
			pendingPosture = null;
			memoryTurn = null;
			memoryAuthorityEpoch += 1;
			compactionController?.abort();
			// An in-process switch replaces the whole prefix: the backend's slot
			// still holds the outgoing session's prompt and history, so the first
			// turn on the incoming one is expected-cold on every tier, exactly as
			// a recompile is. The manifest can no longer say so on its own once
			// provenance follows the session, because the incoming session's last
			// recorded hash usually equals its fresh compile, so the stamp comes
			// from here. Only when this process had actually applied a prompt:
			// before the first compile there is nothing in the slot to have lost.
			if (sessionPromptHash !== null) noteColdReason("prompt_recompiled");
			frozenMemorySection = null;
			frozenRouteSources = undefined;
			frozenRouteIdentity = "";
			frozenMemorySessionId = "";
			sessionPromptDelta = "";
			lastPromptCache = null;
			lastPrewarm = null;
			lastSystemPromptReused = false;
			sessionPromptHash = null;
			sessionPromptKey = null;
			sessionPromptInvalidated = false;
			resumedPromptHashRead = false;
			resumedPromptHash = null;
			sessionWorkingContextPaths.clear();
			pendingPromptLogEntry = null;
			latestPromptCompile = null;
			emptyAutoCompactContextKey = null;
			autoCompactFailures = 0;
			noGainSummaryDigest = null;
			noUsefulCutBasisKey = null;
			reconciledAnchor = null;
			// Real branch navigation. The epoch separates two visits to the same
			// leaf id, so an advisory announced on the branch this session left is
			// re-armed rather than treated as already said.
			branchAnchorTurnId = incomingBranchAnchorTurnId;
			navigationEpoch += 1;
			bindMemoryScope();
			budgetProducer.reset();
			const session = deps.session?.current();
			currentContextSnapshot = session ? getLatestContextSnapshot(session) : null;
		},

		dispose(): void {
			disposed = true;
			compactionController?.abort();
			for (const unsubscribe of unsubscribeColdReasonSources) unsubscribe?.();
		},
	};
	return controller;
}
