import { LMStudioClient } from "@lmstudio/sdk";
import type { Api, Model } from "@mariozechner/pi-ai";

import { mergeCapabilities } from "../../capabilities.js";
import { probeJson } from "../../probe/http.js";
import { type CapabilityFlags, EMPTY_CAPABILITIES } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { type ClioLocalModelMetadata, endpointLifecycle, stripTrailingSlash } from "../common/local-synth.js";

const defaultCapabilities: CapabilityFlags = {
	...EMPTY_CAPABILITIES,
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	vision: true,
	structuredOutputs: "json-schema",
	contextWindow: 8192,
	maxTokens: 4096,
};

function toWebSocketUrl(url: string): string {
	const trimmed = stripTrailingSlash(url);
	if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
	if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
	if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
	return `ws://${trimmed}`;
}

function toHttpUrl(url: string): string {
	const trimmed = stripTrailingSlash(url);
	if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
	if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
	return `http://${trimmed}`;
}

function buildClient(endpoint: EndpointDescriptor, ctx: ProbeContext): LMStudioClient | { error: string } {
	if (!endpoint.url) return { error: "endpoint has no url" };
	try {
		const opts: ConstructorParameters<typeof LMStudioClient>[0] = {
			baseUrl: toWebSocketUrl(endpoint.url),
		};
		const auth = endpoint.auth;
		const envName = auth?.apiKeyEnvVar;
		if (envName && ctx.credentialsPresent.has(envName)) {
			const value = process.env[envName];
			if (value) opts.clientPasskey = value;
		}
		return new LMStudioClient(opts);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted by caller"));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new Error("aborted by caller"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		task
			.then((value) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve(value);
			})
			.catch((err) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				reject(err);
			});
	});
}

interface LmStudioModelsResponse {
	data?: unknown;
}

interface LmStudioModelEntry {
	id?: unknown;
	loaded_context_length?: unknown;
	max_context_length?: unknown;
	type?: unknown;
	capabilities?: unknown;
}

function modelEntries(payload: LmStudioModelsResponse | undefined): LmStudioModelEntry[] {
	if (!Array.isArray(payload?.data)) return [];
	return payload.data.filter((row): row is LmStudioModelEntry => row !== null && typeof row === "object");
}

