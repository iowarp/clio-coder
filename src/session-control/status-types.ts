import type { ModelAdmissionFacts } from "../core/model-admission.js";
import type { ResponseModelIdObservation } from "../core/response-model-id.js";
import type { StatusPhase, WatchdogTier } from "../core/telemetry/live-events.js";
import type { RetryWaitCause } from "../domains/session/retry.js";

// StatusPhase, WatchdogTier, and AgentStatusChangedPayload moved to
// src/core/telemetry/live-events.ts (the phase taxonomy rides the agent.status_changed
// bus channel into the safety domain); re-exported here so interactive code
// keeps one import site.
export type { AgentStatusChangedPayload, StatusPhase, WatchdogTier } from "../core/telemetry/live-events.js";

/**
 * Other Clio work on the request's endpoint, which is all Clio can see of that endpoint's queue: other clients and the
 * server's own scheduler stay out of view.
 */
export interface ModelRequestSlots {
	/** Slots the endpoint is known to have, or null when nothing says. The blind one-slot default is not knowledge. */
	limit: number | null;
	workers: number;
	reservations: number;
	/** Other requests this process has out on the endpoint: a side question or background memory. */
	otherRequests: number;
}

/** What is known about the outstanding model request, measured at the handoff to the provider. */
export interface ModelRequestFacts extends ModelAdmissionFacts {
	sentAt: number;
	/** The model this request went to, which a route change made while it is out does not alter. */
	modelId?: string | undefined;
	/** Null until the provider opened a response. */
	firstByteAt: number | null;
	/** False on a transport that never reports a response, where "no bytes yet" would claim more than is known. */
	bytesObservable: boolean;
	/** Present while other Clio work shares the endpoint and no response has opened. */
	slots?: ModelRequestSlots | null | undefined;
}

export type { RetryWaitCause } from "../domains/session/retry.js";

export type ActiveStatusPhase = Exclude<StatusPhase, "idle" | "ended">;
export type OverlayPhase = "tool_blocked" | "retrying" | "compacting" | "dispatching" | "stuck";
export type TurnStopReason =
	| "stop"
	| "length"
	| "toolUse"
	| "error"
	| "aborted"
	| "cancelled"
	| "generation_guard"
	| "no_answer";
export type ReasoningTokenProvenance = "provider" | "estimated" | "mixed";

export interface RetryOverlay {
	attempt: number;
	maxAttempts: number;
	waitMs: number;
	/** `backoff` waits for the next attempt to be sent; `attempt` is that request, outstanding. */
	stage?: "backoff" | "attempt" | undefined;
	/** Epoch ms the next attempt is due. Present during a backoff with a known delay. */
	dueAt?: number | undefined;
	/** Epoch ms the current attempt was sent. */
	attemptStartedAt?: number | undefined;
	/** The wait the provider itself named, when it named one. */
	retryAfterMs?: number | undefined;
	/** What the target's refusal said it is waiting on; absent when it named nothing the rail can claim. */
	cause?: RetryWaitCause | undefined;
	/** Epoch ms this cause first answered, which stays put across the attempts it keeps answering. */
	causeSince?: number | undefined;
	/** Of `attempt`, how many sat out a provider's wait and so spent no retry. */
	providerWaits?: number | undefined;
	/** This attempt is one of those, so `maxAttempts` says nothing about it. */
	onProviderWait?: boolean | undefined;
}

export interface ToolOverlay {
	toolCallId?: string;
	startedAt?: number;
	toolName: string;
	toolPreview: string;
	/** What the call acts on, in the operator's terms: its command, path or search. */
	toolSubject?: string | undefined;
	/** The operator started this process directly; no model asked for it. */
	operatorShell?: boolean | undefined;
}

export interface DispatchOverlay {
	agentName: string;
}

export interface TurnSummary {
	elapsedMs: number;
	modelId: string;
	/** Direct response model-id observation for the last API call in the turn. */
	responseModelIdObservation: ResponseModelIdObservation;
	targetId: string;
	toolCount: number;
	toolErrorCount: number;
	stopReason: TurnStopReason;
	/**
	 * Human-readable cancel/abort provenance, e.g. "dispatch drain" vs
	 * "stream cancel: user cancelled stream". Present only when the run ended
	 * through run.aborted or a forced cancel; distinguishes abort sources that
	 * share stopReason "cancelled".
	 */
	stopDetail?: string | undefined;
	watchdogPeak: WatchdogTier;
	truncated: boolean;
	/** Of `elapsedMs`, what the turn spent waiting on the operator rather than working. */
	humanWaitMs?: number | undefined;
	/** What kind of failure a `stopReason: "error"` turn hit, when the failed call recorded one. */
	failure?: TurnFailureFacts | undefined;
}

