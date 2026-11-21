import { createHash } from "node:crypto";
import { subscribe } from "node:diagnostics_channel";
import { zstdDecompressSync } from "node:zlib";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { WebSocket as UndiciWebSocket } from "undici";
import type { CodexTransportCounters } from "../types.js";
import { CODEX_TURN_STATE_HEADER } from "./codex-turn-state.js";

/**
 * Clio's own Responses WebSocket transport (PV-2, OI-10). Pi builds the request and parses the stream on its SSE
 * path; this fetch takes Pi's SSE request, sends it as a `response.create` frame on a socket Clio owns and hands the
 * frames back as an SSE body. Clio therefore decides delta against full itself, and the decision ignores what never
 * changes the provider's view of the conversation: the Codex turn-state token (`client_metadata`), a warmup's
 * `generate: false` and a diagnostics comparison id. Pi's own socket compared every one of those and sent a full
 * frame whenever one changed, so turn-state replay and warmup chaining each cost the continuation.
 *
 * A failure before the first frame sends the request over Pi's SSE path instead; nothing that already streamed is
 * ever resent.
 */

export type ResponsesWebSocketFlavor = "codex" | "public";

/** What one call's transport did, filled in as it happens. Every call owns its counters, so attribution is exact. */
export interface ResponsesTransportCall {
	mode: "websocket" | "sse" | "unknown";
	request: "full" | "delta" | "unknown";
	counters: CodexTransportCounters;
	lastInputItems: number | null;
	fallbackActive: boolean;
	reason?: string;
	cooldownMs?: number | null;
	retryAt?: string | null;
	/** The session's cooldown had elapsed and this call tried one new connection (#423). */
	recovered?: boolean;
}

export function newTransportCall(): ResponsesTransportCall {
	return {
		mode: "unknown",
		request: "unknown",
		counters: {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		},
		lastInputItems: null,
		fallbackActive: false,
	};
}

/** The beta the Codex backend's WebSocket handshake names; the public API takes none. */
const CODEX_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
/** #423: let a transient outage settle before one new connection at a request boundary. */
const RESPONSES_WEBSOCKET_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const IDLE_CLOSE_MS = 5 * 60_000;
/** Both backends end a connection after an hour; a socket is retired a little before that. */
const MAX_SOCKET_AGE_MS = 55 * 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const OPEN = 1;
const MESSAGE_TOO_BIG = 1009;

