import type { Api, AssistantMessage, AssistantMessageEventStream, Model, StreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { isProviderAuthRejection } from "../../core/provider-auth-error.js";
import type { CodexTransportCounters, CodexTransportObservation } from "../types.js";

type Bridge = typeof import("@earendil-works/pi-ai/api/openai-codex-responses");
type Stats = ReturnType<Bridge["getOpenAICodexWebSocketDebugStats"]>;
type Call = { overlap: boolean };
type Fallback = {
	reason: string;
	retryAt: string | null;
	deadline: number | null;
	cooldownMs: number | null;
	failures: number;
};
type Health = { active: Set<Call>; fallback?: Fallback; authRejected: boolean; disposed: boolean };

// #423: let a transient outage settle before trying one new connection at a request boundary.
export const CODEX_WEBSOCKET_RECOVERY_COOLDOWN_MS = 30_000;
const MAX_RECOVERY_COOLDOWN_MS = 5 * 60_000;
const sessions = new Map<string, Health>();

registerSessionResourceCleanup((sessionId) => {
	for (const [id, health] of sessions) {
		if (sessionId && id !== sessionId) continue;
		health.disposed = true;
		if (health.active.size === 0) sessions.delete(id);
	}
});

function counters(stats: Stats): CodexTransportCounters {
	return {
		requests: stats?.requests ?? 0,
		connectionsCreated: stats?.connectionsCreated ?? 0,
		connectionsReused: stats?.connectionsReused ?? 0,
		fullContextRequests: stats?.fullContextRequests ?? 0,
		deltaRequests: stats?.deltaRequests ?? 0,
		websocketFailures: stats?.websocketFailures ?? 0,
		sseFallbacks: stats?.sseFallbacks ?? 0,
	};
}

function difference(before: Stats, after: Stats): CodexTransportCounters | null {
	const start = counters(before);
	const end = counters(after);
	for (const key of Object.keys(start) as Array<keyof CodexTransportCounters>) {
		end[key] -= start[key];
		if (end[key] < 0) return null;
	}
	return end;
}

/** #423 / #427 AC4: observe Pi's physical sends and reset only idle session pins, never replay a stream. */
export function observeCodexTransport<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (model.api !== "openai-codex-responses") return invoke(options);
	const sessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	const health = sessionId
		? (sessions.get(sessionId) ?? { active: new Set<Call>(), authRejected: false, disposed: false })
		: undefined;
	const call: Call = { overlap: (health?.active.size ?? 0) > 0 };
	if (health && sessionId) {
		for (const active of health.active) active.overlap = true;
		health.active.add(call);
		sessions.set(sessionId, health);
	}
	const output = createAssistantMessageEventStream();
	void (async () => {
		let bridge: Bridge | undefined;
		let before: Stats;
		let authRejected = false;
		let responseStatus: number | undefined;
		let recovery: CodexTransportObservation["recovery"];
		let finished = false;
		const finish = (message: AssistantMessage): void => {
			if (finished) return;
			finished = true;
			const after = sessionId ? bridge?.getOpenAICodexWebSocketDebugStats(sessionId) : undefined;
			const diff = sessionId && !call.overlap ? difference(before, after) : null;
			const failure = message.diagnostics?.find((item) => item.type === "provider_transport_failure");
			const freshFailure = (diff?.websocketFailures ?? 0) > 0 || failure !== undefined;
			const auth =
				authRejected ||
				isProviderAuthRejection(message.errorMessage, responseStatus) ||
				(freshFailure && isProviderAuthRejection(after?.lastWebSocketError));
			if (health) {
				health.active.delete(call);
				health.authRejected ||= auth;
				if (after?.websocketFallbackActive && (freshFailure || !health.fallback)) {
					const failures = (health.fallback?.failures ?? 0) + 1;
					const cooldown = Math.min(
						CODEX_WEBSOCKET_RECOVERY_COOLDOWN_MS * 2 ** Math.min(failures - 1, 4),
						MAX_RECOVERY_COOLDOWN_MS,
					);
					const preStream = failure?.details?.phase === "before_message_stream_start";
					health.fallback = {
						reason: auth ? "auth_rejection" : preStream ? "transport_failure" : "post_stream_or_unknown_failure",
						retryAt: preStream ? new Date(Date.now() + cooldown).toISOString() : null,
						deadline: preStream ? performance.now() + cooldown : null,
						cooldownMs: preStream ? cooldown : null,
						failures,
					};
				}
			}
			const fallback = health?.fallback;
			const mode = call.overlap
				? "unknown"
				: options?.transport === "sse" || (diff?.sseFallbacks ?? 0) > 0
					? "sse"
					: (diff?.requests ?? 0) > 0
						? "websocket"
						: "unknown";
			const observation: CodexTransportObservation = {
				mode,
				request:
					mode === "sse"
						? "full"
						: diff && diff.requests === 1
							? diff.deltaRequests === 1
								? "delta"
								: diff.fullContextRequests === 1
									? "full"
									: "unknown"
							: "unknown",
				attribution: !sessionId ? "no_session" : call.overlap ? "overlap" : diff === null ? "counter_reset" : "exclusive",
				counters: diff,
				lastInputItems: diff && diff.requests > 0 ? (after?.lastInputItems ?? null) : null,
				fallbackActive: after?.websocketFallbackActive ?? false,
				...(fallback
					? {
							reason: fallback.reason,
							retryAt: fallback.retryAt,
							cooldownMs: fallback.cooldownMs,
						}
					: {}),
				...(recovery
					? {
							recovery: {
								...recovery,
								outcome:
									mode === "unknown"
										? "unknown"
										: mode === "websocket" && message.stopReason !== "error" && message.stopReason !== "aborted"
											? "recovered"
											: "failed",
							},
						}
					: {}),
			};
			// #427 AC4: defer an auth reset until every overlapping stream is terminal.
			if (sessionId && bridge && health?.active.size === 0 && health.authRejected && after?.websocketFallbackActive) {
				observation.recovery = { action: "auth_reset", countersBeforeReset: counters(after), outcome: "eligible" };
				bridge.closeOpenAICodexWebSocketSessions(sessionId);
				bridge.resetOpenAICodexWebSocketDebugStats(sessionId);
				observation.fallbackActive = false;
				observation.reason = "auth_rejection";
				observation.retryAt = null;
				observation.cooldownMs = null;
				delete health.fallback;
				health.authRejected = false;
			}
			if (health?.active.size === 0 && !after?.websocketFallbackActive) delete health.fallback;
			if (health?.active.size === 0) health.authRejected = false;
			if (health && sessionId && health.active.size === 0 && health.disposed) sessions.delete(sessionId);
			(message as AssistantMessage & { codexTransport?: CodexTransportObservation }).codexTransport = observation;
		};
		try {
			// #423: load the heavy Codex adapter only when a Codex call actually runs.
			bridge = await import("@earendil-works/pi-ai/api/openai-codex-responses");
			before = sessionId ? bridge.getOpenAICodexWebSocketDebugStats(sessionId) : undefined;
			const fallback = health?.fallback;
			if (
				sessionId &&
				health &&
				health.active.size === 1 &&
				!call.overlap &&
				before?.websocketFallbackActive &&
				fallback?.deadline !== null &&
				fallback?.deadline !== undefined &&
				performance.now() >= fallback.deadline &&
				options?.transport !== "sse" &&
				!options?.signal?.aborted
			) {
				recovery = { action: "cooldown_reset", countersBeforeReset: counters(before), outcome: "eligible" };
				// #423: closing the selected socket discards its continuation, forcing one full recovery frame.
				bridge.closeOpenAICodexWebSocketSessions(sessionId);
				bridge.resetOpenAICodexWebSocketDebugStats(sessionId);
				before = undefined;
			}
			const onResponse = options?.onResponse;
			const source = invoke({
				...options,
				onResponse: async (response, responseModel) => {
					responseStatus = response.status;
					authRejected ||= isProviderAuthRejection(undefined, response.status);
					await onResponse?.(response, responseModel);
				},
			} as T);
			for await (const event of source) {
				if (event.type === "done" || event.type === "error") {
					finish(event.type === "done" ? event.message : event.error);
				}
				output.push(event);
			}
			output.end();
		} catch (cause) {
			const reason = options?.signal?.aborted ? "aborted" : "error";
			const error: AssistantMessage & { usage: AssistantMessage["usage"] & { callInvoked: false } } = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					callInvoked: false,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: reason,
				errorMessage: cause instanceof Error ? cause.message : String(cause),
				timestamp: Date.now(),
			};
			finish(error);
			output.push({ type: "error", reason, error });
			output.end(error);
		} finally {
			health?.active.delete(call);
		}
	})();
	return output;
}
