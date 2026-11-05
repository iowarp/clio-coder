import type { RunAbortSource, TurnAbortSource } from "../../core/telemetry/live-events.js";
import { ToolNames } from "../../core/tool-names.js";
import type { AgentMessage } from "../../engine/types.js";
import type { ChatLoopEvent, RetryStatusPhase } from "../../session-control/chat-loop.js";
import {
	type AgentStatus,
	INITIAL_STATUS,
	type ModelRequestFacts,
	type OverlayFrame,
	type OverlayPhase,
	type RetryOverlay,
	type StatusPhase,
	type ToolOverlay,
	type TurnStopReason,
	type TurnSummary,
} from "../../session-control/status-types.js";
import { effectiveToolCall } from "../../tools/surface.js";
import { buildSummary, emptyRunTally, foldMessageIntoRunTally, summaryFromRunTally } from "./summary.js";
import { computeWatchdogTier } from "./watchdog.js";

export interface ReduceContext {
	now: number;
	localRuntime: boolean;
	modelId?: string;
	targetId?: string;
	runId?: string | null;
	modelRequest?: ModelRequestFacts | null;
}

export interface WatchdogTickEvent {
	type: "watchdog_tick";
}

export interface OverlayPushEvent {
	type: "overlay_push";
	overlay: Exclude<OverlayPhase, "stuck" | "retrying">;
	data?: unknown;
}

export interface OverlayPopEvent {
	type: "overlay_pop";
	overlay: Exclude<OverlayPhase, "stuck" | "retrying">;
}

export interface RunAbortedStatusEvent {
	type: "run_aborted";
	source?: RunAbortSource | TurnAbortSource;
	reason?: string;
}

export interface ForceCancelledStatusEvent {
	type: "force_cancelled";
	reason: string;
}

/** Worker stream evidence for a dispatch this turn is awaiting. */
export interface DispatchProgressStatusEvent {
	type: "dispatch_progress";
}

/**
 * A prompt has left the editor and Clio is preparing the turn: capability
 * probe, pre-submit compaction, prompt compile, overflow preflight. None of
 * that produces an engine event, so without this the footer kept reporting the
 * previous turn as done for the whole window (issue #251).
 */
export interface SubmitAcceptedStatusEvent {
	type: "submit_accepted";
}

/** The prepared turn was admitted, refused, or failed. Either way the window is over. */
export interface SubmitSettledStatusEvent {
	type: "submit_settled";
}

/** The cancelled submit has returned, so nothing of the turn is still running. */
export interface CancelSettledStatusEvent {
	type: "cancel_settled";
}

export type StatusInputEvent =
	| ChatLoopEvent
	| WatchdogTickEvent
	| OverlayPushEvent
	| OverlayPopEvent
	| RunAbortedStatusEvent
	| ForceCancelledStatusEvent
	| DispatchProgressStatusEvent
	| SubmitAcceptedStatusEvent
	| SubmitSettledStatusEvent
	| CancelSettledStatusEvent;

const OVERLAY_PHASES = new Set<StatusPhase>(["tool_blocked", "retrying", "compacting", "dispatching", "stuck"]);
const CORE_ACTIVE_PHASES = new Set<StatusPhase>(["preparing", "waiting_model", "thinking", "writing", "tool_running"]);
const OVERLAY_PRECEDENCE: readonly OverlayPhase[] = ["stuck", "tool_blocked", "retrying", "compacting", "dispatching"];

function isOverlayPhase(phase: StatusPhase): phase is OverlayPhase {
	return OVERLAY_PHASES.has(phase);
}

function isActive(phase: StatusPhase): phase is Exclude<StatusPhase, "idle" | "ended"> {
	return phase !== "idle" && phase !== "ended";
}

function targetModel(ctx: ReduceContext): { modelId: string; targetId: string } {
	return { modelId: ctx.modelId ?? "", targetId: ctx.targetId ?? "" };
}

function peak(prev: AgentStatus, tier: AgentStatus["watchdogTier"]): AgentStatus["watchdogPeak"] {
	return tier > prev.watchdogPeak ? tier : prev.watchdogPeak;
}

