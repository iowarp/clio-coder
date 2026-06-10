import { ToolNames } from "../../core/tool-names.js";
import type { ChatLoopEvent, RetryStatusPhase } from "../chat-loop.js";
import { buildSummary, emptySummary } from "./summary.js";
import {
	type AgentStatus,
	INITIAL_STATUS,
	type OverlayFrame,
	type OverlayPhase,
	type RetryOverlay,
	type StatusPhase,
	type ToolOverlay,
	type TurnStopReason,
} from "./types.js";
import { computeWatchdogTier } from "./watchdog.js";

export interface ReduceContext {
	now: number;
	localRuntime: boolean;
	modelId?: string;
	endpointId?: string;
	runId?: string | null;
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
	reason?: string;
}

export interface ForceCancelledStatusEvent {
	type: "force_cancelled";
	reason: string;
}

export type StatusInputEvent =
	| ChatLoopEvent
	| WatchdogTickEvent
	| OverlayPushEvent
	| OverlayPopEvent
	| RunAbortedStatusEvent
	| ForceCancelledStatusEvent;

const OVERLAY_PHASES = new Set<StatusPhase>(["tool_blocked", "retrying", "compacting", "dispatching", "stuck"]);
const CORE_ACTIVE_PHASES = new Set<StatusPhase>(["preparing", "waiting_model", "thinking", "writing", "tool_running"]);
const OVERLAY_PRECEDENCE: readonly OverlayPhase[] = ["stuck", "tool_blocked", "retrying", "compacting", "dispatching"];

function isOverlayPhase(phase: StatusPhase): phase is OverlayPhase {
	return OVERLAY_PHASES.has(phase);
}

function isActive(phase: StatusPhase): phase is Exclude<StatusPhase, "idle" | "ended"> {
	return phase !== "idle" && phase !== "ended";
}

