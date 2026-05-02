/**
 * Engine-visible quirks extracted from a knowledge-base entry. The catalog YAML
 * keeps free-form `quirks` (gpu tiers, runtime preferences, serving notes), so
 * `KnowledgeBaseEntry.quirks` stays `Record<string, unknown>`. This module
 * narrows the slice the engine consumes (KV cache layout, per-mode sampling)
 * into a typed shape that flows through `model.clio.quirks` at synth time.
 *
 * Field naming follows the Hugging Face / model-card terminology so the YAML
 * can be authored against the source-of-truth card. Engine adapters translate
 * these into the SDK-specific names at consumption sites:
 *   - LM Studio SDK uses `topPSampling`, `topKSampling`, `minPSampling`,
 *     `repeatPenalty`, `llamaKCacheQuantizationType`.
 *   - LM Studio's OpenAI-compat surface accepts `top_p`, `top_k`, `min_p`,
 *     `repeat_penalty`.
 */

export const KV_CACHE_QUANTS = ["f32", "f16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"] as const;

export type KvCacheQuant = (typeof KV_CACHE_QUANTS)[number];

export interface KvCacheQuirks {
	/** Quantization type for the key cache. `false` disables quantization (full precision). */
	kQuant?: KvCacheQuant | false;
	/** Quantization type for the value cache. Requires flash attention to take effect. */
	vQuant?: KvCacheQuant | false;
	/** Force fp16 KV cache regardless of K/V quant settings. */
	useFp16?: boolean;
}

export interface SamplingProfile {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	/** HF "repetition_penalty" / SDK "repeatPenalty". Catalog accepts either YAML key. */
	repeatPenalty?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	maxTokens?: number;
}

export interface SamplingQuirks {
	/** Sampler used when the agent is reasoning (thinking level != "off"). */
	thinking?: SamplingProfile;
	/** Sampler used when the agent is in plain instruct mode (thinking == "off"). */
	instruct?: SamplingProfile;
}

/**
 * How a local family exposes thinking control to the engine. Drives the
 * payload mutations and TUI glyph rendering so a request never lies about
 * what the model can actually do.
 *
 *   - `effort-levels`: vendor accepts a discrete reasoning_effort enum.
 *   - `budget-tokens`: vendor honors a numeric thinking budget per request.
 *   - `on-off`: chat template toggles thinking on or off; level is coerced.
 *   - `always-on`: model emits chain-of-thought unconditionally.
 *   - `none`: model has no thinking surface; level is ignored.
 */
export type ThinkingMechanism = "effort-levels" | "budget-tokens" | "on-off" | "always-on" | "none";

export interface ThinkingQuirks {
	mechanism: ThinkingMechanism;
	/** Token budget for budget-tokens mechanism, keyed by Clio's thinking level. */
	budgetByLevel?: { low?: number; medium?: number; high?: number };
	/** Effort string for effort-levels mechanism, keyed by Clio's thinking level. */
	effortByLevel?: { low?: string; medium?: string; high?: string };
	/** 2-5 line free-text guidance rendered into the Runtime prompt block. */
	guidance?: string;
}

export interface LocalModelQuirks {
	kvCache?: KvCacheQuirks;
	sampling?: SamplingQuirks;
	thinking?: ThinkingQuirks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asKvCacheQuant(value: unknown): KvCacheQuant | false | undefined {
	if (value === false) return false;
	if (typeof value !== "string") return undefined;
	return (KV_CACHE_QUANTS as ReadonlyArray<string>).includes(value) ? (value as KvCacheQuant) : undefined;
}

function asPositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
	const n = asPositive(value);
	return n !== undefined && Number.isInteger(n) ? n : undefined;
}

