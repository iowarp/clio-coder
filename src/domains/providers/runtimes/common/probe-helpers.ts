import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { ProbeContext, ProbeResult } from "../../types/runtime-descriptor.js";

export interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown; status?: unknown }>;
}

export async function probeUrl(url: string, ctx: ProbeContext, method: "GET" | "HEAD" = "GET"): Promise<ProbeResult> {
	const base = { url, timeoutMs: ctx.httpTimeoutMs, method } as const;
	return ctx.signal ? probeHttp({ ...base, signal: ctx.signal }) : probeHttp(base);
}

export async function probeOpenAIModels(base: string, ctx: ProbeContext, modelsPath = "/v1/models"): Promise<string[]> {
	const opts = { url: `${base}${modelsPath}`, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OpenAIModelsResponse>(opts));
	if (!result.ok || !result.data?.data) return [];
	return result.data.data
		.map((row) => (typeof row?.id === "string" ? row.id : null))
		.filter((id): id is string => id !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelEntries(payload: OpenAIModelsResponse | undefined): Array<{ id: string; status?: unknown }> {
	if (!Array.isArray(payload?.data)) return [];
	const out: Array<{ id: string; status?: unknown }> = [];
	for (const row of payload.data) {
		if (typeof row?.id !== "string" || row.id.length === 0) continue;
		out.push({ id: row.id, status: row.status });
	}
	return out;
}

async function probeOpenAIModelEntries(
	base: string,
	ctx: ProbeContext,
): Promise<Array<{ id: string; status?: unknown }>> {
	const opts = { url: `${base}/v1/models`, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OpenAIModelsResponse>(opts));
	if (!result.ok) return [];
	return modelEntries(result.data);
}

interface LlamaCppProps {
	default_generation_settings?: { n_ctx?: unknown; n_predict?: unknown };
	modalities?: { vision?: unknown };
	build_info?: unknown;
}

export interface LlamaCppPropsEnrichment {
	discoveredCapabilities?: Partial<CapabilityFlags>;
	serverVersion?: string;
}

export interface LlamaCppServerFlags {
	contextSize?: number;
	maxTokens?: number;
	flashAttention?: boolean;
	cacheTypeK?: string;
	cacheTypeV?: string;
	jinja?: boolean;
	reasoning?: boolean;
	reasoningBudget?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	nGpuLayers?: number;
	parallel?: number;
	mmproj?: string;
	chatTemplateKwargs?: string;
}

export interface LlamaCppStatusEnrichment {
	discoveredCapabilities?: Partial<CapabilityFlags>;
	serverFlags?: LlamaCppServerFlags;
	notes?: string[];
}

function argsFromStatus(status: unknown): string[] {
	if (!isRecord(status)) return [];
	const args = status.args;
	if (Array.isArray(args)) return args.filter((entry): entry is string => typeof entry === "string");
	if (typeof args === "string") return args.trim().split(/\s+/).filter(Boolean);
	return [];
}

function valueAfter(args: ReadonlyArray<string>, flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	const value = args[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function numberFlag(args: ReadonlyArray<string>, flag: string): number | undefined {
	const value = valueAfter(args, flag);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFlag(args: ReadonlyArray<string>, flag: string): boolean | undefined {
	if (!args.includes(flag)) return undefined;
	const value = valueAfter(args, flag);
	if (value === undefined) return true;
	const normalized = value.toLowerCase();
	if (normalized === "true" || normalized === "on" || normalized === "1") return true;
	if (normalized === "false" || normalized === "off" || normalized === "0") return false;
	return undefined;
}

export function parseLlamaCppServerFlags(args: ReadonlyArray<string>): LlamaCppServerFlags {
	const flags: LlamaCppServerFlags = {};
	const ctxSize = numberFlag(args, "--ctx-size");
	if (ctxSize !== undefined) flags.contextSize = ctxSize;
	const maxTokens = numberFlag(args, "--n-predict");
	if (maxTokens !== undefined) flags.maxTokens = maxTokens;
	const flashAttention = booleanFlag(args, "--flash-attn");
	if (flashAttention !== undefined) flags.flashAttention = flashAttention;
	const jinja = booleanFlag(args, "--jinja");
	if (jinja !== undefined) flags.jinja = jinja;
	const reasoningRaw = valueAfter(args, "--reasoning");
	if (reasoningRaw) flags.reasoning = reasoningRaw === "on" || reasoningRaw === "true" || reasoningRaw === "1";
	const reasoningBudget = numberFlag(args, "--reasoning-budget");
	if (reasoningBudget !== undefined) flags.reasoningBudget = reasoningBudget;
	const temperature = numberFlag(args, "--temperature");
	if (temperature !== undefined) flags.temperature = temperature;
	const topP = numberFlag(args, "--top-p");
	if (topP !== undefined) flags.topP = topP;
	const topK = numberFlag(args, "--top-k");
	if (topK !== undefined) flags.topK = topK;
	const nGpuLayers = numberFlag(args, "--n-gpu-layers");
	if (nGpuLayers !== undefined) flags.nGpuLayers = nGpuLayers;
	const parallel = numberFlag(args, "--parallel");
	if (parallel !== undefined) flags.parallel = parallel;
	const cacheTypeK = valueAfter(args, "--cache-type-k");
	if (cacheTypeK) flags.cacheTypeK = cacheTypeK;
	const cacheTypeV = valueAfter(args, "--cache-type-v");
	if (cacheTypeV) flags.cacheTypeV = cacheTypeV;
	const mmproj = valueAfter(args, "--mmproj");
	if (mmproj) flags.mmproj = mmproj;
	const chatTemplateKwargs = valueAfter(args, "--chat-template-kwargs");
	if (chatTemplateKwargs) flags.chatTemplateKwargs = chatTemplateKwargs;
	return flags;
}

function selectedModelEntry(
	entries: ReadonlyArray<{ id: string; status?: unknown }>,
	endpoint: EndpointDescriptor,
): { id: string; status?: unknown } | null {
	const expected = endpoint.defaultModel?.trim();
	if (expected) return entries.find((entry) => entry.id === expected) ?? null;
	return entries[0] ?? null;
}

function statusNotes(id: string, status: unknown): string[] {
	if (!isRecord(status)) return [];
	const notes: string[] = [];
	if (status.failed === true) notes.push(`llama.cpp router marks ${id} as failed`);
	const state = typeof status.state === "string" ? status.state : undefined;
	if (state === "loading") notes.push(`llama.cpp router reports ${id} is still loading`);
	return notes;
}

export async function probeLlamaCppModelStatus(
	base: string,
	endpoint: EndpointDescriptor,
	ctx: ProbeContext,
): Promise<LlamaCppStatusEnrichment> {
	const entries = await probeOpenAIModelEntries(base, ctx);
	const selected = selectedModelEntry(entries, endpoint);
	if (!selected) return {};
	const args = argsFromStatus(selected.status);
	if (args.length === 0) return { notes: statusNotes(selected.id, selected.status) };
	const flags = parseLlamaCppServerFlags(args);
	const caps: Partial<CapabilityFlags> = {};
	if (flags.contextSize !== undefined && flags.contextSize > 0) caps.contextWindow = flags.contextSize;
	if (flags.maxTokens !== undefined && flags.maxTokens > 0) caps.maxTokens = flags.maxTokens;
	if (flags.reasoning === true || flags.reasoningBudget !== undefined) caps.reasoning = true;
	if (flags.mmproj) caps.vision = true;
	if (flags.jinja === true) caps.tools = true;
	const enrichment: LlamaCppStatusEnrichment = { serverFlags: flags };
	if (Object.keys(caps).length > 0) enrichment.discoveredCapabilities = caps;
	const notes = statusNotes(selected.id, selected.status);
	if (notes.length > 0) enrichment.notes = notes;
	return enrichment;
}

/**
 * llama.cpp serves a single fixed model per process. Compare the configured
 * wire model id against `/v1/models` so a mismatch surfaces as a probe note
 * instead of producing 404s or, worse, silent serves from the wrong weights.
 * Returns null when the comparison is inconclusive (probe failed, no default
 * model configured, server returned nothing).
 */
export async function detectModelMismatch(
	base: string,
	endpoint: EndpointDescriptor,
	ctx: ProbeContext,
): Promise<string | null> {
	const expected = endpoint.defaultModel?.trim();
	if (!expected) return null;
	const ids = await probeOpenAIModels(base, ctx);
	if (ids.length === 0) return null;
	if (ids.includes(expected)) return null;
	const loaded = ids[0] ?? "(unknown)";
	return `wire model id ${expected} does not match server's loaded model ${loaded}; llama.cpp serves a single fixed model`;
}

export async function probeLlamaCppProps(base: string, ctx: ProbeContext): Promise<LlamaCppPropsEnrichment> {
	const opts = { url: `${base}/props`, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<LlamaCppProps>({ ...opts, signal: ctx.signal })
		: probeJson<LlamaCppProps>(opts));
	if (!result.ok || !result.data) return {};
	const data = result.data;
	const enrichment: LlamaCppPropsEnrichment = {};
	const caps: Partial<CapabilityFlags> = {};
	const nCtx = data.default_generation_settings?.n_ctx;
	if (typeof nCtx === "number" && nCtx > 0) caps.contextWindow = nCtx;
	const nPredict = data.default_generation_settings?.n_predict;
	if (typeof nPredict === "number" && nPredict > 0) caps.maxTokens = nPredict;
	const vision = data.modalities?.vision;
	if (typeof vision === "boolean") caps.vision = vision;
	if (Object.keys(caps).length > 0) enrichment.discoveredCapabilities = caps;
	if (typeof data.build_info === "string" && data.build_info.length > 0) {
		enrichment.serverVersion = data.build_info;
	}
	return enrichment;
}
