/**
 * Shared state for one chat loop instance, and who may touch which part.
 *
 * `createChatLoop` composes single-owner turn modules (runtime, context,
 * persistence, queues, recovery, middleware, prewarm). They coordinate
 * through this one heap object instead of closure captures, so each concern
 * can live in its own file while the loop keeps exactly one copy of every
 * turn fact.
 *
 * Ownership:
 * - `chat-loop.ts` is the composer and the only module that holds the whole
 *   `ChatTurnState`; it opens and settles turns and resets per-turn fields.
 * - Every other module receives its own view declared below
 *   (`TurnRuntimeState`, `TurnMiddlewareState`, ...). A view names only the
 *   fields the module touches; the ones it only reads are `readonly`, so a
 *   new write is a type error until the view here says the module owns it.
 * - Continuation state (the middleware continuation request, its in-run
 *   carry, the per-prompt nudge cap, the yolo continuation count and the
 *   recorded turn stop) lives in `ContinuationState`. Its fields are private;
 *   modules change it only through its methods, and `continuation` itself is
 *   readonly, so the owner is never replaced.
 * - `rule16` in `tests/boundaries/check-boundaries.ts` holds both halves: no
 *   module but these two names `ChatTurnState`, and nothing outside this file
 *   assigns a continuation field.
 */

import type { ClioSettings } from "../core/config.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type {
	AuthResolution,
	ResolvedRuntimeTarget,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import type { createEngineAgent } from "../engine/agent.js";
import type { MainRequestRecord } from "../engine/in-prefix-summary.js";
import type { AgentMessage } from "../engine/types.js";
import type { AskUserToolPolicy } from "../tools/registry.js";
import type { ModelRequestFacts } from "./status-types.js";

export interface ChatLoopTarget {
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	runtimeResolution: ResolvedRuntimeTarget;
}

export interface AgentRuntime {
	lastAuthResolution?: AuthResolution;
	lastProviderStatus?: number;
	agent: ReturnType<typeof createEngineAgent>["agent"];
	targetId: string;
	runtimeId: string;
	wireModelId: string;
	runtimeResolution: ResolvedRuntimeTarget;
}

export interface ChatLoopRunSnapshot {
	/** Deterministic request refusal, retained for the main-agent receipt. */
	outcomeCode?: "information_flow_blocked";
	targetId: string;
	targetUrl: string | null;
	runtimeId: string;
	runtimeKind: RuntimeDescriptor["kind"];
	wireModelId: string;
	autonomy: ClioSettings["safety"]["autonomy"];
	pricedBy?: ResolvedRuntimeTarget["pricedBy"];
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
/** The awaited steps of a turn's preparation that can take real time. */
export type TurnPreparationStep = "capabilities" | "prompt-hook" | "images" | "turn-control" | "turn-start" | "compile";

/** A local request stage must stay distinct from an invoked stream stall (#424). */
export type PreInvocationStage = "transform" | "auth" | "budget admission" | "admission";

export type TurnStop =
	| {
			cause: "retries_exhausted" | "compaction";
			reason: string;
			retryAfterMs?: number;
	  }
	| {
			/** The provider asked for longer than Clio waits on one request, so nothing may go back to it before then. */
			cause: "wait_past_budget";
			reason: string;
			retryAfterMs: number;
	  };

/**
 * The single owner of whether, and how, a turn goes on past its own end.
 *
 * Two producers feed it: a middleware `request_continuation` (the stalled-turn
 * nudge, one per operator prompt) and a stop recorded by recovery that a yolo
 * continuation may get past (#445). Middleware, runtime, recovery, queues and
 * the loop each call the one method for their step; every field is private,
 * so no module can set a flag another module consumes behind the owner's back.
 */
export class ContinuationState {
	/** A middleware request_continuation is waiting to resubmit after settle. */
	#requested = false;
	/** That request moved into the run still out, delivered by the runtime's prepareNextTurn. */
	#inRun = false;
	/** One stalled-turn nudge per user prompt; reset when a real prompt arrives. */
	#nudgeSpent = false;
	/** Continuations spent since the operator's last prompt (#445). */
	#yoloContinuations = 0;
	/** A way this turn ended that nobody asked for and another turn could get past (#445). */
	#stop: TurnStop | null = null;

