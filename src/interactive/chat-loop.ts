import { randomUUID } from "node:crypto";
import type { TurnControlRecord, TurnOutcomeRecord } from "../domains/turn-control/index.js";
import type { TurnControlRunner } from "./turn-control-runner.js";

export { runOutOfTurnRound } from "./side-question.js";
export { createTurnControlRunner } from "./turn-control-runner.js";

import { isPlanOnlyRequest, stripPlanCloseOptions } from "../core/plan-request.js";
import type { PrecomputedRanking } from "../core/precomputed-rank.js";
import { ToolNames } from "../core/tool-names.js";
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BusChannels, type RunAbortSource } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import {
	armedSkillSurface,
	type PendingSkillRequest,
	type PendingSkillToolPolicy,
	SKILL_SURFACE_ENTRY,
	type SkillSurfaceChange,
	skillSurfaceChange,
	skillSurfaceLabels,
	skillSurfaceNames,
	withModelSkillActivation,
} from "../core/skill-activation.js";
import { snapshotTurnConstraints, type TurnConstraints } from "../core/turn-constraints.js";
import { clioStateDir } from "../core/xdg.js";
import type { BudgetInspection } from "../domains/context/budget/inspection.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import type { DispatchContract } from "../domains/dispatch/index.js";
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
	acceptsImageInput,
	canonicalEndpointKey,
	modelCandidatesForStatus,
	registerForegroundStream,
	resolveModelCapabilities,
	runtimeTargetSnapshot,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import { type VisionSidecar, visionObservationText } from "../domains/providers/vision-sidecar.js";
import { type AutonomyLevel, modelMayActivateSkills } from "../domains/safety/autonomy.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
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
import { operatorTextOfUserPayload } from "../domains/session/history.js";
import { protectedArtifactStateFromSessionEntries } from "../domains/session/protected-artifacts.js";
import { isRetryableErrorMessage, type RetrySettings } from "../domains/session/retry.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { TokenSplit } from "../domains/turn-control/index.js";
import { reduceTurnOutcome } from "../domains/turn-control/index.js";
import { createEngineAgent } from "../engine/agent.js";
import { countImageBlocks } from "../engine/image-context.js";
import { cwdHash } from "../engine/session.js";
import type { AgentEvent, AgentMessage, ImageContent, Usage } from "../engine/types.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import { finalizeAskUserInterviewForHost } from "../tools/ask-user.js";
import { isGatewayChain } from "../tools/gateway-display.js";
import type { AskUserToolPolicy, ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";
import { effectiveToolCall } from "../tools/surface.js";
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
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import { normalizeRetrySettings } from "./chat-loop-policy.js";
import { retireActiveUserContextForNextOperator } from "./chat-renderer.js";
import { coldReasonText } from "./cold-reasons.js";
import {
	DRAFT_MAX_TOKENS,
	DRAFT_TEMPERATURES,
	draftCandidateFromText,
	draftTemperature,
	runDraftWithSamplerFallback,
} from "./drafts.js";
import { formatFooterTokens } from "./footer-panel.js";
import { type HandoffRepairInput, runHandoffRound } from "./handoff-round.js";
import type { NoticeSource } from "./notice-source.js";
import type { ApprovalRequestView } from "./permission-overlay.js";
import type { runPrewarmRound } from "./prewarm.js";
import { runOutOfTurnRound, runSideQuestion, type SideQuestionResult, sideQuestionUsage } from "./side-question.js";
import type { AgentStatusEvent } from "./status/types.js";
import { createTurnContext, type LiveContextUsage } from "./turn-context.js";
import { createTurnMiddleware } from "./turn-middleware.js";
import type { TurnOutcomeCollector } from "./turn-outcome-collector.js";
import { createTurnOutcomeCollector } from "./turn-outcome-collector.js";
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
	display?: { text: string; note?: string };
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
	 * the TUI transcript marks it cancelled, as the footer verb does (BT-013).
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
			state: "resumed";
	  };

export interface SpeculativeDispatchCounts {
	held: number;
	adopted: number;
	discarded: number;
}

/** The first `limit` code points of `value`, so a slice never lands inside a surrogate pair. */
function boundedCodePoints(value: string, limit: number): string {
	// A pasted log can be megabytes; 2 × limit code units always hold `limit` code points.
	const points = [...value.slice(0, limit * 2 + 1)];
	return points.length <= limit ? value : points.slice(0, limit).join("");
}

/** The dataset facts of one turn outcome; the settled turn and the turn cancelled before admission write the same shape. */
function turnOutcomeFacts(
	record: TurnOutcomeRecord,
	extra: { continuation: boolean; interviewDismissed: boolean; skillsLoaded: ReadonlyArray<string> },
): Record<string, unknown> {
	return {
		turnId: record.turnId,
		continuation: extra.continuation,
		toolCalls: record.coordinator.toolCalls,
		tools: record.coordinator.byTool,
		dispatches: record.coordinator.dispatches,
		askUserCalls: record.coordinator.byTool[ToolNames.AskUser] ?? 0,
		skillsLoaded: [...extra.skillsLoaded],
		harnessAction:
			record.control === null ? null : { decision: record.control.decision, executed: record.control.executed },
		endedWithQuestion: record.conversation.endedWithQuestion,
		asksOperator: record.conversation.asksOperator,
		clarificationStreak: record.conversation.clarificationStreak,
		canceled: record.operator.canceled,
		// Both an Esc that aborts a stream and a dismissed interview set
		// `canceled`; this tells a label reader which one it was.
		interviewDismissed: extra.interviewDismissed,
		completion: record.completion.decision,
		mutatedPaths: record.completion.mutatedPaths,
		stopReason: record.stopReason,
		durationMs: Math.round(record.durationMs),
		// A cancelled turn settles before its workers seal their receipts, so `provenance` says
		// whether this count is final. A `turn-tokens` row carries the count that arrived late.
		workerTokens: { ...record.tokens.workers },
	};
}

