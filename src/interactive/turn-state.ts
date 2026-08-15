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
	runtimeId: string;
	runtimeKind: RuntimeDescriptor["kind"];
	wireModelId: string;
	autonomy: ClioSettings["autonomy"];
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	promptSignature: string | null;
	toolSignature: string | null;
	runtimeResolution?: RuntimeTargetSnapshot;
	sessionId: string | null;
	cwd: string;
}

export interface ChatTurnState {
	/** Live agent runtime; built or hot-swapped by turn-runtime. */
	runtime: AgentRuntime | null;
	/** Ledger cursor: the id the next appended turn parents under. */
	lastTurnId: string | null;
	/** True while a submit is in flight. */
	streaming: boolean;
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
		currentThinkingLevel: initialThinkingLevel,
		replayedContextMessages: [],
		activeUserTurnId: null,
		activeInterruptReason: null,
		synthesisToolLock: false,
		toolProseAbortReason: null,
		streamStallReason: null,
		toolProseAssessedChars: 0,
		turnToolCalls: 0,
		stalledTurnNudgeSpent: false,
		pendingRequestContinuation: false,
		currentPendingSkillPolicy: undefined,
		currentAskUserPolicy: undefined,
		lastRunSnapshot: null,
	};
}