function modelId(entry: LmStudioModelEntry): string | null {
	return typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : null;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function selectCapabilityEntry(
	entries: ReadonlyArray<LmStudioModelEntry>,
	endpoint: EndpointDescriptor,
): LmStudioModelEntry | null {
	const configured = endpoint.defaultModel?.trim();
	if (configured) {
		return entries.find((entry) => modelId(entry) === configured) ?? null;
	}
	return (
		entries.find((entry) => positiveNumber(entry.loaded_context_length) !== undefined) ??
		entries.find((entry) => positiveNumber(entry.max_context_length) !== undefined) ??
		entries[0] ??
		null
	);
}

function capabilitiesFromModelEntry(entry: LmStudioModelEntry | null): Partial<CapabilityFlags> | undefined {
	if (!entry) return undefined;
	const caps: Partial<CapabilityFlags> = {
		vision: entry.type === "vlm",
		tools: Array.isArray(entry.capabilities) && entry.capabilities.some((capability) => capability === "tool_use"),
	};
	const contextWindow = positiveNumber(entry.loaded_context_length) ?? positiveNumber(entry.max_context_length);
	if (contextWindow !== undefined) caps.contextWindow = contextWindow;
	return caps;
}

function modelsProbeHeaders(endpoint: EndpointDescriptor, ctx: ProbeContext): Record<string, string> | undefined {
	const headers: Record<string, string> = { ...(endpoint.auth?.headers ?? {}) };
	const envName = endpoint.auth?.apiKeyEnvVar;
	if (envName && ctx.credentialsPresent.has(envName)) {
		const key = process.env[envName]?.trim();
		if (key) headers.authorization = `Bearer ${key}`;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

async function probeApiModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	if (!endpoint.url) return { ok: false, error: "endpoint has no url" };
	const opts: { url: string; timeoutMs: number; headers?: Record<string, string> } = {
		url: `${toHttpUrl(endpoint.url)}/api/v0/models`,
		timeoutMs: ctx.httpTimeoutMs,
	};
	const headers = modelsProbeHeaders(endpoint, ctx);
	if (headers) opts.headers = headers;
	const result = await (ctx.signal
		? probeJson<LmStudioModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<LmStudioModelsResponse>(opts));
	if (!result.ok) return result;
	const entries = modelEntries(result.data);
	const models = entries.map(modelId).filter((id): id is string => id !== null);
	const discoveredCapabilities = capabilitiesFromModelEntry(selectCapabilityEntry(entries, endpoint));
	const out: ProbeResult = { ok: true, models };
	if (typeof result.latencyMs === "number") out.latencyMs = result.latencyMs;
	if (discoveredCapabilities) out.discoveredCapabilities = discoveredCapabilities;
	return out;
}

const lmstudioNativeRuntime: RuntimeDescriptor = {
	id: "lmstudio-native",
	displayName: "LM Studio (native SDK)",
	kind: "http",
	tier: "local-native",
	apiFamily: "lmstudio-native",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint, ctx): Promise<ProbeResult> {
		const built = buildClient(endpoint, ctx);
		if ("error" in built) return { ok: false, error: built.error };
		const client = built;
		const started = Date.now();
		try {
			const [version, apiModels] = await Promise.all([
				withTimeout(client.system.getLMStudioVersion(), ctx.httpTimeoutMs, ctx.signal),
				probeApiModels(endpoint, ctx),
			]);
			const latencyMs = Date.now() - started;
			const result: ProbeResult = { ok: true, latencyMs, serverVersion: version.version };
			if (apiModels.ok) {
				if (apiModels.models) result.models = apiModels.models;
				if (apiModels.discoveredCapabilities) result.discoveredCapabilities = apiModels.discoveredCapabilities;
			}
			return result;
		} catch (err) {
			return {
				ok: false,
				latencyMs: Date.now() - started,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
	async probeModels(endpoint, ctx): Promise<string[]> {
		const built = buildClient(endpoint, ctx);
		if ("error" in built) return [];
		const client = built;
		try {
			const [downloaded, loaded] = await Promise.all([
				withTimeout(client.system.listDownloadedModels("llm"), ctx.httpTimeoutMs, ctx.signal),
				withTimeout(client.llm.listLoaded(), ctx.httpTimeoutMs, ctx.signal),
			]);
			const keys = new Set<string>();
			for (const info of downloaded) keys.add(info.modelKey);
			for (const llm of loaded) keys.add(llm.modelKey);
			return [...keys];
		} catch {
			return [];
		}
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const caps = mergeCapabilities(
			defaultCapabilities,
			kb?.entry.capabilities ?? null,
			null,
			endpoint.capabilities ?? null,
		);
		const baseUrl = endpoint.url ? toWebSocketUrl(endpoint.url) : "";
		const pricing = endpoint.pricing;
		const model: Model<Api> & ClioLocalModelMetadata = {
			id: wireModelId,
			name: `${wireModelId} (${endpoint.id})`,
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl,
			reasoning: caps.reasoning,
			input: caps.vision ? ["text", "image"] : ["text"],
			cost: {
				input: pricing?.input ?? 0,
				output: pricing?.output ?? 0,
				cacheRead: pricing?.cacheRead ?? 0,
				cacheWrite: pricing?.cacheWrite ?? 0,
			},
			contextWindow: caps.contextWindow,
			maxTokens: caps.maxTokens,
			clio: {
				targetId: endpoint.id,
				runtimeId: endpoint.runtime,
				lifecycle: endpointLifecycle(endpoint),
				...(endpoint.gateway === true ? { gateway: true } : {}),
			},
		};
		const headers = endpoint.auth?.headers;
		if (headers) model.headers = headers;
		return model;
	},
};

export default lmstudioNativeRuntime;
