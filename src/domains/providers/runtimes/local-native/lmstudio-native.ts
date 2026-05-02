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

interface LmStudioV0ModelsResponse {
	data?: unknown;
}

interface LmStudioV0ModelEntry {
	id?: unknown;
	loaded_context_length?: unknown;
	max_context_length?: unknown;
	type?: unknown;
	capabilities?: unknown;
}

interface LmStudioV1ModelsResponse {
	models?: unknown;
}

interface LmStudioV1ModelEntry {
	key?: unknown;
	type?: unknown;
	loaded_instances?: unknown;
	max_context_length?: unknown;
	capabilities?: unknown;
}

interface LmStudioModelSummary {
	id: string;
	loadedContextLength?: number;
	maxContextLength?: number;
	vision?: boolean;
	tools?: boolean;
	reasoning?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function v0ModelEntries(payload: LmStudioV0ModelsResponse | undefined): LmStudioV0ModelEntry[] {
	if (!Array.isArray(payload?.data)) return [];
	return payload.data.filter((row): row is LmStudioV0ModelEntry => isRecord(row));
}

function v1ModelEntries(payload: LmStudioV1ModelsResponse | undefined): LmStudioV1ModelEntry[] {
	if (!Array.isArray(payload?.models)) return [];
	return payload.models.filter((row): row is LmStudioV1ModelEntry => isRecord(row));
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function loadedContextFromV1Instance(value: unknown): number | undefined {
	if (!isRecord(value) || !isRecord(value.config)) return undefined;
	return positiveNumber(value.config.context_length);
}

function firstLoadedContextFromV1(entry: LmStudioV1ModelEntry): number | undefined {
	if (!Array.isArray(entry.loaded_instances)) return undefined;
	for (const instance of entry.loaded_instances) {
		const contextLength = loadedContextFromV1Instance(instance);
		if (contextLength !== undefined) return contextLength;
	}
	return undefined;
}

function capabilityObject(entry: LmStudioV1ModelEntry): Record<string, unknown> | null {
	return isRecord(entry.capabilities) ? entry.capabilities : null;
}

function v1Tools(entry: LmStudioV1ModelEntry): boolean | undefined {
	const caps = capabilityObject(entry);
	if (!caps) return undefined;
	return caps.trained_for_tool_use === true;
}

function v1Vision(entry: LmStudioV1ModelEntry): boolean | undefined {
	const caps = capabilityObject(entry);
	if (caps && typeof caps.vision === "boolean") return caps.vision;
	if (typeof entry.type === "string") return entry.type === "vlm";
	return undefined;
}

function v1Reasoning(entry: LmStudioV1ModelEntry): boolean | undefined {
	const caps = capabilityObject(entry);
	if (!caps || !("reasoning" in caps)) return undefined;
	const reasoning = caps.reasoning;
	if (typeof reasoning === "boolean") return reasoning;
	return isRecord(reasoning);
}

function summaryFromV1(entry: LmStudioV1ModelEntry): LmStudioModelSummary | null {
	if (typeof entry.key !== "string" || entry.key.trim().length === 0) return null;
	const summary: LmStudioModelSummary = { id: entry.key };
	const loadedContextLength = firstLoadedContextFromV1(entry);
	if (loadedContextLength !== undefined) summary.loadedContextLength = loadedContextLength;
	const maxContextLength = positiveNumber(entry.max_context_length);
	if (maxContextLength !== undefined) summary.maxContextLength = maxContextLength;
	const vision = v1Vision(entry);
	if (vision !== undefined) summary.vision = vision;
	const tools = v1Tools(entry);
	if (tools !== undefined) summary.tools = tools;
	const reasoning = v1Reasoning(entry);
	if (reasoning !== undefined) summary.reasoning = reasoning;
	return summary;
}

function summaryFromV0(entry: LmStudioV0ModelEntry): LmStudioModelSummary | null {
	if (typeof entry.id !== "string" || entry.id.trim().length === 0) return null;
	const summary: LmStudioModelSummary = { id: entry.id };
	const loadedContextLength = positiveNumber(entry.loaded_context_length);
	if (loadedContextLength !== undefined) summary.loadedContextLength = loadedContextLength;
	const maxContextLength = positiveNumber(entry.max_context_length);
	if (maxContextLength !== undefined) summary.maxContextLength = maxContextLength;
	if (typeof entry.type === "string") summary.vision = entry.type === "vlm";
	if (Array.isArray(entry.capabilities)) {
		summary.tools = entry.capabilities.some((capability) => capability === "tool_use");
	}
	return summary;
}

function selectCapabilityEntry(
	entries: ReadonlyArray<LmStudioModelSummary>,
	endpoint: EndpointDescriptor,
): LmStudioModelSummary | null {
	const configured = endpoint.defaultModel?.trim();
	if (configured) {
		return entries.find((entry) => entry.id === configured) ?? null;
	}
	return (
		entries.find((entry) => entry.loadedContextLength !== undefined) ??
		entries.find((entry) => entry.maxContextLength !== undefined) ??
		entries[0] ??
		null
	);
}

function capabilitiesFromModelEntry(entry: LmStudioModelSummary | null): Partial<CapabilityFlags> | undefined {
	if (!entry) return undefined;
	const caps: Partial<CapabilityFlags> = {};
	if (entry.vision !== undefined) caps.vision = entry.vision;
	if (entry.tools !== undefined) caps.tools = entry.tools;
	if (entry.reasoning !== undefined) caps.reasoning = entry.reasoning;
	const contextWindow = entry.loadedContextLength ?? entry.maxContextLength;
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
	const headers = modelsProbeHeaders(endpoint, ctx);
	const v1 = await probeApiV1Models(endpoint, ctx, headers);
	if (v1.ok) return v1;
	const v0 = await probeApiV0Models(endpoint, ctx, headers);
	return v0.ok ? v0 : v1;
}

async function probeApiV1Models(
	endpoint: EndpointDescriptor,
	ctx: ProbeContext,
	headers: Record<string, string> | undefined,
): Promise<ProbeResult> {
	const opts: { url: string; timeoutMs: number; headers?: Record<string, string> } = {
		url: `${toHttpUrl(endpoint.url ?? "")}/api/v1/models`,
		timeoutMs: ctx.httpTimeoutMs,
	};
	if (headers) opts.headers = headers;
	const result = await (ctx.signal
		? probeJson<LmStudioV1ModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<LmStudioV1ModelsResponse>(opts));
	if (!result.ok) return result;
	const entries = v1ModelEntries(result.data)
		.map(summaryFromV1)
		.filter((entry): entry is LmStudioModelSummary => entry !== null);
	return probeResultFromSummaries(entries, endpoint, result.latencyMs);
}

async function probeApiV0Models(
	endpoint: EndpointDescriptor,
	ctx: ProbeContext,
	headers: Record<string, string> | undefined,
): Promise<ProbeResult> {
	const opts: { url: string; timeoutMs: number; headers?: Record<string, string> } = {
		url: `${toHttpUrl(endpoint.url ?? "")}/api/v0/models`,
		timeoutMs: ctx.httpTimeoutMs,
	};
	if (headers) opts.headers = headers;
	const result = await (ctx.signal
		? probeJson<LmStudioV0ModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<LmStudioV0ModelsResponse>(opts));
	if (!result.ok) return result;
	const entries = v0ModelEntries(result.data)
		.map(summaryFromV0)
		.filter((entry): entry is LmStudioModelSummary => entry !== null);
	return probeResultFromSummaries(entries, endpoint, result.latencyMs);
}

function probeResultFromSummaries(
	entries: ReadonlyArray<LmStudioModelSummary>,
	endpoint: EndpointDescriptor,
	latencyMs: number | undefined,
): ProbeResult {
	const models = entries.map((entry) => entry.id);
	const discoveredCapabilities = capabilitiesFromModelEntry(selectCapabilityEntry(entries, endpoint));
	const out: ProbeResult = { ok: true, models };
	if (typeof latencyMs === "number") out.latencyMs = latencyMs;
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
