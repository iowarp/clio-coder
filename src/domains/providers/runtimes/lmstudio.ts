/**
 * LM Studio runtime adapter. Talks to any LM Studio server over its
 * OpenAI-compat `/v1/*` endpoints, plus LM Studio REST extensions at
 * `/api/v0/*` (`/api/v0/models` carries richer metadata than `/v1/models`).
 *
 * Probe order: try `/api/v0/models` first; fall back to `/v1/models` on 404.
 */

import type { EndpointSpec } from "../../../core/defaults.js";
import { initialHealth } from "../health.js";
import type { EndpointProbeResult, RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";
import { fetchJson, headersFromSpec, trimTrailingSlash } from "./local-http.js";

interface LmsModelListV0 {
	data?: Array<{ id: string; type?: string; state?: string }>;
}

interface OpenAIModelList {
	data?: Array<{ id: string }>;
}

export async function listModels(spec: EndpointSpec): Promise<string[]> {
	const base = trimTrailingSlash(spec.url);
	const v0 = await fetchJson<LmsModelListV0>(`${base}/api/v0/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	if (v0.ok && v0.body?.data) {
		return v0.body.data.map((m) => m.id);
	}
	const v1 = await fetchJson<OpenAIModelList>(`${base}/v1/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	return (v1.body?.data ?? []).map((m) => m.id);
}

async function probeOne(name: string, spec: EndpointSpec): Promise<EndpointProbeResult> {
	const base = trimTrailingSlash(spec.url);
	const v0 = await fetchJson<LmsModelListV0>(`${base}/api/v0/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	if (v0.ok && v0.body?.data) {
		return { name, url: spec.url, ok: true, latencyMs: v0.latencyMs, models: v0.body.data.map((m) => m.id) };
	}
	const v1 = await fetchJson<OpenAIModelList>(`${base}/v1/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	if (!v1.ok) {
		return {
			name,
			url: spec.url,
			ok: false,
			latencyMs: v1.latencyMs,
			error: v1.error ?? `HTTP ${v1.status}`,
		};
	}
	return { name, url: spec.url, ok: true, latencyMs: v1.latencyMs, models: (v1.body?.data ?? []).map((m) => m.id) };
}

export const lmstudioAdapter: RuntimeAdapter = {
	id: "lmstudio",
	tier: "native",
	canSatisfy({ endpoints }) {
		const count = endpoints ? Object.keys(endpoints).length : 0;
		if (count === 0) return { ok: false, reason: "no lmstudio endpoints configured" };
		return { ok: true, reason: `${count} endpoint(s) configured` };
	},
	initialHealth() {
		return initialHealth("lmstudio");
	},
	async probe({ endpoints } = {}): Promise<RuntimeProbeResult> {
		if (!endpoints || Object.keys(endpoints).length === 0) {
			return { ok: false, error: "no lmstudio endpoints configured" };
		}
		const results = await Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
		const healthy = results.filter((r) => r.ok).length;
		if (healthy === 0) return { ok: false, error: "no healthy lmstudio endpoints" };
		const latencies = results.filter((r) => r.ok).map((r) => r.latencyMs ?? 0);
		const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
		return { ok: true, latencyMs: avg };
	},
	async probeEndpoints(endpoints) {
		return Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
	},
};