function targetModel(ctx: ReduceContext): { modelId: string; endpointId: string } {
	return { modelId: ctx.modelId ?? "", endpointId: ctx.endpointId ?? "" };
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

function isWaitingForOperator(prev: AgentStatus): boolean {
	return (
		prev.tool?.toolName === ToolNames.AskUser &&
		(prev.phase === "tool_running" || (prev.phase === "stuck" && prev.resumePhase === "tool_running"))
	);
}

function cancelledSummary(prev: AgentStatus, ctx: ReduceContext, stopReason: TurnStopReason, truncated = false) {
	const start = prev.since > 0 ? prev.since : ctx.now;
	const model = targetModel(ctx);
	return emptySummary({
		startedAt: start,
		endedAt: ctx.now,
		modelId: model.modelId,
		endpointId: model.endpointId,
		watchdogPeak: prev.watchdogPeak,
		stopReason,
		truncated,
	});
}

function retryOverlay(status: {
	phase: RetryStatusPhase;
	attempt: number;
	maxAttempts: number;
	delayMs?: number;
}): RetryOverlay {
	return {
		attempt: status.attempt,
		maxAttempts: status.maxAttempts,
		waitMs: status.delayMs ?? 0,
	};
}

export function reduceStatus(prev: AgentStatus, event: StatusInputEvent, ctx: ReduceContext): AgentStatus {
	switch (event.type) {
		case "agent_start":
			if (isActive(prev.phase)) return prev;
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
			if (base === "preparing") return { ...next, phase: "waiting_model", resumePhase: undefined };
			return next;
		}
		case "message_start": {
			const next = refreshMeaningful(prev, ctx);
			const role = (event.message as { role?: unknown }).role;
			if (role === "assistant" && prev.phase === "tool_running") return { ...next, phase: "writing" };
			if (
				role === "assistant" &&
				(prev.phase === "preparing" || prev.phase === "waiting_model" || prev.phase === "thinking")
			)
				return { ...next, phase: "writing", resumePhase: undefined };
			return next;
		}
		case "message_update": {
			const base = activePhaseAfterStuck(prev);
			const next = refreshMeaningful({ ...prev, phase: base }, ctx);
			if (base === "preparing" || base === "waiting_model" || base === "thinking") {
				return { ...next, phase: "writing", resumePhase: undefined };
			}
			if (CORE_ACTIVE_PHASES.has(base)) return { ...next, resumePhase: undefined };
			return next;
		}
		case "tool_execution_update":
		case "message_end":
			return refreshMeaningful(prev, ctx);
		case "tool_execution_end": {
			const next = refreshMeaningful(prev, ctx);
			if (prev.phase === "tool_running") return { ...next, phase: "preparing", tool: undefined };
			if (prev.phase === "stuck" && prev.resumePhase === "tool_running") {
				return { ...next, phase: "preparing", resumePhase: undefined, tool: undefined };
			}
			return next;
		}
		case "thinking_delta": {
			const base = activePhaseAfterStuck(prev);
			const next = refreshMeaningful({ ...prev, phase: base }, ctx);
			if (base === "preparing" || base === "waiting_model" || base === "writing") {
				return { ...next, phase: "thinking", resumePhase: undefined };
			}
			if (CORE_ACTIVE_PHASES.has(base)) return { ...next, resumePhase: undefined };
			return next;
		}
		case "text_delta": {
			const base = activePhaseAfterStuck(prev);
			const next = refreshMeaningful({ ...prev, phase: base }, ctx);
			if (base === "preparing" || base === "waiting_model" || base === "thinking") {
				return { ...next, phase: "writing", resumePhase: undefined };
			}
			if (CORE_ACTIVE_PHASES.has(base)) return { ...next, resumePhase: undefined };
			return next;
		}
		case "tool_execution_start": {
			const tool: ToolOverlay = {
				toolName: event.toolName,
				toolPreview: compactPreview(event.args),
			};
			return { ...refreshMeaningful(prev, ctx), phase: "tool_running", tool };
		}
		case "retry_status": {
			const phase = event.status.phase;
			if (phase === "scheduled" || phase === "waiting" || phase === "retrying") {
				return pushOverlay(prev, "retrying", ctx, retryOverlay(event.status));
			}
			if (phase === "recovered") return popOverlay(prev, "retrying", ctx);
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary: cancelledSummary(prev, ctx, phase === "cancelled" ? "cancelled" : "error"),
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		}
		case "agent_end": {
			const truncated = prev.phase === "idle";
			const start = prev.since > 0 ? prev.since : ctx.now;
			const model = targetModel(ctx);
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary: buildSummary({
					startedAt: start,
					endedAt: ctx.now,
					modelId: model.modelId,
					endpointId: model.endpointId,
					messages: event.messages,
					watchdogPeak: prev.watchdogPeak,
					cancelled: false,
					truncated,
				}),
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		}
		case "overlay_push":
			return pushOverlay(prev, event.overlay, ctx, event.data);
		case "overlay_pop":
			return popOverlay(prev, event.overlay, ctx);
		case "run_aborted":
			if (!isActive(prev.phase)) return prev;
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary: cancelledSummary(prev, ctx, "cancelled"),
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		case "force_cancelled":
			return {
				...refreshMeaningful(prev, ctx),
				phase: "ended",
				summary: cancelledSummary(prev, ctx, "cancelled", true),
				resumePhase: undefined,
				activePhases: undefined,
				overlayStack: [],
			};
		case "watchdog_tick": {
			if (!isActive(prev.phase)) return prev;
			if (isWaitingForOperator(prev)) {
				return {
					...prev,
					phase: "tool_running",
					resumePhase: undefined,
					watchdogTier: 0,
					localRuntime: ctx.localRuntime,
				};
			}
			const elapsed = Math.max(0, ctx.now - prev.lastMeaningfulAt);
			const tier = computeWatchdogTier(elapsed);
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