type Payload = Record<string, unknown>;
function record(value: unknown): value is Payload {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Continuation {
	key: string;
	input: unknown[];
	responseId: string;
	outputItems: number;
}

interface Lane {
	socket: UndiciWebSocket;
	health: string;
	busy: boolean;
	createdAt: number;
	idle?: ReturnType<typeof setTimeout>;
	continuation?: Continuation;
}

interface Health {
	deadline: number;
	failures: number;
	reason: string;
}

const lanes = new Map<string, Lane>();
const health = new Map<string, Health>();
/** The handshake response's headers, which undici reports only on its diagnostics channel. */
const handshakes = new WeakMap<object, Record<string, string>>();
let watchingHandshakes = false;

function healthKey(flavor: ResponsesWebSocketFlavor, session: string): string {
	return `${flavor}\n${session}`;
}

registerSessionResourceCleanup((sessionId) => {
	for (const [key, lane] of lanes) {
		if (sessionId !== undefined && !lane.health.endsWith(`\n${sessionId}`)) continue;
		if (!lane.busy) retire(key, lane, "session_closed");
	}
	for (const key of health.keys()) if (sessionId === undefined || key.endsWith(`\n${sessionId}`)) health.delete(key);
});

function retire(key: string, lane: Lane, reason: string): void {
	if (lane.idle) clearTimeout(lane.idle);
	if (lanes.get(key) === lane) lanes.delete(key);
	try {
		lane.socket.close(1000, reason);
	} catch {
		// A socket that is already closing has nothing left to release.
	}
}

/** #427 AC4: forget a session's sockets and cooldown, as an auth reset does once a credential is refreshed. */
export function resetResponsesWebSocketSession(flavor: ResponsesWebSocketFlavor, session: string): void {
	const prefix = `${healthKey(flavor, session)}\n`;
	for (const [key, lane] of lanes) if (key.startsWith(prefix) && !lane.busy) retire(key, lane, "reset");
	health.delete(healthKey(flavor, session));
}

/** Close every socket this process holds and forget every cooldown; for tests and process shutdown. */
export function closeResponsesWebSockets(): void {
	for (const [key, lane] of lanes) retire(key, lane, "closed");
	health.clear();
}

/** The fields whose change makes the provider read the request as another conversation state, in a stable form. */
function comparisonKey(body: Payload): string {
	const {
		input: _input,
		previous_response_id: _previous,
		client_metadata: _metadata,
		generate: _generate,
		...rest
	} = body;
	if (record(rest.prompt_cache_options)) {
		const { comparison_response_id: _comparison, ...cacheOptions } = rest.prompt_cache_options;
		rest.prompt_cache_options = cacheOptions;
	}
	return JSON.stringify(rest);
}

/** Items a response produced, which the next request carries back and the provider already holds. */
function producedItem(item: unknown): boolean {
	if (!record(item)) return false;
	if (item.type === "message") return item.role === "assistant";
	return item.type === "reasoning" || item.type === "function_call" || item.type === "custom_tool_call";
}

/** The new items when `input` extends the conversation the lane holds, or undefined when only a full frame fits. */
function deltaOf(continuation: Continuation, key: string, input: unknown[]): unknown[] | undefined {
	if (continuation.key !== key) return undefined;
	const held = continuation.input;
	const produced = continuation.outputItems;
	if (input.length <= held.length + produced) return undefined;
	for (let index = 0; index < held.length; index += 1) {
		if (JSON.stringify(input[index]) !== JSON.stringify(held[index])) return undefined;
	}
	if (!input.slice(held.length, held.length + produced).every(producedItem)) return undefined;
	const rest = input.slice(held.length + produced);
	// A produced item past the count means the transcript holds output the provider's response did not.
	if (producedItem(rest[0])) return undefined;
	return rest;
}

function bodyOf(init: RequestInit | undefined, headers: Headers): Payload | undefined {
	const raw = init?.body;
	try {
		let text: string | undefined;
		if (headers.get("content-encoding") === "zstd" && raw instanceof Uint8Array)
			text = zstdDecompressSync(raw).toString("utf8");
		else if (headers.get("content-encoding") === "zstd" && raw instanceof ArrayBuffer)
			text = zstdDecompressSync(new Uint8Array(raw)).toString("utf8");
		else if (typeof raw === "string") text = raw;
		else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString("utf8");
		if (text === undefined) return undefined;
		const parsed: unknown = JSON.parse(text);
		return record(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const HTTP_ONLY_HEADERS = new Set(["accept", "content-type", "content-encoding", "content-length", "openai-beta"]);

function handshakeHeaders(headers: Headers, flavor: ResponsesWebSocketFlavor): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		// The turn-state token belongs to a turn, not to a connection that outlives it; it rides each frame instead.
		if (HTTP_ONLY_HEADERS.has(lower) || lower === CODEX_TURN_STATE_HEADER) continue;
		out[lower] = value;
	}
	if (flavor === "codex") out["openai-beta"] = CODEX_WEBSOCKET_BETA;
	return out;
}

function socketUrl(url: string): string {
	const target = new URL(url);
	if (target.protocol === "https:") target.protocol = "wss:";
	else if (target.protocol === "http:") target.protocol = "ws:";
	return target.toString();
}

/** Nothing reached the provider's stream: the request may go again, over a new socket or over SSE. */
class PreStreamFailure extends Error {
	constructor(
		message: string,
		readonly closeCode?: number,
	) {
		super(message);
		this.name = "PreStreamFailure";
	}
}

function abortError(): DOMException {
	return new DOMException("Request was aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function watchHandshakes(): void {
	if (watchingHandshakes) return;
	watchingHandshakes = true;
	subscribe("undici:websocket:open", (message) => {
		if (!record(message) || !record(message.websocket) || !record(message.handshakeResponse)) return;
		const raw = message.handshakeResponse.headers;
		const out: Record<string, string> = {};
		const entries = Array.isArray(raw) ? raw : record(raw) ? Object.entries(raw) : [];
		for (const entry of entries) {
			if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string")
				out[entry[0].toLowerCase()] = entry[1];
		}
		handshakes.set(message.websocket, out);
	});
}

async function connect(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<UndiciWebSocket> {
	signal?.throwIfAborted();
	// undici's WebSocket, not the runtime's: it takes handshake headers and goes through the process's dispatcher,
	// which carries the operator's proxy (src/core/proxy-env.ts).
	const { WebSocket } = await import("undici");
	watchHandshakes();
	return new Promise((resolve, reject) => {
		let socket: UndiciWebSocket;
		try {
			socket = new WebSocket(url, { headers });
			socket.binaryType = "arraybuffer";
		} catch (error) {
			reject(new PreStreamFailure(error instanceof Error ? error.message : String(error)));
			return;
		}
		const timer = setTimeout(() => fail(new PreStreamFailure("WebSocket connect timed out")), CONNECT_TIMEOUT_MS);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			cleanup();
			try {
				socket.close();
			} catch {
				// Never opened.
			}
			reject(error);
		};
		const onOpen = () => {
			cleanup();
			resolve(socket);
		};
		const onError = () => fail(new PreStreamFailure("WebSocket connection failed"));
		const onClose = (event: { code: number }) => fail(new PreStreamFailure(`WebSocket closed ${event.code}`, event.code));
		const onAbort = () => fail(abortError());
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const encoder = new TextEncoder();
const TERMINAL = new Set(["response.completed", "response.done", "response.incomplete", "response.failed"]);
const METADATA = new Set(["codex.response.metadata", "response.metadata"]);

interface Exchange {
	/** The frames up to the first that is neither metadata nor nothing, read before Pi sees a response. */
	head: Payload[];
	first: Payload;
	/** The frames after `first`, as an SSE body that ends at the terminal frame. */
	rest: ReadableStream<Uint8Array>;
}

interface ExchangeEnd {
	keep: boolean;
	/** The socket failed after the stream began. */
	failure?: Error;
	terminal?: Payload;
	outputItems: number;
}

function frameData(data: unknown): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
	return String(data);
}

/**
 * Send one frame and read up to its first answer; the remaining frames stream on as SSE. The header signal bounds
 * the wait for that answer, as Pi's response-header timeout bounds an HTTP request; the stream signal is the caller's.
 */
function exchange(
	socket: UndiciWebSocket,
	frame: Payload,
	headerSignal: AbortSignal | undefined,
	streamSignal: AbortSignal | undefined,
	onEnd: (end: ExchangeEnd) => void,
): Promise<Exchange> {
	return new Promise((resolve, reject) => {
		let started = false;
		let finished = false;
		let outputItems = 0;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const head: Payload[] = [];
		const pending: Uint8Array[] = [];
		const end = (keep: boolean, error?: Error, terminal?: Payload) => {
			if (finished) return;
			finished = true;
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("close", onClose);
			socket.removeEventListener("error", onError);
			headerSignal?.removeEventListener("abort", onAbort);
			streamSignal?.removeEventListener("abort", onAbort);
			onEnd({
				keep,
				...(started && error && !isAbort(error) ? { failure: error } : {}),
				...(terminal ? { terminal } : {}),
				outputItems,
			});
			if (!started) {
				if (error) reject(error);
				// An error frame ended the exchange before any output; the caller reads it from `first`.
				return;
			}
			if (error) controller?.error(error);
			else controller?.close();
		};
		const push = (event: Payload) => {
			const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
			if (controller) controller.enqueue(chunk);
			else pending.push(chunk);
		};
		const onMessage = (message: { data: unknown }) => {
			let event: unknown;
			try {
				event = JSON.parse(frameData(message.data));
			} catch {
				end(false, started ? new Error("Invalid Responses WebSocket JSON") : new PreStreamFailure("Invalid JSON"));
				return;
			}
			if (!record(event)) return;
			if (!started && typeof event.type === "string" && METADATA.has(event.type)) {
				head.push(event);
				return;
			}
			if (!started) {
				started = true;
				headerSignal?.removeEventListener("abort", onAbort);
				const rest = new ReadableStream<Uint8Array>({
					start(streamController) {
						controller = streamController;
						for (const chunk of pending.splice(0)) streamController.enqueue(chunk);
					},
					cancel() {
						// Pi stopped reading (an abort): the socket's remaining frames have no reader.
						end(false, abortError());
					},
				});
				resolve({ head, first: event, rest });
				if (event.type === "error") {
					end(false);
					return;
				}
			} else push(event);
			if (event.type === "response.output_item.done") outputItems += 1;
			if (event.type === "error") {
				end(false);
				return;
			}
			if (typeof event.type === "string" && TERMINAL.has(event.type))
				end(event.type !== "response.failed", undefined, event);
		};
		const onClose = (event: { code: number }) =>
			end(
				false,
				started
					? new Error(`WebSocket closed ${event.code} before the response finished`)
					: new PreStreamFailure(`WebSocket closed ${event.code}`, event.code),
			);
		const onError = () =>
			end(
				false,
				started ? new Error("WebSocket error before the response finished") : new PreStreamFailure("WebSocket error"),
			);
		const onAbort = () => end(false, abortError());
		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", onClose);
		socket.addEventListener("error", onError);
		headerSignal?.addEventListener("abort", onAbort, { once: true });
		streamSignal?.addEventListener("abort", onAbort, { once: true });
		if (headerSignal?.aborted || streamSignal?.aborted) {
			onAbort();
			return;
		}
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			end(false, new PreStreamFailure(error instanceof Error ? error.message : String(error)));
		}
	});
}

function errorCode(event: Payload): string | undefined {
	if (typeof event.code === "string") return event.code;
	if (record(event.error) && typeof event.error.code === "string") return event.error.code;
	return undefined;
}

/** A lane is one credential's: a refreshed token or another account never continues another's socket. */
function credentialScope(headers: Headers): string {
	const credential = `${headers.get("authorization") ?? ""}\n${headers.get("chatgpt-account-id") ?? ""}`;
	return createHash("sha256").update(credential).digest("hex").slice(0, 16);
}

export interface ResponsesWebSocketFetchOptions {
	flavor: ResponsesWebSocketFlavor;
	/** The fetch the SSE path would have used, and still uses for a fallback. */
	base: typeof globalThis.fetch;
	/** Off for Pi's `websocket` transport: every frame is full and no lane keeps continuation state. */
	continuation: boolean;
	/** The conversation's lane; without one every request opens and closes its own socket. */
	session?: string;
	/** The caller's abort signal, which outlives the per-request signal Pi hands fetch. */
	signal?: AbortSignal;
	call: ResponsesTransportCall;
}

/** A fetch that carries Pi's Responses SSE requests over Clio's WebSocket lanes. */
export function responsesWebSocketFetch(options: ResponsesWebSocketFetchOptions): typeof globalThis.fetch {
	const { base, call, flavor, session } = options;
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = new Headers(init?.headers);
		const body =
			(init?.method ?? "GET").toUpperCase() === "POST" && new URL(url).pathname.endsWith("/responses")
				? bodyOf(init, headers)
				: undefined;
		if (body === undefined || !Array.isArray(body.input)) return base(input, init);
		const healthId = session === undefined ? undefined : healthKey(flavor, session);
		const fallback = (reason: string): Promise<Response> => {
			call.mode = "sse";
			call.request = "full";
			call.counters.sseFallbacks += 1;
			call.reason = reason;
			return base(input, init);
		};
		const cooling = healthId === undefined ? undefined : health.get(healthId);
		if (cooling !== undefined) {
			const remaining = cooling.deadline - performance.now();
			if (remaining > 0) {
				call.fallbackActive = true;
				call.cooldownMs = Math.round(remaining);
				call.retryAt = new Date(Date.now() + remaining).toISOString();
				return fallback(cooling.reason);
			}
			// #423: the cooldown elapsed; this request boundary tries one new connection.
			call.recovered = true;
		}
		const fullInput = body.input as unknown[];
		const key = comparisonKey(body);
		const laneKey = healthId === undefined ? undefined : `${healthId}\n${credentialScope(headers)}\n${url}`;
		const turnState = flavor === "codex" ? headers.get(CODEX_TURN_STATE_HEADER) : null;
		const frameFor = (continuation: Continuation | undefined): { frame: Payload; delta: boolean } => {
			const { stream: _stream, background: _background, ...withoutStreaming } = body;
			// The Codex backend takes Pi's body as it is; the public API's socket rejects the HTTP-only fields.
			const fields: Payload = flavor === "codex" ? { ...body } : withoutStreaming;
			const delta = options.continuation && continuation ? deltaOf(continuation, key, fullInput) : undefined;
			const metadata = { ...(record(body.client_metadata) ? body.client_metadata : {}) };
			if (turnState) metadata[CODEX_TURN_STATE_HEADER] = turnState;
			delete fields.previous_response_id;
			const frame: Payload = {
				type: "response.create",
				...fields,
				...(Object.keys(metadata).length > 0 ? { client_metadata: metadata } : {}),
				...(delta !== undefined && continuation ? { previous_response_id: continuation.responseId, input: delta } : {}),
			};
			return { frame, delta: delta !== undefined };
		};

		let lane = laneKey === undefined ? undefined : lanes.get(laneKey);
		// One request in flight per socket: an overlapping call of the same session gets a socket of its own.
		const shared = laneKey !== undefined && lane?.busy !== true;
		if (lane?.busy) lane = undefined;
		else if (lane && laneKey && (Date.now() - lane.createdAt > MAX_SOCKET_AGE_MS || lane.socket.readyState !== OPEN)) {
			retire(laneKey, lane, "connection_age_limit");
			lane = undefined;
		}
		let retriedContinuation = false;
		let retriedConnection = false;
		for (;;) {
			let socket: UndiciWebSocket;
			let reused = false;
			try {
				if (lane) {
					socket = lane.socket;
					reused = true;
					if (lane.idle) clearTimeout(lane.idle);
				} else {
					socket = await connect(socketUrl(url), handshakeHeaders(headers, flavor), init?.signal ?? undefined);
					if (shared && laneKey !== undefined && healthId !== undefined) {
						const previous = lanes.get(laneKey);
						if (previous && !previous.busy) retire(laneKey, previous, "replaced");
						lane = { socket, health: healthId, busy: false, createdAt: Date.now() };
						lanes.set(laneKey, lane);
					}
				}
			} catch (error) {
				if (isAbort(error)) throw error;
				return failOver(error);
			}
			const owned = lane;
			if (owned) owned.busy = true;
			const { frame, delta } = frameFor(owned?.continuation);
			if (owned) delete owned.continuation;
			call.mode = "websocket";
			call.request = delta ? "delta" : "full";
			call.lastInputItems = Array.isArray(frame.input) ? frame.input.length : null;
			call.counters.requests += 1;
			if (reused) call.counters.connectionsReused += 1;
			else call.counters.connectionsCreated += 1;
			if (delta) call.counters.deltaRequests += 1;
			else call.counters.fullContextRequests += 1;
			const finish = ({ keep, failure, terminal, outputItems }: ExchangeEnd) => {
				if (failure) markFailure("post_stream_or_unknown_failure");
				if (!owned) {
					try {
						socket.close(1000, "done");
					} catch {
						// Already closed.
					}
					return;
				}
				owned.busy = false;
				const response = record(terminal?.response) ? terminal.response : undefined;
				if (options.continuation && terminal?.type === "response.completed" && typeof response?.id === "string")
					owned.continuation = { key, input: fullInput, responseId: response.id, outputItems };
				if (!keep || owned.socket.readyState !== OPEN) {
					if (laneKey) retire(laneKey, owned, "done");
					return;
				}
				owned.idle = setTimeout(() => laneKey && retire(laneKey, owned, "idle_timeout"), IDLE_CLOSE_MS);
				owned.idle.unref?.();
			};
			let result: Exchange;
			try {
				result = await exchange(socket, frame, init?.signal ?? undefined, options.signal, finish);
			} catch (error) {
				if (isAbort(error)) throw error;
				const tooBig = error instanceof PreStreamFailure && error.closeCode === MESSAGE_TOO_BIG;
				// A reused socket may have been closed by the provider while idle; one new connection settles it.
				if (reused && !tooBig && !retriedConnection) {
					retriedConnection = true;
					lane = undefined;
					continue;
				}
				// A frame too big for the socket goes over HTTP, compressed, without pinning the session to SSE.
				if (tooBig) return fallback("message_too_big");
				return failOver(error);
			}
			if (result.first.type === "error") {
				const code = errorCode(result.first);
				if (code === "previous_response_not_found" && delta && !retriedContinuation) {
					// The provider lost the connection's state; the same request goes again in full, once.
					retriedContinuation = true;
					lane = owned && owned.socket.readyState === OPEN ? owned : undefined;
					continue;
				}
				if (code === "websocket_connection_limit_reached" && !retriedConnection) {
					retriedConnection = true;
					lane = undefined;
					continue;
				}
				// Any other refusal before output: HTTP gives Pi the provider's status, retry hints and error body.
				return fallback("websocket_rejected");
			}
			if (healthId !== undefined) health.delete(healthId);
			const opened = reused ? undefined : handshakes.get(socket);
			const prefix = encoder.encode(
				[...result.head, result.first].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
			);
			const reader = result.rest.getReader();
			let sentPrefix = false;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (!sentPrefix) {
						sentPrefix = true;
						controller.enqueue(prefix);
						return;
					}
					try {
						const next = await reader.read();
						if (next.done) controller.close();
						else controller.enqueue(next.value);
					} catch (error) {
						controller.error(error);
					}
				},
				cancel(reason) {
					return reader.cancel(reason);
				},
			});
			const responseHeaders = new Headers();
			for (const [name, value] of Object.entries(opened ?? {})) {
				if (!/^(sec-websocket-|upgrade$|connection$)/u.test(name)) responseHeaders.set(name, value);
			}
			responseHeaders.set("content-type", "text/event-stream");
			return new Response(stream, { status: 200, headers: responseHeaders });
		}

		function markFailure(reason: string): void {
			call.counters.websocketFailures += 1;
			if (healthId === undefined) return;
			const failures = (health.get(healthId)?.failures ?? 0) + 1;
			const cooldown = Math.min(RESPONSES_WEBSOCKET_COOLDOWN_MS * 2 ** Math.min(failures - 1, 4), MAX_COOLDOWN_MS);
			health.set(healthId, { deadline: performance.now() + cooldown, failures, reason });
			call.fallbackActive = true;
			call.reason = reason;
			call.cooldownMs = cooldown;
			call.retryAt = new Date(Date.now() + cooldown).toISOString();
		}

		function failOver(_error: unknown): Promise<Response> {
			markFailure("transport_failure");
			return fallback("transport_failure");
		}
	}) as typeof globalThis.fetch;
}
