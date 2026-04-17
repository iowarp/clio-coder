/**
 * Shared HTTP helpers for local-engine adapters (llamacpp, lmstudio, ollama,
 * openai-compat). Kept deliberately minimal: a single fetchJson with timeout
 * and a small error-normalising layer. No retries; callers aggregate.
 */

import type { EndpointSpec } from "../../../core/defaults.js";

export interface FetchJsonOpts {
	timeoutMs?: number;
	headers?: Record<string, string>;
	apiKey?: string | undefined;
}

export interface FetchJsonResult<T> {
	ok: boolean;
	status: number;
	body: T | null;
	latencyMs: number;
	error?: string;
}

export async function fetchJson<T = unknown>(
	url: string,
	{ timeoutMs = 2000, headers = {}, apiKey }: FetchJsonOpts = {},
): Promise<FetchJsonResult<T>> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const merged: Record<string, string> = { accept: "application/json", ...headers };
	if (apiKey && !("authorization" in merged) && !("Authorization" in merged)) {
		merged.Authorization = `Bearer ${apiKey}`;
	}
	try {
		const res = await fetch(url, { signal: controller.signal, headers: merged });
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			return { ok: false, status: res.status, body: null, latencyMs, error: `HTTP ${res.status}` };
		}
		const text = await res.text();
		if (text.length === 0) {
			return { ok: true, status: res.status, body: null, latencyMs };
		}
		try {
			return { ok: true, status: res.status, body: JSON.parse(text) as T, latencyMs };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, status: res.status, body: null, latencyMs, error: `invalid JSON: ${msg}` };
		}
	} catch (err) {
		const latencyMs = Date.now() - started;
		const msg = err instanceof Error ? err.message : String(err);
		const normalised = msg.includes("aborted") ? "timeout" : msg;
		return { ok: false, status: 0, body: null, latencyMs, error: normalised };
	} finally {
		clearTimeout(timer);
	}
}

export function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function headersFromSpec(spec: EndpointSpec): Record<string, string> {
	return { ...(spec.headers ?? {}) };
}