function noOutcomeUsage(): TokenSplit {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, provenance: "none" };
}

function readWorkerReceipt(
	runId: string,
	dispatch: Pick<DispatchContract, "getRun"> | undefined,
): Record<string, unknown> | null {
	try {
		const envelope = dispatch?.getRun(runId);
		if (!envelope) return null;
		const path = envelope.receiptPath ?? join(clioStateDir(), "receipts", `${runId}.json`);
		const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return receipt.runId === runId ? receipt : null;
	} catch {
		// A run without a sealed receipt yet reads as absent; the caller marks it partial.
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
async function awaitWorkerReceipts(
	runIds: ReadonlyArray<string>,
	dispatch: Pick<DispatchContract, "getRun"> | undefined,
): Promise<string[]> {
	if (!dispatch) return [];
	const pending = new Set(
		runIds.filter((runId) => dispatch.getRun(runId) !== null && readWorkerReceipt(runId, dispatch) === null),
	);
	const deadline = Date.now() + WORKER_RECEIPT_SEAL_WAIT_MS;
	while (pending.size > 0 && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, WORKER_RECEIPT_SEAL_POLL_MS));
		for (const runId of [...pending]) if (readWorkerReceipt(runId, dispatch) !== null) pending.delete(runId);
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
function watchLateWorkerReceipts(input: {
	missing: ReadonlyArray<string>;
	dispatch: Pick<DispatchContract, "getRun"> | undefined;
	onDone: (sealedAfterMs: number | null) => void;
}): () => void {
	const pending = new Set(input.missing);
	const started = performance.now();
	const timer = setInterval(() => {
		for (const runId of [...pending]) if (readWorkerReceipt(runId, input.dispatch) !== null) pending.delete(runId);
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

function workerOutcomeUsage(
	runIds: ReadonlyArray<string>,
	dispatch: Pick<DispatchContract, "getRun"> | undefined,
): TokenSplit {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let totalTokens = 0;
	let reported = 0;
	let available = 0;
	let missing = 0;
	const ids = [...new Set(runIds)];
	for (const runId of ids) {
		const receipt = readWorkerReceipt(runId, dispatch);
		if (receipt === null) {
			missing += 1;
			continue;
		}
		const count = (key: string) =>
			typeof receipt[key] === "number" && Number.isFinite(receipt[key]) ? (receipt[key] as number) : 0;
		inputTokens += count("inputTokenCount");
		outputTokens += count("outputTokenCount");
		cacheReadTokens += count("cacheReadTokenCount");
		totalTokens += count("tokenCount");
		if (typeof receipt.inputTokenCount === "number" || typeof receipt.outputTokenCount === "number") available += 1;
		if (
			typeof receipt.inputTokenCount === "number" &&
			typeof receipt.outputTokenCount === "number" &&
			typeof receipt.tokenCount === "number"
		)
			reported += 1;
	}
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		totalTokens,
		provenance: available === 0 && missing === 0 ? "none" : reported === ids.length ? "reported" : "partial",
	};
}

export type ChatLoopEvent =
	| AgentEvent
	| AssistantDeltaEvent
	| RetryStatusEvent
	| QueueUpdateEvent
	| QueuedUserTurnEvent
	| ChatNoticeEvent
	| AgentStatusEvent
	| ToolApprovalStateEvent
	| { type: "speculative_dispatch"; counts: SpeculativeDispatchCounts };

export interface ChatSubmitOptions {
	/** Explicit host-owned task scope; never parsed from the prompt text. */
	constraints?: TurnConstraints;
	/** Presentation only; never part of the model message or persisted text. */
	display?: { text: string; note?: string };
	/** Host-owned run identity, scoped to this submit and its internal continuations. */
	hostRun?: ToolInvokeOptions["hostRun"];
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
	 * Commits the presentation of a consumed prompt after preparation opens and
	 * before admission work can make the turn durable. Interactive uses this to
	 * guarantee that even a fast probe or prompt compile paints one pending
	 * frame instead of opening and closing entirely between renderer ticks.
	 */
	onPreparationVisible?: () => Promise<void>;
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

export interface DraftOptions {
	/** Cancels every candidate round. */
	signal?: AbortSignal;
	/** One candidate's streamed text, by index in start order. */
	onCandidate?: (index: number, partialText: string) => void;
}

/** One `/draft` candidate: its text, or why its round produced none. */
export type DraftCandidate = { status: "drafted"; text: string } | { status: "failed"; reason: string };

export type DraftOutcome =
	| { status: "drafted"; candidates: DraftCandidate[]; aborted: boolean }
	| { status: "refused"; reason: string };

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
	currentTurnConstraints?(): TurnConstraints | undefined;
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
	/**
	 * Where a consumed prompt currently is between the editor and the stream.
	 * The composer and the footer read it so the window in which the prompt has
	 * been taken but the turn has not been admitted is never rendered as idle
	 * (issue #251).
	 */
	turnPreparation(): { phase: TurnPreparationPhase; since: number };
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
	turnControl?: TurnControlRunner;
	turnOutcomeCollector?: TurnOutcomeCollector;
	/** Tokens System One spent on calls joined to this user turn, for the outcome record's `decisionModel` split. */
	getDecisionUsage?: (userTurnId: string) => TokenSplit;
	getTaskEstablished?: () => boolean;
	outcomeDispatch?: Pick<DispatchContract, "getRun">;
	memoryCommitBridge?: MemoryInterventionRegistration | undefined;
	interactiveGuidance?: boolean;
	/** An ACP client that advertised interviews: the prompt offers ask_user without the TUI-only guidance. */
	operatorInterviews?: boolean;
	/**
	 * True for a headless `clio-coder run`. Its permission listener denies every
	 * approval ask, so the session prompt says so instead of promising a pause.
	 */
	headless?: boolean;
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
	/** Information-flow admission of each model request; see TurnRuntimeDeps.admitFlow. */
	admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
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
			| "keepRecentTokens"
			| "preserveUserTurnId"
			| "skillContextState"
			| "signal"
			| "beforeSummaryCall"
			| "checkpointForSummary"
		>,
	) => Promise<CompactResult | null>;
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
	getMemorySection?: (request: MemoryPromptRequest) => string;
	/**
	 * Read this turn's request through the `turn` site, once, before the prompt is
	 * built. The interactive host always wires it and asks nothing when the site
	 * is unbound. The host keeps the verdict: the hint registration, the turn
	 * controller and the prewarm read it from there. It always settles, so an
	 * outage costs the deadline and never the turn. `userTurnId` is the id the
	 * ledger will file the user turn under, so the decision record and the
	 * outcome that follows it share a join key. `previousTask` reads the ledger
	 * and may throw, so it is called only by a bound site, inside a catch.
	 */
	readTurn?: (input: {
		userTurnId: string;
		task: string;
		/** What the operator typed, as the ledger will show it. */
		request: string;
		previous: string;
		previousTask: () => string;
		signal: AbortSignal;
	}) => Promise<void>;
	/** Called once when a submitted turn settles, whether it completed, failed or was cancelled. */
	onTurnSettled?: () => SpeculativeDispatchCounts | undefined;
	/**
	 * Memory scores for the section this request builds, or undefined when the
	 * `relevance` site is unbound or ranking could not change the section. It runs
	 * while the prompt composes, so it is asked only when the order decides what
	 * the prompt carries.
	 */
	getMemoryRelevance?: (
		request: MemoryPromptRequest,
	) => Promise<PrecomputedRanking | undefined> | PrecomputedRanking | undefined;
	/**
	 * Write every System One decision and outcome recorded since the last flush
	 * as one ledger entry. Called after the user turn is appended so the rows sit
	 * under the turn they describe; the host also flushes at settle.
	 */
	flushSystemOne?: () => void;
	/**
	 * Read the settled turn's final message through the `turnEnd` site. The loop
	 * waits for it inside the site's own deadline, because the clarification
	 * streak the next turn reads is computed from the answer. Null means the site
	 * did not answer and the regex reading stands.
	 */
	readTurnEnd?: (input: {
		userTurnId: string;
		request: string;
		message: string;
		toolNames: ReadonlyArray<string>;
	}) => Promise<{ asks: boolean | null } | null>;
	/** What followed a decision, joined to it by `ref` when the dataset is exported. */
	recordOutcome?: (outcome: {
		ref: string;
		source: "turn" | "turn-tokens" | "next-operator";
		facts: Readonly<Record<string, unknown>>;
	}) => void;
	getReadySkillCount?: () => number;
	/** Structured, redacted task-bank export supplied only to an explicit context-handoff skill request. */
	getTaskMemoryHandoffSource?: () => string;
	/**
	 * Hand the composition root a delivery path for reminders that background
	 * observers produce after their turn boundary closed. Called once during
	 * composition; the loop owns the buffer the reminder lands in.
	 */
	registerDeferredReminderSink?: (sink: (message: string, isCurrent?: () => boolean) => void) => void;
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

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const createAgent = deps.createAgent ?? createEngineAgent;
	const sideQuestionRound = deps.runSideQuestion ?? runSideQuestion;
	const handoffRound = deps.runHandoffRound ?? runHandoffRound;
	const draftRound = deps.runDraftRound ?? runOutOfTurnRound;
	const middlewareToolChoice = deps.middlewareToolChoice ?? createMiddlewareToolChoiceControl();
	const state = createTurnState(deps.getSettings().chat.thinkingLevel ?? "off");
	const toolStartTimes = new Map<string, number>();
	let lastHistoricalImageNoticeKey: string | null = null;

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
	 * The same transcript notice every admission exit already emitted, carrying
	 * the reason the turn never started. Text, level, and surface are unchanged,
	 * so the TUI and headless paths render exactly what they rendered before.
	 */
	const emitAdmissionNotice = (text: string, reason: string): void => {
		emit({ type: "notice", level: "info", surface: "transcript", text, admission: { reason } });
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
	const currentToolInvokeOptions = (): Partial<ToolInvokeOptions> => {
		const options: Partial<ToolInvokeOptions> = {
			toolResultMaxBytes: deps.getSettings().context.toolResultMaxBytes,
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

	const queues = createTurnQueues({
		state,
		emitQueueUpdateEvent: (messages) => emit({ type: "queue_update", messages }),
		emitQueuedUserTurn: (entry) => emit({ type: "queued_user_turn", ...entry }),
		emitNotice,
		// The loop's own resubmits (stranded steers, continuation requests) run
		// from submit's finally and bypass the admission gate: an interrupt that
		// holds the gate while awaiting that same run would otherwise deadlock.
		submit: (text, options) => submitTracked(text, options),
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

	const context = createTurnContext({
		interactiveGuidance: deps.interactiveGuidance === true,
		operatorInterviews: deps.operatorInterviews === true,
		headless: deps.headless === true,
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
		...(deps.getMemoryRelevance ? { getMemoryRelevance: deps.getMemoryRelevance } : {}),
		memoryCommitBridge: deps.memoryCommitBridge,
		getReadySkillCount: deps.getReadySkillCount,
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
		emitCacheNotice: (reasons) =>
			emit({
				type: "notice",
				level: "info",
				surface: "footer",
				text: `cache may be cold: ${reasons.map(coldReasonText).join(", ")}`,
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
		state,
		session: deps.session,
		readSessionEntries: deps.readSessionEntries,
		getSettings: deps.getSettings,
		middlewareToolChoice,
		consumePersistedEcho: (text) => queues.consumePersistedEcho(text),
		removeQueuedMirrorEntry: (text) => queues.removeQueuedMirrorEntry(text),
		promptCachePayloadForAssistant: (usage, backend) => context.promptCachePayloadForAssistant(usage, backend),
		promptSideTokens: () => context.promptSideTokens(),
		observability: deps.observability,
	});
	const outcomeCollector = deps.turnOutcomeCollector ?? createTurnOutcomeCollector();
	if (deps.turnOutcomeCollector === undefined) deps.middleware?.registerHook(outcomeCollector);

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
		if (event.type === "message_end") {
			rewriteStallAbortMessage(state, event.message);
			explainInterruptedAssistant(event.message, state.activeInterruptReason);
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
		state,
		gatewayCapabilityNames: () => deps.toolRegistry?.listGateway().map((spec) => spec.name) ?? [],
		getSettings: deps.getSettings,
		providers: deps.providers,
		knownTargets: deps.knownTargets,
		observability: deps.observability,
		scheduling: deps.scheduling,
		headless: deps.headless,
		createAgent,
		continuity,
		hasQueuedSteering: () => queues.queuedMessages().steer.length > 0,
		middlewareToolChoice,
		persistence,
		context,
		middleware,
		retrySettings,
		sessionId: () => deps.session?.current()?.id,
		...(deps.admitFlow !== undefined ? { admitFlow: deps.admitFlow } : {}),
		emit: emitRuntimeEvent,
		emitNotice,
		emitFooterNotice,
		toolStartTimes,
		prepareInRunContinuation: async (signal) => {
			const userTurnId = state.activeUserTurnId;
			if (!deps.turnControl || userTurnId === null) return null;
			const controllerAbort = new AbortController();
			const forward = () => controllerAbort.abort();
			signal?.addEventListener("abort", forward, { once: true });
			try {
				const result = await deps.turnControl.run({
					operatorText: "",
					continuation: true,
					userTurnId,
					signal: controllerAbort.signal,
				});
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
		deps.bus?.on(BusChannels.ConfigHotReload, () => {
			context.invalidateSessionPromptCache();
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		}) ?? null;
	const unsubscribeConfigNextTurn =
		deps.bus?.on(BusChannels.ConfigNextTurn, (payload) => {
			if (
				!payload.diff.nextTurn.some(
					(path) => path === "chat" || path.startsWith("chat.") || path === "targets" || path.startsWith("targets."),
				)
			)
				return;
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		}) ?? null;
	const unsubscribePluginsReload =
		deps.bus?.on(BusChannels.PluginsReloaded, () => {
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

	const prepareOutOfTurnRound = async (
		inFlightRefusal: string,
		signal?: AbortSignal,
		silent = false,
	): Promise<OutOfTurnPreparation> => {
		if (state.streaming) return { ok: false, reason: inFlightRefusal };
		let agentRuntime: AgentRuntime | null;
		try {
			agentRuntime = turnRuntime.ensureRuntime({ silent });
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
		if (!agentRuntime) return { ok: false, reason: notConfiguredNotice() };
		const resolution = agentRuntime.runtimeResolution;
		try {
			if (resolution.costProvenance === "known" || resolution.costProvenance === "estimated") {
				await deps.scheduling?.admitPaidRequest?.({
					waitForRaise: deps.headless !== true,
					getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
					...(signal ? { signal } : {}),
				});
			}
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
	 * Report an out-of-turn round's provider usage. Money was spent, so `/usage`
	 * says so under its own label; turn persistence, the working-set ledger,
	 * compaction inputs, and the footer counters never see it.
	 *
	 * The same call is also appended to the out-of-turn usage store under the
	 * state dir. That store exists because `/usage` only knows what this process
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
				...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
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
				...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
				reasoning: usage.reasoning,
				totalTokens: usage.totalTokens,
				costUsd: usage.costUsd,
			},
		});
	};

	// A submit owns the turn state machine from the moment it starts running,
	// which is well before `state.streaming` flips: the probe, auto-compaction,
	// and the prompt compile all happen first. The pre-warm reads this flag, not
	// `streaming`, so it can never be the request the operator's turn queues
	// behind.
	let turnActive = false;
	let pendingPreTurnRead: AbortController | null = null;
	let pendingVisionSidecar: AbortController | null = null;
	/**
	 * The last operator turn that settled and has not yet been followed by another
	 * operator message. The next submit reports how it was followed, once.
	 */
	let previousOperatorTurn: { id: string; settledAt: number } | null = null;

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
		ref: string;
		parentTurnId: string | null;
		runIds: ReadonlyArray<string>;
		missing: ReadonlyArray<string>;
	}): void => {
		if (input.missing.length === 0 || !deps.outcomeDispatch) return;
		const sessionId = deps.session?.current()?.id ?? null;
		const stop = watchLateWorkerReceipts({
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
							data: { turnId: input.turnId, ref: input.ref, workers, sealedAfterMs: afterMs },
						});
					} catch {
						// The ledger closed under the watcher; the dataset row below still records the count.
					}
				}
				deps.recordOutcome?.({
					ref: input.ref,
					source: "turn-tokens",
					facts: { turnId: input.turnId, workerTokens: { ...workers }, sealedAfterMs: afterMs },
				});
			},
		});
		lateReceiptWatchers.add(stop);
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
			const missingReceipts = await awaitWorkerReceipts(collected.harness.runIds, deps.outcomeDispatch);
			const record = reduceTurnOutcome({
				...collected,
				turnId: input.userTurnId,
				turnIndex: operatorTurnIndex(),
				continuation: input.continuation,
				finalAssistantText: "",
				asksOperator: null,
				taskEstablished: deps.getTaskEstablished?.() ?? false,
				canceled: true,
				tokens: {
					coordinator: noOutcomeUsage(),
					decisionModel: deps.getDecisionUsage?.(input.userTurnId) ?? noOutcomeUsage(),
					workers: workerOutcomeUsage(collected.harness.runIds, deps.outcomeDispatch),
				},
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
			const outcomeRef = input.continuation && previousOperatorTurn !== null ? previousOperatorTurn.id : input.userTurnId;
			deps.recordOutcome?.({
				ref: outcomeRef,
				source: "turn",
				facts: turnOutcomeFacts(record, { continuation: input.continuation, interviewDismissed: false, skillsLoaded: [] }),
			});
			amendLateWorkerTokens({
				turnId: input.userTurnId,
				ref: outcomeRef,
				parentTurnId: outcomeParent,
				runIds: collected.harness.runIds,
				missing: missingReceipts,
			});
			if (!input.continuation) previousOperatorTurn = { id: input.userTurnId, settledAt: performance.now() };
			else if (previousOperatorTurn !== null) previousOperatorTurn.settledAt = performance.now();
			// The turn decision waits in the buffer for the next admission otherwise, and a
			// session that ends here would file the decision and its outcome apart.
			deps.flushSystemOne?.();
		} catch {
			// Measurement must not change how a cancelled turn settles.
		}
	};

	const prewarm = createTurnPrewarm({
		state,
		getSettings: deps.getSettings,
		providers: deps.providers,
		context,
		bus: deps.bus,
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
		clearSkillSurface: () => {
			const cleared = skillSurfaceNames(state.activeSkillSurface);
			armSkillSurface(undefined, undefined, true);
			return cleared;
		},
		activeSkillSurface: () => skillSurfaceNames(state.activeSkillSurface),
		clearQueuedFollowUps: () => queues.clearQueuedMirror().map((entry) => entry.text),
		queuedMessages: () => queues.queuedMessages(),

		async submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
			const submittedAt = performance.now();
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
					if (options.constraints !== undefined) {
						emitAdmissionNotice(
							"A submission with explicit task constraints must start a fresh turn; wait for settlement or interrupt the active run.",
							"constrained-turn-in-flight",
						);
						return;
					}
					const hasImages = options.images !== undefined && options.images.length > 0;
					if (!hasImages && trimmed.length > 0 && state.runtime) {
						// Enter while streaming means "correct it now": the engine
						// steering queue drains after every tool batch, so the text
						// lands as a user message before the next model turn.
						// Ctrl+Q (queueFollowUp) keeps the after-this-run intent.
						if (isWorkerShareNote(trimmed)) state.turnSharedWorkerNote = true;
						// The queue carries the submitted bytes, not the trimmed copy the
						// guard above reads: a steer is a model-facing turn and the
						// payload contract applies to it too (issue #244).
						if (mode === "end-of-turn") queues.queueFollowUp(text, options.display);
						else queues.steer(text, options.display);
						return;
					}
					emitNotice("[Clio Coder] response already in progress. Press Esc to cancel the active run.");
					return;
				}
			}

			state.currentTurnConstraints =
				options.requestContinuation === true ? state.currentTurnConstraints : snapshotTurnConstraints(options.constraints);
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
			const operatorText = text;
			let sidecarObservation: string | null = null;
			const routeAcceptsImages = acceptsImageInput({
				runtimeId: agentRuntime.runtimeResolution.runtime.id,
				vision: agentRuntime.runtimeResolution.capabilityDecisions.vision,
			});
			if (options.images?.length && !routeAcceptsImages) {
				if (deps.visionSidecar?.configured()) {
					const sidecar = deps.visionSidecar;
					const controller = new AbortController();
					pendingVisionSidecar = controller;
					emitNotice(`[Clio Coder] Processing image with ${sidecar.label() ?? "vision sidecar"}...`);
					try {
						const question = operatorText.trim() || "Describe the attached image and any visible text.";
						const analysis = await sidecar.analyze(options.images, question, controller.signal);
						if (controller.signal.aborted) return;
						sidecarObservation = visionObservationText(analysis);
						text = [operatorText, sidecarObservation].filter(Boolean).join("\n\n");
						emitNotice(`[Clio Coder] Image processed with ${analysis.model}.`);
					} catch (err) {
						if (controller.signal.aborted) {
							emitAdmissionNotice("[Clio Coder] Image processing cancelled.", "vision-sidecar-cancelled");
						} else {
							const reason = err instanceof Error ? err.message : String(err);
							emitAdmissionNotice(`[Clio Coder] Image processing failed: ${reason}`, "vision-sidecar-failed");
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
			middlewareToolChoice.reset();
			if (options.requestContinuation !== true) state.stalledTurnNudgeSpent = false;
			const images = sidecarObservation === null && options.images?.length ? [...options.images] : undefined;
			const pendingSkillRequests =
				state.currentTurnConstraints?.skills === "disabled" ? [] : (options.pendingSkillRequests ?? []);
			context.addWorkingContextPaths(options.workingContextPaths ?? []);
			context.prepareMemoryTurn(agentRuntime, {
				taskText: text,
				continuation: options.requestContinuation === true,
				images,
			});
			// The user turn id is fixed before anything is asked about the turn, so the
			// pre-turn decision record, the ledger row and every outcome that follows
			// carry the id the user turn will be filed under. A run that returns
			// before admission leaves the id unused, which costs nothing.
			const reservedUserTurnId = randomUUID();
			let previous = "";
			const messages = agentRuntime.agent.state.messages;
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				if (messages[index]?.role === "assistant") {
					previous = extractText(messages[index]);
					break;
				}
			}
			const operatorTurn = options.requestContinuation !== true;
			if (operatorTurn && previousOperatorTurn !== null) {
				// The operator's reply is the strongest signal of how the last turn
				// landed: a correction, a thanks, a retry or silence all read differently.
				const followed = previousOperatorTurn;
				previousOperatorTurn = null;
				try {
					deps.recordOutcome?.({
						ref: followed.id,
						source: "next-operator",
						facts: { text: boundedCodePoints(operatorText, 300), gapMs: Math.round(submittedAt - followed.settledAt) },
					});
				} catch {
					// Recording an outcome never costs the turn it describes.
				}
			}
			// The one place a turn pays for System One before the prompt is built. The
			// hint registration and the controller are synchronous, so the answer is
			// awaited here, inside the site's own deadline, rather than fetched where it
			// is read. A continuation turn carries a nudge rather than the operator's
			// request, so a judgment about it would be a judgment about the nudge.
			if (operatorTurn && deps.readTurn) {
				// What the operator asked last turn, as typed. Without it a correction
				// such as "actually drop X from that list" has nothing to correct, and
				// it scored unknown at 0.22 on the assistant's reply alone. Read only
				// when a bound site asks, because it reparses the whole ledger from
				// disk and an operator without System One must not pay for it.
				const lastTurnId = state.lastTurnId ?? undefined;
				const previousTask = (): string => {
					const entries = filterEntriesToActivePath(deps.readSessionEntries?.() ?? [], lastTurnId);
					for (let index = entries.length - 1; index >= 0; index -= 1) {
						const entry = entries[index];
						if (entry?.kind !== "message" || entry.role !== "user") continue;
						if ((entry.payload as { synthetic?: unknown } | null)?.synthetic === true) continue;
						return operatorTextOfUserPayload(entry.payload) ?? "";
					}
					return "";
				};
				const turnReadAbort = new AbortController();
				pendingPreTurnRead = turnReadAbort;
				try {
					// The last assistant message is evidence for a short follow-up: "ok go
					// ahead" is an action after a proposal and a pleasantry without one.
					await deps.readTurn({
						userTurnId: reservedUserTurnId,
						task: text,
						request: options.display?.text ?? operatorText,
						previous,
						previousTask,
						signal: turnReadAbort.signal,
					});
				} catch {
					// Every consumer degrades to what it did before the call existed.
				} finally {
					if (pendingPreTurnRead === turnReadAbort) pendingPreTurnRead = null;
				}
				// Cancellation before prompt admission leaves no user turn or model
				// request behind, even if an injected reader ignored its signal.
				if (turnReadAbort.signal.aborted) {
					await recordCanceledBeforeAdmission({
						userTurnId: reservedUserTurnId,
						continuation: !operatorTurn,
						control: null,
						submittedAt,
					});
					return;
				}
			}

			let orientationBlock: string | null = null;
			let turnControlRecord: TurnControlRecord | null = null;
			if (deps.turnControl) {
				const controllerAbort = new AbortController();
				pendingPreTurnRead = controllerAbort;
				setTurnPreparation("preparing");
				try {
					const result = await deps.turnControl.run({
						operatorText: text,
						continuation: options.requestContinuation === true,
						userTurnId: reservedUserTurnId,
						signal: controllerAbort.signal,
					});
					orientationBlock = result.block;
					turnControlRecord = result.record;
				} finally {
					if (pendingPreTurnRead === controllerAbort) pendingPreTurnRead = null;
				}
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
			const reminderProjection = middleware.takePendingReminderProjection();
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
				[reminderProjection(), orientationBlock ?? "", skillPreamble, taskMemoryHandoffSource, text]
					.filter((part) => part.length > 0)
					.join("\n\n");
			let submittedText = composeSubmittedText();

			// 2. Pre-submit auto-compaction trigger
			const forceNow = process.env.CLIO_CODER_FORCE_COMPACT === "1";
			try {
				setTurnPreparation("compacting");
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
				emitNotice(`[Clio Coder] auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`);
				if (err instanceof Error && err.name === "AbortError") {
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

			// 3. Ensure the session prompt (compiles only on explicit events)
			const compiledPrompt = await context.ensureSessionPrompt(agentRuntime);
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
				setTurnPreparation("compacting");
				let failure: string | undefined;
				let canceled = false;
				await context
					.runAutoCompact(
						agentRuntime,
						true,
						undefined,
						"overflow",
						submittedText,
						pendingSkillPolicy,
						undefined,
						undefined,
						options.requestContinuation !== true,
					)
					.catch((error: unknown) => {
						canceled = error instanceof Error && error.name === "AbortError";
						failure = error instanceof Error ? error.message : String(error);
					})
					.finally(endPreparationCompaction);
				// An operator cancel is not an admission failure: record it like the
				// pre-admission cancels above and leave no window-exceeded notice.
				if (canceled) {
					await recordCanceledBeforeAdmission({
						userTurnId: reservedUserTurnId,
						continuation: options.requestContinuation === true,
						control: turnControlRecord,
						submittedAt,
					});
					return;
				}
				submittedText = composeSubmittedText();
				admission = context.refreshLiveBudget(submittedText);
				if (
					admission.effectiveWindow !== null &&
					!requestFits(admission.inputTokens, admission.outputReserveTokens, admission.effectiveWindow)
				) {
					emitAdmissionNotice(
						`[Clio Coder] Request exceeds the available context window (input ${admission.inputTokens ?? "unknown"} + output ${admission.outputReserveTokens ?? "unknown"}, window ${admission.effectiveWindow ?? "unknown"}).${failure ? ` ${failure}` : ""} Trim the prompt or reduce active tools.`,
						"context-window-exceeded",
					);
					return;
				}
				turnSnapshot = captureTurnSnapshot("pending");
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
			);
			const turnIndex = operatorTurnIndex(userTurnId ?? undefined);
			// A continuation is a synthetic user turn, which the count skips.
			if (options.requestContinuation !== true) operatorTurnsBefore = turnIndex + 1;
			context.installMemoryRestoration(agentRuntime, submittedText);
			context.commitMemoryTurn(agentRuntime);
			// An interrupt was submitted while a run was active, so no caller drew
			// it in the transcript; render it here, after the cancel notice and the
			// cancelled run's leftovers, which is the order the ledger has.
			if (interrupted)
				emit({
					type: "queued_user_turn",
					text: operatorText,
					kind: "interrupt",
					...(options.display ? { display: options.display } : {}),
				});
			context.logPromptCompileIfPending();
			if (deps.flushSystemOne && deps.session?.current()) {
				try {
					// The pre-turn decision and anything asked since the last turn settled
					// (an approval card, a /draft judgment) land under the user turn just
					// appended, so a record and its outcome share a ledger neighborhood.
					deps.flushSystemOne();
				} catch {
					// Recording System One is best effort and never costs the turn.
				}
			}
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
				autonomy: deps.getSettings().safety.autonomy,
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
			state.interruptedAssistantMessage = null;
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
			if (options.requestContinuation !== true && deps.readSessionEntries) {
				const prior = agentRuntime.agent.state.messages;
				const retired = retireActiveUserContextForNextOperator(prior, deps.readSessionEntries(), {
					...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
				});
				if (retired.length < prior.length) replaceEngineMessages(agentRuntime.agent, retired);
			}
			const priorPendingSkillPolicy = state.currentPendingSkillPolicy;
			const priorAskUserPolicy = state.currentAskUserPolicy;
			state.currentPendingSkillPolicy = pendingSkillPolicy;
			state.currentAskUserPolicy = askUserPolicy;
			try {
				await queues.markPersistedUserEcho(runtimePromptText, () => agentRuntime.agent.prompt(runtimePromptText, images));
				if (
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
				const canceled = state.activeInterruptReason !== null && state.activeInterruptByOperator;
				// Esc on an interview resolves it as cancelled and the tool ends the turn
				// itself, so no interrupt is raised and `canceled` stays false. The turn
				// still ended on the operator's say-so, which the outcome has to show.
				const interviewDismissed = askUserPolicy?.status === "cancelled";
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
					const reason = state.activeInterruptReason;
					state.activeInterruptReason = null;
					// A partial response already closed with the cancellation reason.
					// Only a hollow abort needs a synthetic assistant, after all tool
					// results have landed. Publish its notice after settlement too, so
					// it cannot split the entry the provider's message_end finalizes.
					if (state.interruptedAssistantMessage === null) {
						const closing = noticeMessage(reason);
						if (state.interruptedUsage !== null) {
							(closing as { usage?: unknown }).usage = state.interruptedUsage;
						}
						persistence.appendAssistantTurn(closing);
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
					state.interruptedUsage = null;
				}
				// A continuation writes its outcome too: the streak that gates the next
				// turn's direction workflow resets on a turn that used a tool, and a
				// continuation is exactly where an answered interview does. Without its
				// row the streak stayed at the operator turn's value, in memory and on
				// resume.
				if (userTurnId !== null && deps.session?.current()) {
					try {
						const continuation = options.requestContinuation === true;
						const collected = outcomeCollector.take(userTurnId);
						const finalMessage = [...agentRuntime.agent.state.messages]
							.reverse()
							.find((message) => message.role === "assistant");
						const finalEntry = deps.readSessionEntries?.().find((entry) => entry.turnId === state.lastTurnId);
						const finalPayload =
							finalEntry?.kind === "message" && finalEntry.role === "assistant"
								? (finalEntry.payload as { text?: unknown; stopReason?: unknown })
								: undefined;
						const traced = persistence.lastTracedTurn();
						const matchesTrace = traced?.runId === `session:${userTurnId}`;
						const finalAssistantText =
							typeof finalPayload?.text === "string" ? finalPayload.text : finalMessage ? extractText(finalMessage) : "";
						// The turn-end site reads whether the message waits on the operator.
						// A continuation is not the operator's request, so it is not asked, and a
						// dismissed interview already says how the turn ended.
						let asksOperator: boolean | null = null;
						if (!canceled && !interviewDismissed && !continuation && deps.readTurnEnd) {
							try {
								const read = await deps.readTurnEnd({
									userTurnId,
									request: operatorText,
									message: finalAssistantText,
									toolNames: collected.toolNames,
								});
								asksOperator = read?.asks ?? null;
							} catch {
								// The regex reading of the closing text stands.
							}
						}
						const workerRunIds = [...collected.dispatches.flatMap((item) => item.runIds), ...collected.harness.runIds];
						const missingReceipts = canceled ? await awaitWorkerReceipts(workerRunIds, deps.outcomeDispatch) : [];
						const record = reduceTurnOutcome({
							...collected,
							turnId: userTurnId,
							turnIndex,
							continuation,
							finalAssistantText,
							asksOperator,
							taskEstablished: deps.getTaskEstablished?.() ?? false,
							canceled,
							interviewDismissed,
							tokens: {
								coordinator: matchesTrace ? persistence.currentTurnUsage() : noOutcomeUsage(),
								decisionModel: deps.getDecisionUsage?.(userTurnId) ?? noOutcomeUsage(),
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
						// The turn-end reading asked for a continuation, and every decision about
						// the request carries the operator turn's id. A row filed under the
						// continuation's own id would join no decision when the dataset exports.
						const outcomeRef = continuation && previousOperatorTurn !== null ? previousOperatorTurn.id : userTurnId;
						try {
							deps.recordOutcome?.({
								ref: outcomeRef,
								source: "turn",
								facts: turnOutcomeFacts(record, {
									continuation,
									interviewDismissed,
									skillsLoaded: [...(pendingSkillPolicy?.loadedSkillNames ?? [])].filter(
										(name) => !skillsLoadedBeforeTurn.has(name),
									),
								}),
							});
						} catch {
							// Recording an outcome never costs the turn it describes.
						}
						amendLateWorkerTokens({
							turnId: userTurnId,
							ref: outcomeRef,
							parentTurnId: outcomeParent,
							runIds: workerRunIds,
							missing: missingReceipts,
						});
						// A continuation extends the operator turn it followed, so the gap the
						// next operator message reports runs from the end of the whole chain.
						if (!continuation) previousOperatorTurn = { id: userTurnId, settledAt: performance.now() };
						else if (previousOperatorTurn !== null) previousOperatorTurn.settledAt = performance.now();
						if (matchesTrace && traced)
							persistence.traceEventForRun(traced.runId, { type: "turn_outcome", name: "turn_outcome", payload: record });
					} catch {
						// Measurement must not change turn settlement when a ledger or receipt is unavailable.
					}
				}
				state.currentPendingSkillPolicy = priorPendingSkillPolicy;
				state.currentAskUserPolicy = priorAskUserPolicy;
				armSkillSurface(pendingSkillPolicy, skillsLoadedBeforeTurn);
				state.activeUserTurnId = null;
				// Safety net for thrown paths where agent_end never delivered;
				// no-op when the agent_end flush already ran.
				context.flushReconciledSnapshot();
				persistence.deferTraceClose(false);
				// Runs on every exit path (normal settle, catch-arm returns) so
				// a steer the engine never drained still reaches the model.
				if (!(await queues.resubmitStrandedSteers())) await queues.resubmitRequestContinuation();
			}
		},

		cancel(options?: ChatCancelOptions): void {
			continuity.cancel();
			pendingPreTurnRead?.abort();
			pendingVisionSidecar?.abort();
			const wasStreaming = state.streaming;
			context.cancelCompaction();
			recovery.cancelRetryCountdown();
			// Clear both queues before the abort settles the in-flight prompt:
			// a cancelled run must not deliver queued steers or follow-ups, and
			// the stranded-steer fallback must find an empty mirror.
			queues.clearQueuedMirror();
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
		currentTurnConstraints: () => state.currentTurnConstraints,
		contextLedger: () => context.contextLedger(),
		liveBudget: () => context.liveBudget(),
		inspectLiveBudget: () => context.inspectLiveBudget(),
		refreshLiveBudget: () => context.refreshLiveBudget(),
		whenSettled: () => activeSubmit,
		whenPrewarmSettled: () => prewarm.settled(),

		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			operatorTurnsBefore = null;
			lastHistoricalImageNoticeKey = null;
			pendingVisionSidecar?.abort();
			continuity.cancel();
			void continuity.pause();
			state.currentTurnConstraints = undefined;
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
			pendingVisionSidecar?.abort();
			turnRuntime.dispose();
			for (const stop of lateReceiptWatchers) stop();
			lateReceiptWatchers.clear();
			unsubscribeConfigReload?.();
			unsubscribeConfigNextTurn?.();
			unsubscribePluginsReload?.();
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

		async draftCandidates(request: string, count: number, options: DraftOptions = {}): Promise<DraftOutcome> {
			const text = request.trim();
			if (text.length === 0) return { status: "refused", reason: "a draft needs a request" };
			if (!Number.isInteger(count) || count < 1 || count > DRAFT_TEMPERATURES.length) {
				return { status: "refused", reason: `draft count must be 1 to ${DRAFT_TEMPERATURES.length}` };
			}
			// Refused, never queued, for the side question's reason: the drafts
			// answer the session as it stands now.
			const prepared = await prepareOutOfTurnRound(
				"a turn is in flight; /draft runs beside the session, not in its queue",
				options.signal,
			);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			const candidates = await Promise.all(
				DRAFT_TEMPERATURES.slice(0, count).map(async (temperature, index): Promise<DraftCandidate> => {
					const samplingTemperature = draftTemperature(prepared.runtime.agent.state.model, temperature);
					try {
						// One endpoint slot per round: each is a full request against the
						// same scheduler, and capacity has to count every one of them.
						const result = await withEndpointSlot(prepared.runtime, () =>
							runDraftWithSamplerFallback(
								index,
								samplingTemperature,
								(sampling) =>
									draftRound({
										model: prepared.runtime.agent.state.model,
										// Read-only, exactly as the side-question round treats it.
										messages: prepared.runtime.agent.state.messages,
										systemPrompt: sampling.systemPrompt,
										userText: text,
										maxTokens: DRAFT_MAX_TOKENS,
										...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
										...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
										...(options.signal ? { signal: options.signal } : {}),
										...(options.onCandidate ? { onDelta: (partial: string) => options.onCandidate?.(index, partial) } : {}),
									}),
								options.signal,
							),
						);
						recordOutOfTurnUsage(prepared.runtime, result.usage, "side-question");
						return draftCandidateFromText(result.text);
					} catch (err) {
						return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
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
			state.streaming = true;
			try {
				await continuity.recover(handoffId, action);
				await continueEngineWithoutInput(runtime.agent);
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
				emitNotice(`[/context compact] ${notConfiguredNotice()}`);
				return;
			}
			let compacted = false;
			enterPreparation();
			setTurnPreparation("compacting");
			try {
				compacted = await context.runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				emitNotice(`[/context compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			} finally {
				leavePreparation();
				endPreparationCompaction();
			}
			if (!compacted) {
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
		// The flag brackets the whole submit, including the early returns an
		// admission failure takes, so a refused turn does not leave the pre-warm
		// believing a turn is still running.
		turnActive = true;
		const run = submitInner(text, options).finally(() => {
			turnActive = false;
			try {
				const counts = deps.onTurnSettled?.();
				if (counts !== undefined) emit({ type: "speculative_dispatch", counts });
			} catch {
				// Settle hooks are housekeeping and never cost the turn.
			}
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

	return api;
}
