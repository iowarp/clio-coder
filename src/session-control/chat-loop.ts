import { randomUUID } from "node:crypto";
import { classifyCallFailure } from "../core/call-failure.js";
import { CONTEXT_OPERATION_CUSTOM_TYPE, createContextOperation } from "../core/context-operation.js";
import {
	continuationCountsAgainstCap,
	JobClockExpired,
	TURN_CONTINUATION_CAP,
	type TurnContinuationCause,
	turnContinuationDelayMs,
} from "../core/job-types.js";
import type { SideCallAuth } from "../core/oauth-retry.js";
import {
	mainAgent,
	observedToolCallOrigin,
	ownerTelemetryContext,
	telemetryContext,
} from "../core/telemetry/context.js";
import type { FailureCause } from "../core/telemetry/enums.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { pricesCalls, pricingBasisFields, sumFacts } from "../core/telemetry/pricing.js";
import { resolveSideCallAuth } from "../domains/providers/side-call-auth.js";
import { createConversationEggs } from "../domains/session/easter-eggs.js";
import { turnSettlementFromCalls } from "../domains/telemetry/call-facts.js";
import type { AdmissionHold, CallJournalOptions } from "../domains/telemetry/call-scope.js";
import { readSettledRun } from "../domains/telemetry/run-record.js";
import type { TelemetrySessionLease } from "../domains/telemetry/session-journals.js";
import type { TurnControlRecord } from "../domains/turn-control/index.js";
import type { TurnFailureRecord } from "../domains/turn-control/outcome.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type {
	MachineTurnProjectionAdmission,
	MachineTurnProjectionHost,
	MachineTurnRequest,
	MachineTurnResult,
} from "./job-turn-types.js";
import type { TurnControlRunner } from "./turn-control-runner.js";

export { runOutOfTurnRound } from "./side-question.js";
export { createTurnControlRunner } from "./turn-control-runner.js";

import { isPlanOnlyRequest, stripPlanCloseOptions } from "../core/plan-request.js";
import type { RouteName, RouteSource } from "../core/route-provenance.js";
import type { LiveBudgetView } from "../domains/context/budget/live-view.js";
import type { WorkerContextSnapshot } from "../domains/context/worker/contract.js";
import { captureWorkerContext } from "../domains/context/worker/snapshot.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import type { MemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import { estimateAgentMessageTokens } from "../domains/session/context-accounting.js";
import { createContinuityPersistencePorts } from "../domains/session/continuity/ports.js";
import { continuityReplayText, resolveContinuityProjection } from "../domains/session/continuity/projection.js";
import { continueEngineWithoutInput, replaceEngineMessages } from "../engine/agent.js";
import { isLockedSynthesisFallbackOnly, lockedSynthesisRepromptMessages } from "../engine/loop-guard.js";
import { ContinuityController } from "./continuity-controller.js";
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

import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import type { ClioSettings } from "../core/config.js";
import { formatFooterTokens } from "../core/display-units.js";
import {
	armedSkillSurface,
	evaluateSkillToolSurface,
	type PendingSkillRequest,
	type PendingSkillToolPolicy,
	SKILL_SURFACE_ENTRY,
	type SkillSurfaceChange,
	skillSurfaceChange,
	skillSurfaceLabels,
	skillSurfaceNames,
	withModelSkillActivation,
} from "../core/skill-activation.js";
import type { Fact } from "../core/telemetry/fact.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { TurnAbortSource } from "../core/telemetry/live-events.js";
import type { RunSettled } from "../core/telemetry/schemas.js";
import {
	narrowTurnConstraints,
	snapshotTurnConstraints,
	type TurnConstraints,
	toolSurfaceSources,
	turnScopeGuidance,
} from "../core/turn-constraints.js";
import { clioStateDir } from "../core/xdg.js";
import type { BudgetInspection } from "../domains/context/budget/inspection.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import type { DispatchContract } from "../domains/dispatch/index.js";
import {
	createMiddlewareToolChoiceControl,
	type MiddlewareContract,
	type MiddlewareToolChoiceControl,
} from "../domains/middleware/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import {
	acceptsImageInput,
	modelCandidatesForStatus,
	modelEndpointKey,
	registerForegroundStream,
	resolveModelCapabilities,
	resolveRuntimeTarget,
	runtimeTargetSnapshot,
} from "../domains/providers/index.js";
import { type VisionSidecar, visionObservationText } from "../domains/providers/vision-sidecar.js";
import { type AutonomyLevel, modelMayActivateSkills } from "../domains/safety/autonomy.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import { sessionCeilingReached } from "../domains/scheduling/budget.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import type { ContextSnapshot } from "../domains/session/context-accounting.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import {
	type CompactionTrigger,
	latestSkillContextState,
	mainSkillContextState,
	type SessionEntry,
	SKILL_CONTEXT_STATE,
} from "../domains/session/entries.js";
import { readPromptCompileRecords } from "../domains/session/prompt-manifest.js";
import { protectedArtifactStateFromSessionEntries } from "../domains/session/protected-artifacts.js";
import type { RetrySettings } from "../domains/session/retry.js";
import { classifyRecoveryFailure, isRetryableRecoveryFailure } from "../domains/session/retry.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import type { TurnTokens } from "../domains/turn-control/index.js";
import { reduceTurnOutcome } from "../domains/turn-control/index.js";
import { createEngineAgent } from "../engine/agent.js";
import { cacheKeepalivePromptTokens } from "../engine/cache-keepalive.js";
import { countImageBlocks } from "../engine/image-context.js";
import type { MainRequestRecord } from "../engine/in-prefix-summary.js";
import type { AgentEvent, AgentMessage, AnthropicMessagesCompat, EngineModel, ImageContent } from "../engine/types.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import { finalizeAskUserInterviewForHost } from "../tools/ask-user.js";
import { isGatewayChain } from "../tools/gateway-display.js";
import type { AskUserToolPolicy, ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";
import { effectiveToolCall } from "../tools/surface.js";
import type { ApprovalRequestView } from "./approval-request-view.js";
import {
	createAskUserToolPolicy,
	createPendingSkillToolPolicy,
	detectOverflowFromState,
	detectTerminalFailureFromState,
	explainInterruptedAssistant,
	extractText,
	isOperatorCancelReason,
	notConfiguredNotice,
	noticeMessage,
	OPERATOR_CANCEL_REASON,
	pendingSkillRequestPreamble,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import { normalizeRetrySettings } from "./chat-loop-policy.js";
import { coldCacheNoticeText } from "./cold-reasons.js";
import { footerTokens } from "./compaction-lines.js";
import {
	DRAFT_MAX_TOKENS,
	DRAFT_TEMPERATURES,
	draftCandidateFromText,
	draftTemperature,
	runDraftWithSamplerFallback,
} from "./drafts.js";
import { type HandoffRepairInput, runHandoffRound } from "./handoff-round.js";
import { createMessagePath } from "./message-path.js";
import type { NoticeSource } from "./notice-source.js";
import { resolveTurnOutputReserve } from "./output-reserve.js";
import type { runPrewarmRound } from "./prewarm.js";
import { retireActiveUserContextForNextOperator, retiredUserContextWasSent } from "./session-replay-messages.js";
import { type OutOfTurnRoute, runOutOfTurnRound, runSideQuestion, type SideQuestionResult } from "./side-question.js";
import type { AgentStatusEvent, ModelRequestFacts } from "./status-types.js";
import {
	parseTriageAnswer,
	runTriageRound,
	TRIAGE_MAX_TOKENS,
	TRIAGE_RESPONSE_SCHEMA,
	TRIAGE_SCHEMA_NAME,
	TRIAGE_SYSTEM_PROMPT,
	type TriageEntry,
	type TriageSystemOne,
	type TriageVerdict,
	triageFloor,
	triageKindFor,
	triageLabelsFor,
	triageMayInterrupt,
	triageSnapshotMatches,
	triageUserText,
} from "./steering-triage.js";
import type { LiveContextUsage, TurnContextDeps } from "./turn-context.js";
import { createTurnContext } from "./turn-context.js";
import { createTurnKeepalive } from "./turn-keepalive.js";
import { createTurnMiddleware } from "./turn-middleware.js";
import type { TurnOutcomeCollector } from "./turn-outcome-collector.js";
import { createTurnOutcomeCollector } from "./turn-outcome-collector.js";
import { createTurnPersistence } from "./turn-persistence.js";
import { createTurnPrewarm, type PrewarmOutcome, subscribePrewarmToCompaction } from "./turn-prewarm.js";
import {
	createTurnQueues,
	DEFAULT_STEERING_MODE,
	heldQueueNotice,
	type QueuedChatMessage,
	type QueuedMessageKind,
	type QueuedMessagesSnapshot,
	type QueueRemovalReason,
	type SteeringMode,
} from "./turn-queues.js";
import {
	createTurnRecovery,
	type MovedRoute,
	type RetryForecast,
	type RetryStatusEvent,
	reclassifyStallAbort,
	recoveryAttemptHasOutput,
	rewriteStallAbortMessage,
} from "./turn-recovery.js";
import { type AssistantDeltaEvent, createTurnRuntime, TurnAdmissionError, type TurnRuntime } from "./turn-runtime.js";
import {
	type AgentRuntime,
	type ChatLoopRunSnapshot,
	type ChatLoopTarget,
	createTurnState,
	type TurnPreparationPhase,
	type TurnPreparationStep,
	takeInterruptedCall,
} from "./turn-state.js";
import { isWorkerShareNote } from "./worker-share.js";

export type {
	QueuedChatMessage,
	QueuedMessageKind,
	QueuedMessagesSnapshot,
	QueueRemovalReason,
	SteeringMode,
} from "./turn-queues.js";
export type {
	MovedRoute,
	RetryForecast,
	RetryStatusEvent,
	RetryStatusPayload,
	RetryStatusPhase,
} from "./turn-recovery.js";
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
	display?: { text: string; note?: string };
	origin?: string;
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
	/** Present only on the notice that entries wait in a held queue; the TUI names its bound keys. */
	heldQueue?: { count: number };
	/** Present only on the notice that a session change took these operator messages unsent; the TUI returns them to the composer. */
	queueDropped?: { texts: string[] };
	/**
	 * Present only on a notice about the skill tool surface. The TUI transcript
	 * states it as a `§` row (or, for a load that narrows nothing, not at all,
	 * since the load's own row says so); every other surface renders the text.
	 */
	skillSurface?: SkillSurfaceChange;
	/**
	 * Present only on the footer notice that the next response's prompt cache
	 * may be cold, naming why (`prompt_recompiled`, `dispatch`, …). The TUI
	 * transcript keeps them for the run and the Detailed receipt states them.
	 */
	coldReasons?: ReadonlyArray<string>;
	/**
	 * Present only on the transcript notice that closes a turn the operator
	 * cancelled. The level stays `warning` for headless and protocol surfaces;
	 * the TUI transcript marks it cancelled, as the footer verb does.
	 */
	operatorCancel?: true;
	/**
	 * Present only on an advisory, text addressed to the operator. The TUI
	 * transcript frames it under the source's title; every other surface renders
	 * the text. A notice without a source is an event and keeps its gutter row.
	 */
	source?: NoticeSource;
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
			/**
			 * `judging`: the safety judge holds the call before admission, so it is
			 * not running yet. `resumed`: the call was admitted, by the operator's
			 * grant or the judge's allow, and its body runs from here.
			 */
			state: "judging" | "resumed";
	  };

function noOutcomeUsage(): TurnTokens {
	return { input: sumFacts([]), output: sumFacts([]), cacheRead: sumFacts([]), total: sumFacts([]) };
}

/** A worker run's settled record once its journal holds run.settled; null while it has not settled (#434). */
function readWorkerSettlement(
	runId: string,
	dispatch: Pick<DispatchContract, "getRun"> | undefined,
): Pick<RunSettled, "usage" | "totalTokens"> | null {
	try {
		if (!dispatch?.getRun(runId)) return null;
		return readSettledRun(clioStateDir(), runId)?.settled ?? null;
	} catch {
		// A run that has not settled yet reads as absent; the caller marks it partial.
		return null;
	}
}

const WORKER_RECEIPT_SEAL_WAIT_MS = 2000;
const WORKER_RECEIPT_SEAL_POLL_MS = 25;
/** How long the detached watcher keeps looking for a receipt the settle wait gave up on. */
const WORKER_RECEIPT_LATE_WATCH_MS = 30_000;
const WORKER_RECEIPT_LATE_POLL_MS = 250;
/** Session ledger entry that amends a cancelled turn's outcome with worker tokens that sealed after it. */
const TURN_OUTCOME_TOKENS_CUSTOM_TYPE = "turnOutcomeTokens";

/**
 * A cancelled turn records its outcome as soon as the abort lands, while an
 * aborted worker seals its receipt a few tens of milliseconds later. The ledger
 * knows a run from admission, so only runs it knows are worth waiting for; the
 * wait is bounded. Returns the runs still unsealed, whose tokens the outcome
 * then reports as partial.
 */
async function awaitWorkerRunResults(
	runIds: ReadonlyArray<string>,
	dispatch: Pick<DispatchContract, "getRun"> | undefined,
): Promise<string[]> {
	if (!dispatch) return [];
	const pending = new Set(
		runIds.filter((runId) => dispatch.getRun(runId) !== null && readWorkerSettlement(runId, dispatch) === null),
	);
	const deadline = Date.now() + WORKER_RECEIPT_SEAL_WAIT_MS;
	while (pending.size > 0 && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, WORKER_RECEIPT_SEAL_POLL_MS));
		for (const runId of [...pending]) if (readWorkerSettlement(runId, dispatch) !== null) pending.delete(runId);
	}
	return [...pending];
}

/**
 * Follows receipts the settle wait gave up on. Detached and unref'd: it must not
 * hold the process open, and a process that exits first loses the amend, which
 * is only a better count of tokens the outcome already reported as partial.
 * `onDone` runs once: with the elapsed milliseconds when every watched run has
 * sealed, or null when the cap passed first, and the runs still open stay
 * partial. Returns a stop function for dispose.
 */
