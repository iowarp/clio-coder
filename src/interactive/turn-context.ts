import type { SuccessfulMemoryContextCommit } from "../domains/memory/commit-state.js";
import type { MemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import { replaceEngineMessages, setEngineSystemPrompt } from "../engine/agent.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
/**
 * Turn context ownership: the session-prompt compile cache, context-snapshot
 * accounting, prompt-cache honesty, and compaction. `runAutoCompact` is the
 * one compaction entry point; the pre-submit trigger, the preflight overflow
 * guard, overflow recovery, `/context compact`, and the post-tool continuation guard
 * all flow through it.
 */

import { createHash } from "node:crypto";
import {
	BusChannels,
	type ContextActivityStatus,
	type ContextPrunedPayload,
	type ContextRecalledPayload,
	type ContextWarningPayload,
	type MemoryStepCompletedPayload,
	type ResidencyMutationPayload,
} from "../core/bus-events.js";
import {
	type BackendCacheVerdict,
	type BackendCompletionTimings,
	uncachedPrefillTokens,
} from "../core/cache-telemetry.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { residencyTargetKey } from "../core/residency-target-key.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type { ToolName } from "../core/tool-names.js";
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
import { buildEvictionFields, planEviction } from "../domains/context/working-set/engine.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { isTurnStart } from "../domains/context/working-set/horizon.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import { selectVisibleEntries } from "../domains/context/working-set/visible.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import {
	type ContextWindowDetails,
	type ContextWindowSource,
	canonicalEndpointKey,
	isOrchestratorEligibleRuntime,
	type ProvidersContract,
	resolveRuntimeTarget,
} from "../domains/providers/index.js";
import type { LocalModelQuirks } from "../domains/providers/types/local-model-quirks.js";
import {
	AutoCompactionTrigger,
	DEFAULT_COMPACTION_THRESHOLD,
	shouldCompact,
} from "../domains/session/compaction/auto.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import { DEFAULT_KEEP_RECENT_TOKENS } from "../domains/session/compaction/defaults.js";
import { maskStaleObservations } from "../domains/session/compaction/mask-observations.js";
import { estimateTokens } from "../domains/session/compaction/tokens.js";
import {
	appendContextSnapshot,
	type CaptureContextSnapshotInput,
	type ContextSnapshot,
	type ContextUsageSnapshot,
	captureContextSnapshot,
	ceilChars,
	contentChars,
	contextUsageSnapshot,
	estimateAgentContextBreakdown,
	estimateAgentContextTokens,
	estimateAgentMessageTokens,
	getLatestContextSnapshot,
	lastLoadedContextWindow,
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
import { type CompactionTrigger, mainSkillContextState, type SessionEntry } from "../domains/session/entries.js";
import {
	appendPromptCompileRecord,
	PROMPT_MANIFEST_VERSION,
	readPromptCompileRecords,
	type SessionPromptCompileRecord,
} from "../domains/session/prompt-manifest.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { AgentMessage, Usage } from "../engine/types.js";
import { resolveToolPromptHint, type ToolRegistry } from "../tools/registry.js";
import {
	backendCacheVerdict,
	extractUserText,
	runtimeSupportsTools,
	sumRunUsage,
	toolNamesFromAgentState,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import { buildModelReplayAgentMessagesFromTurns, continuityContextFromSession } from "./model-session-replay.js";
import { resolveTurnOutputReserve } from "./output-reserve.js";
import { attachedToolSchemasFromState, mainPromptCacheIdentity } from "./prompt-cache-identity.js";
import { renderCompactionSummaryLine, renderEvictionSkipLine } from "./renderers/compaction-summary.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { AgentRuntime, ChatTurnState } from "./turn-state.js";

export interface TurnContextDeps {
	memoryCommitBridge?: MemoryInterventionRegistration | undefined;
	interactiveGuidance?: boolean;
	state: ChatTurnState;
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	session?: SessionContract | undefined;
	prompts?: PromptsContract | undefined;
	toolRegistry?: ToolRegistry | undefined;
	observability?: ObservabilityContract | undefined;
	bus?: SafeEventBus | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	autoCompact?:
		| ((
				instructions?: string,
				trigger?: CompactionTrigger,
				budget?: Pick<
					CompactInput,
					| "keepRecentTokens"
					| "preserveUserTurnId"
					| "skillContextState"
					| "signal"
					| "beforeSummaryCall"
					| "checkpointForSummary"
				>,
		  ) => Promise<CompactResult | null>)
		| undefined;
	/** Test seam for the eviction planner; production uses `planEviction` from the working-set engine. */
	planEviction?: typeof planEviction;
	getMemorySection?: ((request: MemoryPromptRequest) => string) | undefined;
	getReadySkillCount?: (() => number) | undefined;
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

/** Known causes that make the next provider prefix cache miss expected. */
export type ExpectedColdReason =
	| "dispatch"
	| "compaction"
	| "working_set_evict"
	| "residency"
	| "thinking_change"
	| "tool_surface_change"
	| "prompt_recompiled"
	/**
	 * A proactive-memory step ran between turns on the endpoint this session
	 * streams against. Its prompt is a trajectory rather than the chat prefix, so
	 * on a local server that keeps one prefix cache the next turn re-prefills
	 * (#229).
	 */
	| "background_memory";

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
	/**
	 * The loaded context window this session already recorded for a target and
	 * model, so a resume budgets against it instead of re-probing. Null when the
	 * ledger has no such measurement.
	 */
	rememberedLoadedContextWindow(targetId: string, modelId: string): number | null;
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
	): Promise<boolean>;
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
	/** Consume disturbances since the last settled run (T3.3 honesty). */
	consumeExpectedColdReasons(runtimeId: string): void;
	/** Prompt-cache record for one persisted assistant call, with cold-reason stamp. */
	promptCachePayloadForAssistant(usage: Usage, backend?: BackendCompletionTimings): Record<string, unknown>;
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
	workingSet: Readonly<{ protectLastTurns: number; policy: string }>,
	policyId: string,
): string {
	const turns = visibleEntries.filter(isTurnStart).length;
	return renderEvictionSkipLine({
		reason: turns <= workingSet.protectLastTurns ? "all-protected" : "nothing-evictable",
		turns,
		protectLastTurns: workingSet.protectLastTurns,
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

export function createTurnContext(deps: TurnContextDeps): TurnContext {
	const { state, middleware } = deps;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();
	let compactionController: AbortController | null = null;

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
	// Reuse an empty automatic attempt only for identical ledger and provider
	// context. Same-turn tool growth or same-length content replacement must
	// get a fresh cut; ordinary below-threshold checks never fingerprint it.
	let emptyAutoCompactContextKey: string | null = null;

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
	// Prefix-byte changes cool every tier. Residency, thinking changes, dispatch
	// traffic, and compaction keep the local-native gate because they disturb a
	// local server or its rendered template.
	const TIER_INDEPENDENT_COLD_REASONS: ReadonlySet<ExpectedColdReason> = new Set([
		"working_set_evict",
		"tool_surface_change",
		"prompt_recompiled",
	]);
	const stampsOnTier = (reason: ExpectedColdReason, runtimeId: string | undefined): boolean =>
		TIER_INDEPENDENT_COLD_REASONS.has(reason) ||
		(runtimeId !== undefined && deps.providers.getRuntime(runtimeId)?.tier === "local-native");
	const noteColdReason = (reason: ExpectedColdReason): void => {
		if (!state.streaming) {
			pendingColdReasons.add(reason);
			return;
		}
		if (!stampsOnTier(reason, state.runtime?.runtimeId)) return;
		if (!runExpectedColdReasons.includes(reason)) runExpectedColdReasons.push(reason);
		if (nextAssistantColdReasons.includes(reason)) return;
		nextAssistantColdReasons.push(reason);
		deps.emitNotice(`[context engine] ${reason} may affect cache reuse; actual reuse is reported with the response.`);
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
		deps.bus?.on(BusChannels.ResidencyMutation, (payload: ResidencyMutationPayload) => {
			const runtime = state.runtime;
			const model = runtime?.agent.state.model as { baseUrl?: unknown } | undefined;
			const baseUrl = typeof model?.baseUrl === "string" ? model.baseUrl : null;
			if (payload.targetKey !== residencyTargetKey(runtime?.runtimeId ?? "", baseUrl)) return;
			noteColdReason("residency");
		}) ?? null,
		// A memory step on another endpoint disturbs nothing here, so the stamp is
		// gated on the step having called the very server this session streams to.
		deps.bus?.on(BusChannels.MemoryStepCompleted, (payload: MemoryStepCompletedPayload) => {
			const target = state.runtime?.runtimeResolution.target;
			if (target === undefined) return;
			if (canonicalEndpointKey(target) !== payload.endpointKey) return;
			noteColdReason("background_memory");
		}) ?? null,
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
			conversationMessages: agentRuntime.agent.state.messages.filter((message) => message.role !== "system"),
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
			const messages = state.runtime.agent.state.messages.filter((message) => message.role !== "system");
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

	/**
	 * The window the next turn will resolve to, read the way ensureRuntime
	 * reads it but without building an agent. Before the first turn of a
	 * process, /resume included, state.runtime is null, and the ledger and the
	 * footer meter said `context window unknown · 0 tokens` until a turn ran
	 * (issue #189). Null when no target is configured or it does not resolve,
	 * and the overlay's "unknown" is then true.
	 */
	const rememberedLoadedContextWindow = (targetId: string, modelId: string): number | null => {
		const session = deps.session?.current();
		if (!session) return null;
		return lastLoadedContextWindow(session, targetId, modelId);
	};

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
		resumedPromptHash = records[records.length - 1]?.systemPromptHash ?? null;
		return resumedPromptHash;
	};

	const resolveWindowWithoutRuntime = (allowLedgerRead = true): ContextWindowDetails | null => {
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
			knownLoadedContextWindow: allowLedgerRead
				? rememberedLoadedContextWindow(targetId, wireModelId)
				: currentContextSnapshot?.contextWindowSource === "loaded" &&
						currentContextSnapshot.providerId === targetId &&
						currentContextSnapshot.modelId === wireModelId
					? currentContextSnapshot.effectiveContextWindow
					: null,
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
	 * Window facts while no runtime exists: the live resolution first, then the
	 * resumed snapshot's recorded window, which is what the previous process
	 * measured the same messages against.
	 */
	const windowWithoutRuntime = (
		allowLedgerRead = true,
	): {
		contextWindow: number;
		contextWindowSource: ContextWindowSource | null;
		contextWindowSlots: ContextWindowDetails["contextWindowSlots"];
	} => {
		const details = resolveWindowWithoutRuntime(allowLedgerRead);
		if (details) {
			return {
				contextWindow: details.effectiveContextWindow,
				contextWindowSource: details.contextWindowSource,
				contextWindowSlots: details.contextWindowSlots,
			};
		}
		const snapshot = currentContextSnapshot;
		if (snapshot && snapshot.effectiveContextWindow > 0) {
			return {
				contextWindow: snapshot.effectiveContextWindow,
				contextWindowSource: snapshotWindowSource(snapshot),
				contextWindowSlots: null,
			};
		}
		return { contextWindow: 0, contextWindowSource: null, contextWindowSlots: null };
	};

	const anchorModelKey = (agentRuntime: AgentRuntime): string => {
		const model = agentRuntime.agent.state.model;
		return JSON.stringify([model?.id, model?.provider, model?.api, model?.baseUrl]);
	};

	/** Price appended history separately so eviction can retain it without folding in static growth twice. */
	const reconciledHistoryTokens = (agentRuntime: AgentRuntime): number | null => {
		const anchor = reconciledAnchor;
		if (!anchor) return null;
		const messages = agentRuntime.agent.state.messages.filter((message) => message.role !== "system");
		// The identity, route, and length checks are cheap and run first; `||`
		// short-circuits, so the content digest is only computed for a prefix that
		// still looks like the attested one. The digest covers the attested prefix
		// and never the tail, so an append does not invalidate the anchor; the
		// prefix itself is re-serialized and rehashed on every validation, which
		// is the cost of detecting an in-place edit at all.
		if (
			anchor.runtime !== agentRuntime ||
			anchor.model !== agentRuntime.agent.state.model ||
			anchor.modelKey !== anchorModelKey(agentRuntime) ||
			anchor.targetId !== agentRuntime.targetId ||
			anchor.runtimeId !== agentRuntime.runtimeId ||
			anchor.wireModelId !== agentRuntime.wireModelId ||
			anchor.anchoredMessages.length > messages.length ||
			anchor.anchoredMessages.some((message, index) => message !== messages[index]) ||
			messageListDigest(messages.slice(0, anchor.anchoredMessages.length)) !== anchor.contentDigest
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
	const liveContextEstimate = (agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate => {
		const contextWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
		const estimateInput = {
			systemPrompt: agentRuntime.agent.state.systemPrompt,
			messages: agentRuntime.agent.state.messages.filter((message) => message.role !== "system"),
			tools: agentRuntime.agent.state.tools,
			...(pendingUserText !== undefined ? { pendingUserText, pendingUserImages } : {}),
		};
		const breakdown = estimateAgentContextBreakdown(estimateInput);
		const historyTokens = reconciledHistoryTokens(agentRuntime);
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
				? estimateAgentContextTokens(estimateInput)
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
				windowWithoutRuntime(false).contextWindow,
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
			messageListDigest(agentRuntime.agent.state.messages.filter((message) => message.role !== "system")),
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
	): LiveBudgetAccounting => {
		const estimate = liveContextEstimate(agentRuntime, pendingUserText);
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
				: windowWithoutRuntime(false);
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
	const liveBudgetInput = (pendingUserText?: string): LiveBudgetInput => {
		const settings = deps.getSettings();
		const agentRuntime = state.runtime;
		const snapshot = currentContextSnapshot;
		const promptFingerprint = agentRuntime
			? sha256Json(agentRuntime.agent.state.systemPrompt ?? null)
			: (snapshot?.promptHash ?? null);
		const toolSignature = agentRuntime
			? toolSignatureFromState(agentRuntime.agent.state.tools)
			: (snapshot?.toolSignature ?? null);
		const contentFingerprint = liveBudgetContentFingerprint(
			agentRuntime,
			pendingUserText,
			promptFingerprint,
			toolSignature,
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
			? liveRuntimeAccounting(agentRuntime, pendingUserText)
			: historicalAccounting(snapshot, settings);
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
			policyResolution.policy.reduce,
			policyResolution.policy.target,
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
			policy: policyResolution.policy,
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

	const refreshLiveBudget = (pendingUserText?: string): LiveBudgetView =>
		budgetProducer.publish(liveBudgetInput(pendingUserText));

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
		const anchoredMessages = [...agentRuntime.agent.state.messages.filter((message) => message.role !== "system")];
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
		return refreshedEntries;
	};

	// Compaction rides the context island as a single-phase "compaction"
	// activity (rendered as "Context Compact"). Each stage brackets its work
	// with a started/completed pair; a throwing summary emits failed. The
	// island already knows this kind and phase, and `deps.bus` is optional.
	const emitCompactionActivity = (status: ContextActivityStatus, message: string): void => {
		deps.bus?.emit(BusChannels.ContextActivity, {
			kind: "compaction",
			phase: status === "completed" ? "done" : "compact",
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
			usage.targetId ?? agentRuntime.targetId,
			usage.modelId ?? agentRuntime.wireModelId,
			usage.totalTokens,
			usage.cost.total,
			{
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
				reasoningTokens: usage.reasoning,
				totalTokens: usage.totalTokens,
				apiCalls: Math.max(1, Math.round(usage.apiCalls)),
			},
			usage.targetId === undefined && usage.modelId === undefined
				? agentRuntime.runtimeResolution.costProvenance
				: usage.cost.total > 0
					? "estimated"
					: "unknown",
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
	const performAutoCompact = async (
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
		pendingSkillPolicy?: PendingSkillToolPolicy,
		signal?: AbortSignal,
		handoff?: ContinuityReductionHooks,
	): Promise<boolean> => {
		if (!deps.readSessionEntries) return false;
		const originSession = deps.session?.current()?.id;
		const originNavigation = navigationEpoch;
		// Overflow forces a fit attempt even below the automatic threshold, but
		// still needs the request budget and active task. Manual force keeps its defaults.
		const useRequestBudget = !force || triggerOverride === "overflow" || handoff !== undefined;
		const activeAutoTurnId = useRequestBudget ? state.activeUserTurnId : null;
		const skillContextState = mainSkillContextState(
			filterEntriesToActivePath(deps.readSessionEntries(), state.lastTurnId ?? undefined),
			pendingSkillPolicy ?? state.currentPendingSkillPolicy ?? state.activeSkillSurface,
		);
		const settings = deps.getSettings();
		const cfg = settings.context.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;
		const compactionThreshold = cfg?.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
		const requiredFit = triggerOverride === "overflow";
		const pressureEstimate = force && !requiredFit ? null : liveContextEstimate(agentRuntime, pendingUserText);
		if (
			pressureEstimate &&
			!requiredFit &&
			!shouldCompact(pressureEstimate.tokens, compactionThreshold, pressureEstimate.contextWindow).shouldCompact
		)
			return false;
		// Empty cuts are reusable only while their source and provider context
		// remain unchanged. Tools can grow the same user turn into a useful cut.
		const attemptKey =
			!force && activeAutoTurnId
				? createHash("sha256")
						.update(
							JSON.stringify({
								turn: activeAutoTurnId,
								leaf: state.lastTurnId,
								entries: deps.readSessionEntries(),
								context: {
									systemPrompt: agentRuntime.agent.state.systemPrompt,
									messages: agentRuntime.agent.state.messages.filter((message) => message.role !== "system"),
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

		if (pressureEstimate) {
			const estimate = pressureEstimate;
			const verdict = shouldCompact(estimate.tokens, compactionThreshold, estimate.contextWindow);

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
						// The masked history is not the one the provider counted.
						reconciledAnchor = null;
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

						refreshLiveBudget(pendingUserText);
						const after = liveContextEstimate(agentRuntime, pendingUserText);
						if (
							requiredFit
								? requestFits(after.tokens, resolveTurnOutputReserve(agentRuntime, after.tokens), after.contextWindow)
								: !shouldCompact(after.tokens, compactionThreshold, after.contextWindow).shouldCompact
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
						planned = (deps.planEviction ?? planEviction)(policy, {
							entries: visibleEntries,
							view,
							cwd: deps.session.current()?.cwd ?? null,
							settings: settings.context.workingSet,
							pressure: {
								tokens: estimate.tokens,
								contextWindow: estimate.contextWindow,
								threshold: requiredFit
									? Math.min(
											compactionThreshold,
											Math.max(0, 1 - resolveTurnOutputReserve(agentRuntime, estimate.tokens) / estimate.contextWindow),
										)
									: compactionThreshold,
								target: requiredFit
									? Math.min(
											settings.context.workingSet.target,
											Math.max(0, 1 - resolveTurnOutputReserve(agentRuntime, estimate.tokens) / estimate.contextWindow),
										)
									: settings.context.workingSet.target,
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

							// Published only after the carried anchor and the post-eviction
							// capture are both in place: `liveContextEstimate` clears an
							// anchor whose message prefix no longer matches, so pricing the
							// rebuilt list any earlier would discard the attestation the
							// projection carry exists to preserve.
							refreshLiveBudget(pendingUserText);
							const after = liveContextEstimate(agentRuntime, pendingUserText);
							if (
								requiredFit
									? requestFits(after.tokens, resolveTurnOutputReserve(agentRuntime, after.tokens), after.contextWindow)
									: !shouldCompact(after.tokens, compactionThreshold, after.contextWindow).shouldCompact
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
			deps.bus?.emit(BusChannels.CompactionBegin, { trigger, at: Date.now() });
			emitCompactionActivity("started", "compacting context (summary)");
			summaryLifecycleStarted = true;
		};
		if (force) startSummaryLifecycle();
		// Said before the summary call, not after it: the operator is about to wait
		// on a destructive stage, and the reason the cheap one was skipped is only
		// useful ahead of it.
		if (evictionSkipNotice) deps.emitNotice(evictionSkipNotice);
		let result: CompactResult | null = null;
		// Compare full runtime estimates on both sides. The current snapshot and
		// result.tokensBefore may instead carry provider-calibrated history usage.
		const snapshotMetadata =
			currentContextSnapshot && currentContextSnapshot.systemPrompt === agentRuntime.agent.state.systemPrompt
				? { promptSegments: currentContextSnapshot.promptSegments, promptHash: currentContextSnapshot.promptHash }
				: {};
		const preCompactSnapshot = captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
			compactionThreshold,
			snapshotMetadata,
		);
		let budget:
			| Pick<
					CompactInput,
					| "keepRecentTokens"
					| "preserveUserTurnId"
					| "skillContextState"
					| "signal"
					| "beforeSummaryCall"
					| "checkpointForSummary"
			  >
			| undefined = skillContextState !== undefined ? { skillContextState } : undefined;
		if (useRequestBudget) {
			const estimate = liveContextEstimate(agentRuntime, pendingUserText);
			const output = resolveTurnOutputReserve(agentRuntime, estimate.tokens);
			const inputTarget = Math.min(estimate.contextWindow * compactionThreshold, estimate.contextWindow - output);
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
		try {
			result = await compactionTrigger.fire(async () => {
				const controller = new AbortController();
				compactionController = controller;
				summarySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
				try {
					return (
						(await deps.autoCompact?.(instructions, trigger, {
							...budget,
							...handoff,
							signal: summarySignal,
						})) ?? null
					);
				} finally {
					if (compactionController === controller) compactionController = null;
				}
			});
		} catch (error) {
			if (!summaryLifecycleStarted) startSummaryLifecycle();
			emitCompactionActivity("failed", compactionFailureMessage(error));
			deps.bus?.emit(BusChannels.CompactionEnd, { trigger, at: Date.now() });
			summarySignal?.throwIfAborted();
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

		// The checkpoint identifies the selected summary route; older results
		// fall back to the active chat route. The ledger carries usage for reseed; this is the
		// live sink, so `/usage` and the footer move the moment /context compact
		// returns instead of staying byte-identical to before it ran.
		recordCompactionUsage(agentRuntime, result);
		if (deps.memoryCommitBridge && !handoff && deps.session?.flushAppends) {
			deps.session.flushAppends();
			await deps.session.checkpoint("context-summary");
			if (originSession !== deps.session.current()?.id || originNavigation !== navigationEpoch || signal?.aborted)
				throw new Error("Context ownership changed during checkpoint.");
			const summary = [...deps.readSessionEntries()].reverse().find((entry) => entry.kind === "compactionSummary");
			if (summary) notifyMemoryCommit(summary.turnId, "summary", "summarized");
		}

		refreshAgentMessagesFromSession(agentRuntime);
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

		const tokensBefore = snapshotInputTokens(preCompactSnapshot);
		const tokensAfter = snapshotInputTokens(postCompactSnapshot);
		lastCompactionEvent = {
			stage: "llm_summary",
			tokensBefore,
			tokensAfter,
			trigger,
		};
		deps.bus?.emit(BusChannels.ContextPruned, {
			stage: "llm_summary",
			tokensBefore,
			tokensAfter,
			trigger,
			snapshotIdBefore: preCompactSnapshot.snapshotId,
			snapshotIdAfter: postCompactSnapshot.snapshotId,
			at: Date.now(),
		} satisfies ContextPrunedPayload);
		emitCompactionActivity("completed", `compacted ~${tokensBefore} -> ~${tokensAfter} tokens`);

		deps.emitNotice(
			renderCompactionSummaryLine({
				messagesSummarized: result.messagesSummarized,
				summaryChars: result.summary.length,
				tokensBefore,
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
		const operation = performAutoCompact(...args);
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
		if (scope) deps.memoryCommitBridge?.notifyContextCommitted({ ...scope, commitId, kind, outcome });
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
		const messages = agentRuntime.agent.state.messages.filter((message) => message.role !== "system");
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

	return {
		notifyMemoryCommit,
		installMemoryRestoration,
		prepareMemoryTurn(runtime, input): void {
			bindMemoryScope();
			pendingUserImages = [...(input.images ?? [])];
			if (input.continuation && memoryTurn !== null) return;
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
		rememberedLoadedContextWindow,
		refreshAgentMessagesFromSession,
		runAutoCompact,
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

		reconcileUsage(usage: Usage): void {
			// Cached prompt tokens still occupy the window; providers report them
			// outside `input`, so the attested prompt is the three summed.
			const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			const runtime = state.runtime;
			if (promptTokens > 0 && runtime) {
				const breakdown = estimateAgentContextBreakdown({ ...runtime.agent.state, messages: [] });
				const anchoredMessages = [...runtime.agent.state.messages.filter((message) => message.role !== "system")];
				// The output of this call is part of the next call's prompt for the
				// same messages, which is why it is folded in here.
				reconciledAnchor = {
					tokens: promptTokens + (usage.output || 0),
					anchoredMessages,
					contentDigest: messageListDigest(anchoredMessages),
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
				refreshLiveBudget();
				return;
			}
			// Reconcile in memory on every API call so the live meters
			// track usage; persistence waits for the run to settle.
			if (runtime) {
				const messages = runtime.agent.state.messages.filter((message) => message.role !== "system");
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
			currentContextSnapshot = reconcileSnapshot(currentContextSnapshot, usage);
			snapshotPersistPending = true;
			// A reconcile moves the anchor and therefore the figure the next
			// request budgets against, so it is a publication point of its own.
			refreshLiveBudget();
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
		async ensureSessionPrompt(agentRuntime: AgentRuntime): Promise<CompiledSessionPrompt | null> {
			if (!deps.prompts) return null;
			const settings = deps.getSettings();
			const autonomy = settings.safety.autonomy ?? "auto-edit";
			const sessionId = deps.session?.current()?.id ?? "";
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
			// Per-tool prompt hints come from registry metadata, derived once from
			// the frozen surface per compile. The compiler renders them sorted by
			// tool name, so the compiled text stays byte-stable for a given surface.
			const toolNames = toolNamesFromAgentState(agentRuntime.agent.state.tools);
			const attachedToolSchemas = attachedToolSchemasFromState(agentRuntime.agent.state.tools);
			const toolPromptHints = toolNames.flatMap((name) => {
				const hint = resolveToolPromptHint(deps.toolRegistry?.get(name as ToolName)?.metadata?.promptHint, "session");
				return hint ? [{ tool: name, hint }] : [];
			});
			const sessionInputs: SessionPromptInputs = {
				...(state.currentTurnConstraints ? { turnConstraints: state.currentTurnConstraints } : {}),
				...(deps.getReadySkillCount ? { readySkillCount: deps.getReadySkillCount() } : {}),
				demo: deps.interactiveGuidance === true && settings.interface.demo,
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
					if (memoryTurn !== null && memoryTurn.sessionId !== (sessionId || null)) {
						memoryAuthorityEpoch += 1;
						memoryTurn = null;
					}
					const memorySection = deps.getMemorySection({
						turnId: memoryTurn?.id ?? null,
						sessionAuthority: memoryTurn?.sessionAuthority ?? JSON.stringify([memoryAuthorityEpoch, sessionId]),
						cwd,
						targetId: agentRuntime.targetId,
						runtimeId: agentRuntime.runtimeId,
						modelId: agentRuntime.wireModelId,
						taskText: memoryTurn?.taskText ?? "",
						activePaths: memoryTurn?.activePaths ?? [],
					});
					if (memorySection.length > 0) sessionInputs.memorySection = memorySection;
				} catch (err) {
					deps.emitNotice(
						`[Clio Coder] memory load failed; continuing without memory injection: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			const key = mainPromptCacheIdentity({
				targetId: agentRuntime.targetId,
				runtimeId: agentRuntime.runtimeId,
				wireModelId: agentRuntime.wireModelId,
				autonomy,
				sessionId,
				cwd,
				workingContextPaths: [...sessionWorkingContextPaths],
				contextWindowSource,
				promptInputEpoch: deps.prompts.inputEpoch(),
				sessionInputs,
				attachedToolSchemas,
			});
			if (sessionPrompt && sessionPromptKey === key) {
				lastSystemPromptReused = true;
				return sessionPrompt;
			}
			try {
				const result = await deps.prompts.compileSessionPrompt({
					sessionId,
					sessionInputs,
					autonomy,
					cwd,
					workingContextPaths: [...sessionWorkingContextPaths],
				});
				const previousHash = sessionPromptHash ?? lastRecordedPromptHash();
				const changed = agentRuntime.agent.state.systemPrompt !== result.systemPrompt;
				if (changed) {
					setEngineSystemPrompt(agentRuntime.agent, result.systemPrompt);
					pendingPromptLogEntry = {
						version: PROMPT_MANIFEST_VERSION,
						at: new Date().toISOString(),
						previousHash,
						systemPromptHash: result.systemPromptHash,
						tokenEstimate: result.tokenEstimate,
						thinkingLevel: agentRuntime.agent.state.thinkingLevel ?? null,
						contextWindow,
						contextWindowSource,
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
				sessionPromptHash = result.systemPromptHash;
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
				// A resumed process names the session's last recorded hash as previousHash (#249), so
				// the stamp requires the hash to have moved, not merely to have a predecessor.
				if (entry.previousHash !== null && entry.previousHash !== entry.systemPromptHash) {
					noteColdReason("prompt_recompiled");
				}
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
			if (before.contextWindow <= 0) throw new Error("Context window is unavailable; continuation refused.");

			const settings = deps.getSettings();
			const threshold = settings.context.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
			const verdict = shouldCompact(before.tokens, threshold, before.contextWindow);
			let compacted = false;
			const mustFit = !requestFits(beforeView.inputTokens, beforeView.outputReserveTokens, beforeView.effectiveWindow);
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
			const after = liveContextEstimate(agentRuntime);
			if (!requestFits(afterView.inputTokens, afterView.outputReserveTokens, afterView.effectiveWindow)) {
				throw new Error(
					`[Clio Coder] post-tool context guard stopped continuation before provider call: estimated ${after.tokens} tokens exceeds reported context window ${after.contextWindow}. Use /context compact, narrower reads, or a follow-up turn with smaller observations.`,
				);
			}
			return compacted ? continuationContextUpdate(agentRuntime) : undefined;
		},

		contextUsage(): LiveContextUsage {
			// Footer reads project the last publication. They never rescan the
			// ledger or add streaming output to the next-request message estimate.
			const view = budgetProducer.current() ?? refreshLiveBudget();
			return {
				...contextUsageSnapshot(view.inputTokens, view.effectiveWindow, view.breakdown ?? undefined),
				revision: view.revision,
				inputSource: view.inputSource,
				historical: view.historical,
				breakdownSource: view.breakdownSource,
			};
		},

		contextLedger(): ContextLedger {
			const settings = deps.getSettings();
			const compactionThreshold = settings.context.compaction?.threshold ?? null;
			const compactionAuto = settings.context.compaction?.auto !== false;
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
				: windowWithoutRuntime(false);
			const provider = state.runtime?.targetId ?? settings.chat?.target ?? null;
			const model = state.runtime?.wireModelId ?? settings.chat?.model ?? null;
			const liveToolCount = state.runtime?.agent.state.tools.length ?? 0;

			if (!currentContextSnapshot) {
				return buildContextLedger({
					provider,
					model,
					...window,
					toolCount: liveToolCount,
					compactionThreshold,
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
				compactionThreshold,
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
			deps.bus?.emit(BusChannels.ContextWarning, { warning } satisfies ContextWarningPayload);
		},

		noteColdReason,

		consumeExpectedColdReasons(runtimeId: string): void {
			// Cache-disturbance honesty (T3.3): consume disturbances since
			// the last settled run. Only single-slot local backends lose their
			// prefix cache to interleaved work, so residency, thinking changes,
			// dispatch, and compaction stamp only on local-native targets. Reasons
			// that change the prefix bytes stamp every tier (see stampsOnTier).
			runExpectedColdReasons = [];
			nextAssistantColdReasons = [];
			if (pendingColdReasons.size > 0) {
				const reasons = [...pendingColdReasons].filter((reason) => stampsOnTier(reason, runtimeId));
				pendingColdReasons.clear();
				if (reasons.length > 0) {
					runExpectedColdReasons = reasons;
					nextAssistantColdReasons = reasons;
					deps.emitNotice(
						`[context engine] ${reasons.join(", ")} may affect cache reuse; actual reuse is reported with the response.`,
					);
				}
			}
		},

		promptCachePayloadForAssistant(usage: Usage, backend?: BackendCompletionTimings): Record<string, unknown> {
			// Per-call prompt-cache record (T3.2) keeps normalized provider usage
			// beside any timings captured from the server response. The run's first
			// persisted call also carries any expected-cold reasons.
			const input = typeof usage.input === "number" ? usage.input : 0;
			const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
			const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
			const promptCache: Record<string, unknown> = {
				input,
				cacheRead,
				cacheWrite,
				backendVerdict: backendCacheVerdict(input, cacheRead, backend, usage.cacheReadReported),
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
				lastPromptCache = {
					shellReused: lastSystemPromptReused,
					cacheReadTokens: cacheSummary.cacheRead > 0 || cacheSummary.cacheWrite > 0 ? cacheSummary.cacheRead : null,
					cacheWriteTokens: cacheSummary.cacheRead > 0 || cacheSummary.cacheWrite > 0 ? cacheSummary.cacheWrite : null,
					uncachedInputTokens: cacheSummary.input,
					backend: lastBackend,
					uncachedPrefillTokens: uncachedPrefillTokens(lastBackend),
					backendVerdict: runFirstCallVerdict,
					...(runExpectedColdReasons.length > 0 ? { expectedColdReasons: [...runExpectedColdReasons] } : {}),
				};
			}
		},

		resetForSession(incomingBranchAnchorTurnId: string | null = null): void {
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
			lastPromptCache = null;
			lastPrewarm = null;
			lastSystemPromptReused = false;
			sessionPromptHash = null;
			sessionPromptKey = null;
			resumedPromptHashRead = false;
			resumedPromptHash = null;
			sessionWorkingContextPaths.clear();
			pendingPromptLogEntry = null;
			emptyAutoCompactContextKey = null;
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
			compactionController?.abort();
			for (const unsubscribe of unsubscribeColdReasonSources) unsubscribe?.();
		},
	};
}
