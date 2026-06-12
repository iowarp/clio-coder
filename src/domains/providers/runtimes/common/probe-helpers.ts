import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult } from "../../types/runtime-descriptor.js";

export interface OpenAIModelsResponse {
	data?: Array<Record<string, unknown> & { id?: unknown; status?: unknown }>;
}

export async function probeUrl(url: string, ctx: ProbeContext, method: "GET" | "HEAD" = "GET"): Promise<ProbeResult> {
	const base = { url, timeoutMs: ctx.httpTimeoutMs, method } as const;
	return ctx.signal ? probeHttp({ ...base, signal: ctx.signal }) : probeHttp(base);
}

export async function probeOpenAIModels(base: string, ctx: ProbeContext, modelsPath = "/v1/models"): Promise<string[]> {
	return (await probeOpenAIModelCatalog(base, ctx, modelsPath)).models;
}

export interface OpenAIModelCatalogProbe {
	models: string[];
	modelCapabilities: Record<string, Partial<CapabilityFlags>>;
	modelStates: Record<string, ProbeModelStatus>;
}

export async function probeOpenAIModelCatalog(
	base: string,
	ctx: ProbeContext,
	modelsPath = "/v1/models",
): Promise<OpenAIModelCatalogProbe> {
	const opts = { url: `${base}${modelsPath}`, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OpenAIModelsResponse>(opts));
	if (!result.ok || !result.data?.data) return { models: [], modelCapabilities: {}, modelStates: {} };
	const models: string[] = [];
	const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
	const modelStates: Record<string, ProbeModelStatus> = {};
	for (const row of result.data.data) {
		if (typeof row?.id !== "string" || row.id.length === 0) continue;
		models.push(row.id);
		const caps = capabilitiesFromOpenAIModelEntry(row);
		if (Object.keys(caps).length > 0) modelCapabilities[row.id] = caps;
		const state = modelStateFromOpenAIModelEntry(row);
		if (state) modelStates[row.id] = state;
	}
	return { models, modelCapabilities, modelStates };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstPositiveNumber(record: Record<string, unknown>, keys: ReadonlyArray<string>): number | undefined {
	for (const key of keys) {
		const value = positiveNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function booleanFromAny(record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return isRecord(value) ? value : null;
}

function firstString(record: Record<string, unknown> | null, keys: ReadonlyArray<string>): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function firstBoolean(record: Record<string, unknown> | null, keys: ReadonlyArray<string>): boolean | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function normalizeModelState(raw: string | undefined): ProbeModelStatus["state"] | undefined {
	const value = raw
		?.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	if (!value) return undefined;
	if (value === "loaded" || value === "ready" || value === "running" || value === "active") return "loaded";
	if (value === "loading" || value === "pending" || value === "queued" || value === "starting") return "loading";
	if (value === "unloaded" || value === "not-loaded" || value === "idle" || value === "stopped") return "unloaded";
	if (value === "failed" || value === "error" || value === "errored") return "failed";
	if (value === "unknown") return "unknown";
	return undefined;
}

function modelStateFromOpenAIModelEntry(row: Record<string, unknown>): ProbeModelStatus | undefined {
	const status = nestedRecord(row, "status");
	const failed = firstBoolean(status, ["failed"]) ?? firstBoolean(row, ["failed"]);
	if (failed === true) {
		const detail =
			firstString(status, ["error", "reason", "message"]) ?? firstString(row, ["error", "reason", "message"]);
		return detail ? { state: "failed", detail } : { state: "failed" };
	}
	const raw =
		typeof row.status === "string"
			? row.status
			: (firstString(status, ["value", "state", "status"]) ?? firstString(row, ["state"]));
	const normalized = normalizeModelState(raw);
	if (normalized) {
		const detail = firstString(status, ["detail", "message", "reason"]);
		return detail ? { state: normalized, detail } : { state: normalized };
	}
	const loaded = firstBoolean(status, ["loaded"]) ?? firstBoolean(row, ["loaded"]);
	if (loaded === true) return { state: "loaded" };
	if (loaded === false) return { state: "unloaded" };
	return undefined;
}

function statusArgsFromEntry(row: Record<string, unknown>): string[] {
	const status = nestedRecord(row, "status");
	return argsFromStatus(status);
}

function capabilitiesFromOpenAIModelEntry(row: Record<string, unknown>): Partial<CapabilityFlags> {
	const caps: Partial<CapabilityFlags> = {};
	const meta = nestedRecord(row, "meta");
	const flags = parseLlamaCppServerFlags(statusArgsFromEntry(row));
	const contextWindow =
		positiveNumber(flags.contextSize) ??
		firstPositiveNumber(row, [
			"context_window",
			"contextWindow",
			"context_length",
			"contextLength",
			"max_context_length",
			"maxContextLength",
			"n_ctx",
		]) ??
		(meta ? firstPositiveNumber(meta, ["n_ctx", "n_ctx_train", "context_length", "contextWindow"]) : undefined);
	if (contextWindow !== undefined) caps.contextWindow = Math.floor(contextWindow);
	const maxTokens =
		positiveNumber(flags.maxTokens) ??
		firstPositiveNumber(row, [
			"max_output_tokens",
			"maxOutputTokens",
			"max_completion_tokens",
			"maxCompletionTokens",
			"max_tokens",
			"maxTokens",
			"n_predict",
		]);
	if (maxTokens !== undefined) caps.maxTokens = Math.floor(maxTokens);
	const tools = flags.jinja ?? booleanFromAny(row, ["tools", "tool_use", "toolUse", "trained_for_tool_use"]);
	if (tools !== undefined) caps.tools = tools;
	const reasoning =
		flags.reasoning ??
		(flags.reasoningBudget !== undefined ? true : undefined) ??
		booleanFromAny(row, ["reasoning", "thinking"]);
	if (reasoning !== undefined) caps.reasoning = reasoning;
	const architecture = nestedRecord(row, "architecture");
	const architectureInput = architecture?.input_modalities;
	const modalities = Array.isArray(row.modalities)
		? row.modalities
		: Array.isArray(row.input)
			? row.input
			: Array.isArray(architectureInput)
				? architectureInput
				: null;
	if (modalities) {
		caps.vision = modalities.some((entry) => entry === "image" || entry === "vision");
		if (modalities.some((entry) => entry === "audio")) caps.audio = true;
	}
	return caps;
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
	modelId?: string;
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
	const enrichment: LlamaCppStatusEnrichment = { modelId: selected.id, serverFlags: flags };
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
