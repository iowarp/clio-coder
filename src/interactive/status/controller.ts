import { BusChannels } from "../../core/bus-events.js";
import type { ClioSettings } from "../../core/config.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { ChatLoop, ChatLoopEvent } from "../chat-loop.js";
import { reduceStatus, type StatusInputEvent } from "./state-machine.js";
import { type AgentStatus, type AgentStatusChangedPayload, INITIAL_STATUS } from "./types.js";
import { TIER_THRESHOLDS_MS } from "./watchdog.js";

export interface StatusControllerDeps {
	chat: ChatLoop;
	providers: ProvidersContract;
	bus?: SafeEventBus;
	getSettings?: () => Readonly<ClioSettings>;
	now?: () => number;
	setInterval?: (listener: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	setTimeout?: (listener: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export interface StatusController {
	current(): AgentStatus;
	subscribe(listener: (status: AgentStatus) => void): () => void;
	dispose(): void;
}

const TICK_INTERVAL_MS = 1000;
const SETTLE_MS = 5000;
const STATUS_EMIT_THROTTLE_MS = 100;

function payloadObject(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function statusMetadata(status: AgentStatus): AgentStatusChangedPayload["metadata"] {
	if (status.tool) return { toolName: status.tool.toolName };
	if (status.retry) return { attempt: status.retry.attempt };
	if (status.dispatch) return { agentName: status.dispatch.agentName };
	if (status.phase === "ended" && status.summary) return { reason: status.summary.stopReason };
	return undefined;
}

export function createStatusController(deps: StatusControllerDeps): StatusController {
	const now = deps.now ?? Date.now;
	const setIntervalFn = deps.setInterval ?? ((listener, ms) => setInterval(listener, ms));
	const clearIntervalFn =
		deps.clearInterval ??
		((handle) => {
			clearInterval(handle as ReturnType<typeof setInterval>);
		});
	const setTimeoutFn = deps.setTimeout ?? ((listener, ms) => setTimeout(listener, ms));
	const clearTimeoutFn =
		deps.clearTimeout ??
		((handle) => {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		});

	let status: AgentStatus = { ...INITIAL_STATUS };
	let disposed = false;
	let lastNotifyAt = 0;
	let settleTimer: unknown = null;
	let abortCeilingTimer: unknown = null;
	const listeners = new Set<(status: AgentStatus) => void>();
	const unsubscribes: Array<() => void> = [];

	const currentTarget = (): { endpointId: string; modelId: string } => {
		const settings = deps.getSettings?.();
		return {
			endpointId: settings?.orchestrator?.endpoint ?? "",
			modelId: settings?.orchestrator?.model ?? "",
		};
	};

	const isLocalRuntime = (): boolean => {
		const endpointId = currentTarget().endpointId;
		if (!endpointId) return false;
		const entry = deps.providers.list().find((candidate) => candidate.endpoint.id === endpointId);
		return entry?.runtime?.tier === "local-native";
	};

	const clearSettle = (): void => {
		if (settleTimer === null) return;
		clearTimeoutFn(settleTimer);
		settleTimer = null;
	};

	const clearAbortCeiling = (): void => {
		if (abortCeilingTimer === null) return;
		clearTimeoutFn(abortCeilingTimer);
		abortCeilingTimer = null;
	};

	const emitPhaseTransition = (prev: AgentStatus, next: AgentStatus, at: number): void => {
		if (prev.phase === next.phase) return;
		const payload: AgentStatusChangedPayload = {
			runId: next.runId ?? deps.chat.getSessionId() ?? null,
			phase: next.phase,
			prevPhase: prev.phase,
			at,
			elapsedFromStart: next.since > 0 ? Math.max(0, at - next.since) : 0,
			watchdogTier: next.watchdogTier,
			metadata: statusMetadata(next),
		};
		deps.bus?.emit(BusChannels.AgentStatusChanged, payload);
	};

	const notify = (prev: AgentStatus, next: AgentStatus, force = false): void => {
		const at = now();
		emitPhaseTransition(prev, next, at);
		const phaseChanged = prev.phase !== next.phase;
		if (!force && !phaseChanged && at - lastNotifyAt < STATUS_EMIT_THROTTLE_MS) return;
		lastNotifyAt = at;
		for (const listener of listeners) listener(next);
	};

	const scheduleSettle = (): void => {
		clearSettle();
		settleTimer = setTimeoutFn(() => {
			if (disposed || status.phase !== "ended") return;
			const prev = status;
			status = { ...INITIAL_STATUS, localRuntime: isLocalRuntime() };
			notify(prev, status, true);
		}, SETTLE_MS);
	};

	const scheduleAbortCeiling = (): void => {
		clearAbortCeiling();
		abortCeilingTimer = setTimeoutFn(() => {
			if (disposed || status.phase === "idle" || status.phase === "ended") return;
			apply({ type: "force_cancelled", reason: "watchdog-forced" }, true);
		}, TIER_THRESHOLDS_MS.postAbortCeiling);
	};

	const apply = (event: StatusInputEvent, force = false): void => {
		const at = now();
		const target = currentTarget();
		const prev = status;
		const next = reduceStatus(prev, event, {
			now: at,
			localRuntime: isLocalRuntime(),
			modelId: target.modelId,
			endpointId: target.endpointId,
			runId: deps.chat.getSessionId(),
		});
		if (next === prev) return;
		status = next;
		if (event.type === "agent_start") clearSettle();
		if (status.phase === "ended") {
			clearAbortCeiling();
			scheduleSettle();
		}
		notify(prev, status, force);
	};

	unsubscribes.push(
		deps.chat.onEvent((event: ChatLoopEvent) => {
			if (event.type === "agent_status") return;
			apply(event);
		}),
	);

	if (deps.bus) {
		unsubscribes.push(
			deps.bus.on(BusChannels.SuperRequired, () => apply({ type: "overlay_push", overlay: "tool_blocked" }, true)),
			deps.bus.on(BusChannels.ModeChanged, (payload) => {
				const p = payloadObject(payload);
				if (p.to === "super" && p.from !== "super") apply({ type: "overlay_pop", overlay: "tool_blocked" }, true);
			}),
			deps.bus.on(BusChannels.CompactionBegin, () => apply({ type: "overlay_push", overlay: "compacting" }, true)),
			deps.bus.on(BusChannels.CompactionEnd, () => apply({ type: "overlay_pop", overlay: "compacting" }, true)),
			deps.bus.on(BusChannels.DispatchStarted, (payload) =>
				apply({ type: "overlay_push", overlay: "dispatching", data: payload }, true),
			),
			deps.bus.on(BusChannels.DispatchCompleted, () => apply({ type: "overlay_pop", overlay: "dispatching" }, true)),
			deps.bus.on(BusChannels.DispatchFailed, () => apply({ type: "overlay_pop", overlay: "dispatching" }, true)),
			deps.bus.on(BusChannels.RunAborted, () => {
				scheduleAbortCeiling();
				apply({ type: "run_aborted", reason: "user cancelled stream" }, true);
			}),
		);
	}

	const interval = setIntervalFn(() => apply({ type: "watchdog_tick" }), TICK_INTERVAL_MS);

	return {
		current: () => status,
		subscribe(listener) {
			listeners.add(listener);
			listener(status);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			disposed = true;
			clearSettle();
			clearAbortCeiling();
			clearIntervalFn(interval);
			for (const unsubscribe of unsubscribes) unsubscribe();
			unsubscribes.length = 0;
			listeners.clear();
		},
	};
}