function watchLateWorkerRunResults(input: {
	missing: ReadonlyArray<string>;
	dispatch: Pick<DispatchContract, "getRun"> | undefined;
	onDone: (sealedAfterMs: number | null) => void;
}): () => void {
	const pending = new Set(input.missing);
	const started = performance.now();
	const timer = setInterval(() => {
		for (const runId of [...pending]) if (readWorkerSettlement(runId, input.dispatch) !== null) pending.delete(runId);
		const elapsed = performance.now() - started;
		if (pending.size > 0 && elapsed < WORKER_RECEIPT_LATE_WATCH_MS) return;
		clearInterval(timer);
		try {
			input.onDone(pending.size === 0 ? Math.round(elapsed) : null);
		} catch {
			// Measurement must not surface as an error from a timer.
		}
	}, WORKER_RECEIPT_LATE_POLL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** The workers' tokens, each run one contribution; a run that has not settled counts as unknown, never zero (#434). */
function workerOutcomeUsage(
	runIds: ReadonlyArray<string>,
	dispatch: Pick<DispatchContract, "getRun"> | undefined,
): TurnTokens {
	const notSettled: Fact<number> = { kind: "unknown", reason: "not-observed" };
	const runs = [...new Set(runIds)].map((runId) => readWorkerSettlement(runId, dispatch));
	const read = (pick: (settled: Pick<RunSettled, "usage" | "totalTokens">) => Fact<number>) =>
		sumFacts(runs.map((settled) => (settled === null ? notSettled : pick(settled))));
	return {
		input: read((settled) => settled.usage.input),
		output: read((settled) => settled.usage.output),
		cacheRead: read((settled) => settled.usage.cacheRead),
		total: read((settled) => settled.totalTokens),
	};
}

export type ChatLoopEvent = (
	| AgentEvent
	| AssistantDeltaEvent
	| RetryStatusEvent
	| QueueUpdateEvent
	| QueuedUserTurnEvent
	| ChatNoticeEvent
	| AgentStatusEvent
	| ToolApprovalStateEvent
) & {
	modelTimeMs?: number;
	/**
	 * On a `message_end` or `agent_end` that closes a failed attempt: the attempt recovery will try next. The failure is
	 * then an event of a turn still underway, not that turn's outcome.
	 */
	retryPending?: RetryForecast;
};

export interface PromptSubmitInput {
	/** What the operator typed: the template invocation when one expanded. */
	typed: string;
	/** What the model would receive. */
	text: string;
}

export type PromptSubmitVerdict = { kind: "pass"; text: string } | { kind: "block"; reason: string };

export interface ChatSubmitOptions {
	/** Host-only fresh delivery. Its text never enters steering/editor queues (#411). */
	machineTurn?: {
		preparationToken: object;
		onStarting(): boolean;
		onSettled(result: MachineTurnResult): void;
	};
	/** Explicit host-owned task scope; never parsed from the prompt text. */
	constraints?: TurnConstraints;
	/** Presentation only; never part of the model message or persisted text. */
	display?: { text: string; note?: string };
	/**
	 * Set when this turn was not typed by the operator: who sent it, in words.
	 * Persisted on the user turn and carried through the queue, so the
	 * transcript and any replay attribute it. Never parsed, never sent to the
	 * model.
	 */
	origin?: string;
	/** Rechecked after admission awaits; a retired peer inbox cannot start a turn. */
	isAdmissionCurrent?: () => boolean;
	/** Host-owned run identity, scoped to this submit and its internal continuations. */
	hostRun?: ToolInvokeOptions["hostRun"];
	images?: ReadonlyArray<ImageContent>;
	/** Files already expanded into this session's working context. */
	workingContextPaths?: ReadonlyArray<string>;
	/** Skill requests parsed by the harness for this turn. Not recorded as loaded until the skill body loads. */
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	/** Internal middleware resubmit; does not reset the per-user-prompt stalled-turn nudge cap. */
	requestContinuation?: boolean;
	/** A yolo continuation of a stopped turn; does not reset the count against its cap (#445). */
	yoloContinuation?: boolean;
	/**
	 * Delivery mode when a run is active; ignored when idle. Defaults to
	 * `next-slot`. `interrupt` cancels the run, waits for it to settle, and
	 * submits the text as a fresh prompt; see {@link ChatLoop.interruptRefusal}
	 * for the two states in which it degrades to `next-slot` instead.
	 */
	steering?: SteeringMode;
	/** This prompt is an entry taken off the queue: it returns to the head if the prompt never starts (#447). */
	queued?: QueuedChatMessage;
	/** This prompt is a message taken off the queue by a path that does not return it; its recorded path continues. */
	continuesMessage?: Pick<QueuedChatMessage, "id" | "enqueuedAt">;
	/** Carry the rest of the queue with this prompt's first model call, instead of at its first slot. */
	flushQueue?: boolean;
	/**
	 * Queue the message at the head of the steering queue instead of the tail:
	 * a send-now the operator chose to wait with, or one the run refused.
	 */
	queueFront?: boolean;
	/**
	 * Commits the presentation of a consumed prompt after preparation opens and
	 * before admission work can make the turn durable. Interactive uses this to
	 * guarantee that even a fast probe or prompt compile paints one pending
	 * frame instead of opening and closing entirely between renderer ticks.
	 */
	onPreparationVisible?: () => Promise<void>;
	/**
	 * Fires when a submission with `constraints` arrives while a turn is live
	 * and is refused instead of queued, so the editor that consumed it can put
	 * the draft back rather than report it as queued.
	 */
	onRefused?: (reason: string) => void;
	/**
	 * Fires once this submit owns the live turn (`isStreaming()` is true) and
	 * the next queued submit may use streaming queue routing. Stage 0 replay
	 * awaits it; the loop's own admission gate releases on it.
	 */
	onAdmitted?: () => void;
}

/** The endpoint stream slot an out-of-turn round holds; both calls are idempotent (#250). */
interface EndpointSlot {
	acquire(): void;
	release(): void;
}

/**
 * Placeholder key a target that needs no auth still has to be handed. Mirrors
 * the turn runtime's own local fallback, so a `/btw` round against a local
 * server authenticates exactly the way a turn against it does.
 */
const LOCAL_SIDE_QUESTION_API_KEY = "clio-coder-local-target";

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
 * `turn.aborted` event with `source`.
 */
export interface ChatCancelOptions {
	/** Operator-facing explanation for a system-initiated stop. */
	reason?: string;
	/** Source of the emitted `turn.aborted` event. Defaults to "stream_cancel". */
	source?: TurnAbortSource;
	/** Short reason carried by the live `turn.aborted` payload. Defaults to a source-appropriate phrase. */
	auditReason?: string;
}

export interface SideQuestionOptions {
	/** Cancels the round. Esc and Ctrl+C in the overlay abort through it. */
	signal?: AbortSignal;
	/** Streamed answer text so the overlay fills as the provider produces it. */
	onDelta?: (partialText: string) => void;
	/** The route the round was admitted on, before any answer arrives. */
	onRoute?: (route: OutOfTurnRoute) => void;
}

export interface DraftOptions {
	/** Cancels every candidate round. */
	signal?: AbortSignal;
	/** One candidate's streamed text, by index in start order. */
	onCandidate?: (index: number, partialText: string) => void;
	/** The route the candidates were admitted on, before any text arrives. */
	onRoute?: (route: OutOfTurnRoute) => void;
}

/** One `/draft` candidate: its text, or why its round produced none. */
export type DraftCandidate = ({ status: "drafted"; text: string } | { status: "failed"; reason: string }) & {
	route?: OutOfTurnRoute;
};

export type DraftOutcome =
	| { status: "drafted"; candidates: DraftCandidate[]; aborted: boolean }
	| { status: "refused"; reason: string };

export interface HandoffRoundOptions extends SideQuestionOptions {
	/**
	 * Run the second and last extraction round, quoting the parser's complaint
	 * and what the first round returned. Both rounds are journaled calls under
	 * the handoff agent role (issue #223, #434).
	 */
	repair?: HandoffRepairInput;
}

/**
 * How a `/btw` round ended. `refused` is a round that never started (a turn was
 * in flight, or no orchestrator target is configured); `failed` is a round that
 * started and the provider rejected.
 */
export type SideQuestionOutcome =
	| { status: "answered"; text: string; route?: OutOfTurnRoute }
	| { status: "aborted"; text: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

/**
 * `first-output` and `retry-wait` are the two waits a pick can still move: a request out with nothing back, and no
 * request out between attempts. The rest keep the pick for the next turn. `elsewhere` is everything that is not a model
 * call, such as admission or compaction.
 */
export type RouteMoveWait = "idle" | "first-output" | "retry-wait" | "output" | "tool" | "elsewhere";

export type RouteMoveFit =
	| { kind: "fits" }
	| { kind: "same" }
	| { kind: "too-large"; neededTokens: number; window: number }
	| { kind: "images" }
	| { kind: "unresolved"; reason: string };

export type RouteMoveResult =
	| { kind: "idle" }
	| { kind: "same" }
	| { kind: "moved"; wait: "first-output" | "retry-wait" }
	| { kind: "next-turn"; wait: RouteMoveWait; fit?: Exclude<RouteMoveFit, { kind: "fits" } | { kind: "same" }> };

export interface ChatLoop {
	/** Live operator adapters call this before expansion; internal submits never discover eggs. */
	discoverOperatorEgg?(text: string, ask?: AskUserHandler): Promise<boolean>;
	/** Whether these skill requests are refused in this session, with the notice shown. An install offer asks this first. */
	refuseSkillRequests?(requests: ReadonlyArray<PendingSkillRequest>, inlinedPaths: ReadonlyArray<string>): boolean;
	activeEggs?(): readonly string[];
	eggsCommand?(action: "status" | "off", id?: string): string;
	submit(text: string, options?: ChatSubmitOptions): Promise<void>;
	submitMachineTurn?(request: MachineTurnRequest): Promise<MachineTurnResult>;
	/** Bound attended hosts project this ordinary turn through their existing lifecycle (#411). */
	bindMachineTurnProjection?(host: MachineTurnProjectionHost): () => void;
	machineTurnAvailable?(): boolean;
	currentTurnConstraints?(): TurnConstraints | undefined;
	/**
	 * Bind a session schema ceiling, or narrow admission for the current prompt
	 * without changing the standing prompt inputs and schemas (#423).
	 */
	setToolCeiling?(
		ceilings: ReadonlyArray<TurnConstraints | undefined>,
		lifetime?: "session" | "prompt",
	): TurnConstraints | undefined;
	/** The effective host limits, including a prompt ceiling, for work started outside a turn (#423). */
	toolLimits?(): TurnConstraints | undefined;
	/** Effective creating/current task and skill ceiling for session-owned jobs (#411). */
	jobConstraints?(): TurnConstraints | undefined;
	steer(text: string): boolean;
	queueFollowUp(text: string, display?: { text: string; note?: string }, origin?: string): boolean;
	/** The queued entries still in Clio's hands, in delivery order. */
	queueEntries(): QueuedChatMessage[];
	/** Remove one queued entry; returns it, or null when it already left the queue. `reason` is recorded, never acted on. */
	removeQueuedEntry(id: string, reason?: QueueRemovalReason): QueuedChatMessage | null;
	/** Move one queued entry up (-1) or down (+1) in delivery order. */
	moveQueuedEntry(id: string, delta: -1 | 1): boolean;
	/** The operator's choice of slot for one entry; pins it against producers. */
	setQueuedEntryKind(id: string, kind: QueuedMessageKind): boolean;
	/**
	 * Why an interrupt would be refused right now, or null when it would
	 * cancel the run. An attached dispatch is refused because the parent's abort
	 * kills the worker's run and discards its work with no receipt; a parked
	 * permission ask is refused because it is already waiting on the operator.
	 * In both cases `submit(text, { steering: "interrupt" })` says so and
	 * queues the text for the next slot instead.
	 */
	interruptRefusal(): string | null;
	/**
	 * `/skill off`: drop the tool surface an activated skill armed, so the next
	 * turn runs with the full surface again. Returns the skill names that were
	 * armed, or an empty list when nothing was.
	 */
	clearSkillSurface(): ReadonlyArray<string>;
	/** Skills whose tool surface is armed across turns right now; the footer shows them. */
	activeSkillSurface(): ReadonlyArray<string>;
	clearQueuedFollowUps(): string[];
	queuedMessages(): QueuedMessagesSnapshot;
	cancel(options?: ChatCancelOptions): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
	captureWorkerContext?(): WorkerContextSnapshot | null;
	lastRunSnapshot?(): ChatLoopRunSnapshot | null;
	isStreaming(): boolean;
	/** Tool calls the run has started and not yet finished. */
	runningToolCalls(): number;
	/**
	 * Where a consumed prompt currently is between the editor and the stream.
	 * The composer and the footer read it so the window in which the prompt has
	 * been taken but the turn has not been admitted is never rendered as idle
	 * (issue #251).
	 */
	turnPreparation(): {
		phase: TurnPreparationPhase;
		since: number;
		stage?: { step: TurnPreparationStep; since: number } | null;
	};
	/** Evidence about the newest model request, for a surface that reports a silent wait. */
	modelRequest(): ModelRequestFacts | null;
	/** What the running turn is waiting on, which decides whether a route pick moves its request. */
	routeMoveWait?(): RouteMoveWait;
	/** Whether the running turn's request could go to this route. */
	routeMoveFit?(route: { target: string; model: string }): RouteMoveFit;
	/** Whether the next request on this route would leave the route the session's cached prefix belongs to (#434). */
	routeLeavesCache?(route: { target: string; model: string }): boolean;
	/** Send the waiting request to the route settings now name, if it still can go. Call after the pick is applied. */
	moveWaitingRequest?(): RouteMoveResult;
	/** Fires on every preparation transition, including back to `idle`. */
	onTurnPreparation(handler: (phase: TurnPreparationPhase) => void): () => void;
	contextUsage(): LiveContextUsage;
	/**
	 * Categorized context-window ledger for the `/context` overlay: where every
	 * occupied token lives (system prompt, tools, agents, skills, memory,
	 * messages), the autocompact reserve, and free space. Composes the live
	 * estimate with the current turn's prompt segment manifest.
	 */
	contextLedger(): ContextLedger;
	/**
	 * The live agent messages and when the operator last spoke, epoch milliseconds, for a
	 * reading of what entered the run since then. Role cannot say: reminders and continuations
	 * are user messages too. Null with no runtime.
	 */
	screenWindow(): { messages: ReadonlyArray<AgentMessage>; since: number } | null;
	/**
	 * The published live budget for the next request: one immutable view with
	 * the effective window, the structural accounting, the real output
	 * reservation, headroom, pressure, and an opaque revision every consumer
	 * quotes. A pure read of what the producer last published; it never rescans
	 * the conversation, calls a model, persists anything, or triggers reduction.
	 */
	liveBudget(): LiveBudgetView;
	inspectLiveBudget(): BudgetInspection;
	/**
	 * Republish the live budget before making a decision from it, for a consumer
	 * that may be observing results appended since the last publication. The
	 * only thing it mutates is the accounting cache.
	 */
	refreshLiveBudget(): LiveBudgetView;
	/**
	 * Force-run the compaction flow for the current session, swap the agent's
	 * in-memory `state.messages` for a single bridge message carrying the
	 * summary, and emit the standard summary notice. Used by `/context compact`
	 * slash command so the next user turn ships only the bridge plus the new
	 * text to the provider. When no session or compaction dependencies are
	 * wired, it skips compaction and emits a user-visible
	 * notice so the `/context compact` handler does not have to mirror the logic.
	 */
	compact(instructions?: string): Promise<void>;
	requestSelfCompact(note: unknown, toolCallId: string, signal?: AbortSignal): Promise<string>;
	recoverHandoff(handoffId: string, action: "reduce" | "deliver"): Promise<void>;
	/**
	 * `/btw`: answer one side question against the session's active target,
	 * model, and compiled message history without starting a turn.
	 *
	 * Nothing this produces reaches the session ledger, the transcript, the
	 * context ledger, or the footer token counters; the message history is read,
	 * never mutated. The round's provider usage is still reported to `/usage`,
	 * labeled as a side question, because money was spent. Refused outright
	 * while a turn is in flight rather than queued.
	 */
	askSideQuestion(question: string, options?: SideQuestionOptions): Promise<SideQuestionOutcome>;
	/**
	 * `/draft`: run `count` candidate rounds for one request in parallel against
	 * the session's active target, each at its own temperature.
	 *
	 * Out of turn exactly as a side question is: the history is read and never
	 * mutated, nothing reaches the session, and each round's usage is billed to
	 * `/usage` as a side question. A round that fails reports why in its slot
	 * rather than failing the others.
	 */
	draftCandidates(request: string, count: number, options?: DraftOptions): Promise<DraftOutcome>;
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
	/** Synchronous reset barrier, including an empty /new; ordinary first-turn creation does not fire it. */
	onSessionReset?(handler: () => void): () => void;
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
	eggAsk?: AskUserHandler;
	turnControl?: TurnControlRunner;
	turnOutcomeCollector?: TurnOutcomeCollector;
	getTaskEstablished?: () => boolean;
	outcomeDispatch?: Pick<DispatchContract, "getRun">;
	memoryCommitBridge?: MemoryInterventionRegistration | undefined;
	interactiveGuidance?: boolean;
	/** An ACP client that advertised interviews: the prompt offers ask_user without the TUI-only guidance. */
	operatorInterviews?: boolean;
	/**
	 * The session's standing tool limits (`clio-coder --allow-tools`, `clio-coder acp
	 * --allow-tools`). Every turn's constraints are narrowed by them, and the
	 * tool surface holds them between turns, so a prewarmed runtime and a
	 * continuation see the same limit.
	 */
	sessionToolLimits?: TurnConstraints;
	/**
	 * True for a headless `clio-coder run`. Its permission listener denies every
	 * approval ask, so the session prompt says so instead of promising a pause.
	 */
	headless?: boolean;
	/** False when no operator message can arrive mid-run (a headless run without a steer channel). */
	liveSteering?: boolean;
	scheduling?: SchedulingContract;
	getSettings: () => Readonly<ClioSettings>;
	/**
	 * The same effective autonomy level registry admission resolves, so the
	 * skill-activation gate and the tool gate can never disagree. Absent falls
	 * back to the settings value.
	 */
	getAutonomy?: () => AutonomyLevel;
	providers: ProvidersContract;
	/** Optional independent image model, bound to fleet.profiles.vision. */
	visionSidecar?: VisionSidecar;
	/**
	 * Whitelist of target ids that the chat-loop is allowed to drive. The
	 * orchestrator composes this from `providers.list()` so an unknown
	 * `settings.chat.target` surfaces a configuration error before
	 * the agent is constructed.
	 */
	knownTargets: () => ReadonlySet<string>;
	session?: SessionContract;
	/**
	 * Prompt compiler. When wired, the session system prompt is compiled once
	 * per session and applied to Pi’s system transcript baseline; recompiles happen
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
	/** The `/draft` candidate round. Injectable for the same reason. */
	runDraftRound?: typeof runOutOfTurnRound;
	/**
	 * Return the current session's entries for token estimation. The chat-loop
	 * calls this on every submit so the auto-compaction threshold sees the
	 * latest transcript. Returns an empty array when there is no current
	 * session or when the session contract is absent.
	 */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** Information-flow admission of each model request; see TurnRuntimeDeps.admitFlow. */
	admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	/** The same admission for /btw, /draft, /handoff and the pre-warm, which send the live runtime's history. */
	admitRuntimeFlow?: (runtime: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	/** Labels the information-flow sources that `@file` references inlined into a submitted prompt. */
	labelReferencedPaths?: (paths: ReadonlyArray<string>) => void;
	/** Why an operator's context-handoff request, with the `@file` paths it inlines, may not run in this session, or null. */
	refuseHandoffSkill?: (inlinedPaths: ReadonlyArray<string>) => string | null;
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
	autoCompact?: (
		instructions?: string,
		trigger?: CompactionTrigger,
		budget?: Pick<
			CompactInput,
			| "providerCompaction"
			| "livePrefix"
			| "providerFallbackReason"
			| "providerReplayFallback"
			| "keepRecentTokens"
			| "preserveUserTurnId"
			| "skillContextState"
			| "signal"
			| "beforeSummaryCall"
			| "onSummaryOutput"
			| "checkpointForSummary"
			| "checkpointTokenFigures"
		>,
	) => Promise<CompactResult | null>;
	/** Optional telemetry sink for orchestrator chat token usage. */
	telemetry?: TelemetryContract;
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
	 * The awaited prompt_submit gate of extension runtime hooks, present only
	 * where a surface hosts their runtimes. It runs once per submission that
	 * starts a fresh turn, sees the line the operator typed rather than an
	 * expanded template body, and may refuse the turn or, when nothing
	 * expanded the line, rewrite it.
	 */
	promptSubmit?: (input: PromptSubmitInput) => Promise<PromptSubmitVerdict>;
	/**
	 * Shared next-round provider routing. The registry applies effects emitted
	 * by before_tool/after_tool; the chat loop applies turn hooks and consumes
	 * the resulting choice when it builds each request.
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
	 * Shared event bus. When wired, `cancel()` emits `turn.aborted` with
	 * `source: "stream_cancel"`, journaled in the session for every
	 * Esc-on-stream / Ctrl+C cancel.
	 * Optional so unit tests that drive chat-loop in isolation do not need
	 * to construct a bus.
	 */
	bus?: TelemetryHub;
	/**
	 * Build the approved-memory prompt section for the current turn. Returns
	 * the empty string when no approved, evidence-linked, in-scope memory
	 * applies; otherwise returns a compact markdown section that the prompt
	 * compiler injects via the memory dynamic fragment. Optional so unit
	 * tests omit it when memory is irrelevant.
	 */
	getMemorySection?: (request: MemoryPromptRequest) => string;
	memoryEnabled?: () => boolean;
	/** Runs before any turn is written, so a ledger fact can precede the text it describes. */
	beforeTurnRecorded?: (session: SessionContract) => void;
	getMemoryRecordStatuses?: TurnContextDeps["getMemoryRecordStatuses"];
	/** Told when an operator submits a task, before anything else about the turn runs. Never told about a continuation. */
	onOperatorTurn?: (input: { task: string }) => void;
	/** The operator request the run is working on, for the steering triage round. Absent, triage sends no task. */
	currentOperatorTask?: () => string;
	/** Typed steering triage when a route is bound. Absent or unbound, triage is the side-model round. */
	systemOne?: TriageSystemOne;
	/** Called once when a submitted turn settles, whether it completed, failed or was cancelled. */
	onTurnSettled?: () => void;
	getReadySkillCount?: () => number;
	/** Live source of each active route for the attended prompt (DF-7). */
	getRouteSources?: () => Readonly<Record<RouteName, RouteSource>>;
	/** Structured, redacted task-bank export supplied only to an explicit context-handoff skill request. */
	getTaskMemoryHandoffSource?: () => string;
	/**
	 * Hand the composition root a delivery path for reminders that background
	 * observers produce after their turn boundary closed. Called once during
	 * composition; the loop owns the buffer the reminder lands in.
	 */
	registerDeferredReminderSink?: (sink: (message: string, isCurrent?: () => boolean) => void) => void;
	onMemoryRequestSubmitted?: ((messages: readonly AgentMessage[], systemPrompt?: string) => void) | undefined;
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
	/** An editor draft already owns the next foreground request. */
	isPrewarmBusy?: () => boolean;
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

function reloadProtectedArtifactsForSession(
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

/** The latest assistant text in a transcript, or empty: what a mid-run steer is reacting to. */
function lastAssistantText(messages: ReadonlyArray<AgentMessage>): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((block): block is { type: "text"; text: string } => {
				const candidate = block as { type?: unknown; text?: unknown };
				return candidate?.type === "text" && typeof candidate.text === "string";
			})
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/**
 * Why a forced compaction failed, in words: `compaction stream failed: 401: {"message":"invalid api key"}` reads
 * `the provider answered 401: invalid api key`.
 */
function compactionFailureReason(err: unknown): string {
	const raw = (err instanceof Error ? err.message : String(err)).replace(/^compaction stream failed:\s*/u, "");
	const status = /^(\d{3}):\s*/u.exec(raw);
	const rest = status ? raw.slice(status[0].length) : raw;
	let detail = rest.trim();
	try {
		const parsed: unknown = JSON.parse(detail);
		const message =
			parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
				? parsed.message
				: null;
		if (message !== null) detail = message;
	} catch {
		// Not JSON: the provider's text is already the reason.
	}
	detail = detail.replace(/[.\s]+$/u, "");
	return status ? `The provider answered ${status[1]}: ${detail}` : `The summary call failed: ${detail}`;
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const sessionResetListeners = new Set<() => void>();
	const createAgent = deps.createAgent ?? createEngineAgent;
	const sideQuestionRound = deps.runSideQuestion ?? runSideQuestion;
	const handoffRound = deps.runHandoffRound ?? runHandoffRound;
	const draftRound = deps.runDraftRound ?? runOutOfTurnRound;
	const middlewareToolChoice = deps.middlewareToolChoice ?? createMiddlewareToolChoiceControl();
	const state = createTurnState();
	const operatorToolLimits = snapshotTurnConstraints(deps.sessionToolLimits);
	let sessionToolLimits = operatorToolLimits;
	let promptToolLimits = sessionToolLimits;
	state.currentTurnConstraints = sessionToolLimits;
	const eggs = createConversationEggs({
		identity: () => deps.session?.current()?.id ?? null,
		ensureConversation: () => {
			if (!deps.session || deps.session.current()) return;
			const settings = deps.getSettings();
			deps.session.create({
				cwd: process.cwd(),
				...(settings.chat.target ? { target: settings.chat.target } : {}),
				...(settings.chat.model ? { model: settings.chat.model } : {}),
			});
		},
		notice: (text) => emitNotice(text),
		changed: (active) =>
			deps.bus?.emit("session.eggs_changed", { sessionId: deps.session?.current()?.id ?? null, active }),
	});
	const toolStartTimes = new Map<string, number>();
	let lastHistoricalImageNoticeKey: string | null = null;

	const unsubscribeEggSession = deps.bus?.subscribe("session.parked", () => eggs.reset());
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
		if (phase === "idle") {
			state.turnPreparationSince = 0;
			state.turnPreparationStage = null;
		}
		state.turnPreparation = phase;
		for (const listener of preparationListeners) {
			try {
				listener(phase);
			} catch {
				// Preparation observers are presentation only and cannot fail a turn.
			}
		}
	};

	const markPreparationStep = (step: TurnPreparationStep): void => {
		state.turnPreparationStage = { step, since: Date.now() };
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

	const refuseSkillRequests = (
		requests: ReadonlyArray<PendingSkillRequest>,
		inlinedPaths: ReadonlyArray<string>,
	): boolean => {
		if (!requests.some((request) => request.name.trim() === "context-handoff")) return false;
		// The file this request inlines is judged, not labeled: a refused request sends nothing, so it labels nothing.
		const refusal = deps.refuseHandoffSkill?.(inlinedPaths) ?? null;
		if (refusal === null) return false;
		emit({
			type: "notice",
			level: "warning",
			surface: "transcript",
			text: refusal,
			admission: { reason: "handoff-skill-refused" },
		});
		return true;
	};

	const emitFooterNotice = (level: ChatNoticeEvent["level"], text: string, key: string): void => {
		emit({ type: "notice", level, surface: "footer", text, key });
	};

	/** An operator `/context compact` is between its start and its settled card. */
	let operatorCompactionRunning = false;

	/**
	 * Transcript notices are first-class `notice` events, never fake
	 * `message_end` assistant messages: a notice can never become a headless
	 * turn's answer, never carries usage, and never ends a run. Run closure is
	 * the engine's job (handleRunFailure delivers agent_end on abort and
	 * provider-failure paths) and RunAborted carries abort provenance to the
	 * status reducer.
	 */
	const emitNotice = (
		text: string,
		level: ChatNoticeEvent["level"] = "info",
		key?: string,
		skillSurface?: SkillSurfaceChange,
		source?: NoticeSource,
	): void => {
		emit({
			type: "notice",
			level,
			surface: "transcript",
			text,
			...(key === undefined ? {} : { key }),
			...(skillSurface === undefined ? {} : { skillSurface }),
			...(source === undefined ? {} : { source }),
		});
	};

	/**
	 * Carry (or drop) the tool surface a skill declared once the turn that
	 * loaded it settles, and say so once on the transcript. The operator needs
	 * to know a narrowing is armed across their next messages, and needs one
	 * line back when it lifts; the skill-activation ledger entry already
	 * records provenance, so this is the notice, not a second UI.
	 */
	const armSkillSurface = (
		policy: PendingSkillToolPolicy | undefined,
		loadedBefore?: ReadonlySet<string>,
		explicitOff = false,
	): void => {
		const previous = skillSurfaceNames(state.activeSkillSurface).join(", ");
		const next = armedSkillSurface(policy);
		const current = skillSurfaceNames(next).join(", ");
		if (
			deps.session?.current() &&
			(explicitOff ||
				previous.length > 0 ||
				(policy?.loadedSkillNames.size ?? 0) > 0 ||
				(policy?.requests.length ?? 0) > 0)
		) {
			const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			// A loaded skill that declares no tool narrowing arms no surface, yet its
			// instructions are in context. Record it from the loading policy: an
			// unknown selection would block every later compaction of this session.
			const selection = next
				? mainSkillContextState(entries, next)
				: policy !== undefined && policy.loadedSkillNames.size > 0
					? mainSkillContextState(entries, policy)
					: { version: 1 as const, activationRefs: [] };
			const data = selection ?? { version: 1 as const, activationRefs: [], unknown: true as const };
			if (JSON.stringify(data) !== JSON.stringify(latestSkillContextState(entries))) {
				// Persist before changing live state: restart must not resurrect a cleared/replaced skill.
				deps.session.appendEntry({ kind: "custom", customType: SKILL_CONTEXT_STATE, parentTurnId: state.lastTurnId, data });
			}
		}
		const change = skillSurfaceChange(skillSurfaceNames(state.activeSkillSurface), next);
		state.activeSkillSurface = next;
		// The change itself is recorded, so a resumed transcript states the same
		// `§` row the live one did; the selection above is what compaction reads.
		if (change !== null && deps.session?.current()) {
			deps.session.appendEntry({
				kind: "custom",
				customType: SKILL_SURFACE_ENTRY,
				parentTurnId: state.lastTurnId,
				data: change,
			});
		}
		const activated = skillSurfaceLabels(policy).filter((label) => !loadedBefore?.has(label.split(" ")[0] ?? label));
		if (activated.length > 0) {
			const loaded: SkillSurfaceChange = {
				version: 1,
				state: "loaded",
				names: activated.map((label) => label.split(" ")[0] ?? label),
				previous: [],
				allowedTools: [],
				disallowedTools: [],
			};
			emitNotice(
				policy?.allowListAdvisory === true && current.length === 0
					? `[Clio Coder] Skill activated: ${activated.join(", ")}. Its allowed-tools list is guidance in yolo; explicit disallowed-tools still apply.`
					: current.length > 0
						? `[Clio Coder] Skill activated: ${activated.join(", ")}. Its tool surface stays armed across your next turns until another skill replaces it or you run /skill off.`
						: `[Clio Coder] Skill activated: ${activated.join(", ")}. It declares no tool narrowing.`,
				"info",
				undefined,
				change !== null && change.state !== "cleared" ? change : loaded,
			);
		}
		if (change?.state === "cleared") {
			emitNotice(
				`[Clio Coder] Skill tool surface cleared: ${previous}. The full tool surface is back.`,
				"info",
				undefined,
				change,
			);
		} else if (change?.state === "replaced" && activated.length === 0) {
			emitNotice(`[Clio Coder] Skill tool surface replaced: ${previous} by ${current}.`, "info", undefined, change);
		}
	};

	/**
	 * Transcript notice for an admission exit, carrying the reason the turn
	 * never started. Refusals that end the run report at `"error"` level; exits
	 * where the turn simply did not need to start keep `"info"`.
	 */
	const emitAdmissionNotice = (text: string, reason: string, level: ChatNoticeEvent["level"] = "info"): void => {
		emit({ type: "notice", level, surface: "transcript", text, admission: { reason } });
	};
	const visionModelOptions = (): string[] => {
		const options: string[] = [];
		for (const status of deps.providers.list()) {
			for (const candidate of modelCandidatesForStatus(status)) {
				const caps = resolveModelCapabilities(status, candidate.id, deps.providers.knowledgeBase);
				if (!acceptsImageInput({ runtimeId: status.runtime?.id ?? status.target.runtime, vision: caps.vision })) continue;
				options.push(`${status.target.id}/${candidate.id}`);
				if (options.length === 5) return options;
			}
		}
		return options;
	};

	/**
	 * Which of the two settings is actually missing when the runtime resolves to
	 * null. Both halves produce the same operator-facing notice, but a machine
	 * consumer of the reason (the ACP server reports it as `data.reason`) needs
	 * to tell "no orchestrator at all" from "a target that names no model", and
	 * collapsing them sent a client with a configured target to the wrong fix.
	 */
	const nullRuntimeAdmissionReason = (): string => {
		const orchestrator = deps.getSettings().chat;
		const target = orchestrator.target?.trim() ?? "";
		const model = orchestrator.model?.trim() ?? "";
		return target.length > 0 && model.length === 0 ? "model-not-configured" : "orchestrator-not-configured";
	};

	const retrySettings = (): RetrySettings => normalizeRetrySettings(deps.getSettings().chat.retry);

	const hostRunContext = new AsyncLocalStorage<ToolInvokeOptions["hostRun"]>();
	const currentToolInvokeOptions = (toolCallId?: string): Partial<ToolInvokeOptions> => {
		const options: Partial<ToolInvokeOptions> = {
			toolResultMaxBytes: deps.getSettings().context.toolResultMaxBytes,
			abortCause: () => state.activeInterruptReason ?? state.toolProseAbortReason,
			...observedToolCallOrigin(state.runtime?.agent.state.messages ?? [], toolCallId),
		};
		const hostRun = hostRunContext.getStore();
		if (hostRun !== undefined) options.hostRun = hostRun;
		const sessionId = deps.session?.current()?.id ?? null;
		if (sessionId) options.sessionId = sessionId;
		const turnId = state.activeUserTurnId ?? state.lastTurnId;
		if (turnId) options.turnId = turnId;
		if (state.currentPendingSkillPolicy) options.pendingSkillPolicy = state.currentPendingSkillPolicy;
		if (state.currentTurnConstraints) options.turnConstraints = state.currentTurnConstraints;
		if (state.currentAskUserPolicy) options.askUserPolicy = state.currentAskUserPolicy;
		return options;
	};

	// --- module composition -------------------------------------------------

	let operatorSpokeAt = 0;
	// The session whose run the queue was typed behind; a reset within it keeps the operator's entries (#447).
	let queueSessionId: string | null = null;
	const messagePath = createMessagePath({
		sessionId: () => deps.session?.current()?.id ?? null,
		turnId: () => state.activeUserTurnId ?? state.lastTurnId ?? null,
	});
	const queues = createTurnQueues({
		state,
		emitQueueUpdateEvent: (messages) => emit({ type: "queue_update", messages }),
		emitQueueHeld: (count) =>
			emit({ type: "notice", level: "info", surface: "transcript", text: heldQueueNotice(count), heldQueue: { count } }),
		emitQueueDropped: (texts) =>
			emit({
				type: "notice",
				level: "warning",
				surface: "transcript",
				text: `[Clio Coder] the session changed; not sent: ${texts.join(" | ")}`,
				queueDropped: { texts },
			}),
		emitQueuedUserTurn: (entry) =>
			emit({
				type: "queued_user_turn",
				text: entry.text,
				kind: entry.kind,
				...(entry.display ? { display: entry.display } : {}),
				...(entry.origin !== undefined ? { origin: entry.origin } : {}),
			}),
		emitNotice,
		// The loop's own resubmits (stranded steers, continuation requests) run
		// from submit's finally and bypass the admission gate: an interrupt that
		// holds the gate while awaiting that same run would otherwise deadlock.
		submit: (text, options) => submitTracked(text, options),
		onEvent: (event) => {
			if (event.type === "delivered") operatorSpokeAt = Date.now();
			messagePath.queueEvent(event);
		},
	});

	const middleware = createTurnMiddleware({
		memoryContentGuard: deps.memoryCommitBridge?.isContentCurrent,
		state,
		middleware: deps.middleware,
		toolRegistry: deps.toolRegistry,
		session: deps.session,
		middlewareToolChoice,
		emitNotice: (text, level, source) => emitNotice(text, level, undefined, undefined, source),
		emitFooterNotice,
	});

	try {
		// The one deferred reminder producer is task memory, and the one deferred notice producer is the watchdog.
		deps.registerDeferredReminderSink?.((message, isCurrent) =>
			middleware.injectDeferredReminder(message, "advisory", isCurrent, "memory"),
		);
		deps.registerDeferredNoticeSink?.((text) => middleware.emitDeferredNotice(text, "warning", "watchdog"));
	} catch {
		// A background observer losing its delivery path must not stop the loop
		// from starting; it simply stays silent.
	}

	let submitOwner: AbortController | null = null;
	let submitGeneration = 0;
	let disposed = false;
	const context = createTurnContext({
		isTurnActive: () => turnActive,
		turnSignal: () => submitOwner?.signal,
		standingTurnConstraints: () => sessionToolLimits,
		interactiveGuidance: deps.interactiveGuidance === true,
		operatorInterviews: deps.operatorInterviews === true,
		headless: deps.headless === true,
		...(deps.liveSteering === false ? { liveSteering: false } : {}),
		state,
		getSettings: deps.getSettings,
		...(deps.getAutonomy ? { getAutonomy: deps.getAutonomy } : {}),
		providers: deps.providers,
		session: deps.session,
		prompts: deps.prompts,
		toolRegistry: deps.toolRegistry,
		telemetry: deps.telemetry,
		bus: deps.bus,
		readSessionEntries: deps.readSessionEntries,
		autoCompact: deps.autoCompact,
		getMemorySection: deps.getMemorySection,
		...(deps.memoryEnabled ? { memoryEnabled: deps.memoryEnabled } : {}),
		getMemoryRecordStatuses: deps.getMemoryRecordStatuses,
		memoryCommitBridge: deps.memoryCommitBridge,
		getReadySkillCount: deps.getReadySkillCount,
		...(deps.getRouteSources ? { getRouteSources: deps.getRouteSources } : {}),
		getPendingHandoff: () => {
			const sessionId = deps.session?.current()?.id;
			if (!sessionId) return null;
			const fold = resolveContinuityProjection({
				entries: filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined),
				sessionId,
			}).current;
			return fold?.identity && fold.phase !== "acknowledged"
				? {
						id: fold.identity.handoffId,
						preparedAt: fold.policy ? new Date(fold.policy.preparedAtMs).toISOString() : null,
						sourceRevision: fold.identity.sourceRevision,
					}
				: null;
		},
		getLastOutcome: () => {
			const sessionId = deps.session?.current()?.id;
			if (!sessionId) return null;
			const fold = resolveContinuityProjection({
				entries: filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined),
				sessionId,
			}).current;
			return fold?.identity ? { outcome: fold.phase, at: null, detail: fold.commit?.outcome ?? null } : null;
		},
		middleware,
		emitNotice,
		// #423: an estimate, not a fault, so it reads as one and ends when the call that answers it settles.
		emitCacheReuseNotice: (text) =>
			emit({ type: "notice", level: "info", surface: "footer", text, key: "context.cache.reuse-uncertain" }),
		emitCacheNotice: (reasons) =>
			emit({
				type: "notice",
				level: "info",
				surface: "footer",
				text: coldCacheNoticeText(reasons),
				key: "context.cache.cold",
				coldReasons: [...reasons],
			}),
	});

	let continuityReplayInstalled = false;
	const continuity = new ContinuityController({
		captureOrigin: () => {
			continuityReplayInstalled = false;
			const session = deps.session;
			const meta = session?.current();
			const runtime = state.runtime;
			const leaf = state.lastTurnId;
			const operator = state.activeUserTurnId;
			if (!session || !meta || !runtime || !leaf || !operator || context.inspectLiveBudget().status !== "available") {
				throw new Error("Self-compaction requires a native runtime and a persisted operator turn.");
			}
			const revision = context.navigationRevision();
			const route = `${deps.getSettings().chat.target}/${deps.getSettings().chat.model}`;
			return {
				sessionId: meta.id,
				leafTurnId: leaf,
				initiatingTurnId: operator,
				sourceRevision: context.refreshLiveBudget().revision,
				ports: createContinuityPersistencePorts({
					session,
					origin: {
						sessionId: meta.id,
						cwdHash: meta.cwdHash,
						stillCurrent: () =>
							context.navigationRevision() === revision &&
							state.runtime === runtime &&
							state.activeUserTurnId === operator &&
							`${deps.getSettings().chat.target}/${deps.getSettings().chat.model}` === route,
					},
				}),
			};
		},
		entries: () => filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined),
		leaf: () => state.lastTurnId,
		admitNote: (accepted) => {
			const view = context.refreshLiveBudget();
			if (!view.breakdown || view.historical) return false;
			const messages = state.runtime?.agent.state.messages ?? [];
			const operator = [...messages].reverse().find((message) => message.role === "user");
			const note = continuityReplayText({
				note: accepted.note,
				handoffId: "pending",
				commitId: "pending",
				originSessionId: view.sessionId ?? "",
				phase: "prepared",
				authority: "execution",
			});
			// Include the complete skill messages and tool receipts already in the
			// protected suffix. The final guard still prices the actual replay.
			// A chain that loaded a skill carries that load's instructions too; it
			// is identified by its activation stamp, never named a context call.
			const protectedSkills = messages
				.filter(
					(message) =>
						message.role === "toolResult" &&
						(effectiveToolCall(message.toolName, undefined, message.details).toolName === "context" ||
							(isGatewayChain(message.toolName, undefined, message.details) &&
								(message.details as { capability?: unknown } | undefined)?.capability === "context")),
				)
				.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
			const floor =
				view.breakdown.systemPromptTokens +
				view.breakdown.toolSchemaTokens +
				protectedSkills +
				(operator ? estimateAgentMessageTokens(operator) : 0) +
				estimateAgentMessageTokens({ role: "assistant", content: [{ type: "text", text: note }] }) +
				512;
			return view.effectiveWindow === null || requestFits(floor, view.outputReserveTokens, view.effectiveWindow);
		},
		fits: () => {
			const view = context.refreshLiveBudget();
			return (
				view.effectiveWindow === null || requestFits(view.inputTokens, view.outputReserveTokens, view.effectiveWindow)
			);
		},
		inputTokens: () => context.refreshLiveBudget().inputTokens ?? 0,
		reduce: async (hooks, signal) => {
			if (!state.runtime) throw new Error("Native runtime was detached.");
			continuityReplayInstalled = await context.runAutoCompact(
				state.runtime,
				true,
				undefined,
				"overflow",
				undefined,
				undefined,
				signal,
				hooks,
			);
		},
		installReplay: () => {
			if (state.runtime && !continuityReplayInstalled) {
				context.refreshAgentMessagesFromSession(state.runtime);
				continuityReplayInstalled = true;
			}
		},
		onCommit: (commitId, outcome) => context.notifyMemoryCommit(commitId, "continuity", outcome),
		notice: emitNotice,
	});

	const persistence = createTurnPersistence({
		getToolOwner: (name) => deps.toolRegistry?.get(name as import("../core/tool-names.js").ToolName)?.sourceInfo?.owner,
		state,
		session: deps.session,
		...(deps.beforeTurnRecorded ? { beforeTurnRecorded: deps.beforeTurnRecorded } : {}),
		readSessionEntries: deps.readSessionEntries,
		getSettings: deps.getSettings,
		middlewareToolChoice,
		consumePersistedEcho: (text) => queues.consumePersistedEcho(text),
		removeQueuedMirrorEntry: (text) => queues.acknowledgeInjected(text)?.origin,
		promptCachePayloadForAssistant: (usage, backend, anthropicResponse, transport) =>
			context.promptCachePayloadForAssistant(usage, backend, anthropicResponse, transport),
		noteNextRunColdReason: (reason) => context.noteNextRunColdReason(reason),
		telemetry: deps.telemetry,
	});
	const outcomeCollector = deps.turnOutcomeCollector ?? createTurnOutcomeCollector();
	if (deps.turnOutcomeCollector === undefined) deps.middleware?.registerHook(outcomeCollector);

	let terminalTurnFailure: TurnFailureRecord | undefined;
	const currentTurnFailure = (): TurnFailureRecord | undefined => terminalTurnFailure;
	let turnRetryAttempts = 0;
	let providerRetryAttempts = 0;
	const recovery = createTurnRecovery({
		auth: deps.providers.auth,
		isYolo: () => (deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) === "yolo",
		turnSignal: () => submitOwner?.signal,
		turnIdentity: () => submitGeneration,
		state,
		persistence,
		context,
		retrySettings,
		applyRouteMove: (runtime) => applyRouteMove(runtime),
		markPersistedUserEcho: (text, prompt) => queues.markPersistedUserEcho(text, prompt),
		emitRetryStatus: (status) => {
			if (status.phase === "retrying") turnRetryAttempts += 1;
			emit({ type: "retry_status", status });
		},
		emitFailureMessage: (message) => {
			const forecast = state.runtime ? recovery.forecastRetry(state.runtime, message) : null;
			emit({ type: "message_end", message, ...(forecast ? { retryPending: forecast } : {}) });
		},
		emitNotice,
	});
	/** Moves the running turn's foreground slot, which belongs to the endpoint it is using, along with its request. */
	let moveForeground: ((runtime: AgentRuntime) => void) | null = null;
	const movedRoute = (route: { targetId: string; wireModelId: string }): MovedRoute => ({
		targetId: route.targetId,
		modelId: route.wireModelId,
	});
	/**
	 * Everything a submit binds to its route before the first call, done again for the next one: a next-turn switch
	 * recompiles for the new route on its way out, and a moved request has to arrive with what that route was told.
	 */
	const applyRouteMove = async (runtime: AgentRuntime): Promise<{ from: MovedRoute; to: MovedRoute } | null> => {
		const target = state.routeMove;
		state.routeMove = null;
		if (target === null) return null;
		const from = movedRoute(runtime);
		turnRuntime.rebindRoute(target);
		runtime.agent.state.tools = resolveSessionTools(
			runtime,
			deps.toolRegistry,
			currentToolInvokeOptions,
			turnRuntime.toolTelemetry,
			sessionToolLimits,
		);
		context.syncRouteConfiguration(runtime);
		const compiled = await context.ensureSessionPrompt(runtime);
		context.logPromptCompileIfPending();
		// A request on another target or wire model shares no cached prefix with the previous call's (#434).
		context.noteColdReason("model_changed");
		moveForeground?.(runtime);
		if (state.lastRunSnapshot) {
			const promptHash = compiled?.systemPromptHash ?? state.lastRunSnapshot.compiledPromptHash;
			Object.assign(state.lastRunSnapshot, {
				targetId: runtime.targetId,
				targetUrl: runtime.runtimeResolution.target.url ?? null,
				runtimeId: runtime.runtimeId,
				runtimeKind: runtime.runtimeResolution.runtimeKind,
				wireModelId: runtime.wireModelId,
				pricedBy: runtime.runtimeResolution.pricedBy,
				compiledPromptHash: promptHash,
				staticCompositionHash: promptHash,
				promptSignature: promptHash,
				toolSignature: toolSignatureFromState(runtime.agent.state.tools),
				runtimeResolution: runtimeTargetSnapshot(runtime.runtimeResolution),
			});
		}
		return { from, to: movedRoute(runtime) };
	};
	const routeMoveWait = (): RouteMoveWait => {
		if (!state.streaming) return "idle";
		// A pick already aborted the call, and this pick replaces where it goes.
		if (state.routeMove !== null) return "first-output";
		if (recovery.inRetryWait()) return "retry-wait";
		const wait = turnRuntime.callWait();
		return wait === "first-output" && !state.routeMoveSeat ? "elsewhere" : wait;
	};
	const routeFit = (candidate: { target: ChatLoopTarget; model: EngineModel }): RouteMoveFit => {
		const runtime = state.runtime;
		if (!runtime) return { kind: "unresolved", reason: "the turn has no runtime yet" };
		const resolution = candidate.target.runtimeResolution;
		if (
			state.routeMove === null &&
			runtime.targetId === candidate.target.target.id &&
			runtime.runtimeId === candidate.target.runtime.id &&
			runtime.wireModelId === candidate.target.wireModelId
		)
			return { kind: "same" };
		const prompt = [...runtime.agent.state.messages].reverse().find((message) => message.role === "user");
		if (
			prompt !== undefined &&
			countImageBlocks([prompt]) > 0 &&
			!acceptsImageInput({ runtimeId: candidate.target.runtime.id, vision: resolution.capabilityDecisions.vision })
		)
			return { kind: "images" };
		const inputTokens = context.refreshLiveBudget().inputTokens ?? 0;
		const window = resolution.contextWindowDetails.effectiveContextWindow;
		const outputTokens = resolveTurnOutputReserve(
			{ runtimeResolution: resolution, agent: { state: { model: candidate.model } } },
			inputTokens,
		);
		// An unknown window is nothing to check against, and an overflow there still compacts and retries once.
		if (window > 0 && !requestFits(inputTokens, outputTokens, window))
			return { kind: "too-large", neededTokens: inputTokens + outputTokens, window };
		return { kind: "fits" };
	};
	/** Set between a retried attempt's `message_end` and the `agent_end` that closes that attempt. */
	let attemptRetryForecast: RetryForecast | null = null;
	const emitRuntimeEvent = (event: AgentEvent | AssistantDeltaEvent): void => {
		if (event.type === "agent_end" && attemptRetryForecast !== null) {
			Object.assign(event, { retryPending: attemptRetryForecast });
			attemptRetryForecast = null;
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant") {
				const terminal = terminalFailureFromAssistantMessage(event.message);
				if (terminal?.failure) {
					terminalTurnFailure = terminal.failure;
					providerRetryAttempts += terminal.failure.retryAttempts ?? 0;
				} else if (!terminal) terminalTurnFailure = undefined;
			}
			rewriteStallAbortMessage(state, event.message);
			explainInterruptedAssistant(event.message, state.activeInterruptReason);
			if (event.message.role === "assistant") {
				attemptRetryForecast = state.runtime ? recovery.forecastRetry(state.runtime, event.message) : null;
				if (attemptRetryForecast !== null) Object.assign(event, { retryPending: attemptRetryForecast });
			}
			if (state.currentAskUserPolicy?.planOnly && event.message.role === "assistant") {
				for (const block of event.message.content) {
					if (block.type !== "text") continue;
					const clean = stripPlanCloseOptions(block.text);
					if (clean !== block.text) {
						block.text = clean;
						Object.assign(event, { lockedSynthesisSanitized: true });
					}
				}
			}
		}
		emit(event as ChatLoopEvent);
	};

	const turnRuntime = createTurnRuntime({
		onMemoryRequestSubmitted: deps.onMemoryRequestSubmitted,
		turnIdentity: () => submitGeneration,
		interactiveGuidance: deps.interactiveGuidance === true,
		state,
		gatewayCapabilityNames: () => deps.toolRegistry?.listGateway().map((spec) => spec.name) ?? [],
		getSettings: deps.getSettings,
		providers: deps.providers,
		knownTargets: deps.knownTargets,
		telemetry: deps.telemetry,
		scheduling: deps.scheduling,
		headless: deps.headless,
		createAgent,
		noteMainRequest: (runtime, request, stream) => {
			keepalive.noteRequest(runtime, request, stream);
			const record: MainRequestRecord = { request, sentAt: Date.now(), promptTokens: null };
			state.lastMainRequest = { runtime, record };
			// The prompt size the provider reports is what a compaction inside this prefix reads from cache (T4).
			stream.result().then(
				(message) => {
					if (message.stopReason !== "error" && message.stopReason !== "aborted")
						record.promptTokens = cacheKeepalivePromptTokens(message);
				},
				() => {
					// A failed request leaves no cache entry to read; promptTokens stays null and the prefix is refused.
				},
			);
		},
		continuity,
		hasQueuedSteering: () => queues.hasPendingSteer(),
		queueHandOver: {
			atFinishTurn: (final) => queues.handOverAtFinishTurn(final),
			afterPrepareNextTurn: () => queues.handOverAfterPrepareNextTurn(),
		},
		middlewareToolChoice,
		persistence,
		context,
		middleware,
		retrySettings,
		sessionId: () => deps.session?.current()?.id,
		sessionOrigin: () => deps.session?.current() ?? null,
		onModelRequestSent: (call) => messagePath.requestSent(call),
		onModelCallSettled: (facts) => messagePath.callSettled(facts),
		...(deps.admitFlow !== undefined ? { admitFlow: deps.admitFlow } : {}),
		emit: emitRuntimeEvent,
		emitNotice,
		emitFooterNotice,
		toolStartTimes,
		prepareInRunContinuation: async (signal) => {
			const userTurnId = state.activeUserTurnId;
			if (!deps.turnControl || userTurnId === null) return null;
			const identity = submitGeneration;
			const ownerSignal = submitOwner?.signal;
			const controllerAbort = new AbortController();
			const forward = () => controllerAbort.abort();
			signal?.addEventListener("abort", forward, { once: true });
			if (signal?.aborted || ownerSignal?.aborted) controllerAbort.abort();
			try {
				const result = await deps.turnControl.run({ userTurnId, signal: controllerAbort.signal });
				if (controllerAbort.signal.aborted || ownerSignal?.aborted || identity !== submitGeneration) return null;
				outcomeCollector.recordControl(result.record);
				if (deps.session?.current()) {
					try {
						deps.session.appendEntry({
							kind: "custom",
							customType: "turnControl",
							parentTurnId: state.lastTurnId,
							display: false,
							data: result.record,
						});
					} catch {
						/* S6: ledger recording is best effort and never costs the continuation. */
					}
				}
				return result.block;
			} finally {
				signal?.removeEventListener("abort", forward);
			}
		},
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
		deps.bus?.subscribe("config.hot_reloaded", () => {
			context.invalidateSessionPromptCache();
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		}) ?? null;
	const unsubscribeConfigNextTurn =
		deps.bus?.subscribe("config.next_turn_scheduled", (payload) => {
			if (
				!payload.diff.nextTurn.some(
					(path) => path === "chat" || path.startsWith("chat.") || path === "targets" || path.startsWith("targets."),
				)
			)
				return;
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		}) ?? null;
	const unsubscribePluginsReload =
		deps.bus?.subscribe("plugin.reloaded", () => {
			context.invalidateSessionPromptCache();
		}) ?? null;

	const unsubscribeSynthesisLock =
		deps.bus?.subscribe("safety.loop_blocked", (payload) => {
			const disposition = (payload as { disposition?: unknown } | null)?.disposition;
			if (disposition === "lockout") state.synthesisToolLock = true;
		}) ?? null;
	const unsubscribeToolBudgetLock =
		deps.bus?.subscribe("safety.tool_budget_exceeded", () => {
			state.toolBudgetLock = true;
		}) ?? null;

	// --- the state machine --------------------------------------------------

	// Settlement tracking for whenSettled(): every submit still going, coerced
	// to never reject so shutdown ordering cannot throw. `priorSubmit` is what
	// `activeSubmit` held before the latest submit joined it, which is the run an
	// interrupt has to wait out.
	let activeSubmit: Promise<void> = Promise.resolve();
	let priorSubmit: Promise<void> = Promise.resolve();
	let sessionResetSettlement: Promise<void> = Promise.resolve();
	let machineTurnOwner: object | null = null;
	let machineTurnRunning: object | null = null;
	let pendingMachineCancellation: object | null = null;
	let machinePreparation: { token: object; runtime: AgentRuntime | null } | null = null;
	let machineProjectionBinding: { host: MachineTurnProjectionHost } | null = null;
	let machineProjectionRequired = false;
	let machineHostDisposed = false;

	/** What a settled turn stopped on, when nobody asked for it and yolo has continuations left (#445). */
	const yoloContinuationDue = (): { cause: TurnContinuationCause; reason: string; retryAfterMs?: number } | null => {
		if ((deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) !== "yolo") return null;
		const failed = state.turnStop;
		// Continuing would send this provider a request before the time it named.
		if (failed?.cause === "wait_past_budget") return null;
		// A failure stop outranks a budget crossing in the same turn, so a failing turn cannot escape the cap on one.
		const stop =
			failed ??
			(state.synthesisToolLock
				? { cause: "loop_guard" as const, reason: "the loop guard locked its tools" }
				: state.toolBudgetLock
					? { cause: "tool_budget" as const, reason: "it reached the per-turn tool budget" }
					: null);
		if (stop === null) return null;
		return continuationCountsAgainstCap(stop.cause) && state.yoloContinuations >= TURN_CONTINUATION_CAP ? null : stop;
	};

	/** Give a stopped turn another one, fresh budget included, with what stopped it in the prompt (#445). */
	const continueStoppedTurn = async (
		stop: { cause: TurnContinuationCause; reason: string; retryAfterMs?: number },
		generation: number,
		constraints: ChatSubmitOptions["constraints"],
	): Promise<void> => {
		const counted = continuationCountsAgainstCap(stop.cause);
		if (counted) state.yoloContinuations += 1;
		const attempt = state.yoloContinuations;
		const context = deps.session?.current()?.id;
		deps.bus?.emit(
			"turn.continued",
			{ cause: stop.cause, attempt, cap: TURN_CONTINUATION_CAP, at: Date.now() },
			...(context === undefined ? [] : [ownerTelemetryContext({ sessionId: context })]),
		);
		emitNotice(
			`Continuing this turn because autonomy is yolo${counted ? ` (${attempt} of ${TURN_CONTINUATION_CAP})` : ""}: ${stop.reason}.`,
			"warning",
			"turn.continued",
		);
		if (stop.cause === "retries_exhausted" || stop.cause === "compaction") {
			const waited = await recovery.waitBeforeContinuation(
				turnContinuationDelayMs(attempt, stop.retryAfterMs),
				attempt,
				TURN_CONTINUATION_CAP,
				stop.reason,
			);
			if (waited === "cancelled") return;
		}
		if (disposed || generation !== submitGeneration || state.activeUserTurnId !== null || state.streaming) return;
		if (await queues.resubmitStranded()) return;
		await api.submit(
			`[Clio Coder] The previous turn stopped: ${stop.reason}. Its work and tool results are above. Continue from where it stopped, and if the work is already finished, say so and stop.${counted ? ` This is continuation ${attempt} of ${TURN_CONTINUATION_CAP}.` : ""}`,
			{
				origin: `yolo continuation ${attempt}`,
				yoloContinuation: true,
				...(constraints === undefined ? {} : { constraints }),
			},
		);
	};

	const interruptRefusalReason = (): string | null => {
		if (deps.hasAttachedDispatch?.() === true) {
			return "an attached dispatch is running and the interrupt would kill the worker's run with no run record; use @<agent> to steer it or Esc to cancel it";
		}
		if (deps.toolRegistry?.hasParkedCalls() === true) {
			return "a permission ask is parked and already waiting on you; answer it or press Esc";
		}
		return null;
	};

	/**
	 * Everything an out-of-turn round needs, or the reason it cannot run.
	 *
	 * `/btw`, `/draft`, `/handoff` and the pre-warm are the callers. All read the
	 * compiled history the next turn would see and authenticate exactly the way
	 * a turn against the same target does. Whether one runs while a turn is in
	 * flight is the caller's choice: `/handoff` and the pre-warm pass a refusal,
	 * while `/btw` and `/draft` pass null and answer beside the running turn
	 * (#415). Mid-turn the live runtime is taken as it stands, because
	 * `ensureRuntime` may hot-swap the model, rebuild and abort the agent the
	 * turn is streaming on, or append a session entry. A submit counts as in
	 * flight from entry, as it does for the pre-warm, because it is preparing
	 * that runtime before `state.streaming` flips.
	 */
	type OutOfTurnPreparation =
		| {
				ok: true;
				runtime: AgentRuntime;
				apiKey: string | undefined;
				refreshApiKey?: SideCallAuth["refreshApiKey"];
				origin: ReturnType<SessionContract["current"]>;
				inFlight: boolean;
		  }
		| { ok: false; reason: string };

	const prepareOutOfTurnRound = async (
		inFlightRefusal: string | null,
		signal?: AbortSignal,
		silent = false,
		/** The pre-warm admits once here; a side round admits each of its attempts through `sideCallAdmission` (#424). */
		admitHere = true,
	): Promise<OutOfTurnPreparation> => {
		const inFlight = state.streaming || turnActive;
		if (inFlight && inFlightRefusal !== null) return { ok: false, reason: inFlightRefusal };
		if (inFlight && !state.runtime) return { ok: false, reason: "the turn is still starting its runtime; ask again" };
		const origin = deps.session?.current() ?? null;
		let agentRuntime: AgentRuntime | null;
		try {
			agentRuntime = inFlight ? state.runtime : turnRuntime.ensureRuntime({ silent });
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
		if (!agentRuntime) return { ok: false, reason: notConfiguredNotice(deps.getSettings().chat) };
		const resolution = agentRuntime.runtimeResolution;
		try {
			if (admitHere && pricesCalls(resolution.pricedBy)) {
				await deps.scheduling?.admitPaidRequest?.({
					waitForRaise: deps.headless !== true,
					getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
					...(signal ? { signal } : {}),
				});
			}
			const sideAuth = await resolveSideCallAuth(
				deps.providers.auth,
				resolution.target,
				resolution.runtime,
				LOCAL_SIDE_QUESTION_API_KEY,
				signal,
			);
			if ((deps.session?.current()?.id ?? null) !== (origin?.id ?? null))
				return { ok: false, reason: "session changed before the request" };
			return { ok: true, runtime: agentRuntime, apiKey: sideAuth.apiKey, ...sideAuth, origin, inFlight };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	};

	/**
	 * Budget admission for each attempt of a side round, a schema or auth retry included. It runs inside the attempt's
	 * call, so a hold at the ceiling reads as its admission stage with `waitedOn: "budget"` and journals the crossing
	 * and the wait for that call; a session that changed during the wait refuses the request (#424, #434). A held
	 * request gives its endpoint slot back for the hold, because a paused request must not hold capacity.
	 */
	const sideCallAdmission =
		(runtime: AgentRuntime, origin: ReturnType<SessionContract["current"]>, slot: EndpointSlot, signal?: AbortSignal) =>
		async (hold: AdmissionHold): Promise<void> => {
			if (pricesCalls(runtime.runtimeResolution.pricedBy)) {
				const telemetry = telemetryContext();
				await deps.scheduling?.admitPaidRequest?.({
					waitForRaise: deps.headless !== true,
					getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
					onBlocked: () => {
						hold.waitedOn = "budget";
						slot.release();
					},
					...(telemetry ? { telemetry } : {}),
					...(signal ? { signal } : {}),
				});
			}
			if ((deps.session?.current()?.id ?? null) !== (origin?.id ?? null))
				throw new Error("session changed before the request");
			slot.acquire();
		};

	/**
	 * Run one out-of-turn round while holding a slot on the endpoint it streams
	 * to, exactly as the turn and the pre-warm do. A `/btw` or `/handoff` round
	 * is a full request against the same inference scheduler, so endpoint
	 * capacity (#250) has to count it for as long as it is out, and the
	 * background-memory tier has to read that endpoint as busy (#229). The round
	 * may release the slot while it waits and take it back before it sends.
	 */
	const withEndpointSlot = async <T>(runtime: AgentRuntime, round: (slot: EndpointSlot) => Promise<T>): Promise<T> => {
		const endpointKey = modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId);
		let held: (() => void) | null = null;
		const slot: EndpointSlot = {
			acquire: () => {
				if (endpointKey !== null && held === null) held = registerForegroundStream(endpointKey);
			},
			release: () => {
				held?.();
				held = null;
			},
		};
		slot.acquire();
		try {
			return await round(slot);
		} finally {
			slot.release();
		}
	};

	const sideCallJournal = (
		runtime:
			| AgentRuntime
			| {
					targetId: string;
					runtimeId: string;
					pricedBy: AgentRuntime["runtimeResolution"]["pricedBy"];
					freeRule?: AgentRuntime["runtimeResolution"]["freeRule"];
			  },
		role: CallJournalOptions["role"],
		origin: ReturnType<SessionContract["current"]>,
	): { telemetry?: CallJournalOptions } => {
		const acquire = deps.telemetry?.acquireTelemetrySession;
		return acquire
			? {
					telemetry: {
						origin,
						acquire,
						role,
						targetId: runtime.targetId,
						runtimeId: runtime.runtimeId,
						...pricingBasisFields("runtimeResolution" in runtime ? runtime.runtimeResolution : runtime),
					},
				}
			: {};
	};

	// A submit owns the turn state machine from the moment it starts running,
	// which is well before `state.streaming` flips: the probe, auto-compaction,
	// and the prompt compile all happen first. The pre-warm reads this flag, not
	// `streaming`, so it can never be the request the operator's turn queues
	// behind.
	let turnActive = false;
	let pendingPreTurnRead: AbortController | null = null;
	let pendingVisionSidecar: AbortController | null = null;
	let pendingCompactionPaint: AbortController | null = null;
	// Install cancellation before publishing the preparation edge; listeners may cancel synchronously.
	const prepareCompactionPaint = (): (() => Promise<void>) => {
		const controller = new AbortController();
		pendingCompactionPaint = controller;
		const sessionId = deps.session?.current()?.id;
		const cwd = process.cwd();
		return async () => {
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				controller.signal.throwIfAborted();
				if (sessionId !== deps.session?.current()?.id || cwd !== process.cwd())
					throw new DOMException("Context ownership changed before compaction", "AbortError");
			} finally {
				if (pendingCompactionPaint === controller) pendingCompactionPaint = null;
			}
		};
	};
	/**
	 * The last operator turn that settled and has not yet been followed by another
	 * operator message. The next submit reports how it was followed, once.
	 */

	// Operator turns the session already holds, for the outcome row's `turnIndex`.
	// Reparsing the whole ledger every turn made the row cost grow with the session,
	// so it is counted once per session and advanced as turns are appended;
	// `resetForSession` clears it for /new, /resume, /fork and a park.
	let operatorTurnsBefore: number | null = null;
	const operatorTurnIndex = (excludeTurnId?: string): number => {
		operatorTurnsBefore ??= (deps.readSessionEntries?.() ?? []).filter((entry) => {
			if (entry.kind !== "message" || entry.role !== "user") return false;
			return (entry.payload as { synthetic?: unknown } | null)?.synthetic !== true && entry.turnId !== excludeTurnId;
		}).length;
		return operatorTurnsBefore;
	};

	const lateReceiptWatchers = new Set<() => void>();
	/**
	 * A cancelled turn's outcome was written with worker receipts still unsealed. When
	 * they seal, a `turnOutcomeTokens` entry amends the ledger and a `turn-tokens` row
	 * the dataset, both keyed by turn id and ref. The ledger entry needs the session
	 * that owns the turn, so after /new or /resume only the dataset row is written.
	 */
	const amendLateWorkerTokens = (input: {
		turnId: string;
		parentTurnId: string | null;
		runIds: ReadonlyArray<string>;
		missing: ReadonlyArray<string>;
	}): void => {
		if (input.missing.length === 0 || !deps.outcomeDispatch) return;
		const sessionId = deps.session?.current()?.id ?? null;
		const stop = watchLateWorkerRunResults({
			missing: input.missing,
			dispatch: deps.outcomeDispatch,
			onDone: (afterMs) => {
				lateReceiptWatchers.delete(stop);
				if (afterMs === null) return;
				const workers = workerOutcomeUsage(input.runIds, deps.outcomeDispatch);
				if (sessionId !== null && deps.session?.current()?.id === sessionId) {
					try {
						deps.session.appendEntry({
							kind: "custom",
							customType: TURN_OUTCOME_TOKENS_CUSTOM_TYPE,
							parentTurnId: input.parentTurnId,
							display: false,
							data: { turnId: input.turnId, workers, sealedAfterMs: afterMs },
						});
					} catch {
						// The ledger closed under the watcher, so the late count is lost with it.
					}
				}
			},
		});
		lateReceiptWatchers.add(stop);
	};

	/** One turn.settled per settled user turn, from the turn's own call facts (#430, #434). */
	const recordTurnSettled = async (
		userTurnId: string,
		stopReason: unknown,
		retries: number,
		fallbackCause?: FailureCause,
	): Promise<void> => {
		const calls = turnRuntime.takeSettledCalls(userTurnId);
		const origin = deps.session?.current();
		const acquire = deps.telemetry?.acquireTelemetrySession;
		if (!origin || !acquire) return;
		try {
			const lease = await acquire(origin, mainAgent(origin.id), userTurnId);
			try {
				telemetryHub().emit(
					"turn.settled",
					turnSettlementFromCalls(stopReason, calls, retries, fallbackCause),
					lease.context,
				);
			} finally {
				await lease.release();
			}
		} catch {
			// Recording an outcome never costs the turn it describes; the journal reports its own write gaps.
		}
	};

	/**
	 * A turn the operator cancelled before admission (the pre-turn reads, the
	 * orientation act or pre-submit compaction) leaves no user turn, so the settle
	 * path never runs for it, yet Esc on a turn is the strongest label there is.
	 * This writes the one outcome row that path would have, under the reserved
	 * id every decision about the turn already carries.
	 */
	const recordCanceledBeforeAdmission = async (input: {
		userTurnId: string;
		continuation: boolean;
		control: TurnControlRecord | null;
		submittedAt: number;
	}): Promise<void> => {
		if (!deps.session?.current()) return;
		try {
			if (input.control) outcomeCollector.recordControl(input.control);
			const collected = outcomeCollector.take(input.userTurnId);
			const missingReceipts = await awaitWorkerRunResults(collected.harness.runIds, deps.outcomeDispatch);
			const record = reduceTurnOutcome({
				...collected,
				turnId: input.userTurnId,
				turnIndex: operatorTurnIndex(),
				continuation: input.continuation,
				finalAssistantText: "",
				taskEstablished: deps.getTaskEstablished?.() ?? false,
				canceled: true,
				tokens: {
					coordinator: noOutcomeUsage(),
					workers: workerOutcomeUsage(collected.harness.runIds, deps.outcomeDispatch),
				},
				failure: classifyCallFailure("Canceled before admission", { invoked: false, aborted: true, retryAttempts: 0 }),
				stopReason: "aborted",
				durationMs: Math.max(0, performance.now() - input.submittedAt),
			});
			const outcomeParent = state.lastTurnId;
			deps.session.appendEntry({
				kind: "custom",
				customType: "turnOutcome",
				parentTurnId: outcomeParent,
				display: false,
				data: record,
			});
			outcomeCollector.seedClarificationStreak(record.conversation.clarificationStreak);
			await recordTurnSettled(input.userTurnId, "aborted", 0, "operator_cancel");
			amendLateWorkerTokens({
				turnId: input.userTurnId,
				parentTurnId: outcomeParent,
				runIds: collected.harness.runIds,
				missing: missingReceipts,
			});
		} catch {
			// Measurement must not change how a cancelled turn settles.
		}
	};

	const prewarm = createTurnPrewarm({
		callJournal: (runtime, origin) => sideCallJournal(runtime, "prewarm", origin),
		state,
		getSettings: deps.getSettings,
		providers: deps.providers,
		context,
		bus: deps.bus,
		...(deps.admitRuntimeFlow !== undefined ? { admitRuntimeFlow: deps.admitRuntimeFlow } : {}),
		...(deps.session ? { session: deps.session } : {}),
		isLatencySurface: () => deps.isLatencySurface?.() !== false,
		isTurnActive: () => turnActive || deps.isPrewarmBusy?.() === true,
		hasActiveDispatch: () => (deps.hasActiveDispatch ?? deps.hasAttachedDispatch)?.() === true,
		prepareRuntime: async (signal) => {
			// The same probe a submit awaits, so the pre-warm resolves the model the
			// next turn will resolve rather than a stale catalog entry.
			await turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
			return prepareOutOfTurnRound("a turn is in flight", signal, true);
		},
		applySessionTools: (runtime) => {
			runtime.agent.state.tools = resolveSessionTools(
				runtime,
				deps.toolRegistry,
				currentToolInvokeOptions,
				turnRuntime.toolTelemetry,
				sessionToolLimits,
			);
		},
		...(deps.runPrewarm ? { runPrewarm: deps.runPrewarm } : {}),
		...(deps.abortPrewarmOnSubmit === undefined ? {} : { abortRoundOnSubmit: deps.abortPrewarmOnSubmit }),
		...(deps.registerPrewarmEndpointSlot ? { registerEndpointSlot: deps.registerPrewarmEndpointSlot } : {}),
	});
	const unsubscribePrewarmCompaction = subscribePrewarmToCompaction(deps.bus, prewarm);
	// #423: a hosted route's prompt cache outlives the turn's waits on its own tools, above all an attached dispatch.
	const keepalive = createTurnKeepalive({
		enabled: () => deps.getSettings().chat.cacheKeepalive,
		isTurnActive: () => turnActive,
		waitsOnOperator: () => state.currentAskUserPolicy?.inFlight === true || deps.toolRegistry?.hasParkedCalls() === true,
		hasAttachedDispatch: () => deps.hasAttachedDispatch?.() === true,
		isCurrentRuntime: (runtime) => state.runtime === runtime,
		canSpend: (usd) => {
			const budget = deps.scheduling?.preflight();
			return budget === undefined || !sessionCeilingReached(budget.currentUsd + usd, budget.ceilingUsd);
		},
		withEndpointSlot,
		callJournal: (runtime) => sideCallJournal(runtime, "prewarm", deps.session?.current() ?? null).telemetry,
		record: (runtime, refresh) => {
			try {
				deps.session?.appendEntry({
					kind: "custom",
					customType: "prewarm",
					// A fact about the provider cache, never a model message or a transcript block.
					display: false,
					parentTurnId: state.lastTurnId,
					data: {
						trigger: "keepalive",
						phase: refresh.phase,
						target: runtime.targetId,
						model: runtime.wireModelId,
						promptTokens: refresh.promptTokens,
						economics: refresh.economics,
						promptCache: {
							input: refresh.message?.usage.input ?? null,
							cacheRead: refresh.message?.usage.cacheRead ?? null,
							cacheWrite: refresh.message?.usage.cacheWrite ?? null,
						},
						...(refresh.error === null ? {} : { error: refresh.error }),
					},
				});
			} catch {
				// The ledger entry is diagnostics; the spend is already booked above.
			}
		},
	});
	// The prompt this process will send is known now: the session prompt compiles
	// against the configured target, and a boot-time resume rebuilds the message
	// array in the same tick, which the scheduler collapses onto one round.
	prewarm.schedule("session-start");

	// --- steering triage ----------------------------------------------------
	//
	// Off by default (chat.steering.triage). Once the queue has settled for a
	// moment with enough entries, one detached round reads it, typed picks from a
	// bound route or else the side model, and relabels entries: an unrelated task moves to the end of the turn, a
	// confident stop may interrupt the run when the operator allowed it. The
	// round never holds the engine; a verdict that lands after the queue changed
	// is dropped, and the operator's own toggles pin an entry against it.
	const TRIAGE_DEBOUNCE_MS = 1200;
	let triageTimer: ReturnType<typeof setTimeout> | null = null;
	let triageInFlight = false;

	const cancelTriage = (): void => {
		if (triageTimer !== null) clearTimeout(triageTimer);
		triageTimer = null;
	};

	const scheduleTriage = (): void => {
		const triage = deps.getSettings().chat.steering.triage;
		if (!triage.enabled || queues.entries().length < triageFloor(triage, deps.systemOne)) return;
		cancelTriage();
		triageTimer = setTimeout(() => {
			triageTimer = null;
			void runTriage();
		}, TRIAGE_DEBOUNCE_MS);
		triageTimer.unref?.();
	};

	type TriageModel = Omit<SideCallAuth, "apiKey"> & {
		model: EngineModel;
		target: AgentRuntime["runtimeResolution"]["target"];
		targetId: string;
		runtimeId: string;
		wireModelId: string;
		pricedBy: AgentRuntime["runtimeResolution"]["pricedBy"];
		freeRule?: AgentRuntime["runtimeResolution"]["freeRule"];
		apiKey: string | undefined;
	};

	/** The configured triage target, or the session's active runtime when none is named. */
	const resolveTriageModel = async (signal: AbortSignal): Promise<TriageModel | null> => {
		const triage = deps.getSettings().chat.steering.triage;
		const runtime = state.runtime;
		if (!runtime) return null;
		if (!triage.target) {
			const resolution = runtime.runtimeResolution;
			const sideAuth = await resolveSideCallAuth(
				deps.providers.auth,
				resolution.target,
				resolution.runtime,
				LOCAL_SIDE_QUESTION_API_KEY,
				signal,
			);
			return {
				model: runtime.agent.state.model,
				target: resolution.target,
				targetId: runtime.targetId,
				runtimeId: resolution.runtime.id,
				wireModelId: runtime.wireModelId,
				...pricingBasisFields(resolution),
				apiKey: sideAuth.apiKey,
				...sideAuth,
			};
		}
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId: triage.target,
			wireModelId: triage.model,
			requestedThinkingLevel: "off",
			requireTools: false,
			requireStreaming: false,
			requireOutputBudget: false,
		});
		if (!resolved.ok) return null;
		const route = resolved.target;
		const kbHit = deps.providers.knowledgeBase?.lookup(route.wireModelId, route.runtime.id) ?? null;
		const sideAuth = await resolveSideCallAuth(
			deps.providers.auth,
			route.target,
			route.runtime,
			LOCAL_SIDE_QUESTION_API_KEY,
			signal,
		);
		return {
			model: route.runtime.synthesizeModel(route.target, route.wireModelId, kbHit),
			target: route.target,
			targetId: route.targetId,
			runtimeId: route.runtimeId,
			wireModelId: route.wireModelId,
			...pricingBasisFields(route),
			apiKey: sideAuth.apiKey,
			...sideAuth,
		};
	};

	const runTriage = async (): Promise<void> => {
		if (triageInFlight || !state.streaming || !state.runtime) return;
		const triage = deps.getSettings().chat.steering.triage;
		const asked: TriageEntry[] = queues.entries().map((entry) => ({ id: entry.id, text: entry.text, kind: entry.kind }));
		if (asked.length < triageFloor(triage, deps.systemOne)) return;
		triageInFlight = true;
		try {
			await runTriageRound({
				triage,
				systemOne: deps.systemOne,
				asked,
				task: () => deps.currentOperatorTask?.() ?? "",
				previous: () => (state.runtime ? lastAssistantText(state.runtime.agent.state.messages) : ""),
				current: () => state.streaming && triageSnapshotMatches(asked, queues.entries()),
				apply: (verdicts) => applyTriage(verdicts, triage.autoInterrupt),
				side: () => runSideTriage(asked),
			});
		} catch {
			// A failed round leaves the queue exactly as the operator left it.
		} finally {
			triageInFlight = false;
		}
	};

	/** The side-model round. It has its own deadline, so an ask that spent its bound before falling back does not end it. */
	const runSideTriage = async (asked: ReadonlyArray<TriageEntry>): Promise<void> => {
		if (!state.runtime) return;
		const triage = deps.getSettings().chat.steering.triage;
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), triage.timeoutMs);
		deadline.unref?.();
		try {
			const resolved = await resolveTriageModel(controller.signal);
			if (resolved === null) return;
			const destination = {
				targetId: resolved.targetId,
				runtimeId: resolved.runtimeId,
				wireModelId: resolved.wireModelId,
			};
			// The queued texts carry whatever the operator inlined into them, so the
			// round is admitted under the session's flow restrictions like any side round.
			if ((deps.admitRuntimeFlow?.(destination) ?? null) !== null) return;
			const endpointKey = modelEndpointKey(resolved.target, resolved.wireModelId);
			const release = endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
			const origin = deps.session?.current() ?? null;
			let result: SideQuestionResult;
			try {
				result = await draftRound({
					...sideCallJournal(resolved, "helper", origin),
					admitFlow: () => deps.admitRuntimeFlow?.(destination) ?? null,
					model: resolved.model,
					messages: [],
					systemPrompt: TRIAGE_SYSTEM_PROMPT,
					userText: triageUserText({
						task: deps.currentOperatorTask?.() ?? "",
						previous: state.runtime ? lastAssistantText(state.runtime.agent.state.messages) : "",
						entries: asked,
					}),
					maxTokens: TRIAGE_MAX_TOKENS,
					// A schema-bound classification; reasoning only spends the output budget.
					thinkingLevel: "off",
					responseSchema: { name: TRIAGE_SCHEMA_NAME, schema: TRIAGE_RESPONSE_SCHEMA },
					runtimeId: resolved.runtimeId,
					signal: controller.signal,
					...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
					...(resolved.refreshApiKey ? { refreshApiKey: resolved.refreshApiKey } : {}),
				});
			} finally {
				release();
			}
			if (result.aborted) return;
			const verdicts = parseTriageAnswer(
				result.text,
				asked.map((entry) => entry.id),
			);
			if (!triageSnapshotMatches(asked, queues.entries())) {
				return;
			}
			applyTriage(verdicts, triage.autoInterrupt);
		} finally {
			clearTimeout(deadline);
		}
	};

	const applyTriage = (verdicts: ReadonlyArray<TriageVerdict>, autoInterrupt: boolean): void => {
		for (const verdict of verdicts) {
			const entry = queues.entries().find((candidate) => candidate.id === verdict.id);
			if (entry === undefined) continue;
			if (
				autoInterrupt &&
				state.streaming &&
				triageMayInterrupt(verdict, entry, Date.now()) &&
				interruptRefusalReason() === null
			) {
				const taken = queues.removeEntry(entry.id, "sent-now");
				if (taken === null) continue;
				const preview = taken.text.replace(/\s+/g, " ").slice(0, 60);
				emitNotice(`[Clio Coder] triage read "${preview}" as a stop; interrupting the run to deliver it now.`, "warning");
				void submitTracked(taken.text, {
					steering: "interrupt",
					continuesMessage: { id: taken.id, enqueuedAt: taken.enqueuedAt },
					...(taken.display ? { display: taken.display } : {}),
					...(taken.referencedPaths && taken.referencedPaths.length > 0
						? { workingContextPaths: taken.referencedPaths }
						: {}),
				}).catch(() => {
					// The interrupt path reports its own refusals; nothing else to do here.
				});
				// One interrupt per round: the rest of the queue is held for the new run.
				return;
			}
			queues.relabel(entry.id, triageLabelsFor(verdict), triageKindFor(verdict));
		}
	};

	const api: ChatLoop = {
		steer: (text) => queues.steer(text) !== null,
		queueFollowUp: (text, display, origin) =>
			queues.queueFollowUp(text, display, origin === undefined ? undefined : { origin }) !== null,
		queueEntries: () => queues.entries(),
		removeQueuedEntry: (id, reason) => queues.removeEntry(id, reason),
		moveQueuedEntry: (id, delta) => queues.moveEntry(id, delta),
		setQueuedEntryKind: (id, kind) => queues.setEntryKind(id, kind),
		interruptRefusal: () => (state.streaming ? interruptRefusalReason() : null),
		clearSkillSurface: () => {
			const cleared = skillSurfaceNames(state.activeSkillSurface);
			armSkillSurface(undefined, undefined, true);
			return cleared;
		},
		activeSkillSurface: () => skillSurfaceNames(state.activeSkillSurface),
		activeEggs: eggs.active,
		eggsCommand: eggs.command,
		discoverOperatorEgg: (text, ask) =>
			deps.headless ? Promise.resolve(false) : eggs.discover(text, ask ?? deps.eggAsk),
		refuseSkillRequests,
		clearQueuedFollowUps: () => queues.clearQueuedMirror().map((entry) => entry.text),
		queuedMessages: () => queues.queuedMessages(),

		async submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
			let owner: AbortController | null = null;
			let promptStarted = false;
			const generation = submitGeneration;
			const admissionCurrent = (): boolean =>
				!disposed && generation === submitGeneration && !owner?.signal.aborted && options.isAdmissionCurrent?.() !== false;
			const returnUnstarted = (): void => {
				if (options.queued === undefined || promptStarted || disposed) return;
				if (generation === submitGeneration) queues.requeueUnstarted(options.queued);
				else queues.reportDropped([options.queued]);
			};
			if (!admissionCurrent()) {
				returnUnstarted();
				return;
			}
			const submittedAt = performance.now();
			const submittedWallAt = Date.now();
			const continuedMessage = options.queued ?? options.continuesMessage;
			let interrupted = false;
			if (state.streaming) {
				if (options.machineTurn !== undefined) return;
				let mode: SteeringMode = options.origin !== undefined ? "end-of-turn" : (options.steering ?? DEFAULT_STEERING_MODE);
				let front = options.queueFront === true;
				const trimmed = text.trim();
				// A constrained submission is refused below unless the interrupt
				// lands, so the fallbacks must not announce it as queued.
				const constrained = options.constraints !== undefined;
				let refusal: string | null = null;
				if (mode === "interrupt" && trimmed.length > 0) {
					refusal = interruptRefusalReason();
					if (refusal !== null) {
						if (!constrained)
							emitNotice(`[Clio Coder] interrupt refused: ${refusal}. Queued for the next slot instead.`, "warning");
						mode = "next-slot";
						front = true;
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
						if (!admissionCurrent()) {
							returnUnstarted();
							return;
						}
						if (!state.streaming) {
							interrupted = true;
						} else {
							// Something restarted a run while the cancel settled (a
							// continuation resubmit); do not fight it, deliver at the next slot.
							if (!constrained)
								emitNotice(
									"[Clio Coder] a run restarted before the interrupt landed. Queued for the next slot instead.",
									"warning",
								);
							mode = "next-slot";
						}
					}
				}
				if (!interrupted) {
					if (constrained) {
						emitAdmissionNotice(
							`A submission with explicit task constraints must start a fresh turn; ${
								refusal !== null ? `the interrupt was refused: ${refusal}` : "wait for settlement or interrupt the active run"
							}.`,
							"constrained-turn-in-flight",
							"error",
						);
						options.onRefused?.("constrained-turn-in-flight");
						returnUnstarted();
						return;
					}
					const hasImages = options.images !== undefined && options.images.length > 0;
					if (!hasImages && trimmed.length > 0 && state.runtime) {
						// Enter while streaming means "correct it now": the engine
						// steering queue drains after every tool batch, so the text
						// lands as a user message before the next model turn.
						// The end-of-turn mode (ACP, or the navigator's slot toggle) keeps the after-this-run intent.
						if (isWorkerShareNote(trimmed)) state.turnSharedWorkerNote = true;
						// Inlined @file content is part of this text and reaches the model
						// at the next slot without passing the fresh-prompt path, so its
						// information-flow sources are labeled now, not when it lands.
						const referencedPaths = options.workingContextPaths ?? [];
						if (referencedPaths.length > 0) {
							deps.labelReferencedPaths?.(referencedPaths);
							context.addWorkingContextPaths(referencedPaths);
						}
						// The queue carries the submitted bytes, not the trimmed copy the
						// guard above reads: a steer is a model-facing turn and the
						// payload contract applies to it too (issue #244).
						const entry =
							mode === "end-of-turn"
								? queues.queueFollowUp(text, options.display, {
										referencedPaths,
										...(options.origin !== undefined ? { origin: options.origin } : {}),
										...(continuedMessage ? { continues: continuedMessage } : {}),
									})
								: queues.steer(text, options.display, {
										front,
										referencedPaths,
										...(continuedMessage ? { continues: continuedMessage } : {}),
									});
						if (entry !== null) scheduleTriage();
						return;
					}
					emitNotice("[Clio Coder] response already in progress. Press Esc to cancel the active run.");
					return;
				}
			}

			owner = new AbortController();
			submitOwner?.abort();
			submitOwner = owner;
			if (options.flushQueue === true) queues.flushOnNextPrompt();
			// A continuation or a machine turn is Clio's own and no message anyone sent.
			const pathMessage =
				options.requestContinuation === true || options.yoloContinuation === true || options.machineTurn !== undefined
					? null
					: {
							id: continuedMessage?.id ?? `prompt_${randomUUID().slice(0, 8)}`,
							submittedAt: continuedMessage?.enqueuedAt ?? submittedWallAt,
						};
			if (pathMessage && !continuedMessage)
				messagePath.submitted(pathMessage, {
					chars: text.length,
					by: options.origin === undefined ? "operator" : "machine",
					wallMs: submittedWallAt,
					mono: submittedAt,
				});
			let turnLease: TelemetrySessionLease | undefined;
			try {
				await sessionResetSettlement;
				if (!admissionCurrent()) return;
				// The turn holds its session's writer open from submit to settle, so the records it makes outside a model
				// call (middleware at turn start, tools, snapshots) reach the journal after an idle close (#434).
				const turnOrigin = deps.session?.current();
				if (turnOrigin && deps.telemetry?.acquireTelemetrySession) {
					try {
						turnLease = await deps.telemetry.acquireTelemetrySession(turnOrigin, mainAgent(turnOrigin.id));
					} catch {
						// The writer reports its own failures; a turn never waits on telemetry.
					}
					if (!admissionCurrent()) return;
				}
				state.currentTurnConstraints =
					options.requestContinuation === true
						? state.currentTurnConstraints
						: snapshotTurnConstraints(narrowTurnConstraints(promptToolLimits, options.constraints));
				const previousRunSnapshot = state.lastRunSnapshot;
				let previousThinkingLevel: string | undefined = previousRunSnapshot?.runtimeResolution?.effectiveThinkingLevel;
				let previousModel: { targetId: string; modelId: string } | undefined = previousRunSnapshot
					? { targetId: previousRunSnapshot.targetId, modelId: previousRunSnapshot.wireModelId }
					: undefined;
				if (previousThinkingLevel === undefined || previousModel === undefined) {
					// #423: resume can append the newly requested dial before this loop boots.
					// Recover what the last call used, ignoring changes after that call.
					const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
					const entry = [...entries].reverse().find((row) => row.kind === "message" && row.role === "assistant");
					const lastCall = entry ? entries.indexOf(entry) : -1;
					if (entry?.kind === "message") {
						const payload = entry.payload as {
							promptCache?: {
								observation?: { requestFingerprint?: { thinkingLevel?: string; targetId?: string; modelId?: string } };
							};
						} | null;
						const fingerprint = payload?.promptCache?.observation?.requestFingerprint;
						if (previousModel === undefined && fingerprint?.targetId !== undefined && fingerprint.modelId !== undefined)
							previousModel = { targetId: fingerprint.targetId, modelId: fingerprint.modelId };
						previousThinkingLevel ??= fingerprint?.thinkingLevel;
						if (previousThinkingLevel === undefined) {
							const meta = deps.session?.current();
							const compile = meta
								? readPromptCompileRecords(meta)
										.reverse()
										.find((record) => record.at <= entry.timestamp)
								: undefined;
							previousThinkingLevel = compile?.thinkingLevel ?? undefined;
							const change = entries
								.slice(0, lastCall)
								.reverse()
								.find((row) => row.kind === "thinkingLevelChange");
							if (change?.kind === "thinkingLevelChange" && (!compile || change.timestamp > compile.at)) {
								previousThinkingLevel = change.thinkingLevel;
							}
						}
					}
				}
				let agentRuntime: AgentRuntime | null;
				try {
					markPreparationStep("capabilities");
					await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
					if (!admissionCurrent()) return;
					agentRuntime = turnRuntime.ensureRuntime();
				} catch (err) {
					emitAdmissionNotice(
						err instanceof Error ? err.message : String(err),
						err instanceof TurnAdmissionError ? err.reason : "admission-failed",
						"error",
					);
					return;
				}
				if (!agentRuntime) {
					emitAdmissionNotice(notConfiguredNotice(deps.getSettings().chat), nullRuntimeAdmissionReason(), "error");
					return;
				}
				if (options.machineTurn?.preparationToken === machinePreparation?.token && machinePreparation !== null)
					machinePreparation.runtime = agentRuntime;
				if (refuseSkillRequests(options.pendingSkillRequests ?? [], options.workingContextPaths ?? [])) return;
				if (deps.promptSubmit && options.requestContinuation !== true) {
					markPreparationStep("prompt-hook");
					const verdict = await deps.promptSubmit({ typed: options.display?.text ?? text, text });
					if (!admissionCurrent()) return;
					if (verdict.kind === "block") {
						emit({
							type: "notice",
							level: "warning",
							surface: "transcript",
							text: verdict.reason,
							admission: { reason: "prompt-blocked" },
						});
						return;
					}
					text = verdict.text;
				}
				const operatorText = text;
				let sidecarObservation: string | null = null;
				const routeAcceptsImages = acceptsImageInput({
					runtimeId: agentRuntime.runtimeResolution.runtime.id,
					vision: agentRuntime.runtimeResolution.capabilityDecisions.vision,
				});
				if (options.images?.length && !routeAcceptsImages) {
					if (deps.visionSidecar?.configured()) {
						const sidecar = deps.visionSidecar;
						const controller = owner;
						pendingVisionSidecar = controller;
						emitNotice(`[Clio Coder] Processing image with ${sidecar.label() ?? "vision sidecar"}...`);
						try {
							const question = operatorText.trim() || "Describe the attached image and any visible text.";
							markPreparationStep("images");
							const analysis = await sidecar.analyze(options.images, question, controller.signal);
							if (controller.signal.aborted || !admissionCurrent()) return;
							sidecarObservation = visionObservationText(analysis);
							text = [operatorText, sidecarObservation].filter(Boolean).join("\n\n");
							emitNotice(`[Clio Coder] Image processed with ${analysis.model}.`);
						} catch (err) {
							if (controller.signal.aborted) {
								emitAdmissionNotice("[Clio Coder] Image processing cancelled.", "vision-sidecar-cancelled", "info");
							} else {
								const reason = err instanceof Error ? err.message : String(err);
								emitAdmissionNotice(`[Clio Coder] Image processing failed: ${reason}`, "vision-sidecar-failed", "error");
							}
							return;
						} finally {
							if (pendingVisionSidecar === controller) pendingVisionSidecar = null;
						}
					} else {
						const route = agentRuntime.runtimeResolution;
						const choices = visionModelOptions();
						const alternatives = choices.length
							? ` Known vision-capable models: ${choices.join(", ")}. Open /model to switch.`
							: " No vision-capable models are known in the configured catalog.";
						emit({
							type: "notice",
							level: "warning",
							surface: "transcript",
							text: `IMAGE_INPUT_UNSUPPORTED: ${route.targetId}/${route.wireModelId} cannot accept image input.${alternatives}`,
							admission: { reason: "image-input-unsupported" },
							source: "images",
						});
						return;
					}
				}
				const historicalImages = countImageBlocks(agentRuntime.agent.state.messages);
				if (!routeAcceptsImages && historicalImages > 0) {
					const route = agentRuntime.runtimeResolution;
					const key = `${route.targetId}/${route.wireModelId}:${historicalImages}`;
					if (key !== lastHistoricalImageNoticeKey) {
						lastHistoricalImageNoticeKey = key;
						emitNotice(
							`[Clio Coder] ${historicalImages} earlier image${historicalImages === 1 ? "" : "s"} omitted from requests to text-only ${route.targetId}/${route.wireModelId}. The original images remain in session history for a vision-capable model.`,
							"warning",
							undefined,
							undefined,
							"images",
						);
					}
				} else {
					lastHistoricalImageNoticeKey = null;
				}

				// 1. Accept the prompt: reset per-turn accounting, freeze the tool
				// surface, fire turn_start, and assemble the submitted text.
				state.turnToolCalls = 0;
				state.turnToolNames = [];
				state.turnSharedWorkerNote = isWorkerShareNote(text);
				state.pendingInRunContinuation = false;
				state.turnStop = null;
				if (options.yoloContinuation !== true) state.yoloContinuations = 0;
				middlewareToolChoice.reset();
				if (options.requestContinuation !== true) state.stalledTurnNudgeSpent = false;
				const images = sidecarObservation === null && options.images?.length ? [...options.images] : undefined;
				const pendingSkillRequests =
					state.currentTurnConstraints?.skills === "disabled" ? [] : (options.pendingSkillRequests ?? []);
				// Inlined @file content is part of this text, and the pre-turn decision or
				// a preparation compaction can send it before the user turn is filed.
				// A first turn has no session to hold the label yet, so it is recorded
				// again once the turn below has created one.
				const referencedPaths = options.workingContextPaths ?? [];
				if (referencedPaths.length > 0) deps.labelReferencedPaths?.(referencedPaths);
				context.addWorkingContextPaths(referencedPaths);
				context.prepareMemoryTurn(agentRuntime, {
					taskText: text,
					continuation: options.requestContinuation === true,
					images,
				});
				// The user turn id is fixed before turn control runs, so its record and the
				// ledger row carry the id the user turn will be filed under. A run that returns
				// before admission leaves the id unused, which costs nothing.
				const reservedUserTurnId = randomUUID();
				if (options.requestContinuation !== true) {
					operatorSpokeAt = Date.now();
					try {
						deps.onOperatorTurn?.({ task: text });
					} catch {
						// The host's own bookkeeping never costs the submit.
					}
				}

				let turnControlBlock: string | null = null;
				let turnControlRecord: TurnControlRecord | null = null;
				if (deps.turnControl) {
					const controllerAbort = owner;
					pendingPreTurnRead = controllerAbort;
					setTurnPreparation("preparing");
					markPreparationStep("turn-control");
					try {
						const result = await deps.turnControl.run({
							userTurnId: reservedUserTurnId,
							signal: controllerAbort.signal,
						});
						if (generation !== submitGeneration || disposed) return;
						turnControlBlock = result.block;
						turnControlRecord = result.record;
					} finally {
						if (pendingPreTurnRead === controllerAbort) pendingPreTurnRead = null;
					}
					if (generation !== submitGeneration || disposed) return;
					if (controllerAbort.signal.aborted) {
						await recordCanceledBeforeAdmission({
							userTurnId: reservedUserTurnId,
							continuation: options.requestContinuation === true,
							control: turnControlRecord,
							submittedAt,
						});
						return;
					}
				}
				// A skill the operator activated narrows the tools for the workflow
				// it started, and that workflow outlives the turn it began in. A
				// fresh /skill this turn replaces the armed surface; otherwise the
				// armed surface is what this turn runs under.
				const pendingSkillPolicy = withModelSkillActivation(
					createPendingSkillToolPolicy(pendingSkillRequests) ?? state.activeSkillSurface,
					state.currentTurnConstraints?.skills !== "disabled" && modelMayActivateSkills(),
				);
				if (pendingSkillPolicy) {
					pendingSkillPolicy.allowListAdvisory = (deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) === "yolo";
				}
				// What was already loaded when this turn started, so the settle-time
				// notice names the skills this turn activated and not the ones a
				// carried surface has been holding since an earlier message.
				const skillsLoadedBeforeTurn = new Set(pendingSkillPolicy?.loadedSkillNames ?? []);
				// Resolve the frozen session tool surface before turn_start so intent
				// middleware sees the exact tools this request can actually call.
				agentRuntime.agent.state.tools = resolveSessionTools(
					agentRuntime,
					deps.toolRegistry,
					currentToolInvokeOptions,
					turnRuntime.toolTelemetry,
					sessionToolLimits,
				);
				const toolSignature = toolSignatureFromState(agentRuntime.agent.state.tools);
				const askUserPolicy = createAskUserToolPolicy(
					agentRuntime.agent.state.tools,
					deps.toolRegistry,
					state.currentTurnConstraints,
				);
				if (askUserPolicy) askUserPolicy.planOnly = isPlanOnlyRequest(text);
				// turn_start: the prompt is accepted; registrations may inject
				// context for this request. Accumulated reminders (turn_end
				// advisories from the previous turn plus anything turn_start just
				// emitted) flush into the request as one system-reminder block.
				// Like the skill preamble below, the block is plain visible text in
				// the user message: persisted in the ledger, no hidden prompt
				// machinery.
				middleware.fireTurnStart(agentRuntime, text, pendingSkillRequests.length, options.requestContinuation === true);
				if (options.requestContinuation !== true) {
					markPreparationStep("turn-start");
					await middleware.awaitTurnStart(agentRuntime, text, pendingSkillRequests.length);
					if (!admissionCurrent()) return;
				}
				// The turn's scope is host-framed text in its own user message, kept
				// verbatim in history, never a recompile of the system prompt (#422).
				// Continuations repeat it so a mid-turn compaction cannot drop it.
				const turnScope = turnScopeGuidance(state.currentTurnConstraints);
				// The prompt delta is read when the text is composed, after
				// ensureSessionPrompt below has compared the live inputs (#423).
				const reminderProjection = middleware.takePendingReminderProjection(() =>
					[turnScope, context.sessionPromptDelta()].filter((part) => part.length > 0),
				);
				// Pending skill requests are plain visible text in the user message
				// itself: persisted in the ledger, no hidden prompt machinery.
				const skillPreamble = pendingSkillRequestPreamble(pendingSkillRequests, agentRuntime.agent.state.tools);
				let taskMemoryHandoffSource = "";
				if (pendingSkillRequests.some((request) => request.name.trim() === "context-handoff")) {
					try {
						taskMemoryHandoffSource = deps.getTaskMemoryHandoffSource?.() ?? "";
					} catch {
						// Handoff export is supplemental; a snapshot failure must not block
						// the explicitly requested skill turn.
					}
				}
				const composeSubmittedText = () =>
					[reminderProjection(), turnControlBlock ?? "", skillPreamble, taskMemoryHandoffSource, text]
						.filter((part) => part.length > 0)
						.join("\n\n");
				let submittedText = composeSubmittedText();

				// 2. Pre-submit auto-compaction trigger
				const forceNow = process.env.CLIO_CODER_FORCE_COMPACT === "1";
				const paintCompaction = prepareCompactionPaint();
				try {
					setTurnPreparation("compacting");
					await paintCompaction();
					if (!admissionCurrent()) return;
					await context.runAutoCompact(
						agentRuntime,
						forceNow,
						undefined,
						undefined,
						submittedText,
						pendingSkillPolicy,
						undefined,
						undefined,
						options.requestContinuation !== true,
					);
				} catch (err) {
					const tokens = context.contextUsage().tokens;
					// The cheaper stages run before the summary and may have applied, so the size is stated, not "unchanged".
					const size = tokens !== null ? `; context at ${footerTokens(tokens)} tokens` : "";
					const aborted = err instanceof Error && err.name === "AbortError";
					// Worded as the operator's /context compact failure is: the size, why in words, and the way on (HS14).
					// A failure here does not stop the turn, which goes out without a summary. A settled card already states a cancel.
					if (!aborted) {
						emitNotice(
							`[Clio Coder] auto-compaction failed${size}. ${compactionFailureReason(err)}. This turn goes on without it; /context compact tries again; /model picks another route to summarize on.`,
							"warning",
						);
					} else if (!context.lastCompactionCardSettled()) {
						emitNotice(`[Clio Coder] auto-compaction cancelled${size}`);
					}
					if (aborted) {
						await recordCanceledBeforeAdmission({
							userTurnId: reservedUserTurnId,
							continuation: options.requestContinuation === true,
							control: turnControlRecord,
							submittedAt,
						});
						return;
					}
				} finally {
					endPreparationCompaction();
				}

				if (!admissionCurrent()) return;

				// 3. Ensure the session prompt (compiles only on explicit events)
				markPreparationStep("compile");
				const compiledPrompt = await context.ensureSessionPrompt(agentRuntime, true, submittedText);
				if (!admissionCurrent()) return;
				submittedText = composeSubmittedText();

				// 4. Preflight overflow check, before the user turn is committed.
				// A blocked request must not leave a dangling user entry that the
				// next replay would treat as an unanswered turn.
				const compactionThreshold = deps.getSettings().context.compaction?.threshold ?? null;
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

				let turnSnapshot = captureTurnSnapshot("pending");
				let admission = context.refreshLiveBudget(submittedText);
				if (
					admission.effectiveWindow !== null &&
					!requestFits(admission.inputTokens, admission.outputReserveTokens, admission.effectiveWindow)
				) {
					const paintOverflow = prepareCompactionPaint();
					setTurnPreparation("compacting");
					let failure: string | undefined;
					let canceled = false;
					await paintOverflow()
						.then(() => {
							if (!admissionCurrent()) return false;
							return context.runAutoCompact(
								agentRuntime,
								true,
								undefined,
								"overflow",
								submittedText,
								pendingSkillPolicy,
								undefined,
								undefined,
								options.requestContinuation !== true,
							);
						})
						.catch((error: unknown) => {
							canceled = error instanceof Error && error.name === "AbortError";
							failure = error instanceof Error ? error.message : String(error);
						})
						.finally(endPreparationCompaction);
					if (generation !== submitGeneration || disposed) return;
					// An operator cancel is not an admission failure: record it like the
					// pre-admission cancels above and leave no window-exceeded notice.
					// Stop aborts the submit owner too, so the owner check alone must
					// not skip the reserved turn's outcome.
					if (canceled || owner?.signal.aborted) {
						await recordCanceledBeforeAdmission({
							userTurnId: reservedUserTurnId,
							continuation: options.requestContinuation === true,
							control: turnControlRecord,
							submittedAt,
						});
						return;
					}
					if (!admissionCurrent()) return;
					submittedText = composeSubmittedText();
					admission = context.refreshLiveBudget(submittedText);
					if (
						admission.effectiveWindow !== null &&
						!requestFits(admission.inputTokens, admission.outputReserveTokens, admission.effectiveWindow)
					) {
						emitAdmissionNotice(
							`[Clio Coder] Request exceeds the available context window (input ${admission.inputTokens ?? "unknown"} + output ${admission.outputReserveTokens ?? "unknown"}, window ${admission.effectiveWindow ?? "unknown"}).${failure ? ` ${failure}` : ""} Trim the prompt or reduce active tools.`,
							"context-window-exceeded",
							"error",
						);
						return;
					}
					turnSnapshot = captureTurnSnapshot("pending");
				}

				if (!admissionCurrent()) return;

				if (options.machineTurn !== undefined) {
					if (!options.machineTurn.onStarting() || !admissionCurrent() || state.streaming) return;
				}

				// 5. Append the user turn, then stamp and persist the snapshot.
				// PendingSkillRequest is intent only; SkillActivation ledger entries
				// are recorded on skill-load success.
				const userTurnId = persistence.appendSubmittedUserTurn(
					agentRuntime,
					submittedText,
					options.images?.length ? options.images : undefined,
					options.requestContinuation === true,
					operatorText,
					options.display?.text,
					reservedUserTurnId,
					options.origin,
				);
				if (referencedPaths.length > 0) deps.labelReferencedPaths?.(referencedPaths);
				const turnIndex = operatorTurnIndex(userTurnId ?? undefined);
				// A continuation is a synthetic user turn, which the count skips.
				if (options.requestContinuation !== true) operatorTurnsBefore = turnIndex + 1;
				context.installMemoryRestoration(agentRuntime, submittedText);
				context.commitMemoryTurn(agentRuntime);
				// An interrupt was submitted while a run was active, so no caller drew
				// it in the transcript; render it here, after the cancel notice and the
				// cancelled run's leftovers, which is the order the ledger has. A queued
				// entry sent from idle has no caller to draw it either.
				if (interrupted || (options.steering === "interrupt" && options.queued !== undefined))
					emit({
						type: "queued_user_turn",
						text: operatorText,
						kind: "interrupt",
						...(options.display ? { display: options.display } : {}),
						...(options.origin !== undefined ? { origin: options.origin } : {}),
					});
				// The first submit creates its session after capture; open its writer before session events land (#434).
				const landedSession = deps.session?.current();
				if (!turnLease && landedSession && deps.telemetry?.acquireTelemetrySession) {
					try {
						turnLease = await deps.telemetry.acquireTelemetrySession(landedSession, mainAgent(landedSession.id));
					} catch {
						// The writer reports its own failure; telemetry cannot abort a submitted turn (#434).
					}
				}
				context.logPromptCompileIfPending();
				if (turnControlRecord) {
					outcomeCollector.recordControl(turnControlRecord);
					if (deps.session?.current()) {
						try {
							deps.session.appendEntry({
								kind: "custom",
								customType: "turnControl",
								parentTurnId: state.lastTurnId,
								display: false,
								data: turnControlRecord,
							});
						} catch {
							/* S6: ledger recording is best effort and never costs the admitted turn. */
						}
					}
				}
				// #423: Pi's native effort and tool updates preserve the cached prefix on capable models.
				const cacheModel = agentRuntime.agent.state.model;
				const cacheCompat =
					cacheModel.api === "anthropic-messages" ? (cacheModel.compat as AnthropicMessagesCompat | undefined) : undefined;
				if (
					previousThinkingLevel !== undefined &&
					previousThinkingLevel !== agentRuntime.runtimeResolution.effectiveThinkingLevel &&
					!context.thinkingUsesConfigurationUpdate() &&
					cacheCompat?.supportsMidConvoEffort !== true
				) {
					context.noteColdReason("thinking_change");
				}
				if (
					typeof previousRunSnapshot?.toolSignature === "string" &&
					previousRunSnapshot.toolSignature !== toolSignature &&
					!(cacheCompat?.supportsMidConvoToolChanges === true && cacheCompat.supportsMidConvoSystemMessages === true)
				) {
					context.noteColdReason("tool_surface_change");
				}
				// A request on another target or wire model shares no cached prefix with the previous call's (#434).
				if (
					previousModel !== undefined &&
					(previousModel.targetId !== agentRuntime.targetId || previousModel.modelId !== agentRuntime.wireModelId)
				) {
					context.noteColdReason("model_changed");
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
					autonomy: deps.getSettings().safety.autonomy,
					pricedBy: agentRuntime.runtimeResolution.pricedBy,
					compiledPromptHash: promptHash,
					staticCompositionHash: promptHash,
					promptSignature: promptHash,
					toolSignature,
					runtimeResolution: runtimeTargetSnapshot(agentRuntime.runtimeResolution),
					sessionId: deps.session?.current()?.id ?? null,
					cwd: process.cwd(),
				};

				agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
				state.toolProseAbortReason = null;
				state.toolProseAssessedChars = 0;
				state.activeInterruptReason = null;
				state.interruptedAssistantMessage = null;
				state.interruptedCall = null;

				// 6. Cache-disturbance honesty (T3.3)
				context.consumeExpectedColdReasons(agentRuntime.runtimeId);

				// 7. Run the prompt, then route the settled state through recovery.
				state.streaming = true;
				const foregroundOn = (runtime: AgentRuntime): (() => void) => {
					const endpointKey = modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId);
					return endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
				};
				let releaseForeground = foregroundOn(agentRuntime);
				moveForeground = (runtime) => {
					releaseForeground();
					releaseForeground = foregroundOn(runtime);
				};
				try {
					options.onAdmitted?.();
				} catch {
					// Admission observers are bookkeeping only and cannot affect the turn.
				}
				const runtimePromptText = submittedText;
				if (options.requestContinuation !== true && deps.readSessionEntries) {
					const prior = agentRuntime.agent.state.messages;
					const retired = retireActiveUserContextForNextOperator(prior, deps.readSessionEntries(), {
						...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
					});
					if (retired.length < prior.length) {
						replaceEngineMessages(agentRuntime.agent, retired);
						// Retiring replayed instructions a request already carried rewrites the history it sent (#434).
						if (retiredUserContextWasSent(prior, retired)) context.noteColdReason("input_changed");
					}
				}
				terminalTurnFailure = undefined;
				turnRetryAttempts = 0;
				providerRetryAttempts = 0;
				const machineMessageStart = agentRuntime.agent.state.messages.length;
				recovery.noteAttemptStart(machineMessageStart);
				const priorPendingSkillPolicy = state.currentPendingSkillPolicy;
				const priorAskUserPolicy = state.currentAskUserPolicy;
				state.currentPendingSkillPolicy = pendingSkillPolicy;
				state.currentAskUserPolicy = askUserPolicy;
				try {
					if (!admissionCurrent()) return;
					await queues.markPersistedUserEcho(runtimePromptText, () => {
						if (!admissionCurrent()) return Promise.resolve();
						// A flushed queue rides Pi's opening poll, so it lands with this
						// prompt's first model call; a held queue waits for the first slot.
						promptStarted = true;
						queueSessionId = api.getSessionId();
						if (pathMessage) messagePath.prompted(pathMessage);
						queues.handOverBeforePrompt(agentRuntime.agent, {
							keepOperatorHold:
								options.machineTurn !== undefined || options.origin !== undefined || options.requestContinuation === true,
						});
						if (userTurnId) context.commitSessionPosture(agentRuntime, userTurnId);
						state.routeMoveSeat = true;
						return agentRuntime.agent.prompt(runtimePromptText, images);
					});
					state.routeMoveSeat = false;
					if (
						admissionCurrent() &&
						state.synthesisToolLock &&
						state.activeInterruptReason === null &&
						isLockedSynthesisFallbackOnly(agentRuntime.agent.state.messages.at(-1))
					) {
						// Deliver the pair atomically. The normal follow-up queue drains one
						// message at a time; queuing these separately creates an extra round
						// with an unanswered synthetic tool call.
						emitNotice("[Clio Coder] Recovering a final answer once; tools remain disabled.");
						const model = agentRuntime.agent.state.model;
						await agentRuntime.agent.prompt([
							...lockedSynthesisRepromptMessages(1, {
								provider: model.provider,
								api: model.api,
								model: model.id,
							}),
						]);
					}
					// pi-agent-core does NOT throw on provider failures:
					// it pushes an assistant message with stopReason="error" and
					// errorMessage="<provider text>" onto state.messages, sets
					// state.errorMessage, emits agent_end, and resolves normally.
					// The overflow-recovery heuristic must inspect the state after
					// a resolve, not only the catch arm.
					if (!admissionCurrent()) return;
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
							await recovery.runTransientRetryChain(
								agentRuntime,
								runtimePromptText,
								failure,
								agentRuntime.agent.state.messages.slice(machineMessageStart),
							);
						}
					}
				} catch (err) {
					if (!admissionCurrent()) return;
					// Genuine throws (network, abort, pre-stream bugs) still land
					// here. The heuristic is the same so a thrown overflow from
					// an older pi-agent-core still routes through compact-retry.
					const overflow = toContextOverflowError(err);
					if (!overflow) {
						const message = state.toolProseAbortReason ?? (err instanceof Error ? err.message : String(err));
						const classification = classifyRecoveryFailure({
							message,
							runtimeId: agentRuntime.runtimeId,
							contextOverflow: false,
							hasAttemptOutput: recoveryAttemptHasOutput(agentRuntime.agent.state.messages.slice(machineMessageStart)),
							cause: err,
							...(typeof err === "object" && err !== null && "status" in err ? { status: err.status } : {}),
						});
						if (
							isRetryableRecoveryFailure(classification) ||
							classification.kind === "auth" ||
							recovery.waitsOutRateLimit(classification)
						) {
							const failureMessage = {
								role: "assistant",
								content: [{ type: "text", text: "" }],
								stopReason: "error",
								errorMessage: message,
								timestamp: Date.now(),
							} as AgentMessage;
							const handled = await recovery.runTransientRetryChain(
								agentRuntime,
								runtimePromptText,
								{
									stopReason: "error",
									errorMessage: message,
									message: failureMessage,
								},
								undefined,
								classification,
							);
							if (handled) return;
						}
						emitNotice(operatorFacingEngineError(message));
						return;
					}
					await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflow, images);
				} finally {
					const overtaken = state.routeMove;
					state.routeMove = null;
					state.routeMoveSeat = false;
					moveForeground = null;
					if (overtaken !== null) {
						state.streamStallReason = null;
						// The stop lost the race to the reply it was stopping, and that reply is the one on screen.
						if (generation === submitGeneration && state.activeInterruptReason === null && !owner?.signal.aborted)
							emitNotice(
								`The answer arrived before the request could move, so ${overtaken.wireModelId} takes over from the next turn.`,
								"info",
								"route-move.overtaken",
							);
					}
					recovery.settleOpenForecast();
					const canceled = state.activeInterruptReason !== null && state.activeInterruptByOperator;
					// Esc on an interview resolves it as cancelled and the tool ends the turn
					// itself, so no interrupt is raised and `canceled` stays false. The turn
					// still ended on the operator's say-so, which the outcome has to show.
					const interviewDismissed = askUserPolicy?.status === "cancelled";
					releaseForeground();
					// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
					if (generation !== submitGeneration) return;
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
					// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
					if (generation !== submitGeneration) return;
					state.streaming = false;
					if (state.activeInterruptReason !== null) {
						const reason = state.activeInterruptReason;
						state.activeInterruptReason = null;
						// A partial response already closed with the cancellation reason.
						// Only a hollow abort needs a synthetic assistant, after all tool
						// results have landed. Publish its notice after settlement too, so
						// it cannot split the entry the provider's message_end finalizes.
						if (state.interruptedAssistantMessage === null) {
							const closing = noticeMessage(reason);
							const interrupted = takeInterruptedCall(state);
							if (interrupted !== null) {
								Object.assign(closing, interrupted.message, noticeMessage(reason));
								delete (closing as { errorMessage?: string }).errorMessage;
							}
							persistence.appendAssistantTurn(closing, interrupted?.timing, undefined, {
								operatorCancel: state.activeInterruptByOperator,
							});
							emit({
								type: "notice",
								level: "warning",
								surface: "transcript",
								text: reason,
								key: "turn.interrupted",
								...(state.activeInterruptByOperator ? { operatorCancel: true as const } : {}),
							});
						}
						state.interruptedAssistantMessage = null;
						state.interruptedCall = null;
					}
					// A continuation writes its outcome too: the streak that gates the next
					// turn's direction workflow resets on a turn that used a tool, and a
					// continuation is exactly where an answered interview does. Without its
					// row the streak stayed at the operator turn's value, in memory and on
					// resume.
					if (userTurnId !== null && deps.session?.current()) {
						try {
							const continuation = options.requestContinuation === true;
							const collected = outcomeCollector.take(userTurnId, state.activeUserTurnId);
							const finalMessage = [...agentRuntime.agent.state.messages]
								.reverse()
								.find((message) => message.role === "assistant");
							const finalEntry = deps.readSessionEntries?.().find((entry) => entry.turnId === state.lastTurnId);
							const finalPayload =
								finalEntry?.kind === "message" && finalEntry.role === "assistant"
									? (finalEntry.payload as { text?: unknown; stopReason?: unknown })
									: undefined;
							const finalAssistantText =
								typeof finalPayload?.text === "string" ? finalPayload.text : finalMessage ? extractText(finalMessage) : "";
							const workerRunIds = [...collected.dispatches.flatMap((item) => item.runIds), ...collected.harness.runIds];
							const missingReceipts = canceled ? await awaitWorkerRunResults(workerRunIds, deps.outcomeDispatch) : [];
							// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
							if (generation !== submitGeneration) return;
							const failure = terminalFailureFromAssistantMessage(finalMessage)?.failure ?? currentTurnFailure();
							const record = reduceTurnOutcome({
								...collected,
								turnId: userTurnId,
								turnIndex,
								continuation,
								finalAssistantText,
								taskEstablished: deps.getTaskEstablished?.() ?? false,
								canceled,
								interviewDismissed,
								...(failure ? { failure: { ...failure, retryAttempts: turnRetryAttempts + providerRetryAttempts } } : {}),
								tokens: {
									coordinator: persistence.turnUsage(userTurnId) ?? noOutcomeUsage(),
									workers: workerOutcomeUsage(workerRunIds, deps.outcomeDispatch),
								},
								stopReason:
									typeof finalPayload?.stopReason === "string"
										? finalPayload.stopReason
										: typeof finalMessage?.stopReason === "string"
											? finalMessage.stopReason
											: canceled
												? "aborted"
												: "error",
								durationMs: Math.max(0, performance.now() - submittedAt),
							});
							const outcomeParent = state.lastTurnId;
							deps.session.appendEntry({
								kind: "custom",
								customType: "turnOutcome",
								parentTurnId: outcomeParent,
								display: false,
								data: record,
							});
							outcomeCollector.seedClarificationStreak(record.conversation.clarificationStreak);
							await recordTurnSettled(
								userTurnId,
								record.stopReason,
								turnRetryAttempts + providerRetryAttempts,
								canceled ? "operator_cancel" : undefined,
							);
							amendLateWorkerTokens({
								turnId: userTurnId,
								parentTurnId: outcomeParent,
								runIds: workerRunIds,
								missing: missingReceipts,
							});
							// A continuation extends the operator turn it followed, so the gap the
							// next operator message reports runs from the end of the whole chain.
						} catch {
							// Measurement must not change turn settlement when a ledger or receipt is unavailable.
						}
					}
					state.currentPendingSkillPolicy = priorPendingSkillPolicy;
					state.currentAskUserPolicy = priorAskUserPolicy;
					armSkillSurface(pendingSkillPolicy, skillsLoadedBeforeTurn);
					// Safety net for thrown paths where agent_end never delivered;
					// no-op when the agent_end flush already ran.
					context.flushReconciledSnapshot();
					// Runs on every exit path (normal settle, catch-arm returns) so
					// a steer the engine never drained still reaches the model.
					if (options.machineTurn !== undefined) {
						const messages = agentRuntime.agent.state.messages.slice(machineMessageStart);
						const finalMessage = [...messages].reverse().find((message) => message.role === "assistant");
						const failure = detectTerminalFailureFromState(agentRuntime.agent);
						const usage = sumRunUsage(messages);
						// An exhausted ladder prunes its failure, so an earlier round's text must not read as success (#445).
						const stop = state.turnStop as { reason: string; retryAfterMs?: number } | null;
						// A failure stop outranks a budget crossing in the same turn, so a failing turn cannot escape the cap on one.
						const guardStop =
							stop !== null
								? undefined
								: state.synthesisToolLock
									? "loop_guard"
									: state.toolBudgetLock
										? "tool_budget"
										: undefined;
						options.machineTurn.onSettled({
							status:
								!admissionCurrent() || canceled || interviewDismissed
									? "canceled"
									: failure || stop || !finalMessage
										? "failed"
										: "succeeded",
							turnId: userTurnId,
							...(failure || stop ? { reason: failure?.errorMessage ?? stop?.reason ?? "" } : {}),
							...(guardStop === undefined ? {} : { stoppedBy: guardStop }),
							...(stop?.retryAfterMs === undefined ? {} : { retryAfterMs: stop.retryAfterMs }),
							...(finalMessage ? { text: extractText(finalMessage) } : {}),
							usage: { tokens: usage.totals.totalTokens, cost: usage.cost },
						});
					}
					state.activeUserTurnId = null;
					const continuation =
						options.machineTurn === undefined && !canceled && !interviewDismissed && admissionCurrent()
							? yoloContinuationDue()
							: null;
					if (
						!disposed &&
						generation === submitGeneration &&
						options.machineTurn === undefined &&
						!(await queues.resubmitStranded())
					) {
						if (state.pendingRequestContinuation) await queues.resubmitRequestContinuation();
						else if (continuation !== null) {
							await continueStoppedTurn(continuation, generation, options.constraints);
						}
					}
				}
			} finally {
				void turnLease?.release();
				returnUnstarted();
				if (pathMessage && !promptStarted && options.queued === undefined) messagePath.neverStarted(pathMessage);
				if (submitOwner === owner) {
					submitOwner = null;
					// Template bounds end with their turn; prewarm and jobs see only
					// the host's remaining prompt or session ceiling (#423).
					state.currentTurnConstraints = promptToolLimits;
					if (!disposed) queues.settleSubmit(promptStarted);
				}
			}
		},

		cancel(options?: ChatCancelOptions): void {
			const machineCancellation = pendingMachineCancellation;
			pendingMachineCancellation = null;
			const preserveQueue = machineCancellation !== null && machineCancellation === machineTurnRunning;
			submitOwner?.abort();
			turnRuntime.cancelRunWatchdog();
			continuity.cancel();
			pendingPreTurnRead?.abort();
			pendingVisionSidecar?.abort();
			pendingCompactionPaint?.abort();
			const wasStreaming = state.streaming;
			const wasCanceledByOperator = state.activeInterruptReason !== null && state.activeInterruptByOperator;
			context.cancelCompaction();
			recovery.cancelRetryCountdown();
			// Settle the queue before the abort settles the in-flight prompt: a
			// cancelled run must not deliver queued messages on its own. An
			// interrupt holds them for the prompt it is about to send, and an operator
			// stop holds them until the operator acts (#447). A guard stop was not the
			// operator's choice, and a job cancellation has successors to protect
			// (#411), so both leave the entries to the ordinary settlement path.
			queues.onRunCancelled({
				hold: options?.reason === INTERRUPT_CANCEL_REASON,
				preserve: preserveQueue,
				settle: options?.source === "loop_guard",
			});
			const requestedReason = options?.reason?.trim();
			if (wasStreaming) {
				// Keep immediate feedback in the footer. A transcript notice here
				// would split the streamed entry before message_end can finalize it.
				// The reason is carried by the provider's aborted assistant, or by
				// one synthetic closing record after an empty abort settles.
				state.activeInterruptReason =
					requestedReason && requestedReason.length > 0 ? requestedReason : OPERATOR_CANCEL_REASON;
				state.activeInterruptByOperator = (options?.source ?? "stream_cancel") === "stream_cancel";
				// An Esc is reported once, by the turn's Cancelled outcome. The footer
				// carries only an interruption the operator did not ask for.
				if (!isOperatorCancelReason(state.activeInterruptReason))
					emitFooterNotice("warning", state.activeInterruptReason, "turn.interrupted");
			}
			state.runtime?.agent.abort();
			if (wasStreaming && !wasCanceledByOperator && (options?.source ?? "stream_cancel") === "stream_cancel") {
				const sessionId = api.getSessionId();
				const settled = api.whenSettled();
				// #425: publish after stream closure so the notice cannot split the aborted assistant entry.
				void import("../domains/dispatch/batch-store.js")
					.then(async ({ listDetachedBatches }) => {
						await settled;
						if (disposed || api.getSessionId() !== sessionId) return;
						const batches = listDetachedBatches().filter(
							(batch) => batch.sessionId === sessionId && (sessionId !== null || batch.cwd === process.cwd()),
						);
						if (batches.length === 0) return;
						emitNotice(
							`Main turn cancelled. Detached batches continue independently: ${batches.map((batch) => batch.id).join(", ")}. ` +
								'Collect with monitor(mode="collect", batch_id="<batch-id>"); abort a worker with steer(action="cancel", run_id="<run-id>"). ' +
								"Collect existing results or explicitly re-run failed assignments before replacing their work.",
							"info",
							"dispatch.detached-continues",
						);
					})
					.catch((error: unknown) => {
						process.stderr.write(
							`[dispatch] cancel notice failed: ${error instanceof Error ? error.message : String(error)}\n`,
						);
					});
			}
			if (wasStreaming && deps.bus) {
				// A keypress cancels outside the turn's async context, so the record names its session itself (#434).
				deps.bus.emit(
					"turn.aborted",
					{
						source: options?.source ?? "stream_cancel",
						at: Date.now(),
						reason: options?.auditReason ?? (requestedReason ? "loop guard stopped a runaway turn" : "user cancelled stream"),
					},
					ownerTelemetryContext({ sessionId: api.getSessionId(), turnId: state.activeUserTurnId ?? undefined }),
				);
			}
		},

		onEvent(handler: (event: ChatLoopEvent) => void): () => void {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},

		captureWorkerContext(): WorkerContextSnapshot | null {
			const meta = deps.session?.current();
			if (!meta) return null;
			return captureWorkerContext(
				{ sessionId: meta.id, leafTurnId: state.lastTurnId, cwd: meta.cwd },
				state.runtime?.agent.state.messages ?? state.replayedContextMessages,
			);
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
		runningToolCalls(): number {
			return toolStartTimes.size;
		},

		modelRequest() {
			state.refreshModelRequest?.();
			return state.modelRequest;
		},

		routeMoveWait,

		routeMoveFit(route) {
			try {
				const candidate = turnRuntime.previewRoute(route);
				return candidate ? routeFit(candidate) : { kind: "unresolved", reason: "no route is configured" };
			} catch (err) {
				return { kind: "unresolved", reason: err instanceof Error ? err.message : String(err) };
			}
		},

		routeLeavesCache(route) {
			try {
				const candidate = turnRuntime.previewRoute(route);
				if (!candidate) return false;
				const runtime = state.runtime;
				// A session resumed with nothing sent yet has no runtime; the route it would run on is the one it left off with.
				const current = runtime
					? { targetId: runtime.targetId, wireModelId: runtime.wireModelId }
					: (() => {
							const resolved = turnRuntime.previewRoute();
							return resolved ? { targetId: resolved.target.target.id, wireModelId: resolved.target.wireModelId } : null;
						})();
				return (
					current === null ||
					current.targetId !== candidate.target.target.id ||
					current.wireModelId !== candidate.target.wireModelId
				);
			} catch {
				// An unresolvable route has no cost to state; the rest of the dialog and the pick itself report it.
				return false;
			}
		},

		moveWaitingRequest() {
			const wait = routeMoveWait();
			if (wait === "idle") return { kind: "idle" };
			let fit: RouteMoveFit;
			let candidate: ReturnType<TurnRuntime["previewRoute"]> = null;
			try {
				candidate = turnRuntime.previewRoute();
				fit = candidate ? routeFit(candidate) : { kind: "unresolved", reason: "no route is configured" };
			} catch (err) {
				fit = { kind: "unresolved", reason: err instanceof Error ? err.message : String(err) };
			}
			if (fit.kind === "same") return { kind: "same" };
			if (wait !== "first-output" && wait !== "retry-wait") return { kind: "next-turn", wait };
			if (fit.kind !== "fits" || candidate === null) {
				return { kind: "next-turn", wait, ...(fit.kind === "fits" ? {} : { fit }) };
			}
			const inFlight = state.runtime;
			const alreadyStopped = state.routeMove !== null;
			state.routeMove = candidate.target;
			if (wait === "retry-wait") recovery.cancelRetryCountdown();
			else if (!alreadyStopped && inFlight) {
				// The stall path's seam, because this is the same event to everything below it: Clio aborted a silent call
				// with no operator stop behind it, and the run goes on. The reason stays in the ledger for /view.
				state.streamStallReason = `aborted to move this request to ${candidate.target.target.id}/${candidate.target.wireModelId}: no output had arrived from ${inFlight.targetId}/${inFlight.wireModelId}`;
				state.streamStallStage = null;
				turnRuntime.cancelRunWatchdog();
				inFlight.agent.abort();
			}
			return { kind: "moved", wait };
		},

		turnPreparation() {
			return { phase: state.turnPreparation, since: state.turnPreparationSince, stage: state.turnPreparationStage };
		},

		onTurnPreparation(handler) {
			preparationListeners.add(handler);
			return () => {
				preparationListeners.delete(handler);
			};
		},

		contextUsage: () => context.contextUsage(),
		currentTurnConstraints: () => state.currentTurnConstraints,
		setToolCeiling(ceilings, lifetime = "session") {
			const limits = snapshotTurnConstraints(
				ceilings.reduce(narrowTurnConstraints, lifetime === "session" ? operatorToolLimits : sessionToolLimits),
			);
			if (lifetime === "session") sessionToolLimits = limits;
			promptToolLimits = limits;
			// A run in flight keeps the scope it was admitted under (#423).
			if (!state.streaming) state.currentTurnConstraints = promptToolLimits;
			return limits;
		},
		toolLimits: () => promptToolLimits,
		jobConstraints: () => {
			const constraints = state.currentTurnConstraints;
			const policy = state.currentPendingSkillPolicy ?? state.activeSkillSurface;
			if (!policy) return snapshotTurnConstraints(constraints);
			const allowedTools = (deps.toolRegistry?.listAll() ?? [])
				.map((tool) => tool.name)
				.filter(
					(name) =>
						evaluateSkillToolSurface(policy, name) === null &&
						(constraints?.allowedTools === undefined || constraints.allowedTools.includes(name)),
				);
			// The skill surface narrows the job, so a refusal must name it rather than
			// blame a wider scope that still admits the tool.
			return snapshotTurnConstraints({
				...constraints,
				allowedTools,
				toolSurfaceSources: [
					...toolSurfaceSources(constraints),
					{
						tools: allowedTools,
						source: `active skill tool surface (${skillSurfaceNames(policy).join(", ")})`,
						remedy: "Unload the narrowing skill or widen its allowed-tools, then recreate the job.",
					},
				],
			});
		},
		contextLedger: () => context.contextLedger(),
		screenWindow: () => (state.runtime ? { messages: state.runtime.agent.state.messages, since: operatorSpokeAt } : null),
		liveBudget: () => context.liveBudget(),
		inspectLiveBudget: () => context.inspectLiveBudget(),
		refreshLiveBudget: () => context.refreshLiveBudget(),
		whenSettled: () => activeSubmit,
		whenPrewarmSettled: () => prewarm.settled(),
		onSessionReset(handler): () => void {
			sessionResetListeners.add(handler);
			return () => {
				sessionResetListeners.delete(handler);
			};
		},

		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			submitOwner?.abort();
			submitGeneration += 1;
			turnRuntime.cancelRunWatchdog();
			sessionResetSettlement = activeSubmit;
			state.streaming = false;
			pendingPreTurnRead?.abort();
			context.cancelCompaction();
			for (const listener of sessionResetListeners) {
				try {
					listener();
				} catch {
					// A host observer must not interrupt canonical replay and state cleanup.
				}
			}
			// Local shell completion and tree navigation also refresh the same transcript.
			eggs.syncConversation();
			operatorTurnsBefore = null;
			lastHistoricalImageNoticeKey = null;
			pendingVisionSidecar?.abort();
			pendingCompactionPaint?.abort();
			continuity.cancel();
			void continuity.pause();
			state.currentTurnConstraints = sessionToolLimits;
			state.activeSkillSurface = undefined;
			state.currentPendingSkillPolicy = undefined;
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			cancelTriage();
			const sessionId = api.getSessionId();
			queues.reset({ keepOperator: sessionId !== null && sessionId === queueSessionId });
			queueSessionId = sessionId;
			middleware.clearPendingReminders();
			middlewareToolChoice.reset();
			state.lastTurnId = leafTurnId;
			state.lastRunSnapshot = null;
			// The incoming leaf is the advisory branch identity for the new session.
			// Ordinary appends advance `state.lastTurnId` from here without re-arming
			// an advisory; arriving here at all is the navigation that does.
			context.resetForSession(leafTurnId);
			// The resumed ledger renders before the first new turn (issue #189),
			// and the window it renders against should be the probed one rather
			// than the catalog's, so the live capability probe the first submit
			// would run runs now, under the same TTL; the footer refreshes on the
			// provider-health event the probe publishes.
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});
			state.replayedContextMessages = replayMessages ? [...replayMessages] : [];
			if (state.runtime) {
				replaceEngineMessages(state.runtime.agent, [...state.replayedContextMessages]);
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
			disposed = true;
			submitOwner?.abort();
			pendingPreTurnRead?.abort();
			machineHostDisposed = true;
			sessionResetListeners.clear();
			unsubscribeEggSession?.();
			eggs.reset();
			pendingVisionSidecar?.abort();
			pendingCompactionPaint?.abort();
			turnRuntime.dispose();
			for (const stop of lateReceiptWatchers) stop();
			lateReceiptWatchers.clear();
			unsubscribeConfigReload?.();
			unsubscribeConfigNextTurn?.();
			unsubscribePluginsReload?.();
			unsubscribeSynthesisLock?.();
			unsubscribeToolBudgetLock?.();
			unsubscribePrewarmCompaction();
			prewarm.dispose();
			keepalive.dispose();
			context.dispose();
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			cancelTriage();
			queues.reset();
			middlewareToolChoice.reset();
		},

		async askSideQuestion(question: string, options: SideQuestionOptions = {}): Promise<SideQuestionOutcome> {
			const text = question.trim();
			if (text.length === 0) {
				return { status: "refused", reason: "a side question needs a question" };
			}
			// Never queued and, since #415, never refused for a running turn. A side
			// question exists to be answered now, beside a run the operator is
			// watching; holding it until the run settles would deliver it after the
			// moment it was asked in had passed.
			const prepared = await prepareOutOfTurnRound(null, options.signal, false, false);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			const route = { targetId: prepared.runtime.targetId, wireModelId: prepared.runtime.wireModelId };
			options.onRoute?.(route);
			// A snapshot, taken now: a running turn keeps appending to the live list
			// while this round awaits admission and streams.
			const messages = [...prepared.runtime.agent.state.messages];
			let result: SideQuestionResult;
			try {
				result = await withEndpointSlot(prepared.runtime, (slot) =>
					sideQuestionRound({
						...sideCallJournal(prepared.runtime, "btw", prepared.origin),
						beforeRequest: sideCallAdmission(prepared.runtime, prepared.origin, slot, options.signal),
						admitFlow: () => deps.admitRuntimeFlow?.(prepared.runtime) ?? null,
						model: prepared.runtime.agent.state.model,
						// Read-only: the round appends its own message to this copy, so
						// the live agent's history is untouched.
						messages,
						question: text,
						midTurn: prepared.inFlight,
						// The level the session's own next turn would use.
						thinkingLevel: prepared.runtime.agent.state.thinkingLevel ?? "off",
						...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
						...(prepared.refreshApiKey ? { refreshApiKey: prepared.refreshApiKey } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.onDelta ? { onDelta: options.onDelta } : {}),
					}),
				);
			} catch (err) {
				return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
			}
			return result.aborted
				? { status: "aborted", text: result.text }
				: {
						status: "answered",
						text: result.text,
						route: { ...route, ...(result.reportedModel !== undefined ? { reportedModel: result.reportedModel } : {}) },
					};
		},

		async draftCandidates(request: string, count: number, options: DraftOptions = {}): Promise<DraftOutcome> {
			const text = request.trim();
			if (text.length === 0) return { status: "refused", reason: "a draft needs a request" };
			if (!Number.isInteger(count) || count < 1 || count > DRAFT_TEMPERATURES.length) {
				return { status: "refused", reason: `draft count must be 1 to ${DRAFT_TEMPERATURES.length}` };
			}
			// Never queued, for the side question's reason, and run beside a turn in
			// flight the same way (#415): the drafts answer the session as it stands now.
			const prepared = await prepareOutOfTurnRound(null, options.signal, false, false);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			const route = { targetId: prepared.runtime.targetId, wireModelId: prepared.runtime.wireModelId };
			options.onRoute?.(route);
			const messages = [...prepared.runtime.agent.state.messages];
			const candidates = await Promise.all(
				DRAFT_TEMPERATURES.slice(0, count).map(async (temperature, index): Promise<DraftCandidate> => {
					const samplingTemperature = draftTemperature(prepared.runtime.agent.state.model, temperature);
					try {
						// One endpoint slot per round: each is a full request against the
						// same scheduler, and capacity has to count every one of them.
						const result = await withEndpointSlot(prepared.runtime, (slot) =>
							runDraftWithSamplerFallback(
								index,
								samplingTemperature,
								(sampling) =>
									draftRound({
										...sideCallJournal(prepared.runtime, "helper", prepared.origin),
										beforeRequest: sideCallAdmission(prepared.runtime, prepared.origin, slot, options.signal),
										admitFlow: () => deps.admitRuntimeFlow?.(prepared.runtime) ?? null,
										model: prepared.runtime.agent.state.model,
										// One snapshot for every candidate, read-only as the side question's is.
										messages,
										systemPrompt: sampling.systemPrompt,
										userText: text,
										midTurn: prepared.inFlight,
										maxTokens: DRAFT_MAX_TOKENS,
										thinkingLevel: prepared.runtime.agent.state.thinkingLevel ?? "off",
										...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
										...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
										...(prepared.refreshApiKey ? { refreshApiKey: prepared.refreshApiKey } : {}),
										...(options.signal ? { signal: options.signal } : {}),
										...(options.onCandidate ? { onDelta: (partial: string) => options.onCandidate?.(index, partial) } : {}),
									}),
								options.signal,
							),
						);
						return {
							...draftCandidateFromText(result.text),
							route: { ...route, ...(result.reportedModel !== undefined ? { reportedModel: result.reportedModel } : {}) },
						};
					} catch (err) {
						return { status: "failed", reason: err instanceof Error ? err.message : String(err), route };
					}
				}),
			);
			return { status: "drafted", candidates, aborted: options.signal?.aborted === true };
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
				false,
				false,
			);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			options.onRoute?.({ targetId: prepared.runtime.targetId, wireModelId: prepared.runtime.wireModelId });
			let result: SideQuestionResult;
			try {
				result = await withEndpointSlot(prepared.runtime, (slot) =>
					handoffRound({
						...sideCallJournal(prepared.runtime, "handoff", prepared.origin),
						beforeRequest: sideCallAdmission(prepared.runtime, prepared.origin, slot, options.signal),
						admitFlow: () => deps.admitRuntimeFlow?.(prepared.runtime) ?? null,
						model: prepared.runtime.agent.state.model,
						// Read-only, exactly as the side-question round treats it.
						messages: prepared.runtime.agent.state.messages,
						goal: text,
						// The runtime id is what decides whether the schema can be bound
						// on the wire rather than only stated in the prompt.
						runtimeId: prepared.runtime.runtimeResolution.runtime.id,
						...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
						...(prepared.refreshApiKey ? { refreshApiKey: prepared.refreshApiKey } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.repair ? { repair: options.repair } : {}),
					}),
				);
			} catch (err) {
				return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
			}
			return result.aborted ? { status: "aborted", text: result.text } : { status: "answered", text: result.text };
		},

		requestSelfCompact: (note, toolCallId, signal) => continuity.request(note, toolCallId, signal),
		async recoverHandoff(handoffId, action) {
			if (state.streaming || state.turnPreparation !== "idle")
				throw new Error("Wait for the current turn to settle before recovery.");
			const runtime = turnRuntime.ensureRuntime();
			if (!runtime) throw new Error("No native runtime is configured.");
			state.activeInterruptReason = null;
			if (!state.activeUserTurnId) {
				const operator = [...filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined)]
					.reverse()
					.find((entry) => entry.kind === "message" && entry.role === "user");
				state.activeUserTurnId = operator?.turnId ?? null;
			}
			const operationSession = deps.session?.current()?.id ?? null;
			const operationCwd = process.cwd();
			const operation = createContextOperation(
				{
					kind: "context-recover",
					sessionId: operationSession,
					cwd: operationCwd,
					origin: "operator",
					reason: `handoff ${action}`,
				},
				(event) => {
					if (operationSession !== (deps.session?.current()?.id ?? null) || operationCwd !== process.cwd()) return;
					deps.bus?.emit("context.activity_changed", event);
					if (event.operation?.outcome && operationSession)
						deps.session?.appendEntry({
							kind: "custom",
							customType: CONTEXT_OPERATION_CUSTOM_TYPE,
							parentTurnId: state.lastTurnId,
							data: event.operation,
						});
				},
			);
			state.streaming = true;
			operation.start("state", "Recovering paused handoff");
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (
					state.activeInterruptReason ||
					operationSession !== (deps.session?.current()?.id ?? null) ||
					operationCwd !== process.cwd()
				)
					throw new DOMException("Handoff recovery cancelled", "AbortError");
				await continuity.recover(handoffId, action);
				await continueEngineWithoutInput(runtime.agent);
				operation.finish(state.activeInterruptReason ? "cancelled" : "completed", "Handoff recovery settled");
			} catch (error) {
				operation.finish(
					error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
					error instanceof Error ? error.message : String(error),
				);
				throw error;
			} finally {
				state.streaming = false;
				await continuity.pause();
			}
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
				emitNotice(`[/context compact] ${notConfiguredNotice(deps.getSettings().chat)}`);
				return;
			}
			// A second request while one runs would join it and report the same ending twice, and drop its own instructions.
			if (operatorCompactionRunning) {
				emitNotice(
					"[/context compact] a compaction is already running; its card reports how it ends. Run /context compact again after that if it is still needed.",
					"warning",
				);
				return;
			}
			operatorCompactionRunning = true;
			let compacted = false;
			const paintCompaction = prepareCompactionPaint();
			enterPreparation();
			setTurnPreparation("compacting");
			try {
				await paintCompaction();
				compacted = await context.runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					// A forced compaction skips every cheaper stage, so a stop before the summary saved left the context as it was.
					// Its card already says so with the size it stayed at; a notice beside it said the same thing twice.
					if (context.lastCompactionCardSettled()) return;
					const tokens = context.contextUsage().tokens;
					emitNotice(
						`[/context compact] cancelled; context unchanged${tokens !== null ? ` at ${footerTokens(tokens)} tokens` : ""}`,
					);
					return;
				}
				// A failed summary saved nothing either, and the operator needs that, the reason in words and the way on (HS14).
				const tokens = context.contextUsage().tokens;
				emitNotice(
					`[/context compact] failed; context unchanged${tokens !== null ? ` at ${footerTokens(tokens)} tokens` : ""}. ${compactionFailureReason(err)}. /context compact tries again; /model picks another route to summarize on.`,
					"error",
				);
				return;
			} finally {
				operatorCompactionRunning = false;
				leavePreparation();
				endPreparationCompaction();
			}
			if (!compacted && !context.lastCompactionWasNoGain()) {
				const entries = deps.readSessionEntries?.() ?? [];
				const hasMessages =
					entries.some((entry) => entry.kind === "message") || agentRuntime.agent.state.messages.length > 0;
				const usage = context.contextUsage();
				const used = usage.tokens !== null ? `${formatFooterTokens(usage.tokens)} tokens` : "unknown usage";
				const budget =
					usage.tokens !== null && usage.contextWindow > 0
						? `${formatFooterTokens(usage.tokens)} of ${formatFooterTokens(usage.contextWindow)} tokens used`
						: used;
				emitNotice(
					hasMessages
						? `[/context compact] too short to compact (${budget}); no older history can be summarized yet`
						: "[/context compact] session is empty; start a conversation first",
				);
			}
		},
	};

	const submitInner = api.submit.bind(api);
	const submitTracked: ChatLoop["submit"] = (text, options) => {
		priorSubmit = activeSubmit;
		const preparationToken = options?.machineTurn?.preparationToken;
		machinePreparation = preparationToken === undefined ? null : { token: preparationToken, runtime: null };
		// The flag brackets the whole submit, including the early returns an
		// admission failure takes, so a refused turn does not leave the pre-warm
		// believing a turn is still running.
		turnActive = true;
		const run = submitInner(text, options).finally(() => {
			if (machinePreparation?.token === preparationToken) machinePreparation = null;
			turnActive = false;
			keepalive.cancel();
			try {
				deps.onTurnSettled?.();
			} catch {
				// Settle hooks are housekeeping and never cost the turn.
			}
		});
		// A steer during a run is a submit that returns at once. Replacing the record with it forgot the
		// live run, so an interrupt's wait for the cancel to settle returned early and shutdown could stop the writer
		// under a persisting turn. The record covers every submit still going.
		activeSubmit = Promise.all([priorSubmit, run.catch(() => {})]).then(() => {});
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
		const constraints = snapshotTurnConstraints(options.constraints);
		options = { ...options, ...(constraints === undefined ? {} : { constraints }) };
		// Capture before admission can await. Internal resubmits inherit the
		// async scope; every independent public submit explicitly starts its own.
		const hostRun = options.hostRun === undefined ? undefined : structuredClone(options.hostRun);
		// The operator owns the slot from the keystroke, not from admission. The
		// prefix the pre-warm already pushed through stays in it either way, so
		// aborting here costs nothing and stops the real turn from queueing behind
		// a request nobody is waiting on.
		prewarm.cancel();
		keepalive.cancel();
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
		const start = async (): Promise<void> => {
			const { onPreparationVisible, ...submitOptions } = options;
			try {
				await onPreparationVisible?.();
			} catch {
				// A presentation observer cannot refuse a turn after the editor has
				// consumed it. The ordinary render path can recover on its next tick.
			}
			if (options.isAdmissionCurrent?.() === false) {
				releaseTicket();
				return;
			}
			return hostRunContext
				.run(hostRun, () =>
					submitTracked(text, {
						...submitOptions,
						onAdmitted: () => {
							releaseTicket();
							leaveOnce();
							options.onAdmitted?.();
						},
					}),
				)
				.finally(releaseTicket);
		};
		const run = previous ? previous.then(start) : start();
		return run.finally(leaveOnce);
	};

	api.bindMachineTurnProjection = (host) => {
		const binding = { host };
		machineProjectionRequired = true;
		machineProjectionBinding = binding;
		return () => {
			if (machineProjectionBinding === binding) machineProjectionBinding = null;
		};
	};
	api.machineTurnAvailable = () =>
		!machineHostDisposed &&
		(!machineProjectionRequired || machineProjectionBinding !== null) &&
		machineTurnOwner === null &&
		!state.streaming &&
		preparingSubmits === 0 &&
		!turnActive &&
		!state.currentAskUserPolicy?.inFlight &&
		deps.toolRegistry?.hasParkedCalls() !== true &&
		queues.entries().length === 0;
	api.submitMachineTurn = async (request) => {
		const refused = (reason: string): MachineTurnResult => ({ status: "refused", turnId: null, reason });
		if (machineProjectionRequired && machineProjectionBinding === null)
			return refused(
				"The attended turn projection is detached; delivery remains with its job controller until the host is available.",
			);
		if (!api.machineTurnAvailable?.())
			return refused("The main conversation is busy; delivery remains with its job controller.");
		const current = (): boolean =>
			!machineHostDisposed &&
			!request.signal.aborted &&
			request.sessionId === api.getSessionId() &&
			request.isAdmissionCurrent();
		if (!current()) return refused("The job's originating session or generation is no longer current.");
		const token = {};
		machineTurnOwner = token;
		let settled: MachineTurnResult | null = null;
		let ownedUserTurnId: string | null = null;
		let ownedRuntime: AgentRuntime | null = null;
		let projectionLease: Extract<MachineTurnProjectionAdmission, { status: "ready" }> | null = null;
		const cancel = (): void => {
			if (
				machineTurnOwner === token &&
				machinePreparation?.token === token &&
				!state.streaming &&
				state.activeUserTurnId === null
			) {
				// This preparation still owns the FIFO slot; cancel its ports without aborting a successor runtime (#411).
				pendingPreTurnRead?.abort();
				pendingVisionSidecar?.abort();
				pendingCompactionPaint?.abort();
				if (machinePreparation.runtime !== null && state.runtime === machinePreparation.runtime) context.cancelCompaction();
				return;
			}
			if (
				machineTurnRunning === token &&
				ownedUserTurnId !== null &&
				state.activeUserTurnId === ownedUserTurnId &&
				state.runtime === ownedRuntime &&
				request.sessionId === api.getSessionId()
			) {
				pendingMachineCancellation = token;
				// The controller's abort reason says what ended it; a timed-out occurrence is not a cancelled one (#445).
				const cause = request.signal.reason;
				const ended = cause instanceof Error ? cause.message : String(cause);
				try {
					api.cancel({
						reason: `Scheduled job occurrence ended: ${ended}.`,
						auditReason: `job occurrence ended: ${ended}`,
						...(cause instanceof JobClockExpired ? { source: "job_clock" as const } : {}),
					});
				} finally {
					pendingMachineCancellation = null;
				}
			}
		};
		request.signal.addEventListener("abort", cancel, { once: true });
		try {
			const binding = machineProjectionBinding;
			if (binding !== null) {
				const meta = deps.session?.current();
				if (!meta || meta.id !== request.sessionId)
					return refused("The projection's conversation is no longer bound to this machine turn.");
				const projection = binding.host.acquire({
					jobId: request.jobId,
					executionId: request.executionId,
					text: request.text,
					origin: request.origin,
					sessionId: request.sessionId,
					cwd: realpathSync(meta.cwd),
					signal: request.signal,
				});
				if (projection.status === "deferred") return refused(projection.reason);
				projectionLease = projection;
				if (!current() || machineProjectionBinding !== binding)
					return refused("The attended projection host changed during machine-turn admission.");
			}
			await api.submit(request.text, {
				origin: request.origin,
				...(request.constraints === undefined ? {} : { constraints: request.constraints }),
				isAdmissionCurrent: current,
				machineTurn: {
					preparationToken: token,
					onStarting: request.onStarting,
					onSettled: (result) => {
						settled = result;
						if (machineTurnRunning === token) machineTurnRunning = null;
					},
				},
				onAdmitted: () => {
					if (machinePreparation?.token === token) machinePreparation = null;
					machineTurnRunning = token;
					ownedUserTurnId = state.activeUserTurnId;
					ownedRuntime = state.runtime;
					emit({
						type: "queued_user_turn",
						text: request.text,
						kind: "follow-up",
						origin: request.origin,
					});
					if (request.notice !== undefined) emitNotice(request.notice, "warning", "job.clock-resumed");
					if (request.signal.aborted) cancel();
				},
			});
			return (
				settled ??
				refused(
					request.signal.aborted
						? "Scheduled delivery cancelled before execution."
						: "The fresh turn was refused during ordinary admission.",
				)
			);
		} catch (error) {
			return {
				status: request.signal.aborted ? "canceled" : "failed",
				turnId: null,
				reason: error instanceof Error ? error.message : String(error),
			};
		} finally {
			request.signal.removeEventListener("abort", cancel);
			if (machineTurnRunning === token) machineTurnRunning = null;
			try {
				projectionLease?.release();
			} catch (error) {
				emitNotice(
					`Machine turn projection release failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			if (machineTurnOwner === token) machineTurnOwner = null;
			// Successor prompts have their own lifetime and must never extend this occurrence (#411).
			if (settled !== null && !machineHostDisposed)
				void queues
					.resubmitStranded()
					.then(async (submitted) => {
						if (!submitted) await queues.resubmitRequestContinuation();
					})
					.catch((error: unknown) => emitNotice(error instanceof Error ? error.message : String(error), "error"));
		}
	};
	return api;
}
