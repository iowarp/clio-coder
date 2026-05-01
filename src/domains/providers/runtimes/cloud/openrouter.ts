import type { Api, Model } from "@mariozechner/pi-ai";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_HEADERS = {
	"HTTP-Referer": "https://github.com/iowarp/clio-coder",
	"X-OpenRouter-Title": "Clio Coder",
};

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	thinkingFormat: "openrouter",
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 128000,
	maxTokens: 8192,
};

interface OpenRouterModelsResponse {
	data?: Array<{ id?: unknown }>;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function endpointBase(endpoint: EndpointDescriptor): string {
	return trimTrailingSlash(endpoint.url ?? OPENROUTER_BASE_URL);
}

function modelsUrl(endpoint: EndpointDescriptor): string {
	return `${endpointBase(endpoint)}/models`;
}

function probeHeaders(endpoint: EndpointDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers: Record<string, string> = { ...OPENROUTER_HEADERS, ...(endpoint.auth?.headers ?? {}) };
	const envName = endpoint.auth?.apiKeyEnvVar ?? "OPENROUTER_API_KEY";
	if (ctx.credentialsPresent.has(envName)) {
		const key = process.env[envName]?.trim();
		if (key) headers.authorization = `Bearer ${key}`;
	}
	return headers;
}

async function fetchModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	const opts = {
		url: modelsUrl(endpoint),
		timeoutMs: ctx.httpTimeoutMs,
		headers: probeHeaders(endpoint, ctx),
	} as const;
	const result = await (ctx.signal
		? probeJson<OpenRouterModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OpenRouterModelsResponse>(opts));
	if (!result.ok) return result;
	const models = (result.data?.data ?? [])
		.map((row) => (typeof row?.id === "string" ? row.id : null))
		.filter((id): id is string => id !== null);
	const out: ProbeResult = { ok: true, models };
	if (result.latencyMs !== undefined) out.latencyMs = result.latencyMs;
	const configured = endpoint.defaultModel?.trim();
	if (configured && models.length > 0 && !models.includes(configured)) {
		out.ok = false;
		out.error = `configured model '${configured}' was not returned by OpenRouter`;
	}
	return out;
}

const openrouterRuntime: RuntimeDescriptor = {
	id: "openrouter",
	displayName: "OpenRouter",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "OPENROUTER_API_KEY",
	defaultCapabilities,
	probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return fetchModels(endpoint, ctx);
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const result = await fetchModels(endpoint, ctx);
		return result.ok && result.models ? [...result.models] : [];
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "openrouter",
			api: "openai-completions",
			provider: "openrouter",
			defaultBaseUrl: OPENROUTER_BASE_URL,
			defaultHeaders: OPENROUTER_HEADERS,
		});
	},
};

export default openrouterRuntime;
