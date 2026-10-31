import type { BudgetAlertPayload } from "../core/bus-events.js";
import { classifyCallFailure, trackCallFetch } from "../core/call-failure.js";
import { isHostAuthored, messageUsageForAccounting, rememberMessageCalls } from "../core/message-accounting.js";
import type { TelemetryCall } from "../core/telemetry/producer.js";
import { beginCall, recordTelemetry, telemetryCaptures } from "../core/telemetry/producer.js";
import type { CallSettled } from "../core/telemetry/schemas.js";
import { normalizeTokenUsage } from "../core/token-split.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import { observationTracing, traceObservation } from "../domains/memory/observation-trace.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import type { QuotaReading } from "../domains/quota/index.js";
import { quotaReadingFingerprint, quotaReadingFromMessage } from "../domains/quota/index.js";
import { usageCallsFromAttempts } from "../domains/session/journal-usage.js";
import { PROMPT_MANIFEST_VERSION } from "../domains/session/prompt-manifest.js";
import { recordUsageCall } from "../domains/session/usage-record.js";
import type { CacheBaseline } from "../domains/telemetry/cache-physics.js";
import { cachePhysics, serverTimedUsage } from "../domains/telemetry/cache-physics.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../domains/telemetry/call-facts.js";
import type { TelemetrySessionLease, TelemetrySessionOrigin } from "../domains/telemetry/session-journals.js";
import { readDiffusionFrame } from "../engine/apis/diffusion-frames.js";
import { estimateInputTokensFromContext } from "../engine/apis/output-budget.js";
import { resolvedRequestContext } from "../engine/context.js";
import { hasAssistantGenerationDelta } from "../engine/generation-delta.js";
import { requestStructure } from "../engine/request-structure.js";
import type { ContinuityController } from "./continuity-controller.js";
import { resolveTurnOutputReserve } from "./output-reserve.js";
import { prefixBlocksOf } from "./prefix-blocks.js";
/**
 * Turn runtime ownership: orchestrator target resolution, model synthesis,
 * live-agent construction and model hot-swap, thinking-level reconciliation,
 * capability/reasoning probes, and the run-event pipeline that enriches
 * engine events with timing, observability, persistence, and honesty facts.
 */

import { performance } from "node:perf_hooks";
import type { BackendCompletionTimings } from "../core/cache-telemetry.js";
import type { ClioSettings } from "../core/config.js";
import { gatewayRoutingObservationFromRecord, gatewayRoutingObservationLabel } from "../core/gateway-routing.js";
import { attributedModelId } from "../core/response-model-id.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import {
	applyModelCapabilityPatch,
	canonicalEndpointKey,
	modelResidencyForStatus,
	type ProvidersContract,
	recordEndpointThroughput,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
	runtimeResolutionWarningsBesideThinkingNotice,
	type TargetStatus,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import {
	SessionCostCeilingError,
	sessionCeilingReached,
	suggestedSessionCostCeilingUsd,
} from "../domains/scheduling/budget.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { RetrySettings } from "../domains/session/retry.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import type { createEngineAgent } from "../engine/agent.js";
import { enginePinnedPrefix } from "../engine/agent.js";
import { cleanupEngineSessionResources } from "../engine/ai.js";
import { engineMainStreamSimple } from "../engine/api-registry.js";
import { setGlobalDefaultMaxOutputTokens } from "../engine/apis/index.js";
import type { CacheKeepaliveReply, CacheKeepaliveRequest } from "../engine/cache-keepalive.js";
import { lockedSynthesisSystemPrompt, sanitizeLockedSynthesisMessage } from "../engine/loop-guard.js";
import { applyToolRounds, streamToolRound } from "../engine/provider-payload.js";
import type { AgentEvent, AgentMessage, EngineModel, Usage } from "../engine/types.js";
import type { resolveAgentTools, ToolFinishEvent, ToolTelemetry } from "../tools/agent-tools.js";
import { effectiveToolCall } from "../tools/surface.js";
import { createAssistantGenerationTiming } from "./assistant-generation-timing.js";
import {
	type AssistantCallTiming,
	type BackendCacheVerdict,
	backendCacheVerdict,
	estimatedUsageForInterruptedTurn,
	extractText,
	extractThinking,
	fallbackIdentityPrompt,
	hasStructuredToolCall,
	isEmptyAbortedAssistantMessage,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
	toolNamesFromAgentState,
	toolResultSummary,
} from "./chat-loop-messages.js";
import { assessToolProseLoop, runtimeNarratesToolCalls, shouldAssessToolProse } from "./tool-prose-loop.js";
import type { ExpectedColdReason, TurnContext } from "./turn-context.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { TurnPersistence } from "./turn-persistence.js";
import type { AgentRuntime, ChatLoopTarget, ChatTurnState, PreInvocationStage } from "./turn-state.js";

const LOCAL_API_KEY_FALLBACK = "clio-coder-local-target";
type StreamAdmission = NonNullable<NonNullable<Parameters<typeof createEngineAgent>[0]>["beforeStreamRequest"]>;
type AdmissionHold = { waitedOn?: "budget" };

const PRE_INVOCATION_STAGE_LABEL: Readonly<Record<PreInvocationStage, string>> = {
	transform: "request transform",
	auth: "authentication",
	"budget admission": "budget admission",
	admission: "request admission",
};

/**
 * The stall watchdog's abort text. A silent request that never reached the
 * provider names the step it was in: the session behind #423 read "no output
 * from openai-codex" while no request had left the host. Both forms end in a
 * timeout; only an invoked stream belongs on the transient retry ladder (#424).
 */
function stallAbortReason(
	targetId: string,
	idleMs: number,
	stage: PreInvocationStage | null,
	awaitingFirstToken: boolean,
): string {
	const seconds = Math.round(idleMs / 1000);
	if (stage !== null) {
		return `request stalled: ${PRE_INVOCATION_STAGE_LABEL[stage]} made no progress for ${seconds}s and nothing was sent to ${targetId}, aborting (pre-invocation timeout)`;
	}
	return `stream stalled: no ${awaitingFirstToken ? "first token" : "output"} from ${targetId} for ${seconds}s, aborting (stream timeout)`;
}

/**
 * A turn that never started, with a machine-readable reason attached. The
 * operator-facing message is unchanged prose; `reason` exists because the ACP
 * server has to tell a client *why* Clio refused to admit the prompt, and
 * parsing that out of the prose would bind a wire contract to a sentence.
 */
export class TurnAdmissionError extends Error {
	constructor(
		message: string,
		readonly reason: string,
	) {
		super(message);
		this.name = "TurnAdmissionError";
	}
}

/**
 * Say that the first request will pay for a load, before it does.
 *
 * A self-hosted server loads a model on demand, and a 30B at 4-bit takes tens
 * of seconds off disk. Clio sends the request and waits, which from the outside
 * is indistinguishable from a hang: no spinner explains it, no notice names it,
 * and the operator's next move is usually Ctrl-C. The probe already knows the
 * model is not resident, because llama-swap and LM Studio both report per-model
 * load state; nothing was reading it.
 *
 * Notice only, never a block. The server loads it either way, and a state that
 * says `unknown` says nothing worth interrupting for. Residency comes from the
 * same discovery view the planner budgets against, so a model Clio is planning
 * a loaded window for is never announced as absent.
 */
function coldModelNotice(
	status: TargetStatus | null | undefined,
	targetId: string,
	wireModelId: string,
): { key: string; message: string } | null {
	const residency = modelResidencyForStatus(status, wireModelId);
	if (residency === "loading") {
		return {
			key: `${targetId}|${wireModelId}|loading`,
			message: `[Clio Coder] ${wireModelId} is still loading on ${targetId}; the first reply waits for it.`,
		};
	}
	if (residency !== "absent") return null;
	return {
		key: `${targetId}|${wireModelId}|unloaded`,
		message: `[Clio Coder] ${wireModelId} is not resident on ${targetId}; the first request loads it, which can take a minute.`,
	};
}

export type AssistantDeltaEvent =
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partialText: string;
	  }
	| {
			/**
			 * One whole frame from a diffusion model: the entire text so far, with
			 * positions the model has not resolved yet still noise. Replaces the
			 * streamed text rather than extending it.
			 */
			type: "text_frame";
			contentIndex: number;
			text: string;
			/** 0 to 1 as reported by the provider. */
			progress: number;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partialThinking: string;
	  };

export interface TurnRuntimeDeps {
	onMemoryRequestSubmitted?: ((messages: readonly AgentMessage[], systemPrompt?: string) => void) | undefined;
	turnIdentity?: () => unknown;
	interactiveGuidance?: boolean;
	state: ChatTurnState;
	/** Capabilities behind the attached gateway, for the streaming tool-prose cutoff. */
	gatewayCapabilityNames?: (() => ReadonlyArray<string>) | undefined;
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	knownTargets: () => ReadonlySet<string>;
	telemetry?: TelemetryContract | undefined;
	scheduling?: SchedulingContract | undefined;
	headless?: boolean | undefined;
	createAgent: typeof createEngineAgent;
	/** Every main-turn request as sent, for the hosted cache keepalive (#423). */
	noteMainRequest?: (
		runtime: AgentRuntime,
		request: CacheKeepaliveRequest,
		stream: { result(): Promise<CacheKeepaliveReply> },
	) => void;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	persistence: TurnPersistence;
	context: TurnContext;
	continuity?: ContinuityController;
	hasQueuedSteering?: () => boolean;
	/**
	 * Clio's steering queue hands operator messages to the engine only at a
	 * slot: the top of `finishTurn`, before Pi's poll, and the end of
	 * `prepareNextTurn`, before Pi's second poll.
	 */
	queueHandOver?: {
		atFinishTurn(final: boolean): void;
		afterPrepareNextTurn(): void;
	};
	middleware: TurnMiddleware;
	retrySettings: () => RetrySettings;
	/** Stable Clio session id forwarded only to gateway runtimes that understand it. */
	sessionId?: () => string | undefined;
	sessionOrigin?: () => TelemetrySessionOrigin | null;
	/**
	 * Information-flow admission of one model request: the block reason when
	 * the session's restricted context may not reach this target, or null.
	 * Asked on every request, after ownership and before budget, so a target
	 * whose endpoint changed is judged on what it is now.
	 */
	admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	emit: (event: AgentEvent | AssistantDeltaEvent) => void;
	emitNotice: (text: string) => void;
	/** Transport advisories belong in the footer, separate from conversation. */
	emitFooterNotice: (level: "info" | "warning", text: string, key: string) => void;
	/** Tool-call id to its `performance.now()` start mark; spans only, never an instant. */
	toolStartTimes: Map<string, number>;
	/**
	 * Turn-control work a middleware continuation runs before its request (the
	 * detached-batch collection), returned as a block for model context. The
	 * submit path did this for a resubmitted continuation.
	 */
	prepareInRunContinuation?: (signal?: AbortSignal) => Promise<string | null>;
}