function refreshMeaningful(prev: AgentStatus, ctx: ReduceContext): AgentStatus {
	return {
		...prev,
		lastMeaningfulAt: ctx.now,
		watchdogTier: 0,
		localRuntime: ctx.localRuntime,
		...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
	};
}

function compactPreview(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value.slice(0, 60);
	try {
		return JSON.stringify(value).slice(0, 60);
	} catch {
		return String(value).slice(0, 60);
	}
}

/** The one argument that says what a call is doing, flattened for a single rail row. */
function toolSubject(args: unknown): string | undefined {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	for (const key of ["command", "path", "file_path", "pattern", "query", "url", "symbol", "name"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.replace(/\s+/gu, " ").trim();
	}
	return undefined;
}

function overlayFrame(status: AgentStatus): OverlayFrame {
	return {
		phase: status.phase as OverlayPhase,
		resumePhase: status.resumePhase ?? "preparing",
		retry: status.retry,
		tool: status.tool,
		dispatch: status.dispatch,
	};
}

function overlayFrames(prev: AgentStatus): Map<OverlayPhase, OverlayFrame> {
	const frames = new Map<OverlayPhase, OverlayFrame>();
	for (const frame of prev.overlayStack ?? []) frames.set(frame.phase, frame);
	if (isOverlayPhase(prev.phase)) frames.set(prev.phase, overlayFrame(prev));
	for (const phase of prev.activePhases ?? []) {
		if (!frames.has(phase)) frames.set(phase, { phase, resumePhase: baseResumePhase(prev) });
	}
	return frames;
}

function baseResumePhase(prev: AgentStatus): StatusPhase {
	if (isOverlayPhase(prev.phase)) return prev.resumePhase ?? "preparing";
	return prev.phase;
}

function visibleOverlay(frames: ReadonlyMap<OverlayPhase, OverlayFrame>): OverlayFrame | undefined {
	for (const phase of OVERLAY_PRECEDENCE) {
		const frame = frames.get(phase);
		if (frame) return frame;
	}
	return undefined;
}

function overlayStackWithoutVisible(
	frames: ReadonlyMap<OverlayPhase, OverlayFrame>,
	visible: OverlayFrame,
): OverlayFrame[] {
	return OVERLAY_PRECEDENCE.flatMap((phase) => {
		if (phase === visible.phase) return [];
		const frame = frames.get(phase);
		return frame ? [frame] : [];
	});
}

function statusForVisibleOverlay(
	prev: AgentStatus,
	visible: OverlayFrame,
	frames: ReadonlyMap<OverlayPhase, OverlayFrame>,
): AgentStatus {
	const base = visible.resumePhase;
	return {
		...prev,
		phase: visible.phase,
		resumePhase: base,
		retry: visible.retry,
		tool: visible.tool,
		dispatch: visible.dispatch,
		activePhases: new Set(frames.keys()),
		overlayStack: overlayStackWithoutVisible(frames, visible),
	};
}

function pushOverlay(prev: AgentStatus, phase: OverlayPhase, ctx: ReduceContext, data?: unknown): AgentStatus {
	if (!isActive(prev.phase)) return prev;
	const frames = overlayFrames(prev);
	const resumePhase = baseResumePhase(prev);
	const nextFrame = overlayFrame(
		overlayData(
			{
				...prev,
				phase,
				resumePhase,
			},
			phase,
			data,
		),
	);
	frames.set(phase, nextFrame);
	const nextVisible = visibleOverlay(frames);
	if (!nextVisible) return refreshMeaningful(prev, ctx);
	return statusForVisibleOverlay(refreshMeaningful(prev, ctx), nextVisible, frames);
}

function overlayData(status: AgentStatus, phase: OverlayPhase, data?: unknown): AgentStatus {
	if (phase === "retrying") {
		const retry = data as RetryOverlay | undefined;
		return { ...status, retry };
	}
	if (phase === "dispatching") {
		const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		const agentName =
			typeof obj.agentName === "string"
				? obj.agentName
				: typeof obj.agentId === "string"
					? obj.agentId
					: typeof obj.runId === "string"
						? obj.runId
						: "";
		return { ...status, dispatch: { agentName } };
	}
	return status;
}

function popOverlay(prev: AgentStatus, overlay: OverlayPhase, ctx: ReduceContext): AgentStatus {
	const frames = overlayFrames(prev);
	const restore = baseResumePhase(prev);
	frames.delete(overlay);
	const nextVisible = visibleOverlay(frames);
	if (nextVisible) return statusForVisibleOverlay(refreshMeaningful(prev, ctx), nextVisible, frames);
	return {
		...refreshMeaningful(prev, ctx),
		phase: restore,
		resumePhase: undefined,
		activePhases: undefined,
		overlayStack: [],
		retry: undefined,
		dispatch: undefined,
	};
}

function activePhaseAfterStuck(prev: AgentStatus): StatusPhase {
	if (prev.phase !== "stuck") return prev.phase;
	return prev.resumePhase ?? "thinking";
}

function isAwaitingDispatch(prev: AgentStatus): boolean {
	if (activePhaseAfterStuck(prev) === "tool_running" && prev.tool?.toolName === ToolNames.Dispatch) return true;
	if (prev.phase === "dispatching") return true;
	if (prev.activePhases?.has("dispatching")) return true;
	return (prev.overlayStack ?? []).some((frame) => frame.phase === "dispatching");
}

/**
 * The next step belongs to a person: an approval card or an interview is open. Silence here is not evidence about the
 * agent, so it never reaches the watchdog, and the time it takes is the operator's rather than the turn's work.
 */
export function isWaitingForOperator(status: AgentStatus): boolean {
	if (!isActive(status.phase)) return false;
	if (status.phase === "tool_blocked" || status.activePhases?.has("tool_blocked")) return true;
	if ((status.overlayStack ?? []).some((frame) => frame.phase === "tool_blocked")) return true;
	return (
		status.tool?.toolName === ToolNames.AskUser ||
		(status.activeTools ?? []).some((tool) => tool.toolName === ToolNames.AskUser)
	);
}

/** What the turn has spent waiting on the operator, the wait still open included. */
export function humanWaitTotalMs(status: AgentStatus, now: number): number {
	const open = status.humanWaitSince !== undefined ? Math.max(0, now - status.humanWaitSince) : 0;
	return (status.humanWaitMs ?? 0) + open;
}

function withHumanWait(next: AgentStatus, now: number): AgentStatus {
	const waiting = isWaitingForOperator(next);
	let status = next;
	if (waiting && next.humanWaitSince === undefined) status = { ...next, humanWaitSince: now };
	else if (!waiting && next.humanWaitSince !== undefined) {
		status = { ...next, humanWaitMs: humanWaitTotalMs(next, now), humanWaitSince: undefined };
	}
	const waited = status.humanWaitMs ?? 0;
	return status.phase === "ended" && status.summary && status.summary.humanWaitMs !== waited && waited > 0
		? { ...status, summary: { ...status.summary, humanWaitMs: waited } }
		: status;
}

/** The messages a run tally folds: its assistant replies and tool results. */
function settledMessageCount(messages: ReadonlyArray<AgentMessage>): number {
	return messages.filter((message) => message.role === "assistant" || message.role === "toolResult").length;
}

function cancelledSummary(
	prev: AgentStatus,
	ctx: ReduceContext,
	stopReason: TurnStopReason,
	truncated = false,
	stopDetail?: string,
) {
	const start = prev.since > 0 ? prev.since : ctx.now;
	const model = targetModel(ctx);
	// The engine hands the cancel path a message window it has already replaced
	// with one synthetic zero-usage failure message, so a summary rebuilt from
	// it reports nothing. The live tally is what this run actually settled.
	return summaryFromRunTally(prev.runTally ?? emptyRunTally(), {
		startedAt: start,
		endedAt: ctx.now,
		modelId: model.modelId,
		targetId: model.targetId,
		watchdogPeak: prev.watchdogPeak,
		stopReason,
		truncated,
		...(stopDetail !== undefined ? { stopDetail } : {}),
	});
}

/** The provisional cancel summary, closed at the moment the stop was observed. */
function finalizedCancel(prev: AgentStatus, ctx: ReduceContext): TurnSummary | undefined {
	const start = prev.since > 0 ? prev.since : ctx.now;
	return prev.summary && { ...prev.summary, elapsedMs: Math.max(0, ctx.now - start) };
}

const ABORT_SOURCE_LABELS: Record<RunAbortSource | TurnAbortSource, string> = {
	dispatch_abort: "dispatch abort",
	dispatch_drain: "dispatch drain",
	stream_cancel: "stream cancel",
	loop_guard: "loop guard",
	job_clock: "job clock",
};

function runAbortDetail(event: RunAbortedStatusEvent): string | undefined {
	const label = event.source !== undefined ? ABORT_SOURCE_LABELS[event.source] : undefined;
	if (label !== undefined && event.reason !== undefined) return `${label}: ${event.reason}`;
	return event.reason ?? label;
}

function retryOverlay(
	status: {
		phase: RetryStatusPhase;
		attempt: number;
		maxAttempts: number;
		delayMs?: number;
		retryAfterMs?: number;
	},
	previous: RetryOverlay | undefined,
	now: number,
): RetryOverlay {
	const backoff = status.phase !== "retrying";
	const delayMs = status.delayMs ?? 0;
	// Every countdown tick repeats its `scheduled` payload, so the deadline holds from the first one.
	const sameWait = previous?.stage === "backoff" && previous.attempt === status.attempt && previous.dueAt !== undefined;
	return {
		attempt: status.attempt,
		maxAttempts: status.maxAttempts,
		waitMs: delayMs,
		stage: backoff ? "backoff" : "attempt",
		...(backoff && delayMs > 0 ? { dueAt: sameWait ? previous?.dueAt : now + delayMs } : {}),
		...(backoff ? {} : { attemptStartedAt: now }),
		...(status.retryAfterMs !== undefined ? { retryAfterMs: status.retryAfterMs } : {}),
	};
}

/**
 * Output from the attempt answers the retry, so the rail goes back to saying what the model is doing. A later failure
 * of the same attempt opens the overlay again.
 */
function leaveRetryOnOutput(prev: AgentStatus, ctx: ReduceContext): AgentStatus {
	return prev.phase === "retrying" && prev.retry?.stage === "attempt" ? popOverlay(prev, "retrying", ctx) : prev;
}

export function reduceStatus(prev: AgentStatus, event: StatusInputEvent, ctx: ReduceContext): AgentStatus {
	const next = reduceEvent(prev, event, ctx);
	if (next === prev) return prev;
	const waited = withHumanWait(next, ctx.now);
	const awaitingModel =
		waited.phase === "waiting_model" ||
		(waited.phase === "stuck" && waited.resumePhase === "waiting_model") ||
		(waited.phase === "retrying" && waited.retry?.stage === "attempt");
	return awaitingModel && ctx.modelRequest !== waited.modelRequest
		? { ...waited, modelRequest: ctx.modelRequest ?? undefined }
		: waited;
}

function reduceEvent(prev: AgentStatus, event: StatusInputEvent, ctx: ReduceContext): AgentStatus {
	switch (event.type) {
		// A consumed prompt occupies `preparing` before any engine event exists,
		// and the previous turn's summary rides along untouched: a refused
		// admission puts the footer back on the last turn that actually ran,
		// which is still the truth about what happened.
		case "submit_accepted":
			if (isActive(prev.phase)) return prev;
			return {
				...prev,
				phase: "preparing",
				since: ctx.now,
				lastMeaningfulAt: ctx.now,
				localRuntime: ctx.localRuntime,
				preparingSubmission: true,
				watchdogTier: 0,
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
				tool: undefined,
				toolStartedAt: undefined,
				retry: undefined,
				dispatch: undefined,
				humanWaitMs: undefined,
				humanWaitSince: undefined,
			};
		case "submit_settled":
			if (prev.preparingSubmission !== true) return prev;
			return {
				...prev,
				phase: prev.summary ? "ended" : "idle",
				since: ctx.now,
				preparingSubmission: undefined,
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		case "agent_start":
			// A window this opened is the same turn arriving, not a duplicate
			// start, so the run resets through it rather than being ignored.
			if (isActive(prev.phase) && prev.preparingSubmission !== true) return prev;
			return {
				...INITIAL_STATUS,
				phase: "preparing",
				since: ctx.now,
				lastMeaningfulAt: ctx.now,
				localRuntime: ctx.localRuntime,
				...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
			};
		case "turn_start": {
			const base = activePhaseAfterStuck(prev);
			const next = refreshMeaningful({ ...prev, phase: base }, ctx);
			if (base === "preparing") return { ...next, phase: "waiting_model", resumePhase: undefined, waitingSince: ctx.now };
			return next;
		}
		case "message_start":
			return refreshMeaningful(prev, ctx);
		case "message_update": {
			const streamed = event.assistantMessageEvent;
			const answered = streamed.type === "toolcall_start" || streamed.type === "toolcall_delta";
			const current = answered ? leaveRetryOnOutput(prev, ctx) : prev;
			const next = refreshMeaningful(current, ctx);
			const base = activePhaseAfterStuck(current);
			if (
				(streamed.type === "toolcall_start" || streamed.type === "toolcall_delta") &&
				CORE_ACTIVE_PHASES.has(base) &&
				base !== "tool_running"
			) {
				return { ...next, phase: "writing", preparingToolCall: true, resumePhase: undefined };
			}
			return next;
		}
		case "tool_execution_update":
			return refreshMeaningful(prev, ctx);
		case "message_end":
			// Fold every settled message as it lands. This is the only record of
			// the run's usage that survives a cancel.
			return {
				...refreshMeaningful(prev, ctx),
				runTally: foldMessageIntoRunTally(prev.runTally ?? emptyRunTally(), event.message),
			};
		case "tool_execution_end": {
			const activeTools = (prev.activeTools ?? []).filter((tool) => tool.toolCallId !== event.toolCallId);
			const next = { ...refreshMeaningful(prev, ctx), activeTools };
			const remaining = activeTools.at(-1);
			if (prev.phase === "cancelling") return { ...next, tool: remaining, toolStartedAt: remaining?.startedAt };
			if (remaining && prev.phase === "tool_running")
				return { ...next, tool: remaining, toolStartedAt: remaining.startedAt };
			if (prev.phase === "tool_running")
				return { ...next, phase: "preparing", tool: undefined, toolStartedAt: undefined, activeTools: [] };
			if (prev.phase === "stuck" && prev.resumePhase === "tool_running") {
				return {
					...next,
					phase: "preparing",
					resumePhase: undefined,
					tool: undefined,
					toolStartedAt: undefined,
					activeTools: [],
				};
			}
			// A blocked call's end can land while an overlay is still visible
			// (permission prompt not yet resolved, retry or dispatch in front).
			// Without scrubbing the stashed frames, the eventual overlay pop
			// restores phase tool_running with this already-finished call's
			// overlay, leaving a perpetual "running tool" display.
			if (isOverlayPhase(prev.phase)) {
				return {
					...next,
					resumePhase: prev.resumePhase === "tool_running" ? "preparing" : prev.resumePhase,
					tool: undefined,
					toolStartedAt: undefined,
					overlayStack: (prev.overlayStack ?? []).map((frame) => ({
						...frame,
						tool: undefined,
						resumePhase: frame.resumePhase === "tool_running" ? "preparing" : frame.resumePhase,
					})),
				};
			}
			return next;
		}
		case "thinking_delta": {
			const current = leaveRetryOnOutput(prev, ctx);
			const base = activePhaseAfterStuck(current);
			const next = refreshMeaningful({ ...current, phase: base, preparingToolCall: false }, ctx);
			// Model reasoning arriving while a tool still shows as running means the
			// tool is done (its end never landed or was an admission block): the
			// model is generating, nothing is executing, so drop the tool display.
			if (base === "preparing" || base === "waiting_model" || base === "writing" || base === "tool_running") {
				return {
					...next,
					phase: "thinking",
					resumePhase: undefined,
					tool: undefined,
					toolStartedAt: undefined,
					activeTools: [],
				};
			}
			if (CORE_ACTIVE_PHASES.has(base)) return { ...next, resumePhase: undefined };
			return next;
		}
		// A diffusion frame is answer text arriving, whole rather than sliced.
		case "text_frame":
		case "text_delta": {
			const current = leaveRetryOnOutput(prev, ctx);
			const base = activePhaseAfterStuck(current);
			const next = refreshMeaningful({ ...current, phase: base, preparingToolCall: false }, ctx);
			// Streamed answer text while a tool still shows as running: same as
			// above, the model is writing, so the running-tool spinner must clear.
			if (base === "preparing" || base === "waiting_model" || base === "thinking" || base === "tool_running") {
				return {
					...next,
					phase: "writing",
					resumePhase: undefined,
					tool: undefined,
					toolStartedAt: undefined,
					activeTools: [],
				};
			}
			if (CORE_ACTIVE_PHASES.has(base)) return { ...next, resumePhase: undefined };
			return next;
		}
		case "tool_execution_start": {
			// Name the capability, not the gateway wrapper: the operator-wait
			// watchdog exemption and the footer key on ask_user, bash and friends.
			const call = effectiveToolCall(event.toolName, event.args);
			const tool: ToolOverlay = {
				toolCallId: event.toolCallId,
				startedAt: ctx.now,
				toolName: call.toolName,
				toolPreview: compactPreview(call.viaGateway ? call.args : event.args),
				toolSubject: toolSubject(call.viaGateway ? call.args : event.args),
			};
			// Stamp this call's own start so the footer's running-tool timer counts
			// from here, not from turn start.
			return {
				...refreshMeaningful(leaveRetryOnOutput(prev, ctx), ctx),
				// A call already in the engine's hands can still start after the stop request; the turn stays cancelling.
				phase: prev.phase === "cancelling" ? "cancelling" : "tool_running",
				preparingToolCall: false,
				tool,
				toolStartedAt: ctx.now,
				activeTools: [...(prev.activeTools ?? []).filter((active) => active.toolCallId !== event.toolCallId), tool],
			};
		}
		case "retry_status": {
			const phase = event.status.phase;
			if (phase === "scheduled" || phase === "waiting" || phase === "retrying") {
				const previous = prev.phase === "retrying" ? prev.retry : undefined;
				// A wait announced after a settled run is the run's wait; `agent_start` takes the window over.
				const active = prev.phase === "ended" ? { ...prev, phase: "preparing" as const, preparingSubmission: true } : prev;
				return pushOverlay(active, "retrying", ctx, retryOverlay(event.status, previous, ctx.now));
			}
			if (phase === "recovered") return popOverlay(prev, "retrying", ctx);
			// The attempt's own settlement already said how the turn ended.
			if (!isActive(prev.phase)) return prev;
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary:
					prev.phase === "cancelling" && prev.summary
						? finalizedCancel(prev, ctx)
						: cancelledSummary(prev, ctx, phase === "cancelled" ? "cancelled" : "error"),
				retry: undefined,
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		}
		case "agent_end": {
			// A failed attempt recovery will retry closes that attempt, not the turn.
			if (event.retryPending !== undefined) {
				const { attempt, maxAttempts } = event.retryPending;
				return pushOverlay(prev, "retrying", ctx, { attempt, maxAttempts, waitMs: 0, stage: "backoff" });
			}
			const truncated = prev.phase === "idle";
			const start = prev.since > 0 ? prev.since : ctx.now;
			const model = targetModel(ctx);
			const rebuilt = buildSummary({
				startedAt: start,
				endedAt: ctx.now,
				modelId: model.modelId,
				targetId: model.targetId,
				messages: event.messages,
				watchdogPeak: prev.watchdogPeak,
				cancelled: false,
				truncated,
			});
			// On the abort path the engine has already replaced the run's window
			// with one synthetic zero-usage failure message, so this rebuild
			// reports nothing and would undo the summary run_aborted just wrote
			// from the live tally. The tally saw the run whenever it folded at
			// least as many messages as the window holds; on a normal turn the two
			// agree exactly, because both fold the same messages through the same
			// function.
			const tally = prev.runTally;
			const summary =
				tally && tally.settledMessages > 0 && tally.settledMessages >= settledMessageCount(event.messages)
					? summaryFromRunTally(tally, {
							startedAt: start,
							endedAt: ctx.now,
							modelId: model.modelId,
							targetId: model.targetId,
							watchdogPeak: prev.watchdogPeak,
							stopReason: rebuilt.stopReason,
							truncated,
							...(rebuilt.stopDetail !== undefined ? { stopDetail: rebuilt.stopDetail } : {}),
						})
					: rebuilt;
			// run_aborted may already have stamped this run's abort provenance
			// (loop guard, dispatch drain, user cancel). The rebuild from the
			// settled message window keeps that detail instead of dropping it.
			if (
				(prev.phase === "ended" || prev.phase === "cancelling") &&
				prev.summary?.stopDetail !== undefined &&
				summary.stopDetail === undefined
			) {
				summary.stopDetail = prev.summary.stopDetail;
			}
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary,
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		}
		case "dispatch_progress":
			// The orchestrator's own stream is silent for as long as a worker runs,
			// so the await-watchdog measured its own silence and reported "no
			// progress" about a worker that was streaming the whole time
			// (issue #54). Worker output is this turn's progress.
			if (!isActive(prev.phase) || !isAwaitingDispatch(prev)) return prev;
			return refreshMeaningful(prev, ctx);
		case "overlay_push":
			return pushOverlay(prev, event.overlay, ctx, event.data);
		case "overlay_pop":
			return popOverlay(prev, event.overlay, ctx);
		case "run_aborted":
			if (!isActive(prev.phase) || prev.phase === "cancelling") return prev;
			// The request is not the stop. The turn reads as cancelling until its stream or child process has
			// actually gone: `agent_end`, the ladder's own settlement or `cancel_settled` observes that.
			return {
				...refreshMeaningful(prev, ctx),
				phase: "cancelling",
				cancelRequestedAt: ctx.now,
				summary: cancelledSummary(prev, ctx, "cancelled", false, runAbortDetail(event)),
				retry: undefined,
				preparingToolCall: false,
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		case "cancel_settled":
			if (prev.phase !== "cancelling") return prev;
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary: finalizedCancel(prev, ctx),
				tool: undefined,
				toolStartedAt: undefined,
				activeTools: [],
			};
		case "force_cancelled":
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary: cancelledSummary(prev, ctx, "cancelled", true, event.reason),
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		case "watchdog_tick": {
			if (!isActive(prev.phase)) return prev;
			if (isWaitingForOperator(prev)) {
				const held = prev.phase === "stuck" ? popOverlay(prev, "stuck", ctx) : prev;
				return { ...held, watchdogTier: 0, localRuntime: ctx.localRuntime };
			}
			const elapsed = Math.max(0, ctx.now - prev.lastMeaningfulAt);
			const tier = computeWatchdogTier(elapsed);
			// Stopping is already the claim on screen, and the abort ceiling bounds it.
			if (prev.phase === "cancelling") return { ...prev, watchdogTier: tier, localRuntime: ctx.localRuntime };
			if (tier === 4 && prev.phase !== "stuck") {
				return {
					...prev,
					phase: "stuck",
					resumePhase: prev.phase,
					watchdogTier: tier,
					watchdogPeak: peak(prev, tier),
					localRuntime: ctx.localRuntime,
				};
			}
			if (prev.phase === "stuck" && tier < 4) {
				return {
					...prev,
					phase: prev.resumePhase ?? "thinking",
					resumePhase: undefined,
					watchdogTier: tier,
					watchdogPeak: peak(prev, tier),
					localRuntime: ctx.localRuntime,
				};
			}
			return { ...prev, watchdogTier: tier, watchdogPeak: peak(prev, tier), localRuntime: ctx.localRuntime };
		}
		default:
			return prev;
	}
}