	get requested(): boolean {
		return this.#requested;
	}

	get nudgeSpent(): boolean {
		return this.#nudgeSpent;
	}

	get yoloContinuations(): number {
		return this.#yoloContinuations;
	}

	get stop(): TurnStop | null {
		return this.#stop;
	}

	/** Prompt acceptance: a fresh operator prompt resets the caps its own continuations do not. */
	beginPrompt(kind: { requestContinuation: boolean; yoloContinuation: boolean }): void {
		this.#inRun = false;
		this.#stop = null;
		if (!kind.yoloContinuation) this.#yoloContinuations = 0;
		if (!kind.requestContinuation) this.#nudgeSpent = false;
	}

	/** Middleware asks for one more request. False when this prompt's one nudge is already spent. */
	request(): boolean {
		if (this.#nudgeSpent) return false;
		this.#nudgeSpent = true;
		this.#requested = true;
		return true;
	}

	/** The run is still out, so it carries the waiting request itself instead of a post-settle resubmit. */
	carryIntoRun(): void {
		if (!this.#requested) return;
		this.#requested = false;
		this.#inRun = true;
	}

	/** The runtime delivers the carried request; true exactly once per carry. */
	takeInRun(): boolean {
		if (!this.#inRun) return false;
		this.#inRun = false;
		return true;
	}

	/** A new run starts; nothing carried from an earlier one survives into it. */
	clearInRun(): void {
		this.#inRun = false;
	}

	/** The post-settle resubmit takes the waiting request; true exactly once per request. */
	takeRequest(): boolean {
		if (!this.#requested) return false;
		this.#requested = false;
		return true;
	}

	/** A stranded operator message goes out as the next prompt and supersedes the waiting request. */
	dropRequest(): void {
		this.#requested = false;
	}

	/** Recovery records why the turn stopped; the settle reads it to decide a yolo continuation. */
	recordStop(stop: TurnStop): void {
		this.#stop = stop;
	}

	/** Count one capped yolo continuation and return its attempt number. */
	countYoloContinuation(): number {
		this.#yoloContinuations += 1;
		return this.#yoloContinuations;
	}
}

export interface ChatTurnState {
	/** Live agent runtime; built or hot-swapped by turn-runtime. */
	runtime: AgentRuntime | null;
	/** The newest main-turn request and the runtime that sent it; compaction summarizes inside its cached prefix (T4). */
	lastMainRequest?: { runtime: AgentRuntime; record: MainRequestRecord };
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
	/** The step inside the window worth naming if it takes time, with when it began. Null outside the window. */
	turnPreparationStage: { step: TurnPreparationStep; since: number } | null;
	/** Provider context rebuilt on session switch, consumed by the next runtime build. */
	replayedContextMessages: AgentMessage[];
	/** The user turn id of the in-flight submit; null between turns. */
	activeUserTurnId: string | null;
	/**
	 * Set by an operator or explained interrupt. A nonempty aborted assistant
	 * carries this reason; hollow abort messages are suppressed and replaced
	 * by one durable closing turn after in-flight tool results have landed.
	 * Cleared at settlement and defensively at the start of each submit.
	 */
	activeInterruptReason: string | null;
	/**
	 * Whether the operator asked for the interrupt, as opposed to the loop
	 * guard. Read only while `activeInterruptReason` is set; cancel writes both.
	 */
	activeInterruptByOperator: boolean;
	/** The provider's nonempty aborted message closes this interrupt without a synthetic second assistant. */
	interruptedAssistantMessage: AgentMessage | null;
	/** Accounting for the hollow call carried by the interrupt's closing turn (#430). */
	interruptedCall: { message: AgentMessage; timing: { ttftMs: number | null; apiMs: number } | null } | null;
	/**
	 * Loop-guard synthesis lockout: once the guard locks a turn, the remaining
	 * model rounds are forced text-only at the request level (tool_choice none
	 * from the text-only round in transcriptStreamFn). Cleared when the next user turn starts.
	 */
	synthesisToolLock: boolean;
	/**
	 * The loop guard's soft per-turn tool budget was crossed: every further
	 * call this turn is blocked, so turn_end reminders must not ask for one.
	 * Cleared with `synthesisToolLock`.
	 */
	toolBudgetLock: boolean;
	/** The operator turn that already spent its one re-prompt for a tool call the model only wrote out. */
	toolMarkupRepromptTurnId: string | null;
	/** Continuation requests, carries and stops; written only through its methods. */
	readonly continuation: ContinuationState;
	/** Reason a streaming tool-prose cutoff (or hard-block reminder) aborted the run. */
	toolProseAbortReason: string | null;
	/** Reason the stall watchdog aborted a silent stream. Set just before `agent.abort()` and consumed by `reclassifyStallAbort` once the run settles, which is what separates a watchdog abort from an operator Esc. */
	streamStallReason: string | null;
	/** A route pick the waiting request is moving to. Pinned at the pick, so a later pick changes the next turn only. */
	routeMove: ChatLoopTarget | null;
	/** True only while a run the recovery ladder settles is out, because nothing else would send the moved request. */
	routeMoveSeat: boolean;
	/** The newest model request of this session, read by the status surfaces as evidence during a silent wait. */
	modelRequest: ModelRequestFacts | null;
	/** Refreshes the live parts of `modelRequest` for a surface about to read it; throttled by its owner. */
	refreshModelRequest: (() => void) | null;
	/** Local stage held at a watchdog abort; null once invoked or after recovery (#424). */
	streamStallStage: PreInvocationStage | null;
	/** Answer length at the last tool-prose scan, so the scan samples instead of running per delta. */
	toolProseAssessedChars: number;
	/** Tool calls observed in the current turn; feeds turn_end metadata. */
	turnToolCalls: number;
	/** Names of those calls, in order, so turn_end can tell a listing-only turn from a working one. */
	turnToolNames: string[];
	/** A `[worker result]` note the operator shared entered this turn, as the prompt or as a steer; feeds turn_end metadata. */
	turnSharedWorkerNote: boolean;
	currentPendingSkillPolicy: PendingSkillToolPolicy | undefined;
	currentTurnConstraints: TurnConstraints | undefined;
	/**
	 * Tool surface an activated skill narrowed, held across the operator's
	 * later turns. Replaced when the operator activates a different skill,
	 * cleared by `/skill off`, gone with the session.
	 */
	activeSkillSurface: PendingSkillToolPolicy | undefined;
	currentAskUserPolicy: AskUserToolPolicy | undefined;
	lastRunSnapshot: ChatLoopRunSnapshot | null;
}

/**
 * A module's slice of the turn state: what it only reads comes through
 * `Readonly`, what it writes stays mutable, and nothing else is visible.
 */
type TurnStateView<Reads extends keyof ChatTurnState, Writes extends keyof ChatTurnState = never> = Readonly<
	Pick<ChatTurnState, Exclude<Reads, Writes>>
> &
	Pick<ChatTurnState, Writes>;

/** turn-runtime: builds or swaps the runtime, runs the stream, and owns its watchdog and tool-prose scan. */
export type TurnRuntimeState = TurnStateView<
	| "activeInterruptByOperator"
	| "activeInterruptReason"
	| "activeUserTurnId"
	| "continuation"
	| "lastRunSnapshot"
	| "replayedContextMessages"
	| "routeMove"
	| "streaming"
	| "synthesisToolLock"
	| "toolBudgetLock",
	| "modelRequest"
	| "refreshModelRequest"
	| "runtime"
	| "streamStallReason"
	| "streamStallStage"
	| "toolMarkupRepromptTurnId"
	| "toolProseAbortReason"
	| "toolProseAssessedChars"
	| "turnToolCalls"
	| "turnToolNames"
>;

/** turn-middleware: reads the turn's facts for its hooks; a hard block sets the tool-prose abort reason. */
export type TurnMiddlewareState = TurnStateView<
	| "activeInterruptReason"
	| "activeUserTurnId"
	| "continuation"
	| "currentTurnConstraints"
	| "lastTurnId"
	| "synthesisToolLock"
	| "toolBudgetLock"
	| "turnSharedWorkerNote"
	| "turnToolCalls"
	| "turnToolNames",
	"toolProseAbortReason"
>;

/** turn-context: reads the turn for compaction and memory; owns the replayed provider context. */
export type TurnContextState = TurnStateView<
	| "activeSkillSurface"
	| "activeUserTurnId"
	| "currentPendingSkillPolicy"
	| "lastMainRequest"
	| "lastTurnId"
	| "runtime"
	| "streaming",
	"replayedContextMessages"
>;

/** turn-persistence: owns the ledger cursor, the filed user turn and the interrupt's closing records. */
export type TurnPersistenceState = TurnStateView<
	"activeInterruptReason" | "runtime",
	| "activeUserTurnId"
	| "interruptedAssistantMessage"
	| "interruptedCall"
	| "lastTurnId"
	| "synthesisToolLock"
	| "toolBudgetLock"
>;

/** turn-recovery: owns the route move and consumes the stall watchdog's reason. */
export type TurnRecoveryState = TurnStateView<
	"activeInterruptReason" | "continuation",
	"routeMove" | "routeMoveSeat" | "streamStallReason" | "streamStallStage"
>;

/** The stall reclassification seam: consumes the watchdog's reason. */
export type StallAbortState = TurnStateView<"activeInterruptReason", "streamStallReason" | "streamStallStage">;

/** The stall rewrite seam: reads the watchdog's reason without consuming it. */
export type StallAbortReadState = TurnStateView<"activeInterruptReason" | "streamStallReason" | "streamStallStage">;

/** turn-queues: reads whether a run is out and steers its runtime; continuation only through the owner. */
export type TurnQueuesState = TurnStateView<"continuation" | "runtime" | "streaming">;

/** turn-prewarm: stays out of a live turn and parents its ledger row under the cursor. */
export type TurnPrewarmState = TurnStateView<"lastTurnId" | "streaming">;

/**
 * The thinking level argument is ignored: the agent state owns the level and
 * turn state keeps no copy. The parameter stays optional because existing test
 * call sites still pass one, and removing it from them is test work.
 */
export function createTurnState(_initialThinkingLevel?: ThinkingLevel): ChatTurnState {
	return {
		runtime: null,
		lastTurnId: null,
		streaming: false,
		turnPreparation: "idle",
		turnPreparationSince: 0,
		turnPreparationStage: null,
		replayedContextMessages: [],
		activeUserTurnId: null,
		activeInterruptReason: null,
		activeInterruptByOperator: false,
		interruptedAssistantMessage: null,
		interruptedCall: null,
		synthesisToolLock: false,
		toolBudgetLock: false,
		toolMarkupRepromptTurnId: null,
		continuation: new ContinuationState(),
		toolProseAbortReason: null,
		streamStallReason: null,
		routeMove: null,
		routeMoveSeat: false,
		modelRequest: null,
		refreshModelRequest: null,
		streamStallStage: null,
		toolProseAssessedChars: 0,
		turnToolCalls: 0,
		turnToolNames: [],
		turnSharedWorkerNote: false,
		currentPendingSkillPolicy: undefined,
		currentTurnConstraints: undefined,
		activeSkillSurface: undefined,
		currentAskUserPolicy: undefined,
		lastRunSnapshot: null,
	};
}

/** Consume callback-written accounting after the provider settles, outside submit's narrowing (#430). */
export function takeInterruptedCall(state: TurnStateView<never, "interruptedCall">): ChatTurnState["interruptedCall"] {
	const interrupted = state.interruptedCall;
	state.interruptedCall = null;
	return interrupted;
}
