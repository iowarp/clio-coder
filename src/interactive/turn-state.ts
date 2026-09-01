/**
 * Shared mutable state for one chat loop instance.
 *
 * `createChatLoop` composes single-owner turn modules (runtime, context,
 * persistence, queues, recovery, middleware). They coordinate through this
 * one heap object instead of closure captures, so each concern can live in
 * its own file while the loop keeps exactly one copy of every turn fact.
 * Fields are grouped by the module that owns writes; everything is readable
 * by every module.
 */

import type { ClioSettings } from "../core/config.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type {
	ResolvedRuntimeTarget,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import type { createEngineAgent } from "../engine/agent.js";
import type { AgentMessage } from "../engine/types.js";
import type { AskUserToolPolicy } from "../tools/registry.js";

export interface ChatLoopTarget {
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	runtimeResolution: ResolvedRuntimeTarget;
}

export interface AgentRuntime {
	agent: ReturnType<typeof createEngineAgent>["agent"];
	targetId: string;
	runtimeId: string;
	wireModelId: string;
	runtimeResolution: ResolvedRuntimeTarget;
}

export interface ChatLoopRunSnapshot {
	targetId: string;
	targetUrl: string | null;
	runtimeId: string;
	runtimeKind: RuntimeDescriptor["kind"];
	wireModelId: string;
	autonomy: ClioSettings["safety"]["autonomy"];
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	promptSignature: string | null;
	toolSignature: string | null;
	runtimeResolution?: RuntimeTargetSnapshot;
	sessionId: string | null;
	cwd: string;
}

/**
 * What a consumed prompt is doing before it owns the stream. `compacting` is
 * the sub-state that made the defect visible, because it is the one that lasts
 * long enough for an operator to conclude the keystroke was lost.
 */
export type TurnPreparationPhase = "idle" | "preparing" | "compacting";

export interface ChatTurnState {
	/** Live agent runtime; built or hot-swapped by turn-runtime. */
	runtime: AgentRuntime | null;
	/** Ledger cursor: the id the next appended turn parents under. */
	lastTurnId: string | null;
	/** True while a submit is in flight. */
	streaming: boolean;
	/**
	 * Where a consumed prompt is between the editor and the live stream.
	 *
	 * The editor is cleared and the prompt painted into the transcript before
	 * admission, and everything from the capability probe through pre-submit
	 * compaction to the prompt compile happens after that and before
	 * `streaming`. With nothing naming that window the composer went straight
	 * back to `MESSAGE` and the footer still read the previous turn as done, so
	 * a 77-second compaction was indistinguishable from a dropped Enter
	 * (issue #251).
	 */
	turnPreparation: TurnPreparationPhase;
	/** When the current preparation window opened, for its elapsed counter. */
	turnPreparationSince: number;
	/** Thinking level the active request runs under; read by onPayload. */
	currentThinkingLevel: ThinkingLevel;
	/** Provider context rebuilt on session switch, consumed by the next runtime build. */
	replayedContextMessages: AgentMessage[];
	/** The user turn id of the in-flight submit; null between turns. */
	activeUserTurnId: string | null;
	/**
	 * Set by a loop-guard interrupt (cancel with a reason). While set, the empty
	 * aborted assistant messages the abort produces are suppressed in both the
	 * ledger and the live transcript; the durable closing turn carrying the
	 * reason is persisted when the run settles (submit's finally), after the
	 * in-flight tool results have landed. Cleared there, and defensively at the
	 * start of each submit.
	 */
	activeInterruptReason: string | null;
	/**
	 * Estimated spend of the cancelled call whose hollow aborted message the
	 * interrupt suppressed (thinking streamed, no text). The message never reaches
	 * the ledger, so the closing turn persisted in submit's finally carries this
	 * instead of an estimate derived from its own notice text. Cleared with
	 * `activeInterruptReason`.
	 */
	interruptedUsage: Record<string, unknown> | null;
	/**
	 * Loop-guard synthesis lockout: once the guard locks a turn, the remaining
	 * model rounds are forced text-only at the request level (tool_choice none
	 * in onPayload). Cleared when the next user turn starts.
	 */
	synthesisToolLock: boolean;
	/** Reason a streaming tool-prose cutoff (or hard-block reminder) aborted the run. */
	toolProseAbortReason: string | null;
	/** Reason the stall watchdog aborted a silent stream. Set just before `agent.abort()` and consumed by `reclassifyStallAbort` once the run settles, which is what separates a watchdog abort from an operator Esc. */
	streamStallReason: string | null;
	/** Answer length at the last tool-prose scan, so the scan samples instead of running per delta. */
	toolProseAssessedChars: number;
	/** Tool calls observed in the current turn; feeds turn_end metadata. */
	turnToolCalls: number;
	/** Names of those calls, in order, so turn_end can tell a listing-only turn from a working one. */
	turnToolNames: string[];
	/** A `[worker result]` note the operator shared entered this turn, as the prompt or as a steer; feeds turn_end metadata. */
	turnSharedWorkerNote: boolean;
	/** One stalled-turn nudge per user prompt; reset when a real prompt arrives. */
	stalledTurnNudgeSpent: boolean;
	/** A middleware request_continuation is waiting to resubmit after settle. */
	pendingRequestContinuation: boolean;
	currentPendingSkillPolicy: PendingSkillToolPolicy | undefined;
	currentAskUserPolicy: AskUserToolPolicy | undefined;
	lastRunSnapshot: ChatLoopRunSnapshot | null;
}

export function createTurnState(initialThinkingLevel: ThinkingLevel): ChatTurnState {
	return {
		runtime: null,
		lastTurnId: null,
		streaming: false,
		turnPreparation: "idle",
		turnPreparationSince: 0,
		currentThinkingLevel: initialThinkingLevel,
		replayedContextMessages: [],
		activeUserTurnId: null,
		activeInterruptReason: null,
		interruptedUsage: null,
		synthesisToolLock: false,
		toolProseAbortReason: null,
		streamStallReason: null,
		toolProseAssessedChars: 0,
		turnToolCalls: 0,
		turnToolNames: [],
		turnSharedWorkerNote: false,
		stalledTurnNudgeSpent: false,
		pendingRequestContinuation: false,
		currentPendingSkillPolicy: undefined,
		currentAskUserPolicy: undefined,
		lastRunSnapshot: null,
	};
}
