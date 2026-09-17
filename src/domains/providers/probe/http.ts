import { performance } from "node:perf_hooks";

import type { ProbeResult } from "../types/runtime-descriptor.js";

export interface HttpProbeOptions {
	url: string;
	method?: "GET" | "HEAD" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export type JsonProbeOptions = HttpProbeOptions;

export interface JsonProbeResult<T = unknown> extends ProbeResult {
	data?: T;
}

export async function probeHttp(opts: HttpProbeOptions): Promise<ProbeResult> {
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
			await response.body?.cancel();
			controller.signal.throwIfAborted();
			return ok
				? { ok: true, latencyMs }
				: { ok: false, latencyMs, error: `HTTP ${response.status}: ${response.statusText}` };
		}
		parsingJson = true;
		const data = (await response.json()) as T;
		controller.signal.throwIfAborted();
		return { ok: true, latencyMs, data };
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
