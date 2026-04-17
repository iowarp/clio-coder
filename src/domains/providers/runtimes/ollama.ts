/**
 * Ollama runtime adapter. Talks to any Ollama instance through its native
 * `/api/tags` listing; chat/completions flow through Ollama's OpenAI-compat
 * `/v1/*` endpoints for v0.1.
 */

import type { EndpointSpec } from "../../../core/defaults.js";
import { initialHealth } from "../health.js";
import type { EndpointProbeResult, RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";
import { fetchJson, headersFromSpec, trimTrailingSlash } from "./local-http.js";

interface OllamaTagsResponse {
	models?: Array<{ name: string; model?: string }>;
}

export async function listModels(spec: EndpointSpec): Promise<string[]> {
	const base = trimTrailingSlash(spec.url);
	const result = await fetchJson<OllamaTagsResponse>(`${base}/api/tags`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	return (result.body?.models ?? []).map((m) => m.name);
}

/**
 * v0.2 placeholder. For now this throws so callers know they need to run
 * `ollama pull` externally. Wiring it in-process means streaming a large
 * blob over the local socket; punt.
 */
export async function pullModel(_spec: EndpointSpec, _modelId: string): Promise<void> {
	throw new Error("ollama pull is not implemented in v0.1; run `ollama pull <model>` on the host");
}

async function probeOne(name: string, spec: EndpointSpec): Promise<EndpointProbeResult> {
	const base = trimTrailingSlash(spec.url);
	const tags = await fetchJson<OllamaTagsResponse>(`${base}/api/tags`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	if (!tags.ok) {
		return {
			name,
			url: spec.url,
			ok: false,
			latencyMs: tags.latencyMs,
			error: tags.error ?? `HTTP ${tags.status}`,
		};
	}
	const models = (tags.body?.models ?? []).map((m) => m.name);
	if (models.length === 0) {
		return {
			name,
			url: spec.url,
			ok: false,
			latencyMs: tags.latencyMs,
			error: "no models installed",
		};
	}
	return { name, url: spec.url, ok: true, latencyMs: tags.latencyMs, models };
}

async function probeLiveEndpoints(endpoints: Record<string, EndpointSpec> | undefined): Promise<RuntimeProbeResult> {
	if (!endpoints || Object.keys(endpoints).length === 0) {
		return { ok: false, error: "no ollama endpoints configured" };
	}
	const results = await Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
	const healthy = results.filter((r) => r.ok).length;
	if (healthy === 0) return { ok: false, error: "no healthy ollama endpoints" };
	const latencies = results.filter((r) => r.ok).map((r) => r.latencyMs ?? 0);
	const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
	return { ok: true, latencyMs: avg };
}

export const ollamaAdapter: RuntimeAdapter = {
	id: "ollama",
	tier: "native",
	canSatisfy({ endpoints }) {
		const count = endpoints ? Object.keys(endpoints).length : 0;
		if (count === 0) return { ok: false, reason: "no ollama endpoints configured" };
		return { ok: true, reason: `${count} endpoint(s) configured` };
	},
	initialHealth() {
		return initialHealth("ollama");
	},
	async probe({ endpoints } = {}): Promise<RuntimeProbeResult> {
		return probeLiveEndpoints(endpoints);
	},
	async probeLive({ endpoints } = {}): Promise<RuntimeProbeResult> {
		return probeLiveEndpoints(endpoints);
	},
	async probeEndpoints(endpoints) {
		return Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
	},
};
