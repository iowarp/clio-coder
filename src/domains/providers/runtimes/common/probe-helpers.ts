import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import { type ContextWindowSlots, formatContextWindowSlots } from "../../types/context-window-slots.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

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

/**
 * Vendor detail endpoints that describe the same models `/v1/models` lists,
 * with the numbers `/v1/models` omits. LM Studio's `/api/v0/models` reports
 * `max_context_length`, `loaded_context_length`, `state`, and `capabilities`;
 * the OpenAI schema has nowhere to put any of them, so a self-hosted LM Studio
 * reached over `openai-compat` looks like a target that declared nothing and
 * Clio has to assume a window instead of reading one. Asking costs one GET
 * that 404s harmlessly on servers that do not implement it.
 */
const OPENAI_COMPAT_DETAIL_PATHS: ReadonlyArray<string> = ["/api/v0/models"];

async function probeModelDetailRows(
	base: string,
	ctx: ProbeContext,
	modelsPath: string,
): Promise<Map<string, Record<string, unknown>>> {
	const rows = new Map<string, Record<string, unknown>>();
	for (const detailPath of OPENAI_COMPAT_DETAIL_PATHS) {
		if (detailPath === modelsPath) continue;
		const opts = { url: `${base}${detailPath}`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OpenAIModelsResponse>(opts));
		if (!result.ok || !Array.isArray(result.data?.data)) continue;
		for (const row of result.data.data) {
			if (typeof row?.id !== "string" || row.id.length === 0) continue;
			if (!rows.has(row.id)) rows.set(row.id, row);
		}
		if (rows.size > 0) break;
	}
	return rows;
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
	const detail = await probeModelDetailRows(base, ctx, modelsPath);
	const models: string[] = [];
	const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
	const modelStates: Record<string, ProbeModelStatus> = {};
	for (const row of result.data.data) {
		if (typeof row?.id !== "string" || row.id.length === 0) continue;
		models.push(row.id);
		const detailRow = detail.get(row.id);
		// The listing row wins on any field it fills. It is the endpoint the
		// target chose to serve as canonical; the detail row only answers the
		// questions the OpenAI schema cannot ask.
		const caps = {
			...(detailRow ? capabilitiesFromOpenAIModelEntry(detailRow) : {}),
			...capabilitiesFromOpenAIModelEntry(row),
		};
		if (Object.keys(caps).length > 0) modelCapabilities[row.id] = caps;
		const loadedContext = loadedContextFromEntry(row) ?? (detailRow ? loadedContextFromEntry(detailRow) : undefined);
		const state =
			modelStateFromOpenAIModelEntry(row) ??
			(detailRow ? modelStateFromOpenAIModelEntry(detailRow) : undefined) ??
			// A reported loaded context is itself the residency answer: nothing
			// serves a window for a model it has not loaded.
			(loadedContext !== undefined ? { state: "loaded" as const } : undefined);
		// The slot split rides on the load-state record because it is the same
		// kind of fact: how this server is serving this model. A row with no
		// recognized state still gets one, as `unknown`, so the split is kept
		// without claiming residency the server did not report.
		const contextSlots = contextSlotsFromEntry(row) ?? (detailRow ? contextSlotsFromEntry(detailRow) : undefined);
		const withSlots = contextSlots ? { ...(state ?? { state: "unknown" as const }), contextSlots } : state;
		if (withSlots) {
			modelStates[row.id] = loadedContext === undefined ? withSlots : { ...withSlots, contextLength: loadedContext };
		}
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

/**
 * `capabilities: ["tool_use"]`, the shape LM Studio uses. A listed capability
 * is a claim of support; an absent one is silence, not a denial, so this
 * returns true or undefined and never false.
 */
function capabilityListFlag(record: Record<string, unknown>, name: string): true | undefined {
	const list = record.capabilities;
	if (!Array.isArray(list)) return undefined;
	return list.some((entry) => entry === name) ? true : undefined;
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
	if (
		value === "unloaded" ||
		value === "not-loaded" ||
		value === "idle" ||
		value === "sleeping" ||
		value === "stopped"
	) {
		return "unloaded";
	}
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

/**
 * The window a server has this model open at, as distinct from the window the
 * model could support. Only the loaded keys count here: `max_context_length` is
 * a fact about the weights, not about what is serving.
 */
function loadedContextFromEntry(row: Record<string, unknown>): number | undefined {
	const reported = firstPositiveNumber(row, ["loaded_context_length", "loadedContextLength"]);
	return reported === undefined ? undefined : Math.floor(reported);
}

function statusArgsFromEntry(row: Record<string, unknown>): string[] {
	const status = nestedRecord(row, "status");
	return argsFromStatus(status);
}

function contextSlotsFromEntry(row: Record<string, unknown>): ContextWindowSlots | undefined {
	return llamaCppRequestContextWindow(parseLlamaCppServerFlags(statusArgsFromEntry(row)))?.slots;
}

function capabilitiesFromOpenAIModelEntry(row: Record<string, unknown>): Partial<CapabilityFlags> {
	const caps: Partial<CapabilityFlags> = {};
	const meta = nestedRecord(row, "meta");
	const flags = parseLlamaCppServerFlags(statusArgsFromEntry(row));
	const contextWindow =
		llamaCppRequestContextWindow(flags)?.contextWindow ??
		firstPositiveNumber(row, [
			// What is actually loaded outranks what the model could support: a
			// model served at 8k out of a possible 262k has an 8k window today,
			// and the run has to be planned against the real one.
			"loaded_context_length",
			"loadedContextLength",
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
	const tools =
		flags.jinja ??
		booleanFromAny(row, ["tools", "tool_use", "toolUse", "trained_for_tool_use"]) ??
		capabilityListFlag(row, "tool_use");
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
	total_slots?: unknown;
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
	/** `--kv-unified` / `-kvu` true, `--no-kv-unified` false, absent when neither was given. */
	kvUnified?: boolean;
	mmproj?: string;
	chatTemplateKwargs?: string;
}

export interface LlamaCppRequestContextWindow {
	/** What one request can use. */
	contextWindow: number;
	/** Present when `contextWindow` is a quotient of the server's total. */
	slots?: ContextWindowSlots;
}

/**
 * The window one request actually gets from a llama.cpp server.
 *
 * `--ctx-size` is the total KV budget of the process. Without `--kv-unified`
 * the server splits it evenly across `--parallel` slots, so a router started
 * with `--ctx-size 786432 --parallel 4 --no-kv-unified` admits 196,608 tokens
 * per request while reporting 786,432 as its context size. Reading the total
 * as the window armed autocompact at a number the server would never admit
 * and walked a long session into a hard context failure with the meter at
 * 25% (issue #187). With `--kv-unified` every slot shares one sequence and
 * the total is the window.
 */
function llamaCppRequestContextWindow(flags: LlamaCppServerFlags): LlamaCppRequestContextWindow | undefined {
	const total = positiveNumber(flags.contextSize);
	if (total === undefined) return undefined;
	const parallel = positiveNumber(flags.parallel);
	if (parallel === undefined || parallel <= 1 || flags.kvUnified === true) return { contextWindow: Math.floor(total) };
	const slots = Math.floor(parallel);
	return {
		contextWindow: Math.floor(total / slots),
		slots: { totalContextSize: Math.floor(total), slots },
	};
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

/** `-1` is a value (`--reasoning-budget -1`); `-np` and `--jinja` are flags. */
function looksLikeFlag(token: string): boolean {
	return token.startsWith("-") && Number.isNaN(Number(token));
}

/**
 * The value after the first of `flags` present, or undefined. A token that
 * reads as the next flag is not a value, which is how boolean flags read as
 * present-without-value. Short spellings (`-c`, `-np`) come after the long
 * one so the long form wins when both are given.
 */
function valueAfter(args: ReadonlyArray<string>, ...flags: ReadonlyArray<string>): string | undefined {
	for (const flag of flags) {
		const index = args.indexOf(flag);
		if (index < 0) continue;
		const value = args[index + 1];
		return value && !looksLikeFlag(value) ? value : undefined;
	}
	return undefined;
}

function numberFlag(args: ReadonlyArray<string>, ...flags: ReadonlyArray<string>): number | undefined {
	const value = valueAfter(args, ...flags);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFlag(args: ReadonlyArray<string>, ...flags: ReadonlyArray<string>): boolean | undefined {
	const flag = flags.find((candidate) => args.includes(candidate));
	if (flag === undefined) return undefined;
	const value = valueAfter(args, flag);
	if (value === undefined) return true;
	const normalized = value.toLowerCase();
	if (normalized === "true" || normalized === "on" || normalized === "1") return true;
	if (normalized === "false" || normalized === "off" || normalized === "0") return false;
	return undefined;
}

function parseLlamaCppServerFlags(args: ReadonlyArray<string>): LlamaCppServerFlags {
	const flags: LlamaCppServerFlags = {};
	const ctxSize = numberFlag(args, "--ctx-size", "-c");
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
	const parallel = numberFlag(args, "--parallel", "-np");
	if (parallel !== undefined) flags.parallel = parallel;
	// The negative spelling is its own flag, and the last one given wins, which
	// is how llama.cpp itself resolves a repeated boolean option.
	const kvUnifiedAt = Math.max(args.lastIndexOf("--kv-unified"), args.lastIndexOf("-kvu"));
	const noKvUnifiedAt = args.lastIndexOf("--no-kv-unified");
	if (noKvUnifiedAt > kvUnifiedAt) flags.kvUnified = false;
	else if (kvUnifiedAt >= 0) flags.kvUnified = booleanFlag(args, "--kv-unified", "-kvu") ?? true;
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
	target: TargetDescriptor,
): { id: string; status?: unknown } | null {
	const expected = target.defaultModel?.trim();
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
	target: TargetDescriptor,
	ctx: ProbeContext,
): Promise<LlamaCppStatusEnrichment> {
	const entries = await probeOpenAIModelEntries(base, ctx);
	const selected = selectedModelEntry(entries, target);
	if (!selected) return {};
	const args = argsFromStatus(selected.status);
	if (args.length === 0) return { notes: statusNotes(selected.id, selected.status) };
	const flags = parseLlamaCppServerFlags(args);
	const caps: Partial<CapabilityFlags> = {};
	const window = llamaCppRequestContextWindow(flags);
	if (window !== undefined) caps.contextWindow = window.contextWindow;
	if (flags.maxTokens !== undefined && flags.maxTokens > 0) caps.maxTokens = flags.maxTokens;
	if (flags.reasoning === true || flags.reasoningBudget !== undefined) caps.reasoning = true;
	if (flags.mmproj) caps.vision = true;
	if (flags.jinja === true) caps.tools = true;
	if (flags.parallel !== undefined && Number.isInteger(flags.parallel) && flags.parallel > 0) {
		caps.parallelSlots = flags.parallel;
	}
	const enrichment: LlamaCppStatusEnrichment = { modelId: selected.id, serverFlags: flags };
	if (Object.keys(caps).length > 0) enrichment.discoveredCapabilities = caps;
	const notes = statusNotes(selected.id, selected.status);
	if (window?.slots) {
		notes.push(
			`${selected.id} context window ${formatContextWindowSlots(window.contextWindow, window.slots)}: --ctx-size is split across --parallel slots without --kv-unified`,
		);
	}
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
	target: TargetDescriptor,
	ctx: ProbeContext,
): Promise<string | null> {
	const expected = target.defaultModel?.trim();
	if (!expected) return null;
	const ids = await probeOpenAIModels(base, ctx);
	if (ids.length === 0) return null;
	if (ids.includes(expected)) return null;
	const loaded = ids[0] ?? "(unknown)";
	return `wire model id ${expected} does not match server's loaded model ${loaded}; llama.cpp serves a single fixed model`;
}

export async function probeLlamaCppProps(
	base: string,
	ctx: ProbeContext,
	modelId?: string,
): Promise<LlamaCppPropsEnrichment> {
	const request = async (url: string): Promise<LlamaCppProps | null> => {
		const opts = { url, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<LlamaCppProps>({ ...opts, signal: ctx.signal })
			: probeJson<LlamaCppProps>(opts));
		return result.ok && result.data ? result.data : null;
	};
	const router = await request(`${base}/props`);
	if (router === null) return {};
	// A llama.cpp router reports its own role at /props and the selected
	// worker's request slots at /props?model=<id>. A fixed-model server answers
	// the first request directly, so the second GET is only made when needed.
	const selected =
		typeof router.total_slots === "number" || !modelId
			? null
			: await request(`${base}/props?model=${encodeURIComponent(modelId)}`);
	const data = selected ?? router;
	const enrichment: LlamaCppPropsEnrichment = {};
	const caps: Partial<CapabilityFlags> = {};
	const nCtx = data.default_generation_settings?.n_ctx;
	if (typeof nCtx === "number" && nCtx > 0) caps.contextWindow = nCtx;
	const nPredict = data.default_generation_settings?.n_predict;
	if (typeof nPredict === "number" && nPredict > 0) caps.maxTokens = nPredict;
	const vision = data.modalities?.vision;
	if (typeof vision === "boolean") caps.vision = vision;
	const totalSlots = data.total_slots;
	if (typeof totalSlots === "number" && Number.isInteger(totalSlots) && totalSlots > 0) caps.parallelSlots = totalSlots;
	if (Object.keys(caps).length > 0) enrichment.discoveredCapabilities = caps;
	const buildInfo = data.build_info ?? router.build_info;
	if (typeof buildInfo === "string" && buildInfo.length > 0) {
		enrichment.serverVersion = buildInfo;
	}
	return enrichment;
}
