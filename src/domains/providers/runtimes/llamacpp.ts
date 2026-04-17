/**
 * llama.cpp runtime adapter. Talks to any `llama-server` process over its
 * OpenAI-compat `/v1/*` endpoints plus llama.cpp-specific `/health`, `/props`,
 * `/slots`, `/models/load`, `/models/unload`, `/tokenize`.
 *
 * Endpoints are supplied at probe time through settings; the adapter never
 * hard-codes a URL.
 */

import type { EndpointSpec } from "../../../core/defaults.js";
import { initialHealth } from "../health.js";
import type { EndpointProbeResult, RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";
import { fetchJson, headersFromSpec, trimTrailingSlash } from "./local-http.js";

interface OpenAIModelListItem {
	id: string;
	status?: { value?: string };
}

interface OpenAIModelList {
	data?: OpenAIModelListItem[];
}

export async function listModels(spec: EndpointSpec): Promise<string[]> {
	const base = trimTrailingSlash(spec.url);
	const result = await fetchJson<OpenAIModelList>(`${base}/v1/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	const data = result.body?.data ?? [];
	return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}

export async function probeLoaded(spec: EndpointSpec): Promise<string[]> {
	const base = trimTrailingSlash(spec.url);
	const result = await fetchJson<OpenAIModelList>(`${base}/v1/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	const data = result.body?.data ?? [];
	return data.filter((m) => m.status?.value === "loaded").map((m) => m.id);
}

async function probeOne(name: string, spec: EndpointSpec): Promise<EndpointProbeResult> {
	const base = trimTrailingSlash(spec.url);
	const health = await fetchJson(`${base}/health`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	if (!health.ok) {
		return {
			name,
			url: spec.url,
			ok: false,
			latencyMs: health.latencyMs,
			error: health.error ?? `HTTP ${health.status}`,
		};
	}
	const models = await listModels(spec);
	return { name, url: spec.url, ok: true, latencyMs: health.latencyMs, models };
}

export const llamacppAdapter: RuntimeAdapter = {
	id: "llamacpp",
	tier: "native",
	canSatisfy({ endpoints }) {
		const count = endpoints ? Object.keys(endpoints).length : 0;
		if (count === 0) return { ok: false, reason: "no llamacpp endpoints configured" };
		return { ok: true, reason: `${count} endpoint(s) configured` };
	},
	initialHealth() {
		return initialHealth("llamacpp");
	},
	async probe({ endpoints } = {}): Promise<RuntimeProbeResult> {
		if (!endpoints || Object.keys(endpoints).length === 0) {
			return { ok: false, error: "no llamacpp endpoints configured" };
		}
		const results = await Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
		const healthy = results.filter((r) => r.ok).length;
		if (healthy === 0) {
			return { ok: false, error: "no healthy llamacpp endpoints" };
		}
		const latencies = results.filter((r) => r.ok).map((r) => r.latencyMs ?? 0);
		const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
		return { ok: true, latencyMs: avg };
	},
	async probeEndpoints(endpoints) {
		return Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
	},
};
