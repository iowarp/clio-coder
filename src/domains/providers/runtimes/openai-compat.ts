/**
 * Generic OpenAI-compatible runtime adapter. Fallback for any server that
 * exposes `/v1/chat/completions` but doesn't match llamacpp/lmstudio/ollama
 * specifics (SGLang, vLLM, tgi, custom). Probes only `/v1/models`.
 */

import type { EndpointSpec } from "../../../core/defaults.js";
import { initialHealth } from "../health.js";
import type { EndpointProbeResult, RuntimeAdapter, RuntimeProbeResult } from "../runtime-contract.js";
import { fetchJson, headersFromSpec, trimTrailingSlash } from "./local-http.js";

interface OpenAIModelList {
	data?: Array<{ id: string }>;
}

export async function listModels(spec: EndpointSpec): Promise<string[]> {
	const base = trimTrailingSlash(spec.url);
	const result = await fetchJson<OpenAIModelList>(`${base}/v1/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	return (result.body?.data ?? []).map((m) => m.id);
}

async function probeOne(name: string, spec: EndpointSpec): Promise<EndpointProbeResult> {
	const base = trimTrailingSlash(spec.url);
	const models = await fetchJson<OpenAIModelList>(`${base}/v1/models`, {
		headers: headersFromSpec(spec),
		apiKey: spec.api_key,
	});
	if (!models.ok) {
		return {
			name,
			url: spec.url,
			ok: false,
			latencyMs: models.latencyMs,
			error: models.error ?? `HTTP ${models.status}`,
		};
	}
	return {
		name,
		url: spec.url,
		ok: true,
		latencyMs: models.latencyMs,
		models: (models.body?.data ?? []).map((m) => m.id),
	};
}

async function probeLiveEndpoints(endpoints: Record<string, EndpointSpec> | undefined): Promise<RuntimeProbeResult> {
	if (!endpoints || Object.keys(endpoints).length === 0) {
		return { ok: false, error: "no openai-compat endpoints configured" };
	}
	const results = await Promise.all(Object.entries(endpoints).map(([name, spec]) => probeOne(name, spec)));
	const healthy = results.filter((r) => r.ok).length;
	if (healthy === 0) return { ok: false, error: "no healthy openai-compat endpoints" };
	const latencies = results.filter((r) => r.ok).map((r) => r.latencyMs ?? 0);
	const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
	return { ok: true, latencyMs: avg };
}

export const openaiCompatAdapter: RuntimeAdapter = {
	id: "openai-compat",
	tier: "native",
	canSatisfy({ endpoints }) {
		const count = endpoints ? Object.keys(endpoints).length : 0;
		if (count === 0) return { ok: false, reason: "no openai-compat endpoints configured" };
		return { ok: true, reason: `${count} endpoint(s) configured` };
	},
	initialHealth() {
		return initialHealth("openai-compat");
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
