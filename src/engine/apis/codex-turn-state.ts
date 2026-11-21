import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { codexUserTurn } from "./codex-configuration.js";

/** The Codex backend's sticky-routing token, named as native Codex names it (codex-rs `X_CODEX_TURN_STATE_HEADER`). */
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

type Payload = Record<string, unknown>;
function record(value: unknown): value is Payload {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One conversation's token, bound to the turn the backend issued it in. */
interface TurnState {
	turn: string;
	token?: string;
	/** A `generate: false` warm: it opens the next turn, so its token belongs to that turn's first request. */
	warm?: boolean;
}

const states = new Map<string, TurnState>();
/** Long-lived processes open many sessions; the oldest token is the cheapest to lose. */
const MAX_SESSIONS = 256;

registerSessionResourceCleanup((sessionId) => {
	if (sessionId === undefined) states.clear();
	else states.delete(sessionId);
});

/**
 * The turn a request belongs to: its last user message. Tool rounds of one turn append assistant and tool-result
 * messages after it and keep the identity; the next operator prompt, or a steering message, starts a new one.
 */
function turnOf(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		return `${index}:${message.timestamp}:${codexUserTurn(message) ?? ""}`;
	}
	return undefined;
}

function headerValue(headers: Record<string, string> | undefined): string | undefined {
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() === CODEX_TURN_STATE_HEADER && typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** The token a WebSocket stream carries in its metadata event, where the backend sends what SSE puts in headers. */
function eventValue(event: unknown): string | undefined {
	if (!record(event) || (event.type !== "codex.response.metadata" && event.type !== "response.metadata"))
		return undefined;
	return record(event.headers) ? headerValue(event.headers as Record<string, string>) : undefined;
}

/**
 * Keep the Codex backend's sticky routing for every request of one turn (PV-2), as native Codex does: the backend
 * issues `x-codex-turn-state` on the turn's first response (a response header over SSE, a metadata event over the
 * WebSocket), and each later request of that turn sends it back; a new turn starts without one, so a token never
 * crosses a turn. The token is opaque and never logged; a request without one is ordinary, never a failure.
 *
 * It travels as the request header; on the WebSocket, `responses-websocket.ts` moves it into the frame's
 * `client_metadata`, which its delta decision ignores.
 */
export function withCodexTurnState<T extends StreamOptions | SimpleStreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
): T | undefined {
	const sessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	if (model.api !== "openai-codex-responses" || !sessionId) return options;
	const opened = turnOf(context);
	if (opened === undefined) return options;
	// Only a warm ends on the assistant's message: a turn's requests end on the prompt or on a tool result.
	const warm = context.messages.at(-1)?.role === "assistant";
	const turn = warm ? `warm:${opened}` : opened;
	let state = states.get(sessionId);
	if (state?.turn !== turn) {
		// As native Codex prewarms inside the turn it opens, the warm's token carries into that turn's first request.
		const carried = !warm && state?.warm === true ? state.token : undefined;
		state = { turn, ...(warm ? { warm: true } : {}), ...(carried !== undefined ? { token: carried } : {}) };
		states.delete(sessionId);
		states.set(sessionId, state);
		if (states.size > MAX_SESSIONS) {
			const oldest = states.keys().next().value;
			if (oldest !== undefined) states.delete(oldest);
		}
	}
	const current = state;
	const capture = (token: string | undefined): void => {
		// The first token of a turn holds for the rest of it, as native Codex's once-set lock does.
		if (token !== undefined && current.token === undefined && states.get(sessionId) === current) current.token = token;
	};
	const onResponse = options?.onResponse;
	const onProviderStreamEvent = options?.onProviderStreamEvent;
	return {
		...options,
		...(current.token === undefined
			? {}
			: { headers: { ...options?.headers, [CODEX_TURN_STATE_HEADER]: current.token } }),
		onResponse: async (response: { status: number; headers: Record<string, string> }, responseModel: Model<Api>) => {
			capture(headerValue(response.headers));
			await onResponse?.(response, responseModel);
		},
		onProviderStreamEvent: async (event: unknown, eventModel: Model<Api>) => {
			capture(eventValue(event));
			await onProviderStreamEvent?.(event, eventModel);
		},
	} as T;
}