export interface TurnRuntime {
	ensureRuntime(options?: { silent?: boolean }): AgentRuntime | null;
	ensureLiveCapabilitiesForSelectedModel(options?: { silent?: boolean }): Promise<void>;
	dispose(): void;
	cancelRunWatchdog(): void;
	cleanupSessionResources(sessionId: string | undefined): void;
	/**
	 * Install on the session tool surface so admission verdicts reach the panel.
	 * The engine's `tool_execution_end` carries only `isError` and result text,
	 * which cannot tell a permission block from a command that ran and exited
	 * nonzero; this stream carries the registry's actual verdict.
	 */
	toolTelemetry: ToolTelemetry;
	/** The journaled main calls whose lease was taken for this user turn, in settle order (#434). */
	takeSettledCalls(userTurnId: string): CallSettled[];
}

export function createTurnRuntime(deps: TurnRuntimeDeps): TurnRuntime {
	const { state, context, persistence, middleware, middlewareToolChoice } = deps;

	/**
	 * Authoritative admission outcome per call, keyed by the engine's
	 * `toolCallId`, recorded as the registry settles and consumed when the
	 * matching `tool_execution_end` arrives. Entries are deleted on consumption;
	 * a call whose end event never arrives leaves at most one stale entry, which
	 * the next run with the same id would overwrite.
	 */
	const toolOutcomes = new Map<
		string,
		Pick<
			ToolFinishEvent,
			| "outcome"
			| "reason"
			| "durationMs"
			| "actionClass"
			| "decision"
			| "deniedPark"
			| "redundantRepeat"
			| "ruleId"
			| "reasonCode"
			| "policySource"
			| "denial"
		>
	>();
	const toolTelemetry: ToolTelemetry = {
		onFinish(event) {
			if (event.toolCallId === undefined) return;
			toolOutcomes.set(event.toolCallId, {
				outcome: event.outcome,
				...(event.reason === undefined ? {} : { reason: event.reason }),
				durationMs: event.durationMs,
				...(event.actionClass === undefined ? {} : { actionClass: event.actionClass }),
				...(event.decision === undefined ? {} : { decision: event.decision }),
				...(event.deniedPark === true ? { deniedPark: true } : {}),
				...(event.redundantRepeat === true ? { redundantRepeat: true } : {}),
				...(event.ruleId === undefined ? {} : { ruleId: event.ruleId }),
				...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
				...(event.policySource === undefined ? {} : { policySource: event.policySource }),
				...(event.denial === undefined ? {} : { denial: event.denial }),
			});
		},
	};

	/**
	 * Resolution warnings the operator has already been shown, keyed by
	 * target+model+message. A resolution runs on every turn, so without this the
	 * same context-window warning would print on every submit; without any
	 * surfacing at all, it printed nowhere. Known template-option limitations
	 * use a brief footer advisory; actionable resolution warnings retain their
	 * transcript notice. Detailed diagnostics remain on the resolution.
	 */
	const announcedResolutionWarnings = new Set<string>();
	const turnCalls = new Map<string, CallSettled[]>();
	// The last request sent on each cache key, kept across runtime rebuilds and dropped whenever turn-context restarts
	// cache comparison, so the journal compares within one context generation as #423 does (#434).
	const cacheBaselines = new Map<string, CacheBaseline>();
	let cacheBaselineGeneration: number | undefined;
	// Disturbances owed to the next request that leaves: those taken for one that never left, and a Codex auth reset
	// that closed the socket after its call, so the next call sends the recovery frame (#434).
	let carriedColdReasons: ExpectedColdReason[] = [];
	// The last quota reading journaled per provider and target. A reading is journaled at its turn's first sight of it
	// and whenever it changes, never once per call (#434).
	const journaledQuota = new Map<string, { fingerprint: string; turnId: string | undefined }>();
	const recordQuotaReading = (
		reading: QuotaReading,
		owner: TelemetrySessionLease["context"] | undefined,
		facts: CallSettled,
	): void => {
		if (!owner) return;
		const key = JSON.stringify([reading.provider, reading.targetId]);
		const fingerprint = quotaReadingFingerprint(reading);
		const previous = journaledQuota.get(key);
		if (previous?.fingerprint === fingerprint && previous.turnId === owner.turnId) return;
		if (recordTelemetry("quota.reading", reading, { ...owner, callId: facts.callId, attemptId: facts.attemptId }))
			journaledQuota.set(key, { fingerprint, turnId: owner.turnId });
	};

	const readTarget = (): ChatLoopTarget | null => {
		const settings = deps.getSettings();
		const targetId = settings.chat.target?.trim();
		const wireModelId = settings.chat.model?.trim();
		if (!targetId || !wireModelId) return null;
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: settings.chat.thinkingLevel ?? "off",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: true,
		});
		if (!resolved.ok) {
			const failure = resolved.diagnostics.find((entry) => entry.severity === "error") ?? resolved.diagnostics[0];
			throw new TurnAdmissionError(
				`[Clio Coder] ${failure?.message ?? "orchestrator target resolution failed"}`,
				failure?.code ?? "admission-failed",
			);
		}
		for (const entry of resolved.diagnostics) {
			if (entry.code !== "chat-template-kwargs-undeliverable") continue;
			const key = `${targetId}|${wireModelId}|${entry.code}`;
			if (announcedResolutionWarnings.has(key)) continue;
			announcedResolutionWarnings.add(key);
			deps.emitFooterNotice(
				resolved.target.modelRuntime.request.undeliverableChatTemplateKwargs?.declaredUnsupported ? "info" : "warning",
				`${resolved.target.runtime.id} ignores custom template options; continuing.`,
				key,
			);
		}
		// The TUI's thinking indicator owns coercion facts; other surfaces retain their notice.
		for (const message of runtimeResolutionWarningsBesideThinkingNotice(
			resolved.diagnostics.filter((entry) => entry.code !== "chat-template-kwargs-undeliverable"),
			resolved.target.modelRuntime.thinking.notice,
		)) {
			const key = `${targetId}|${wireModelId}|${message}`;
			if (announcedResolutionWarnings.has(key)) continue;
			announcedResolutionWarnings.add(key);
			deps.emitNotice(`[Clio Coder] ${message}`);
		}
		return {
			target: resolved.target.target,
			runtime: resolved.target.runtime,
			wireModelId: resolved.target.wireModelId,
			runtimeResolution: resolved.target,
		};
	};

	/**
	 * Refresh the selected route's server report on a short TTL. The key
	 * includes target settings and wire model, so selection and endpoint edits
	 * refresh immediately on the next poll or submit. A failed probe is retried
	 * after the TTL and never extends a prior serving-window claim.
	 *
	 * Every tier but `cloud` is probed. A self-hosted OpenAI-compatible gateway
	 * serves whatever context it was launched with, and that number lives on the
	 * server. Restricting this to `local-native` meant an `openai-compat`
	 * target ran the whole session on an assumed window while the server was
	 * one HTTP GET away from reporting the real one. A hosted provider is asked
	 * too when its runtime reports windows (`probeServingWindows`); the rest of
	 * the cloud runtimes keep their labeled catalog fallback.
	 */
	const TARGET_PROBE_TTL_MS = 30_000;
	const TARGET_PROBE_POLL_MS = 5_000;
	let lastTargetProbe: { key: string; at: number } | null = null;
	let disposed = false;
	let clearCurrentWatchdog: () => void = () => {};
	const targetProbesInFlight = new Map<string, Promise<void>>();
	const ensureLiveCapabilitiesForSelectedModel = async (options?: { silent?: boolean }): Promise<void> => {
		if (disposed) return;
		const settings = deps.getSettings();
		const targetId = settings.chat.target?.trim();
		const wireModelId = settings.chat.model?.trim();
		if (!targetId || !wireModelId) return;
		const target = deps.providers.getTarget(targetId);
		if (!target) return;
		const runtimeDesc = deps.providers.getRuntime(target.runtime);
		if (!runtimeDesc || (runtimeDesc.tier === "cloud" && typeof runtimeDesc.probeServingWindows !== "function")) return;
		const key = JSON.stringify([targetId, wireModelId, target]);
		const inFlight = targetProbesInFlight.get(key);
		if (inFlight) {
			await inFlight;
			return;
		}
		const now = Date.now();
		if (lastTargetProbe?.key === key && now - lastTargetProbe.at < TARGET_PROBE_TTL_MS) return;
		lastTargetProbe = { key, at: now };
		const probe = (async (): Promise<void> => {
			let status: Awaited<ReturnType<ProvidersContract["probeTarget"]>> = null;
			try {
				status = await deps.providers.probeTarget(targetId);
			} catch {
				// Unexpected provider-contract failures retry after the TTL.
			}
			if (disposed) return;
			if (!options?.silent) announceColdModel(status, targetId, wireModelId);
			// A passive refresh must update the attached model and footer budget too;
			// the provider status alone is otherwise invisible until the next submit.
			if (
				state.runtime &&
				!state.streaming &&
				deps.getSettings().chat.target === targetId &&
				deps.getSettings().chat.model === wireModelId
			) {
				ensureRuntime({ silent: true });
			}
			context.refreshLiveBudget();
		})();
		targetProbesInFlight.set(key, probe);
		try {
			await probe;
		} finally {
			if (targetProbesInFlight.get(key) === probe) targetProbesInFlight.delete(key);
		}
	};
	const selectedRoutePoll = setInterval(() => {
		if (state.streaming) return;
		void ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
	}, TARGET_PROBE_POLL_MS);
	selectedRoutePoll.unref();

	/** One notice per target+model+state, so a repeated probe stays quiet. */
	const announcedColdModels = new Set<string>();
	const announceColdModel = (
		status: Awaited<ReturnType<ProvidersContract["probeTarget"]>>,
		targetId: string,
		wireModelId: string,
	): void => {
		const notice = coldModelNotice(status, targetId, wireModelId);
		if (!notice) return;
		if (announcedColdModels.has(notice.key)) return;
		announcedColdModels.add(notice.key);
		deps.emitNotice(notice.message);
	};

	const synthesizeModel = (target: ChatLoopTarget): EngineModel => {
		const kbHit = deps.providers.knowledgeBase?.lookup(target.wireModelId, target.runtime.id) ?? null;
		const synth = target.runtime.synthesizeModel(target.target, target.wireModelId, kbHit);
		target.runtimeResolution = refineRuntimeTargetWithModelHints(
			target.runtimeResolution,
			synth,
			deps.providers.knowledgeBase,
		);
		applyModelCapabilityPatch(synth, target.runtimeResolution.capabilities);
		return synth;
	};

	const ensureReasoningProbe = (target: ChatLoopTarget): void => {
		if (deps.providers.getDetectedReasoning(target.target.id, target.wireModelId) !== null) return;
		void deps.providers
			.probeReasoningForModel(target.target.id, target.wireModelId)
			.then((reasoning) => {
				if (
					reasoning !== null &&
					state.runtime &&
					state.runtime.targetId === target.target.id &&
					state.runtime.wireModelId === target.wireModelId
				) {
					const refreshed = resolveRuntimeTarget(deps.providers, {
						targetId: target.target.id,
						wireModelId: target.wireModelId,
						requestedThinkingLevel: deps.getSettings().chat.thinkingLevel ?? "off",
						use: "orchestrator",
						requireTools: false,
						requireOutputBudget: true,
					});
					if (!refreshed.ok) return;
					const liveModel = state.runtime.agent.state.model;
					const runtimeResolution = liveModel
						? refineRuntimeTargetWithModelHints(refreshed.target, liveModel, deps.providers.knowledgeBase)
						: refreshed.target;
					if (liveModel) applyModelCapabilityPatch(liveModel, runtimeResolution.capabilities);
					state.runtime.agent.state.thinkingLevel = runtimeResolution.effectiveThinkingLevel;
					state.runtime.runtimeResolution = runtimeResolution;
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
			deps.emitNotice(`[Clio Coder] session resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/**
	 * One visible line when the requested thinking dial cannot apply as-is
	 * (reasoning-class-never model, always-on model, on/off coercion). Emitted
	 * where the dial takes effect, once per session, model and requested level; the
	 * same facts stay inspectable in receipts via runtimeResolution.thinking.
	 */
	const announcedThinkingNotices = new Set<string>();
	let thinkingNoticeSession: string | undefined;
	const emitThinkingClampNotice = (resolution: ChatLoopTarget["runtimeResolution"]): void => {
		if (deps.interactiveGuidance) return;
		const sessionId = deps.sessionId?.();
		// The first runtime can precede session creation; bind its notices to that session.
		if (sessionId !== thinkingNoticeSession) {
			if (thinkingNoticeSession !== undefined) announcedThinkingNotices.clear();
			thinkingNoticeSession = sessionId;
		}
		const thinking = resolution.modelRuntime.thinking;
		const notice = thinking.notice.trim();
		if (thinking.noticeKind === "applied" || notice.length === 0) return;
		const key = `${resolution.wireModelId}|${resolution.requestedThinkingLevel}`;
		if (announcedThinkingNotices.has(key)) return;
		announcedThinkingNotices.add(key);
		deps.emitNotice(notice);
	};

	// A target id/model names the selection, not its current URL, auth, pricing
	// or cache policy. Keep the constructed descriptor identity across calls.
	let runtimeTargetSettings: string | null = null;
	const ensureRuntime = (options?: { silent?: boolean }): AgentRuntime | null => {
		const target = readTarget();
		if (!target) return null;
		const targetSettings = JSON.stringify(target.target);
		const sameTargetSettings = runtimeTargetSettings === targetSettings;
		// Preflight and the wire budget share the session's effective settings,
		// including overrides that never reach the saved providers snapshot.
		setGlobalDefaultMaxOutputTokens(deps.getSettings().chat.maxOutputTokens);
		if (!options?.silent)
			context.emitContextWindowWarningTransition(target.runtimeResolution?.contextWindowDetails?.warning ?? null);
		if (!deps.knownTargets().has(target.target.id)) {
			throw new TurnAdmissionError(
				`[Clio Coder] orchestrator target=${target.target.id} unknown. Run \`clio-coder targets\` to see configured targets.`,
				"target-unknown",
			);
		}
		const requestedThinkingLevel = target.runtimeResolution.requestedThinkingLevel;
		persistence.appendThinkingLevelChangeEntry(
			requestedThinkingLevel,
			target.runtimeResolution.modelRuntime.thinking.effort ?? target.runtimeResolution.effectiveThinkingLevel,
		);
		if (
			state.runtime &&
			state.runtime.targetId === target.target.id &&
			state.runtime.runtimeId === target.runtime.id &&
			sameTargetSettings &&
			state.runtime.wireModelId === target.wireModelId
		) {
			// Same target+runtime+model. Settings may still have moved
			// thinkingLevel since the last call (the user invoked /thinking
			// or Shift+Tab); reconcile the clamped level so the next prompt
			// dispatches under the current intent without forcing a rebuild.
			ensureReasoningProbe(target);
			const runtimeResolution = refineRuntimeTargetWithModelHints(
				target.runtimeResolution,
				state.runtime.agent.state.model,
				deps.providers.knowledgeBase,
			);
			// The wire adapter reads the existing model, including route controls
			// that fresh metadata may have changed or removed for this same alias.
			applyModelCapabilityPatch(state.runtime.agent.state.model, runtimeResolution.capabilities);
			const desiredLevel = runtimeResolution.effectiveThinkingLevel;
			if (state.runtime.agent.state.thinkingLevel !== desiredLevel) {
				state.runtime.agent.state.thinkingLevel = desiredLevel;
			}
			state.runtime.runtimeResolution = runtimeResolution;
			if (!options?.silent) emitThinkingClampNotice(runtimeResolution);
			return state.runtime;
		}

		// Same target+runtime, new wireModelId: hot-swap the model in place on
		// the live agent. Mirrors the pi-coding-agent setModel pattern (mutate
		// `agent.state.model`, re-clamp thinking level, persist) so the runtime
		// keeps its conversation, subscribers, and pending tool calls.
		// Server-side residency for the new model is reconciled by the engine
		// adapters at the top of the next stream (engine/apis/residency.ts):
		// co-resident when capacity allows, swapping only when a slot must be
		// freed, never evicting protected models.
		if (
			state.runtime &&
			state.runtime.targetId === target.target.id &&
			state.runtime.runtimeId === target.runtime.id &&
			sameTargetSettings &&
			state.runtime.wireModelId !== target.wireModelId
		) {
			const nextModel = synthesizeModel(target);
			state.runtime.agent.state.model = nextModel;
			state.runtime.wireModelId = target.wireModelId;
			const effectiveThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
			state.runtime.agent.state.thinkingLevel = effectiveThinkingLevel;
			state.runtime.runtimeResolution = target.runtimeResolution;
			if (!options?.silent) emitThinkingClampNotice(target.runtimeResolution);
			persistence.appendModelChangeEntry(target);
			ensureReasoningProbe(target);
			return state.runtime;
		}

		const model = synthesizeModel(target);
		const initialThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
		const tools: ReturnType<typeof resolveAgentTools> = [];
		// Seed the system prompt with the fallback identity text. The first
		// submit replaces it with the compiled session prompt; the fallback
		// only shows up when the prompts contract is absent (tests, degraded
		// boot).
		const hadPriorRuntime = state.runtime !== null;
		const priorMessages = state.runtime ? [...state.runtime.agent.state.messages] : [...state.replayedContextMessages];
		// Drop any in-flight stream on the prior agent before discarding it.
		if (state.runtime) {
			state.runtime.agent.abort();
			cleanupSessionResources(state.runtime.agent.sessionId);
		}
		let getCurrentAgentSignal: () => AbortSignal | undefined = () => undefined;
		const gatewaySessionId = target.runtime.id === "litellm" ? deps.sessionId?.() : undefined;
		// message_start can follow response headers. Keep each invocation's
		// monotonic anchor before that wait, including custom stream delegates.
		let apiCallStartedAt: number | null = null;
		let callTracking: ReturnType<typeof trackCallFetch> | null = null;
		let modelCall: TelemetryCall | undefined;
		let journalLease: TelemetrySessionLease | undefined;
		let settledAttempts: CallSettled[] = [];
		// What each attempt handed Pi, digested only at settle so the hashing stays off the send path (#434).
		let attemptRequest:
			| {
					model: Parameters<typeof requestStructure>[0];
					context: Parameters<typeof requestStructure>[1];
					compiled: Parameters<typeof requestStructure>[2];
					coldReasons: ExpectedColdReason[];
			  }
			| undefined;
		/**
		 * Cache physics against the previous request on the same key. Every attempt the provider saw advances the
		 * baseline, hidden #426 retries included, so the ledger's #423 shortfall, which only persisted replies
		 * advance, can differ from rePrefilledTokens until the ledger copy retires (#434).
		 */
		const withCachePhysics = (
			settlement: ReturnType<typeof callSettlementFromMessage>,
			message: AgentMessage,
		): ReturnType<typeof callSettlementFromMessage> => {
			const request = attemptRequest;
			attemptRequest = undefined;
			const sent = settlement.disposition !== "never_sent";
			// A cooldown reset closed the Codex socket before this call, so its own full frame rebuilt the continuation;
			// an auth reset closed it after, so the next call's does. The SSE pin has no measured reset behind it (#423).
			const recovery = settlement.transport.recovery?.action;
			const reasons: ExpectedColdReason[] = [
				...new Set([
					...(request?.coldReasons ?? []),
					...(recovery === "cooldown_reset" ? ["transport_reset" as const] : []),
				]),
			];
			if (!sent) carriedColdReasons = [...new Set([...carriedColdReasons, ...reasons])];
			if (recovery === "auth_reset")
				carriedColdReasons = [...new Set([...carriedColdReasons, "transport_reset" as const])];
			const generation = context.cacheGeneration?.() ?? 0;
			if (generation !== cacheBaselineGeneration) {
				cacheBaselines.clear();
				cacheBaselineGeneration = generation;
			}
			const resolution = localRuntime.runtimeResolution;
			const key = JSON.stringify([localRuntime.targetId, request?.model.api ?? model.api, localRuntime.wireModelId]);
			let structure: ReturnType<typeof requestStructure> | undefined;
			try {
				structure = request ? requestStructure(request.model, request.context, request.compiled) : undefined;
			} catch {
				// A request Clio cannot digest leaves its cache facts unobserved; telemetry never fails the call (#434).
			}
			const backend = (message as { backendTimings?: BackendCompletionTimings }).backendTimings;
			// A server whose usage omits cache reads its own timings report is judged by those timings (#434).
			const timed = serverTimedUsage(settlement, backend);
			const physics = cachePhysics({
				settlement: timed ? { ...settlement, usage: timed } : settlement,
				structure,
				previous: cacheBaselines.get(key),
				pricing: resolveEffectivePricing(resolution.target, resolution.runtime, resolution.wireModelId),
			});
			if (physics.baseline) cacheBaselines.set(key, physics.baseline);
			else cacheBaselines.delete(key);
			const usage = (message as { usage?: Record<string, unknown> }).usage ?? {};
			const verdict =
				settlement.disposition === "settled" && typeof usage.input === "number" && typeof usage.cacheRead === "number"
					? backendCacheVerdict(
							usage.input,
							usage.cacheRead,
							backend,
							typeof usage.cacheReadReported === "boolean" ? usage.cacheReadReported : undefined,
						)
					: "unknown";
			return {
				...settlement,
				cache: {
					...settlement.cache,
					...physics.cache,
					...(timed ? { uncachedPrefillTokens: timed.input } : {}),
					expectedColdReasons: sent ? reasons : [],
					verdict,
				},
			};
		};
		// A call the producer relabels never sent, because its stages never reached the send, leaves its expected cold
		// reasons to the next call the provider sees, as one the runtime already knew was unsent does (#434).
		const carryRelabelledReasons = (
			settlement: ReturnType<typeof callSettlementFromMessage>,
			facts: CallSettled | undefined,
		): void => {
			if (facts?.disposition === "never_sent" && settlement.disposition !== "never_sent")
				carriedColdReasons = [...new Set([...carriedColdReasons, ...settlement.cache.expectedColdReasons])];
		};
		const recordSettledCall = (
			facts: CallSettled | undefined,
			owner: TelemetrySessionLease["context"] | undefined,
			hidden = false,
		): void => {
			if (facts) settledAttempts.push(facts);
			if (!facts || !deps.telemetry || owner?.sessionId !== deps.sessionOrigin?.()?.id) return;
			// A call belongs to the turn its lease was taken for, never to whichever turn is active when it settles,
			// including a stream that settles after its run ended (#434).
			if (owner?.turnId) turnCalls.set(owner.turnId, [...(turnCalls.get(owner.turnId) ?? []), facts]);
			if (!currentRun()) return;
			// Final never-sent messages are counted when persisted; hidden retries have no ledger row (#430, #434).
			if (hidden && facts.disposition === "never_sent") deps.telemetry.recordNeverSentCalls(1);
			for (const call of usageCallsFromAttempts([{ started: facts, settled: facts }])) {
				recordUsageCall(deps.telemetry, call);
			}
		};
		const settleModelCall = async (message: AgentMessage): Promise<boolean> => {
			const call = modelCall;
			const lease = journalLease;
			modelCall = undefined;
			journalLease = undefined;
			if (call) {
				Object.assign(message, { callId: call.callId, attemptId: call.attemptId });
				const quota = quotaReadingFromMessage(message, localRuntime.runtimeId, localRuntime.targetId);
				const settlement = withCachePhysics(
					callSettlementFromMessage(
						message,
						localRuntime.runtimeResolution.costProvenance,
						message.role === "assistant" && message.stopReason === "aborted" && state.activeInterruptByOperator
							? "operator_cancel"
							: undefined,
					),
					message,
				);
				const facts = call.settle(
					{
						...settlement,
						...(quota ? { quota: { provider: quota.provider, windows: quota.windows, source: quota.source } } : {}),
					},
					reportedModelFromMessage(message),
				);
				carryRelabelledReasons(settlement, facts);
				recordSettledCall(facts, lease?.context);
				if (quota && facts) recordQuotaReading(quota, lease?.context, facts);
				rememberMessageCalls(message, settledAttempts);
			}
			await lease?.release();
			return call !== undefined;
		};
		// A round the loop moves past without an assistant message still settles its attempt, so no call.started stays
		// open and no lease is held past the run (#434, R9). It has no ledger row, so a never-sent one is counted here.
		const abandonModelCall = async (): Promise<void> => {
			const call = modelCall;
			const lease = journalLease;
			modelCall = undefined;
			journalLease = undefined;
			attemptRequest = undefined;
			if (call) {
				recordSettledCall(
					call.abandon(state.activeInterruptByOperator ? "operator_cancel" : "internal"),
					lease?.context,
					true,
				);
			}
			await lease?.release();
		};
		// The journal's call for the next model response of this run (#434).
		const openModelCall = async (): Promise<void> => {
			const origin = deps.sessionOrigin?.();
			if (!origin || !deps.telemetry?.acquireTelemetrySession) return;
			journalLease = await deps.telemetry.acquireTelemetrySession(origin, "main", state.activeUserTurnId ?? undefined);
			const compiled = context.compiledSessionPrompt?.();
			const objects = await journalLease.storeRequestObjects?.({
				...(compiled ? { prompt: compiled } : {}),
				tools: localRuntime.agent.state.tools.map(({ name, description, parameters }) => ({
					name,
					description,
					parameters,
				})),
			});
			const choice = middlewareToolChoice.current();
			const textOnly = state.synthesisToolLock || choice.kind === "none";
			modelCall = beginCall(
				{
					label: "main",
					...(objects && Object.keys(objects).length > 0 ? { objects } : {}),
					target: {
						targetId: localRuntime.targetId,
						runtimeId: localRuntime.runtimeId,
						api: model.api,
						requestedModel: localRuntime.wireModelId,
						reportedModel: { kind: "unknown", reason: "not-observed" },
					},
					roundKind: textOnly ? "text-only" : choice.kind === "required" ? "required" : "normal",
					toolChoice: textOnly ? "none" : choice.kind === "required" ? { name: choice.toolName } : "auto",
				},
				journalLease.context,
			);
			if (objects?.promptStructure && compiled)
				journalLease.recordPromptCompiled?.(
					objects.promptStructure,
					{
						layoutVersion: PROMPT_MANIFEST_VERSION,
						tokenEstimate: Math.max(0, Math.round(compiled.tokenEstimate)),
						sections: compiled.sections.length,
						...(localRuntime.agent.state.thinkingLevel
							? { thinkingLevel: String(localRuntime.agent.state.thinkingLevel) }
							: {}),
					},
					{ ...journalLease.context, callId: modelCall.callId, attemptId: modelCall.attemptId },
				);
			modelCall.stage("transform", "start");
		};
		let apiCallFirstDeltaAt: number | null = null;
		// Where a request is before `onStreamInvocation`. A watchdog abort while
		// `apiCallStartedAt` is null names this step, because no request has
		// reached the provider it would otherwise blame (#423).
		let preInvocationStage: PreInvocationStage = "transform";
		let unsettledSpendUsd = 0;
		let admittedMessages: readonly AgentMessage[] = [];
		let admittedSystemPrompt = "";
		let requiredToolReminder: string | null = null;
		clearCurrentWatchdog();
		let runIdentity = deps.turnIdentity?.();
		const currentRun = (): boolean => runIdentity === deps.turnIdentity?.();
		// One span covers Pi's whole pre-invocation gate; `waitedOn` names the ceiling that held it, so a
		// budget wait reads as admission and never as a stall (#424, #434).
		const stageAdmission =
			(admit: (request: Parameters<StreamAdmission>[0], hold: AdmissionHold) => ReturnType<StreamAdmission>) =>
			async (request: Parameters<StreamAdmission>[0]): Promise<Awaited<ReturnType<StreamAdmission>>> => {
				const call = modelCall;
				const hold: AdmissionHold = {};
				call?.stage("admission", "start");
				try {
					return await admit(request, hold);
				} finally {
					call?.stage("admission", "end", hold);
				}
			};
		const handle = deps.createAgent({
			transcriptStreamFn: (currentModel, currentContext, options) => {
				const middlewareChoice = middlewareToolChoice.current();
				// A locked round has no named tool to require; it is text-only.
				const controlled = applyToolRounds(
					currentModel,
					currentContext,
					options,
					[
						state.synthesisToolLock || middlewareChoice.kind === "none" ? { kind: "text-only" } : undefined,
						middlewareChoice.kind === "required" && !state.synthesisToolLock
							? { kind: "required", toolName: middlewareChoice.toolName }
							: undefined,
					],
					target.target.id,
				);
				delete localRuntime.lastProviderStatus;
				const tracking = trackCallFetch(controlled.options?.fetch);
				callTracking = tracking;
				tracking.start(currentModel.api, controlled.options?.transport);
				let invokedAttempt = false;
				const pinnedPrefix = enginePinnedPrefix(localRuntime.agent);
				return streamToolRound(
					currentModel,
					controlled,
					(request) => {
						const retry = invokedAttempt;
						if (retry && modelCall) modelCall = modelCall.nextAttempt({ toolChoice: "auto" }) ?? modelCall;
						invokedAttempt = true;
						const attempt = modelCall;
						// The first attempt's send opened at onStreamInvocation; a #426 retry opens its own here.
						attempt?.stage("send", "start");
						// #423: fingerprint the control this attempt sends, including a #426 recovery retry.
						context.noteCacheRequestToolChoice?.(JSON.stringify(request.options?.toolChoice ?? "auto"), retry);
						delete localRuntime.lastProviderStatus;
						const requestOptions = {
							...request.options,
							fetch: tracking.fetch,
							...(pinnedPrefix ? { clioCoderPinnedPrefix: pinnedPrefix } : {}),
							onResponse: async (...args: Parameters<NonNullable<NonNullable<typeof request.options>["onResponse"]>>) => {
								// Pi can discard HTTP 401 when rendering the body's friendly message (#427).
								localRuntime.lastProviderStatus = args[0].status;
								// Pi retries a retryable status inside one attempt; the first byte is the response that
								// opens the stream. Transports that never report a response leave it unobserved (#434).
								if (args[0].status >= 200 && args[0].status < 300) attempt?.mark("firstByte");
								await request.options?.onResponse?.(...args);
							},
						};
						let sent = request.context;
						if (state.synthesisToolLock || (middlewareChoice.kind === "none" && request.options?.toolChoice === "auto")) {
							const resolved = resolvedRequestContext(request.context);
							sent = { ...resolved, systemPrompt: lockedSynthesisSystemPrompt(resolved.systemPrompt ?? "") };
						}
						if (attempt) {
							attemptRequest = {
								model: currentModel,
								context: sent,
								compiled: context.compiledSessionPrompt?.() ?? null,
								coldReasons: [...new Set([...carriedColdReasons, ...(context.takeCallColdReasons?.() ?? [])])],
							};
							carriedColdReasons = [];
							// Research capture: the prefix exactly as this attempt sends it, hashed (#423, #434).
							attempt.withContext(() => {
								if (!telemetryCaptures("prefix.blocks")) return;
								const blocks = prefixBlocksOf(context.compiledSessionPrompt?.() ?? null, sent);
								if (blocks) recordTelemetry("prefix.blocks", blocks);
							});
						}
						// The provider stream runs inside the attempt's context, so the engine seam and every observer below it
						// find this call; the seam's marks agree with the ones taken here because each keeps its first (#434).
						const stream = attempt
							? attempt.withContext(() => engineMainStreamSimple(currentModel, sent, requestOptions))
							: engineMainStreamSimple(currentModel, sent, requestOptions);
						// send.end is the handoff to Pi's provider, which owns serialization and the socket under
						// transport option B. The journal's TTFT is firstToken minus this mark (#434).
						attempt?.stage("send", "end");
						// #423: a cache keepalive replays exactly this request, without this turn's call tracker or status hook.
						const { fetch: _tracked, onResponse: _status, ...replayed } = requestOptions;
						deps.noteMainRequest?.(
							localRuntime,
							{
								model: currentModel,
								context: sent,
								options: {
									...replayed,
									...(request.options?.fetch ? { fetch: request.options.fetch } : {}),
									...(request.options?.onResponse ? { onResponse: request.options.onResponse } : {}),
								},
							},
							stream,
						);
						return stream;
					},
					target.target.id,
					(message) => {
						if (!modelCall) return;
						const terminal = terminalFailureFromAssistantMessage(message);
						const reported = normalizeTokenUsage((message.usage ?? {}) as unknown as Record<string, unknown>).observed;
						const failure = terminal
							? tracking.failure(terminal.errorMessage, terminal.stopReason === "aborted", reported)
							: undefined;
						const settlement = withCachePhysics(
							callSettlementFromMessage(
								{ ...message, ...(failure ? { failure } : {}) },
								localRuntime.runtimeResolution.costProvenance,
							),
							message,
						);
						const facts = modelCall.settle(settlement, reportedModelFromMessage(message));
						carryRelabelledReasons(settlement, facts);
						recordSettledCall(facts, journalLease?.context, true);
					},
				);
			},
			initialState: {
				systemPrompt: fallbackIdentityPrompt(),
				model,
				thinkingLevel: initialThinkingLevel,
				tools,
				messages: priorMessages,
			},
			maxRetryDelayMs: deps.retrySettings().maxDelayMs,
			// Everything Clio hands over at a slot lands before one model call, as
			// separate user messages; Pi's default would spend one call per message.
			steeringMode: "all",
			followUpMode: "all",
			...(gatewaySessionId ? { sessionId: gatewaySessionId } : {}),
			beforeToolBatch: ({ assistantMessage }) => {
				const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
				if (
					calls.some((call) => effectiveToolCall(call.name, call.arguments).toolName === "self_compact") &&
					calls.length !== 1
				) {
					return { reason: "self_compact must be the only call in its batch; no sibling was executed." };
				}
				return undefined;
			},
			beforeStreamRequest: stageAdmission(async ({ context: request, options: streamOptions }, hold) => {
				setGlobalDefaultMaxOutputTokens(deps.getSettings().chat.maxOutputTokens);
				callTracking = null;
				delete localRuntime.lastProviderStatus;
				if (!currentRun() || state.activeInterruptReason !== null || state.runtime !== localRuntime) {
					return { block: true, reason: "Request ownership changed before invocation." };
				}
				const flowViolation =
					deps.admitFlow?.({ targetId: target.target.id, runtimeId: target.runtime.id, wireModelId: target.wireModelId }) ??
					null;
				if (flowViolation !== null) {
					if (state.lastRunSnapshot) state.lastRunSnapshot.outcomeCode = "information_flow_blocked";
					return { block: true, reason: flowViolation };
				}
				if (state.lastRunSnapshot) delete state.lastRunSnapshot.outcomeCode;
				if (deps.hasQueuedSteering?.() && deps.continuity?.admission().block === false) {
					const handoff = deps.continuity.admission();
					if (!handoff.block && handoff.correlationId)
						return { block: true, reason: "Operator steering arrived during handoff preparation; handoff paused." };
				}
				const view = context.refreshLiveBudget();
				const resolved = resolvedRequestContext(request);
				const actual = state.synthesisToolLock
					? { ...resolved, systemPrompt: lockedSynthesisSystemPrompt(resolved.systemPrompt ?? "") }
					: request;
				const input = Math.max(estimateInputTokensFromContext(actual), view.inputTokens ?? 0);
				const output = resolveTurnOutputReserve(localRuntime, input);
				if (view.effectiveWindow !== null && !requestFits(input, output, view.effectiveWindow))
					return {
						block: true,
						reason: `Context window exceeded: input ${input} + output ${output}, window ${view.effectiveWindow ?? "unknown"}.`,
					};
				if (
					deps.scheduling &&
					(localRuntime.runtimeResolution.costProvenance === "known" ||
						localRuntime.runtimeResolution.costProvenance === "estimated")
				) {
					const recordBlock = (block: BudgetAlertPayload): void => {
						hold.waitedOn = "budget";
						persistence.appendBudgetBlock({
							...block,
							raiseToUsd: suggestedSessionCostCeilingUsd(block.currentUsd, block.ceilingUsd),
							setting: "safety.limits.sessionCostUsd",
						});
					};
					try {
						if (deps.scheduling.admitPaidRequest) {
							// A ceiling wait is the operator's decision, not a silent provider.
							// The watchdog re-arms through it as it does through a running
							// tool, so a budget stop is never aborted and retried as a stream
							// stall (#423).
							preInvocationStage = "budget admission";
							stallSuspendDepth += 1;
							try {
								await deps.scheduling.admitPaidRequest({
									waitForRaise: deps.headless !== true,
									additionalUsd: unsettledSpendUsd,
									getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
									contextTokens: input,
									onBlocked: recordBlock,
									...(modelCall && journalLease
										? {
												telemetry: {
													...journalLease.context,
													callId: modelCall.callId,
													attemptId: modelCall.attemptId,
												},
											}
										: {}),
									...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
								});
							} finally {
								stallSuspendDepth -= 1;
								lastActivityAt = performance.now();
							}
						} else {
							const { currentUsd, ceilingUsd, pricing } = deps.scheduling.preflight();
							if (sessionCeilingReached(currentUsd + unsettledSpendUsd, ceilingUsd)) {
								recordBlock({
									level: currentUsd + unsettledSpendUsd > ceilingUsd ? "over" : "at",
									currentUsd: currentUsd + unsettledSpendUsd,
									ceilingUsd,
									contextTokens: input,
									...(pricing ? { pricing } : {}),
								});
								throw new SessionCostCeilingError(currentUsd + unsettledSpendUsd, ceilingUsd, undefined, input, pricing);
							}
						}
					} catch (error) {
						return { block: true, reason: error instanceof Error ? error.message : String(error) };
					}
				}
				if (state.activeInterruptReason !== null || state.runtime !== localRuntime) {
					return { block: true, reason: "Request ownership changed while waiting for budget approval." };
				}
				if (observationTracing())
					traceObservation("actor-input", {
						sessionId: deps.sessionId?.() ?? null,
						target: target.target.id,
						model: target.wireModelId,
						window: view.effectiveWindow,
						inputTokens: input,
						outputTokens: output,
						context: resolved,
					});
				preInvocationStage = "admission";
				const admission = deps.continuity?.admission() ?? { block: false };
				admittedMessages = admission.block ? [] : resolved.messages;
				admittedSystemPrompt = admission.block ? "" : (resolved.systemPrompt ?? "");
				return admission;
			}),
			onStreamInvocation: () => {
				deps.onMemoryRequestSubmitted?.(admittedMessages, admittedSystemPrompt);
				setGlobalDefaultMaxOutputTokens(deps.getSettings().chat.maxOutputTokens);
				// Legacy ttftMs counts from here, so it includes Clio's request shaping and any provider-replay
				// rebuild; the journal's TTFT starts at send.end, the handoff to Pi's provider (#434).
				apiCallStartedAt = performance.now();
				apiCallFirstDeltaAt = null;
				modelCall?.stage("send", "start");
			},
			getApiKey: async () => {
				// Pi converts the conversation between turn_start and this call; that is the transform stage (#434).
				const call = modelCall;
				call?.stage("transform", "end");
				if (!targetRequiresAuth(target.target, target.runtime)) {
					return LOCAL_API_KEY_FALLBACK;
				}
				preInvocationStage = "auth";
				call?.stage("auth", "start");
				let refreshed: boolean | undefined;
				try {
					const signal = getCurrentAgentSignal();
					const resolved = await deps.providers.auth.resolveForTarget(
						target.target,
						target.runtime,
						signal ? { signal } : undefined,
					);
					refreshed = resolved.refreshed;
					if (!currentRun() || signal?.aborted) throw new Error("Request ownership changed while resolving authentication.");
					localRuntime.lastAuthResolution = resolved;
					// A failed OAuth refresh carries its remedy in detail; Pi's own "No API key" error would drop it.
					if (
						resolved.apiKey === undefined &&
						resolved.source === "stored-oauth" &&
						resolved.detail &&
						resolved.detail !== resolved.providerId
					)
						throw new Error(resolved.detail);
					return resolved.apiKey;
				} finally {
					call?.stage("auth", "end", refreshed === undefined ? {} : { refreshed });
				}
			},
		});
		getCurrentAgentSignal = () => handle.agent.signal;

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
		if (!options?.silent) emitThinkingClampNotice(target.runtimeResolution);

		// Stall watchdog. `agent_start` arms a timer for `retry.streamStallMs`;
		// every later engine event counts as progress and pushes the deadline
		// out. When the deadline passes with nothing from the stream, the
		// backend is presumed wedged (the server answers /health while its slot
		// is dead) and the run is aborted through the same `agent.abort()` call
		// Esc uses. `state.streamStallReason` is what tells the two aborts apart
		// once the run settles: `turn-recovery.reclassifyStallAbort` reads it and
		// hands the failure to the transient retry ladder, while an operator
		// cancel still ends the turn.
		//
		// Idle is measured on `performance.now()`. Wall time is not a duration:
		// a forward step of one threshold or more (NTP correcting a node that
		// booted without an RTC battery, a laptop resuming from suspend) would
		// otherwise make a healthy stream look silent and abort it through the
		// operator-cancel path.
		//
		// `toolsInFlight` and `stallSuspendDepth` cover the windows where silence
		// is expected and the stream is not the thing we are waiting on: a tool
		// executing (a `npm run ci` that takes ten minutes is not a stalled
		// stream), the post-tool continuation guard, whose auto-compaction is its
		// own model call, and a paid request parked at the session cost ceiling
		// (#423). The watchdog re-arms instead of firing while either
		// is above zero. They are counted apart because only the tool half can
		// leak: the guard's depth is a try/finally around one await, while a
		// `tool_execution_end` that never arrives would disable the watchdog for
		// the rest of the run. The engine settles an entire tool batch before it
		// emits `turn_end`, so that event bounds the tool suspension below.
		let lastActivityAt = performance.now();
		let toolsInFlight = 0;
		let stallSuspendDepth = 0;
		let stallTimer: ReturnType<typeof setTimeout> | null = null;
		const clearStallTimer = (): void => {
			if (stallTimer === null) return;
			clearTimeout(stallTimer);
			stallTimer = null;
		};
		clearCurrentWatchdog = clearStallTimer;
		const armStallTimer = (delayMs: number): void => {
			if (disposed || !currentRun() || localRuntime.agent.signal?.aborted) return;
			stallTimer = setTimeout(
				() => {
					stallTimer = null;
					const retry = deps.retrySettings();
					// Zero disables the escalation; an operator who wants a stream to
					// hang forever keeps that by setting `retry.streamStallMs: 0`.
					if (retry.streamStallMs <= 0) return;
					if (stallSuspendDepth > 0 || toolsInFlight > 0) {
						armStallTimer(retry.streamStallMs);
						return;
					}
					// Silence before a call's first delta is not silence mid-stream. A
					// local server that slept reloads the model and prefills cold before
					// it can emit anything, which is minutes of healthy quiet; a stream
					// that already produced output and stops is a wedged slot.
					const awaitingFirstToken = apiCallStartedAt !== null && apiCallFirstDeltaAt === null;
					if (awaitingFirstToken && retry.firstTokenStallMs <= 0) {
						armStallTimer(retry.streamStallMs);
						return;
					}
					const stallMs = awaitingFirstToken ? Math.max(retry.firstTokenStallMs, retry.streamStallMs) : retry.streamStallMs;
					const idleMs = performance.now() - lastActivityAt;
					if (idleMs < stallMs) {
						armStallTimer(stallMs - idleMs);
						return;
					}
					state.streamStallStage = apiCallStartedAt === null ? preInvocationStage : null;
					state.streamStallReason = stallAbortReason(
						localRuntime.targetId,
						idleMs,
						state.streamStallStage,
						awaitingFirstToken,
					);
					localRuntime.agent.abort();
				},
				Math.max(1, delayMs),
			);
			// The in-flight request already holds the event loop open; this timer
			// must not keep a settled headless run alive on its own.
			stallTimer.unref?.();
		};

		handle.agent.prepareNextTurnWithContext = async (_completed, signal?: AbortSignal) => {
			stallSuspendDepth += 1;
			try {
				if (!currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
				if (deps.hasQueuedSteering?.()) await deps.continuity?.pause();
				const handoffChanged = (await deps.continuity?.settle(signal)) ?? false;
				if (!currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
				const continued = await deliverInRunContinuation(signal);
				const requirementChanged = requiredToolReminder !== null;
				if (requiredToolReminder !== null) {
					// Context-only host tails preserve task authority and the cached prefix (#423).
					localRuntime.agent.state.messages.push({ role: "user", content: requiredToolReminder, timestamp: Date.now() });
					requiredToolReminder = null;
				}
				const contextChanged =
					(await middleware.prepareToolContinuation(localRuntime, signal)) ||
					handoffChanged ||
					continued ||
					requirementChanged;
				const update = await context.postToolContinuationGuard(localRuntime, signal, contextChanged);
				if (!currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
				const restored = context.installMemoryRestoration(localRuntime);
				if (!currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
				// Preparation can be long (compaction). A message typed during it is
				// handed over now so Pi's poll right after this hook takes it.
				deps.queueHandOver?.afterPrepareNextTurn();
				// Compaction owns any replacement snapshot. Without one, publish the
				// already-accounted reminder through context, not message events that
				// would manufacture a new operator turn and reset task authority.
				return (
					(!restored ? update : undefined) ??
					(contextChanged || restored
						? {
								context: {
									messages: [...localRuntime.agent.state.messages],
									tools: [...localRuntime.agent.state.tools],
								},
							}
						: undefined)
				);
			} finally {
				stallSuspendDepth -= 1;
				lastActivityAt = performance.now();
			}
		};

		// The run's final turn is where turn_end fires, so a middleware
		// request_continuation (stalled turn, open tasks, finish contract,
		// detached batches, skill wait) carries the run on inside it instead of
		// resubmitting a fresh prompt after the turn rendered Done, which showed
		// the operator two completions for one request. agent_end fires turn_end
		// only for a final message this hook never saw: an engine that does not
		// call finishTurn, or its thrown-failure path.
		let turnEndFiredFor: AgentMessage | null = null;
		handle.agent.finishTurn = async (turn) => {
			// A tool batch that did not terminate, or an operator message already
			// queued, carries the run on: this is not its final turn.
			const final = !hasStructuredToolCall(turn.message) || pendingTerminalToolResult !== null;
			// Operator messages waiting in Clio's queue reach the engine here, after
			// the tool batch and before Pi's steering poll, so the check below sees
			// them and the run carries on with them instead of ending around them.
			// An errored or aborted turn hands nothing over; the settle path decides.
			if (
				turn.message.stopReason !== "error" &&
				turn.message.stopReason !== "aborted" &&
				state.activeInterruptReason === null
			) {
				deps.queueHandOver?.atFinishTurn(final);
			}
			if (!final || localRuntime.agent.hasQueuedMessages?.() === true) return undefined;
			if (requiredToolReminder !== null && currentRun() && state.activeInterruptReason === null) {
				persistence.continueTracedTurn();
				return { action: "continue" };
			}
			const terminal = pendingTerminalToolResult;
			pendingTerminalToolResult = null;
			if (terminal) persistence.appendTerminalToolAssistantTurn(terminal);
			context.flushReconciledSnapshot();
			turnEndFiredFor = turn.message;
			stallSuspendDepth += 1;
			try {
				await middleware.fireTurnEnd(localRuntime, localRuntime.agent.state.messages, terminal ?? undefined);
			} finally {
				stallSuspendDepth -= 1;
				lastActivityAt = performance.now();
			}
			if (!currentRun() || !state.pendingRequestContinuation || state.activeInterruptReason !== null) return undefined;
			if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
			state.pendingRequestContinuation = false;
			state.pendingInRunContinuation = true;
			persistence.continueTracedTurn();
			return { action: "continue" };
		};
		// What the post-settle resubmit did between runs, done inside this one:
		// a fresh per-turn tool count, the turn controller's collection, a
		// turn_start marked as a continuation, and the buffered continuation
		// reminders as model-only context.
		const deliverInRunContinuation = async (signal?: AbortSignal): Promise<boolean> => {
			if (!state.pendingInRunContinuation) return false;
			state.pendingInRunContinuation = false;
			state.turnToolCalls = 0;
			state.turnToolNames = [];
			middlewareToolChoice.reset();
			let block: string | null = null;
			try {
				block = (await deps.prepareInRunContinuation?.(signal)) ?? null;
			} catch {
				// Collection is best effort; the continuation reminder still goes out.
			}
			if (!currentRun() || signal?.aborted || state.activeInterruptReason !== null) return false;
			middleware.fireTurnStart(localRuntime, "", 0, true);
			// The reminder block leads: only a block opening the message is host
			// framing, and the orientation block quotes scout findings.
			const content = [middleware.flushPendingReminders(), block]
				.filter((part): part is string => part !== null && part.length > 0)
				.join("\n\n");
			if (content.length === 0) return false;
			localRuntime.agent.state.messages.push({ role: "user", content, timestamp: Date.now() });
			return true;
		};

		const generationTiming = createAssistantGenerationTiming();
		// First call of the run is the one whose verdict says whether the
		// backend reused the session prefix; later calls in a tool loop are
		// trivially warm.
		let runFirstCallVerdict: BackendCacheVerdict | null = null;
		// artifact plan/review/report set ToolResult.terminate=true so the agent
		// loop skips the follow-up LLM call that would otherwise produce the
		// assistant message carrying the turn's terminal stopReason. Track the
		// most recent terminating tool result here; a real assistant
		// message_end (the follow-up call did happen, e.g. another tool in the
		// same batch did not also set terminate) clears it. If it is still set
		// at agent_end, no terminal ledger row was ever written for this turn,
		// so one is synthesized below.
		let pendingTerminalToolResult: { toolCallId: string; toolName: string } | null = null;
		// state.messages length when this run started; agent state appends every
		// message of the run (prompts, assistant, tool results) via message_end,
		// so the slice from here is the run's real message window.
		let runStartMessageCount = 0;

		const onAgentEvent = async (event: AgentEvent): Promise<void> => {
			if (event.type === "agent_start") runIdentity = deps.turnIdentity?.();
			if (event.type === "agent_end") await abandonModelCall();
			if (!currentRun()) {
				if (event.type === "message_end" && event.message.role === "assistant") await settleModelCall(event.message);
				clearStallTimer();
				return;
			}
			if (event.type === "turn_start") {
				await abandonModelCall();
				settledAttempts = [];
				attemptRequest = undefined;
				await openModelCall();
			}
			// Every span below is measured on the monotonic frame, so an NTP
			// correction mid-turn cannot corrupt a tool duration or a TTFT.
			const eventClock = performance.now();
			lastActivityAt = eventClock;
			let enrichedEvent = event;
			if (event.type === "message_end" && event.message.role === "assistant") {
				requiredToolReminder = middlewareToolChoice.completeRound(event.message);
			}
			if (event.type === "tool_execution_start") {
				toolsInFlight += 1;
				middlewareToolChoice.toolStarted(event.toolName);
				deps.toolStartTimes.set(event.toolCallId, eventClock);
				state.turnToolCalls += 1;
				// Turn-end detectors (#184 skill wait) reason about the capability
				// that ran, which for the coordinator is usually behind gateway op=call.
				state.turnToolNames.push(effectiveToolCall(event.toolName, event.args).toolName);
			} else if (event.type === "tool_execution_end") {
				toolsInFlight = Math.max(0, toolsInFlight - 1);
				const startedAt = deps.toolStartTimes.get(event.toolCallId);
				deps.toolStartTimes.delete(event.toolCallId);
				// Carry the registry's verdict alongside the engine's result. The
				// panel classifies settlement from `outcome`; without it the only
				// available signal is result text, and grepping that text for
				// "blocked"/"cancelled" labels every failing `node --test` run
				// (which prints `cancelled 0`) a permission block.
				const admission = toolOutcomes.get(event.toolCallId);
				toolOutcomes.delete(event.toolCallId);
				// The registry's own span is the one that means "how long the tool
				// took": the engine's start-to-end frame also covers the operator,
				// because a call awaiting a permission decision is parked between
				// those two events. Approving `wc -l src/*.ts | sort -n` after 25
				// seconds of reading rendered it as a 31-second command.
				const engineSpan = startedAt === undefined ? undefined : Math.round(Math.max(0, eventClock - startedAt));
				const durationMs = admission?.durationMs ?? engineSpan;
				enrichedEvent = {
					...event,
					...(durationMs !== undefined ? { durationMs } : {}),
					resultSummary: toolResultSummary(event.result),
					...(admission === undefined
						? {}
						: {
								outcome: admission.outcome,
								// The registry's per-call classification and admission
								// decision. Headless receipts count safety decisions and
								// tell a successful write from any other success with
								// these, the same facts a worker's receipt is built from.
								...(admission.actionClass === undefined ? {} : { actionClass: admission.actionClass }),
								...(admission.decision === undefined ? {} : { decision: admission.decision }),
								...(admission.deniedPark === true ? { deniedPark: true } : {}),
								...(admission.redundantRepeat === true ? { redundantRepeat: true } : {}),
								...(admission.ruleId === undefined ? {} : { ruleId: admission.ruleId }),
								...(admission.reasonCode === undefined ? {} : { reasonCode: admission.reasonCode }),
								...(admission.policySource === undefined ? {} : { policySource: admission.policySource }),
								...(admission.reason === undefined ? {} : { blockReason: admission.reason }),
								...(admission.denial === undefined ? {} : { denial: admission.denial }),
							}),
				} as typeof event;
			} else if (event.type === "agent_end") {
				// The engine's failure path (an abort or a thrown provider error)
				// replaces the run's message window with one synthetic zero-usage
				// failure message, which zeroed token usage, tool counts, and cache
				// records for every aborted turn. Rebuild the real window from agent
				// state, which already holds all of this run's messages plus that
				// failure message.
				const runMessages = localRuntime.agent.state.messages.slice(runStartMessageCount);
				if (runMessages.length > event.messages.length) {
					enrichedEvent = { ...event, messages: runMessages } as typeof event;
				}
			} else if (event.type === "message_end" && state.synthesisToolLock) {
				// Synthesis-locked turn: a model that ignores tool_choice none emits
				// its chat template's tool-call syntax as plain text. Sanitize the
				// message in place (pi stores this same object in agent state, so
				// the emitted event, ledger persistence below, and later provider
				// rounds all see the sanitized text) and mark the event so the
				// panel replaces its streamed markup tail instead of appending.
				if (sanitizeLockedSynthesisMessage(event.message)) {
					enrichedEvent = { ...event, lockedSynthesisSanitized: true } as typeof event;
				}
			}
			// The run's start and end name the operator turn its calls journal under, so the transcript receipt reads
			// that turn's spend from the read model (#434 §11.3).
			if ((enrichedEvent.type === "agent_start" || enrichedEvent.type === "agent_end") && state.activeUserTurnId)
				enrichedEvent = { ...enrichedEvent, turnId: state.activeUserTurnId } as unknown as typeof enrichedEvent;
			let publicEvent = enrichedEvent;
			let journalAccounted = false;
			if (enrichedEvent.type === "message_end" && enrichedEvent.message?.role === "assistant") {
				const message = enrichedEvent.message;
				const usage = (message.usage ?? {}) as unknown as Record<string, unknown>;

				const observed = normalizeTokenUsage(usage).observed;
				const responseId = (message as { responseId?: unknown }).responseId;
				const responseObserved = observed || (typeof responseId === "string" && responseId.length > 0);
				const terminal = terminalFailureFromAssistantMessage(message);
				if (terminal) {
					const tracked = callTracking?.failure(terminal.errorMessage, terminal.stopReason === "aborted", responseObserved);
					const status =
						(message as unknown as { anthropicResponse?: { status?: number } }).anthropicResponse?.status ??
						localRuntime.lastProviderStatus;
					const failure = classifyCallFailure(state.streamStallReason ?? terminal.errorMessage, {
						invoked: responseObserved || (tracked?.invoked ?? apiCallStartedAt !== null),
						httpStatus: status !== undefined && status >= 400 ? status : (tracked?.httpStatus ?? null),
						retryAttempts: tracked?.retryAttempts ?? 0,
						aborted: terminal.stopReason === "aborted" && state.streamStallReason === null,
						transportFailed: tracked?.stage === "transport",
					});
					Object.assign(message, {
						failure:
							!failure.invoked && preInvocationStage === "budget admission"
								? { ...failure, stage: "budget", errorClass: "budget_wait" }
								: failure,
					});
					Object.assign(message, { callInvoked: failure.invoked });
				} else {
					Object.assign(message, { callInvoked: apiCallStartedAt !== null || responseObserved });
				}
				const costProvenance = !observed
					? "unknown"
					: (usage.clioExternal as { cost?: string } | undefined)?.cost === "provider-reported"
						? "known"
						: localRuntime.runtimeResolution.costProvenance;
				Object.assign(message, {
					callAccounting: { usageObserved: observed, costProvenance, targetId: localRuntime.targetId },
				});
				const gatewayRouting = gatewayRoutingObservationFromRecord(
					enrichedEvent.message as unknown as Record<string, unknown>,
				);
				if (
					gatewayRouting !== null &&
					((gatewayRouting.attemptedFallbacks ?? 0) > 0 || (gatewayRouting.attemptedRetries ?? 0) > 0)
				) {
					deps.emitNotice(`[Clio Coder] ${gatewayRoutingObservationLabel(gatewayRouting)}`);
				}
				const interruptedUsage = estimatedUsageForInterruptedTurn(enrichedEvent.message, context.promptSideTokens());
				if (interruptedUsage !== null) {
					// Preserve the display estimate without replacing provider usage (#423, #430).
					Object.assign(enrichedEvent.message, { estimatedUsage: interruptedUsage });
				}
				journalAccounted = await settleModelCall(enrichedEvent.message);
				// A reply Clio wrote into the prompt, such as the loop guard's recovery pair, settles the call opened at
				// turn_start as never sent, as its ledger row counts it; the model's own reply gets a call of its own (#434).
				if (isHostAuthored(message)) await openModelCall();
			}

			if (publicEvent?.type === "message_end" && publicEvent.message.role === "assistant" && apiCallStartedAt !== null) {
				publicEvent = {
					...publicEvent,
					modelTimeMs: Math.round(Math.max(0, eventClock - apiCallStartedAt)),
					ttftMs: apiCallFirstDeltaAt === null ? null : Math.round(Math.max(0, apiCallFirstDeltaAt - apiCallStartedAt)),
				} as typeof publicEvent;
			}
			if (publicEvent) generationTiming.record(publicEvent, eventClock);
			if (publicEvent?.type === "agent_start") {
				persistence.deferTraceClose(true);
				turnEndFiredFor = null;
				state.pendingInRunContinuation = false;
				runStartMessageCount = localRuntime.agent.state.messages.length;
				apiCallStartedAt = null;
				apiCallFirstDeltaAt = null;
				preInvocationStage = "transform";
				runFirstCallVerdict = null;
				pendingTerminalToolResult = null;
				clearStallTimer();
				toolsInFlight = 0;
				stallSuspendDepth = 0;
				state.streamStallReason = null;
				state.streamStallStage = null;
				const stallMs = deps.retrySettings().streamStallMs;
				if (stallMs > 0) armStallTimer(stallMs);
			}
			// The engine runs the whole tool batch to settlement before it emits
			// `turn_end`, so nothing from this turn can still be executing here.
			// A call whose `tool_execution_end` was never emitted (a crashed
			// mediator, a dropped frame) therefore stops suspending the watchdog
			// at the turn that issued it instead of for the rest of the run.
			if (publicEvent?.type === "turn_end") toolsInFlight = 0;
			if (publicEvent?.type === "message_update") {
				const hasDelta = hasAssistantGenerationDelta(publicEvent.assistantMessageEvent);
				if (hasDelta && apiCallFirstDeltaAt === null) {
					apiCallFirstDeltaAt = eventClock;
					modelCall?.mark("firstToken");
					// The timer may be armed for the longer first-token window; the
					// stream is live now, so the mid-stream window applies from here.
					const stallMs = deps.retrySettings().streamStallMs;
					clearStallTimer();
					if (stallMs > 0) armStallTimer(stallMs);
				}
			}
			if (enrichedEvent.type === "agent_end") {
				context.noteRunCacheSummary(enrichedEvent.messages, runFirstCallVerdict);
			}
			if (enrichedEvent.type === "message_end" && enrichedEvent.message.role === "assistant") {
				const completed = sumRunUsage([enrichedEvent.message]);
				if (!deps.telemetry && completed.hadUsage && Number.isFinite(completed.costUsd) && completed.costUsd > 0) {
					unsettledSpendUsd += completed.costUsd;
				}
			}
			if (
				enrichedEvent.type === "message_end" &&
				enrichedEvent.message.role === "assistant" &&
				deps.telemetry &&
				!journalAccounted
			) {
				const summary = sumRunUsage([enrichedEvent.message]);
				const rawUsage = messageUsageForAccounting(enrichedEvent.message) ?? {};
				const reported = normalizeTokenUsage(rawUsage ?? {});
				if (summary.hadUsage && rawUsage.callInvoked === true) {
					deps.telemetry.recordTokens(
						localRuntime.targetId,
						attributedModelId(
							summary.lastResponseModelIdObservation,
							localRuntime.wireModelId,
							summary.lastDifferingResponseModelId,
						),
						reported.totalTokens,
						rawUsage.estimated === true ? 0 : summary.costUsd,
						{
							input: reported.input,
							output: reported.output,
							cacheRead: reported.cacheRead,
							cacheWrite: reported.cacheWrite,
							...(summary.cacheWrite1h === undefined ? {} : { cacheWrite1h: summary.cacheWrite1h }),
							reasoningTokens: reported.reasoning,
							totalTokens: reported.totalTokens,
							apiCalls: summary.apiCalls,
							...(!reported.observed ? { missingTokenCalls: 1 } : {}),
						},
						rawUsage.estimated === true
							? "unknown"
							: (rawUsage.costProvenance as AgentRuntime["runtimeResolution"]["costProvenance"]),
						{
							requestedModelIds: [localRuntime.wireModelId],
							responseModelIdObservationCounts: summary.responseModelIdObservationCounts,
						},
					);
				}
			}
			if (enrichedEvent.type === "agent_end" && deps.telemetry) {
				const timing = generationTiming.snapshot(eventClock);
				const generated = generationTiming.output();
				if (generated.outputTokens > 0 && timing) {
					const durationMs = Math.round(timing.durationMs);
					deps.telemetry.recordTokenThroughput({
						tokensPerSecond: generated.outputTokens / (durationMs / 1000),
						...generated,
						durationMs,
						ttftMs: Math.round(timing.ttftMs),
					});
				}
			}
			if (enrichedEvent.type === "agent_end") unsettledSpendUsd = 0;
			// Suppress the hollow transcript event while its closing turn keeps the call's accounting (#430).
			if (
				state.activeInterruptReason !== null &&
				enrichedEvent.type === "message_end" &&
				isEmptyAbortedAssistantMessage(enrichedEvent.message)
			) {
				persistence.appendAssistantTurn(
					enrichedEvent.message,
					apiCallStartedAt === null
						? null
						: {
								ttftMs: apiCallFirstDeltaAt === null ? null : Math.round(Math.max(0, apiCallFirstDeltaAt - apiCallStartedAt)),
								apiMs: Math.round(Math.max(0, eventClock - apiCallStartedAt)),
							},
				);
				return;
			}
			if (publicEvent) deps.emit(publicEvent);
			if (publicEvent?.type === "message_update") {
				const assistantEvent = publicEvent.assistantMessageEvent as {
					type: string;
					contentIndex?: number;
					delta?: string;
					partial?: AgentMessage;
				};
				if (assistantEvent.type === "text_delta") {
					const partialText = extractText(assistantEvent.partial);
					const frame = readDiffusionFrame(assistantEvent);
					if (frame) {
						deps.emit({
							type: "text_frame",
							contentIndex: assistantEvent.contentIndex ?? 0,
							text: frame.text,
							progress: frame.progress,
						});
					} else {
						deps.emit({
							type: "text_delta",
							contentIndex: assistantEvent.contentIndex ?? 0,
							delta: assistantEvent.delta ?? "",
							partialText,
						});
					}
					const localToolRuntime = runtimeNarratesToolCalls(localRuntime.runtimeResolution.runtimeTier);
					if (
						localToolRuntime &&
						state.toolProseAbortReason === null &&
						shouldAssessToolProse(partialText.length, state.toolProseAssessedChars)
					) {
						state.toolProseAssessedChars = partialText.length;
						const activeToolNames = toolNamesFromAgentState(localRuntime.agent.state.tools);
						const assessment = assessToolProseLoop({
							text: partialText,
							activeToolNames,
							...(activeToolNames.includes("gateway") && deps.gatewayCapabilityNames
								? { gatewayToolNames: deps.gatewayCapabilityNames() }
								: {}),
							hasStructuredToolCall: hasStructuredToolCall(assistantEvent.partial),
						});
						if (assessment.kind === "loop") {
							state.toolProseAbortReason = `[Clio Coder] aborted local model turn: ${assessment.reason}.`;
							localRuntime.agent.abort();
							deps.emitNotice(state.toolProseAbortReason);
						}
					}
				}
				if (assistantEvent.type === "thinking_delta") {
					deps.emit({
						type: "thinking_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialThinking: extractThinking(assistantEvent.partial),
					});
				}
			}
			if (enrichedEvent.type === "message_end") {
				persistence.appendQueuedUserTurn(enrichedEvent.message);
				const isAssistant = enrichedEvent.message?.role === "assistant";
				if (isAssistant) pendingTerminalToolResult = null;
				const timing: AssistantCallTiming | null =
					isAssistant && apiCallStartedAt !== null
						? {
								ttftMs: apiCallFirstDeltaAt !== null ? Math.round(Math.max(0, apiCallFirstDeltaAt - apiCallStartedAt)) : null,
								apiMs: Math.round(Math.max(0, eventClock - apiCallStartedAt)),
							}
						: null;
				const correlationId = event.type === "message_end" ? handle.requestCorrelationId(event.message) : undefined;
				const persistedId = persistence.appendAssistantTurn(enrichedEvent.message, timing, correlationId);
				await deps.continuity?.response(persistedId, correlationId);
				if (!currentRun()) return;
				if (isAssistant) {
					apiCallStartedAt = null;
					preInvocationStage = "transform";
				}
				const usage = (enrichedEvent.message as { usage?: Usage }).usage;
				if (isAssistant && usage && typeof usage === "object" && runFirstCallVerdict === null) {
					const input = typeof usage.input === "number" ? usage.input : 0;
					const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
					const backendTimings = (enrichedEvent.message as { backendTimings?: BackendCompletionTimings }).backendTimings;
					runFirstCallVerdict = backendCacheVerdict(input, cacheRead, backendTimings, usage.cacheReadReported);
				}
				// The background memory budget sizes a local step's deadline from the
				// speed this endpoint measured on the operator's own turns.
				if (isAssistant) {
					recordEndpointThroughput(
						canonicalEndpointKey(localRuntime.runtimeResolution.target),
						(enrichedEvent.message as { backendTimings?: BackendCompletionTimings }).backendTimings,
					);
				}
				if (usage) {
					const origin = enrichedEvent.message as { callId?: unknown; attemptId?: unknown };
					context.reconcileUsage(
						usage,
						typeof origin.callId === "string" && typeof origin.attemptId === "string"
							? { callId: origin.callId, attemptId: origin.attemptId }
							: undefined,
					);
				}
			}
			if (enrichedEvent.type === "tool_execution_start") {
				persistence.appendToolCallTurn(enrichedEvent);
			}
			if (enrichedEvent.type === "tool_execution_end") {
				persistence.appendToolResultTurn(enrichedEvent);
				pendingTerminalToolResult =
					(enrichedEvent.result as { terminate?: boolean } | undefined)?.terminate === true
						? { toolCallId: enrichedEvent.toolCallId, toolName: enrichedEvent.toolName }
						: null;
			}
			if (enrichedEvent.type === "agent_end") {
				await deps.continuity?.pause();
				clearStallTimer();
				if (!currentRun()) return;
				const terminal = pendingTerminalToolResult;
				pendingTerminalToolResult = null;
				if (terminal) {
					persistence.appendTerminalToolAssistantTurn(terminal);
				}
				context.flushReconciledSnapshot();
				persistence.deferTraceClose(false);
				const finalAssistant = [...enrichedEvent.messages].reverse().find((message) => message.role === "assistant");
				if (terminal !== null || finalAssistant === undefined || finalAssistant !== turnEndFiredFor) {
					await middleware.fireTurnEnd(localRuntime, enrichedEvent.messages, terminal ?? undefined);
				}
				turnEndFiredFor = null;
			}
		};
		handle.agent.subscribe((event) => {
			const settled = onAgentEvent(event);
			// Pi awaits this promise and fails the prompt on a rejection, which the
			// chat loop reports. An emitter that drops it must not turn the same
			// fault into an unhandled rejection that kills a headless run before
			// its receipt and events are written (#428).
			settled.catch(() => {});
			return settled;
		});

		state.runtime = localRuntime;
		runtimeTargetSettings = targetSettings;
		// Append a modelChange marker only when this rebuild replaces a prior
		// runtime, which is the cross-target swap case (mid-session change of
		// target or runtime id). On the initial build, the session header's
		// `meta.model` (written by `session.create()` in submit()) captures
		// the first model and a marker would be redundant.
		if (hadPriorRuntime) persistence.appendModelChangeEntry(target);
		ensureReasoningProbe(target);
		return state.runtime;
	};

	return {
		ensureRuntime,
		ensureLiveCapabilitiesForSelectedModel,
		dispose: () => {
			disposed = true;
			clearCurrentWatchdog();
			clearInterval(selectedRoutePoll);
		},
		cancelRunWatchdog: () => clearCurrentWatchdog(),
		cleanupSessionResources,
		toolTelemetry,
		takeSettledCalls(userTurnId) {
			const calls = turnCalls.get(userTurnId) ?? [];
			turnCalls.delete(userTurnId);
			// Any other turn's calls but the running one's settled after their own turn.settled was written. Each still
			// carries its turn id in the journal, so releasing them here only bounds this map (#434).
			for (const turnId of turnCalls.keys()) if (turnId !== state.activeUserTurnId) turnCalls.delete(turnId);
			return calls;
		},
	};
}
