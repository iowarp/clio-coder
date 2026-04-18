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
	const { response, latencyMs, error } = await runFetch(opts);
	if (response === null) return { ok: false, error: error ?? "unknown transport error", latencyMs };
	const method = opts.method ?? "GET";
	if (response.ok) return { ok: true, latencyMs };
	// Some servers reject HEAD with 405 even though the endpoint is reachable.
	if (method === "HEAD" && response.status === 405) return { ok: true, latencyMs };
	return {
		ok: false,
		latencyMs,
		error: `HTTP ${response.status}: ${response.statusText}`,
	};
}

export async function probeJson<T = unknown>(
	opts: JsonProbeOptions,
): Promise<JsonProbeResult<T>> {
	const { response, latencyMs, error } = await runFetch(opts);
	if (response === null) return { ok: false, error: error ?? "unknown transport error", latencyMs };
	const method = opts.method ?? "GET";
	if (!response.ok && !(method === "HEAD" && response.status === 405)) {
		return {
			ok: false,
			latencyMs,
			error: `HTTP ${response.status}: ${response.statusText}`,
		};
	}
	let data: T;
	try {
		data = (await response.json()) as T;
	} catch (err) {
		return { ok: false, latencyMs, error: `JSON parse: ${describeError(err)}` };
	}
	return { ok: true, latencyMs, data };
}

interface FetchOutcome {
	response: Response | null;
	latencyMs: number;
	error?: string;
}

async function runFetch(opts: HttpProbeOptions): Promise<FetchOutcome> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, opts.timeoutMs);
	const onExternalAbort = () => controller.abort();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
	}
	const init: RequestInit = {
		method: opts.method ?? "GET",
		signal: controller.signal,
	};
	if (opts.headers) init.headers = opts.headers;
	if (opts.body !== undefined) init.body = opts.body;
	const started = performance.now();
	try {
		const response = await fetch(opts.url, init);
		return { response, latencyMs: Math.round(performance.now() - started) };
	} catch (err) {
		const latencyMs = Math.round(performance.now() - started);
		if (timedOut) {
			return { response: null, latencyMs, error: `timeout after ${opts.timeoutMs}ms` };
		}
		if (opts.signal?.aborted) {
			return { response: null, latencyMs, error: "aborted by caller" };
		}
		return { response: null, latencyMs, error: describeError(err) };
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
	}
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