/** The class of a failed provider call, enough for the status rail to give the same way out as the transcript. */
export interface TurnFailureFacts {
	targetId: string;
	stage?: string;
	errorClass?: string;
	partialReply?: boolean;
}

/**
 * The run's messages folded in as they settle, so a run that never reaches
 * `agent_end` can still report its tool calls.
 *
 * The engine replaces an aborted run's message window with one synthetic
 * zero-usage failure message, and the cancel path built its summary from
 * nothing at all. A cancelled turn therefore reported no tool calls even when
 * it ran several. Its spend is the read model's, never this tally's.
 */
export interface RunTally {
	/** Assistant and tool-result messages folded, which says whether this tally saw more of the run than a rebuild. */
	settledMessages: number;
	toolCount: number;
	toolErrorCount: number;
	/** Direct response model-id observation for the last assistant call folded. */
	responseModelIdObservation: ResponseModelIdObservation;
	/** The class of the last assistant call folded, when that call failed. */
	failure?: TurnFailureFacts | undefined;
}

export interface OverlayFrame {
	phase: OverlayPhase;
	resumePhase: StatusPhase;
	retry?: RetryOverlay | undefined;
	tool?: ToolOverlay | undefined;
	dispatch?: DispatchOverlay | undefined;
}

export interface AgentStatus {
	phase: StatusPhase;
	since: number;
	lastMeaningfulAt: number;
	watchdogTier: WatchdogTier;
	watchdogPeak: WatchdogTier;
	localRuntime: boolean;
	/** The model is streaming tool arguments; execution has not started. */
	preparingToolCall?: boolean;
	/** Tool-call markup is open in the answer channel, so nothing is being prepared and nothing will run from it. */
	writingCallAsText?: boolean | undefined;
	/** Epoch ms this model round started waiting, which the rail times instead of the whole turn. */
	waitingSince?: number | undefined;
	/** Evidence about the outstanding request, carried while a model wait is on screen. */
	modelRequest?: ModelRequestFacts | null | undefined;
	/** Epoch ms a stop was requested. The phase holds until the work is observed to have stopped. */
	cancelRequestedAt?: number | undefined;
	runId?: string | null | undefined;
	resumePhase?: StatusPhase | undefined;
	activePhases?: ReadonlySet<OverlayPhase> | undefined;
	overlayStack?: OverlayFrame[] | undefined;
	tool?: ToolOverlay | undefined;
	/**
	 * Wall-clock start of the tool call the `tool_running` phase is showing, so
	 * the footer's `running tool · Ns` reads the call's OWN elapsed rather than
	 * time-since-turn-start. Set on `tool_execution_start`, cleared when the
	 * phase leaves `tool_running`.
	 */
	toolStartedAt?: number | undefined;
	activeTools?: readonly ToolOverlay[];
	retry?: RetryOverlay | undefined;
	dispatch?: DispatchOverlay | undefined;
	/**
	 * Set while the `preparing` phase belongs to a consumed prompt that has not
	 * yet been admitted, rather than to a run the engine has started. It is what
	 * lets `agent_start` take over a window this opened instead of treating an
	 * already-active phase as a duplicate start (issue #251).
	 */
	preparingSubmission?: boolean | undefined;
	summary?: TurnSummary | undefined;
	/** Usage settled so far in the active run. Reset by `agent_start`. */
	runTally?: RunTally | undefined;
	/** Epoch ms Clio asked the model again because it only wrote out a tool call; cleared when that reply settles. */
	toolMarkupRepromptSince?: number | undefined;
	/** Closed spans this turn spent on an operator-owned wait: an open approval card or interview. */
	humanWaitMs?: number | undefined;
	/** Epoch ms the operator-owned wait now open began. */
	humanWaitSince?: number | undefined;
}

export interface AgentStatusEvent {
	type: "agent_status";
	status: AgentStatus;
}

export const INITIAL_STATUS: AgentStatus = {
	phase: "idle",
	since: 0,
	lastMeaningfulAt: 0,
	watchdogTier: 0,
	watchdogPeak: 0,
	localRuntime: false,
};
