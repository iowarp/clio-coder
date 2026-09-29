import { performance } from "node:perf_hooks";

import type { ProbeResult } from "../types/runtime-descriptor.js";

export interface HttpProbeOptions {
	url: string;
	method?: "GET" | "HEAD" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/**
	 * Keep the start of a non-2xx body in {@link JsonProbeResult.errorBody}.
	 * Off by default so every other probe cancels an unread error stream at once.
	 */
	readErrorBody?: boolean;
}

export type JsonProbeOptions = HttpProbeOptions;

export interface HttpProbeResult extends ProbeResult {
	/** Status of a completed HTTP response; absent when body/transport work fails. */
	status?: number;
}

export interface JsonProbeResult<T = unknown> extends HttpProbeResult {
	data?: T;
	/**
	 * The first {@link ERROR_BODY_LIMIT} bytes of a non-2xx response, so a caller
	 * can tell a 422 that names a rejected `response_format` from one that names
	 * a bad question. Absent when the body was empty or unreadable.
	 */
	errorBody?: string;
}

/** Enough for a provider's error JSON, small enough that a failing server cannot make a probe buffer a page. */
export const ERROR_BODY_LIMIT = 2048;

export async function probeHttp(opts: HttpProbeOptions): Promise<HttpProbeResult> {
	return runProbe(opts, false);
}

export async function probeJson<T = unknown>(opts: JsonProbeOptions): Promise<JsonProbeResult<T>> {
	return runProbe<T>(opts, true);
}

/** Own the request until its body has been consumed or cancelled. */
async function runProbe<T>(opts: HttpProbeOptions, readJson: boolean): Promise<JsonProbeResult<T>> {
	const controller = new AbortController();
	let abortError: string | undefined;
	const abort = (error: string): void => {
		if (controller.signal.aborted) return;
		abortError = error;
		controller.abort();
	};
	const timer = setTimeout(() => abort(`timeout after ${opts.timeoutMs}ms`), opts.timeoutMs);
	const onExternalAbort = () => abort("aborted by caller");
	if (opts.signal?.aborted) onExternalAbort();
	else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const method = opts.method ?? "GET";
	const init: RequestInit = { method, signal: controller.signal };
	if (opts.headers) init.headers = opts.headers;
	if (opts.body !== undefined) init.body = opts.body;
	const started = performance.now();
	let latencyMs: number | undefined;
	let parsingJson = false;
	try {
		const response = await fetch(opts.url, init);
		// Preserve the existing network latency measurement at response headers.
		latencyMs = Math.round(performance.now() - started);
		// HEAD 405 demonstrates reachability, but does not supply JSON data.
		const ok = response.ok || (method === "HEAD" && response.status === 405);
		if (!ok || !readJson) {
			// The bounded reader cancels the stream itself; cancelling a locked one throws.
			let errorBody = "";
			if (!ok && readJson && opts.readErrorBody === true) errorBody = await readBoundedBody(response);
			else await response.body?.cancel();
			controller.signal.throwIfAborted();
			return ok
				? { ok: true, latencyMs, status: response.status }
				: {
						ok: false,
						latencyMs,
						status: response.status,
						error: `HTTP ${response.status}: ${response.statusText}`,
						...(errorBody === "" ? {} : { errorBody }),
					};
		}
		parsingJson = true;
		const data = (await response.json()) as T;
		controller.signal.throwIfAborted();
		return { ok: true, latencyMs, status: response.status, data };
	} catch (err) {
		return {
			ok: false,
			latencyMs: latencyMs ?? Math.round(performance.now() - started),
			error: abortError ?? `${parsingJson ? "JSON parse: " : ""}${describeError(err)}`,
		};
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onExternalAbort);
	}
}

/**
 * How long an error body may take to arrive after its headers. A server that
 * holds the stream open must not delay the failure past the probe's own deadline.
 */
const ERROR_BODY_GRACE_MS = 50;

/** Read at most {@link ERROR_BODY_LIMIT} bytes of a response body within the grace window, then cancel the rest. */
async function readBoundedBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder("utf-8");
	let text = "";
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), ERROR_BODY_GRACE_MS);
	});
	try {
		while (text.length < ERROR_BODY_LIMIT) {
			const next = await Promise.race([reader.read(), expired]);
			if (next === "expired" || next.done) break;
			text += decoder.decode(next.value, { stream: true });
		}
	} catch {
		// The status line already says the request failed; a body that will not
		// read (abort, reset) leaves the caller with that and nothing more.
	} finally {
		clearTimeout(timer);
		await reader.cancel().catch(() => {
			// Cancelling a stream that already errored has nothing left to release.
		});
	}
	return text.slice(0, ERROR_BODY_LIMIT).trim();
}

/**
 * The actionable half of a transport failure.
 *
 * undici reports every one of them as the same two words, `fetch failed`, and
 * puts the part a user can act on onto `cause`: ECONNREFUSED, ENOTFOUND,
 * ECONNRESET, and the TLS errors all arrive that way. Surfacing only the
 * wrapper tells someone that something failed and nothing whatsoever about
 * what, which is the difference between a wrong port and a wrong hostname.
 */
function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	if (cause instanceof Error && cause.message.length > 0) {
		const code = (cause as { code?: unknown }).code;
		return typeof code === "string" && !cause.message.includes(code) ? `${cause.message} (${code})` : cause.message;
	}
	return err.message;
}