function asPenalty(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractKvCache(raw: unknown): KvCacheQuirks | undefined {
	if (!isRecord(raw)) return undefined;
	const out: KvCacheQuirks = {};
	const k = asKvCacheQuant(raw.kQuant);
	if (k !== undefined) out.kQuant = k;
	const v = asKvCacheQuant(raw.vQuant);
	if (v !== undefined) out.vQuant = v;
	if (typeof raw.useFp16 === "boolean") out.useFp16 = raw.useFp16;
	return Object.keys(out).length > 0 ? out : undefined;
}

function extractSamplingProfile(raw: unknown): SamplingProfile | undefined {
	if (!isRecord(raw)) return undefined;
	const out: SamplingProfile = {};
	const temperature = asPositive(raw.temperature);
	if (temperature !== undefined) out.temperature = temperature;
	const topP = asPositive(raw.topP);
	if (topP !== undefined) out.topP = topP;
	const topK = asInteger(raw.topK);
	if (topK !== undefined) out.topK = topK;
	const minP = asPositive(raw.minP);
	if (minP !== undefined) out.minP = minP;
	// Catalog YAML may use either `repeatPenalty` (LM Studio SDK term) or
	// `repetitionPenalty` (HF model-card term); accept both, prefer the SDK
	// spelling when both are present.
	const rp = asPenalty(raw.repeatPenalty) ?? asPenalty(raw.repetitionPenalty);
	if (rp !== undefined) out.repeatPenalty = rp;
	const pp = asPenalty(raw.presencePenalty);
	if (pp !== undefined) out.presencePenalty = pp;
	const fp = asPenalty(raw.frequencyPenalty);
	if (fp !== undefined) out.frequencyPenalty = fp;
	const maxTokens = asInteger(raw.maxTokens);
	if (maxTokens !== undefined) out.maxTokens = maxTokens;
	return Object.keys(out).length > 0 ? out : undefined;
}

function extractSampling(raw: unknown): SamplingQuirks | undefined {
	if (!isRecord(raw)) return undefined;
	const out: SamplingQuirks = {};
	const thinking = extractSamplingProfile(raw.thinking);
	if (thinking) out.thinking = thinking;
	const instruct = extractSamplingProfile(raw.instruct);
	if (instruct) out.instruct = instruct;
	return Object.keys(out).length > 0 ? out : undefined;
}

const THINKING_MECHANISMS: ReadonlyArray<ThinkingMechanism> = [
	"effort-levels",
	"budget-tokens",
	"on-off",
	"always-on",
	"none",
];

function asThinkingMechanism(value: unknown): ThinkingMechanism | undefined {
	if (typeof value !== "string") return undefined;
	return (THINKING_MECHANISMS as ReadonlyArray<string>).includes(value) ? (value as ThinkingMechanism) : undefined;
}

function extractBudgetByLevel(raw: unknown): ThinkingQuirks["budgetByLevel"] | undefined {
	if (!isRecord(raw)) return undefined;
	const out: NonNullable<ThinkingQuirks["budgetByLevel"]> = {};
	const low = asInteger(raw.low);
	if (low !== undefined) out.low = low;
	const medium = asInteger(raw.medium);
	if (medium !== undefined) out.medium = medium;
	const high = asInteger(raw.high);
	if (high !== undefined) out.high = high;
	return Object.keys(out).length > 0 ? out : undefined;
}

function extractEffortByLevel(raw: unknown): ThinkingQuirks["effortByLevel"] | undefined {
	if (!isRecord(raw)) return undefined;
	const out: NonNullable<ThinkingQuirks["effortByLevel"]> = {};
	if (typeof raw.low === "string" && raw.low.length > 0) out.low = raw.low;
	if (typeof raw.medium === "string" && raw.medium.length > 0) out.medium = raw.medium;
	if (typeof raw.high === "string" && raw.high.length > 0) out.high = raw.high;
	return Object.keys(out).length > 0 ? out : undefined;
}

function extractThinkingQuirks(raw: unknown): ThinkingQuirks | undefined {
	if (!isRecord(raw)) return undefined;
	const mechanism = asThinkingMechanism(raw.mechanism);
	if (!mechanism) return undefined;
	const out: ThinkingQuirks = { mechanism };
	const budgetByLevel = extractBudgetByLevel(raw.budgetByLevel);
	if (budgetByLevel) out.budgetByLevel = budgetByLevel;
	const effortByLevel = extractEffortByLevel(raw.effortByLevel);
	if (effortByLevel) out.effortByLevel = effortByLevel;
	if (typeof raw.guidance === "string" && raw.guidance.length > 0) out.guidance = raw.guidance;
	return out;
}

/**
 * Pull the engine-visible quirks slice out of a free-form catalog quirks
 * record. Returns `undefined` when nothing engine-relevant is configured so
 * `model.clio.quirks` only gets attached when it carries information.
 */
export function extractLocalModelQuirks(raw: unknown): LocalModelQuirks | undefined {
	if (!isRecord(raw)) return undefined;
	const out: LocalModelQuirks = {};
	const kvCache = extractKvCache(raw.kvCache);
	if (kvCache) out.kvCache = kvCache;
	const sampling = extractSampling(raw.sampling);
	if (sampling) out.sampling = sampling;
	const thinking = extractThinkingQuirks(raw.thinking);
	if (thinking) out.thinking = thinking;
	return Object.keys(out).length > 0 ? out : undefined;
}
