import type { Api, AssistantMessage, AssistantMessageEventStream, Model, StreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { isProviderAuthRejection } from "../../core/provider-auth-error.js";
import type { CodexTransportCounters, CodexTransportObservation } from "../types.js";
import { withProxyConnectionNote } from "./proxy-connection-error.js";
import {
	newTransportCall,
	type ResponsesWebSocketFlavor,
	resetResponsesWebSocketSession,
	responsesWebSocketFetch,
} from "./responses-websocket.js";

/** A session's counters since its last reset, which a recovery reports as what came before it. */
const totals = new Map<string, CodexTransportCounters>();

registerSessionResourceCleanup((sessionId) => {
	for (const key of totals.keys()) if (sessionId === undefined || key.endsWith(`\n${sessionId}`)) totals.delete(key);
});

function zero(): CodexTransportCounters {
	return newTransportCall().counters;
}

function add(into: CodexTransportCounters, from: CodexTransportCounters): void {
	for (const key of Object.keys(into) as Array<keyof CodexTransportCounters>) into[key] += from[key];
}

/** The public API's own endpoint; a gateway or proxy that speaks the HTTP shape need not speak its socket. */
function isPublicOpenAI(baseUrl: string | undefined): boolean {
	try {
		return baseUrl !== undefined && new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

function flavorOf(model: Model<Api>): ResponsesWebSocketFlavor | undefined {
	if (model.api === "openai-codex-responses") return "codex";
	if (model.api === "openai-responses" && isPublicOpenAI(model.baseUrl)) return "public";
	return undefined;
}

/**
 * Route a Responses call through Clio's WebSocket transport (`responses-websocket.ts`) and attach what it did as
 * `codexTransport` on the terminal message (#423 / #427 AC4). Pi runs its SSE path with a fetch that sends the request
 * over the socket, so Pi still builds the body and parses the stream while Clio owns the send, the delta decision and
 * recovery. `transport: "sse"` keeps the request on HTTP; Pi's `websocket` sends full frames only.
 */
export function observeResponsesTransport<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const flavor = flavorOf(model);
	if (flavor === undefined) return invoke(options);
	const requested = options?.transport ?? "auto";
	const session = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	// Without a session the public API has no conversation to continue, so a socket would only add a handshake.
	if (flavor === "public" && (session === undefined || requested === "sse")) return invoke(options);
	const totalsKey = session === undefined ? undefined : `${flavor}\n${session}`;
	const call = newTransportCall();
	const base = options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const routed = {
		...options,
		transport: "sse",
		...(requested === "sse"
			? {}
			: {
					fetch: responsesWebSocketFetch({
						flavor,
						base,
						continuation: requested !== "websocket",
						call,
						...(session !== undefined ? { session } : {}),
						...(options?.signal !== undefined ? { signal: options.signal } : {}),
					}),
				}),
	} as T;
	const output = createAssistantMessageEventStream();
	void (async () => {
		let responseStatus: number | undefined;
		let finished = false;
		const finish = (message: AssistantMessage): void => {
			if (finished) return;
			finished = true;
			if (message.stopReason === "error" && message.errorMessage !== undefined && flavor === "codex")
				message.errorMessage = withProxyConnectionNote(message.errorMessage, model.baseUrl);
			const mode = requested === "sse" ? "sse" : call.mode;
			const before = totalsKey === undefined ? undefined : (totals.get(totalsKey) ?? zero());
			let recovery: CodexTransportObservation["recovery"];
			if (call.recovered && before) {
				recovery = {
					action: "cooldown_reset",
					countersBeforeReset: { ...before },
					outcome:
						mode === "unknown"
							? "unknown"
							: mode === "websocket" && message.stopReason !== "error" && message.stopReason !== "aborted"
								? "recovered"
								: "failed",
				};
			}
			const observation: CodexTransportObservation = {
				mode,
				request: mode === "sse" ? "full" : call.request,
				attribution: session === undefined ? "no_session" : "exclusive",
				counters: { ...call.counters },
				lastInputItems: call.lastInputItems,
				fallbackActive: call.fallbackActive,
				...(call.reason !== undefined && call.fallbackActive
					? { reason: call.reason, retryAt: call.retryAt ?? null, cooldownMs: call.cooldownMs ?? null }
					: {}),
				...(recovery ? { recovery } : {}),
			};
			const auth = isProviderAuthRejection(message.errorMessage, responseStatus);
			if (auth && session !== undefined && call.fallbackActive) {
				// #427 AC4: a refreshed credential must not inherit a cooldown its predecessor's rejection earned.
				observation.recovery = {
					action: "auth_reset",
					countersBeforeReset: { ...(before ?? zero()) },
					outcome: "eligible",
				};
				resetResponsesWebSocketSession(flavor, session);
				observation.fallbackActive = false;
				observation.reason = "auth_rejection";
				observation.retryAt = null;
				observation.cooldownMs = null;
			}
			if (totalsKey !== undefined) {
				const next = observation.recovery ? zero() : (before ?? zero());
				add(next, call.counters);
				totals.set(totalsKey, next);
			}
			(message as AssistantMessage & { codexTransport?: CodexTransportObservation }).codexTransport = observation;
		};
		try {
			const onResponse = options?.onResponse;
			const source = invoke({
				...routed,
				onResponse: async (response: { status: number; headers: Record<string, string> }, responseModel: Model<Api>) => {
					responseStatus = response.status;
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
		}
	})();
	return output;
}
