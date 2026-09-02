/**
 * Engine-visible quirks extracted from a knowledge-base entry. The catalog YAML
 * keeps free-form `quirks` (gpu tiers, runtime preferences, serving notes), so
 * `KnowledgeBaseEntry.quirks` stays `Record<string, unknown>`. This module
 * narrows the slice the engine consumes (per-mode sampling and thinking)
 * into a typed shape that flows through `model.clioCoder.quirks` at synth time.
 *
 * Field naming follows the Hugging Face / model-card terminology so the YAML
 * can be authored against the source-of-truth card. The OpenAI adapter
 * translates these into pi-ai sampling parameters at consumption:
 *   - OpenAI-compatible surfaces accept `top_p`, `top_k`, `min_p`,
 *     `repeat_penalty`.
 */

import type { ThinkingBudgetByLevel, ThinkingEffortByLevel } from "../thinking-control-policy.js";
import { type ThinkingLevel, VALID_THINKING_LEVELS } from "./capability-flags.js";

export interface SamplingProfile {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	/** HF "repetition_penalty" / SDK "repeatPenalty". Catalog accepts either YAML key. */
	repeatPenalty?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
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

export type ChatTemplateKwargValue = string | number | boolean;

export interface ChatTemplateKwargsByLevel {
	key: string;
	values: Partial<Record<ThinkingLevel, string | number>>;
	lmstudio?: "unsupported" | string;
}

export interface ChatTemplateKwargsQuirks {
	static?: Record<string, ChatTemplateKwargValue>;
	byLevel?: ChatTemplateKwargsByLevel;
	lmstudio?: "unsupported" | string | Record<string, string>;
}

export interface ThinkingQuirks {
	mechanism: ThinkingMechanism;
	/** Token budget for budget-tokens mechanism, keyed by Clio's thinking level. */
	budgetByLevel?: ThinkingBudgetByLevel;
	/** Effort string for effort-levels mechanism, keyed by Clio's thinking level. */
	effortByLevel?: ThinkingEffortByLevel;
	/** 2-5 line free-text guidance rendered into the Runtime prompt block. */
	guidance?: string;
	chatTemplateKwargs?: ChatTemplateKwargsQuirks;
}

export interface LocalModelQuirks {
	sampling?: SamplingQuirks;
	thinking?: ThinkingQuirks;
	chatTemplateKwargs?: ChatTemplateKwargsQuirks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
	// Catalog YAML may use either `repeatPenalty` (engine field name) or
	// `repetitionPenalty` (HF model-card term); accept both, preferring the
	// engine spelling when both are present.
	const rp = asPenalty(raw.repeatPenalty) ?? asPenalty(raw.repetitionPenalty);
	if (rp !== undefined) out.repeatPenalty = rp;
	const pp = asPenalty(raw.presencePenalty);
	if (pp !== undefined) out.presencePenalty = pp;
	const fp = asPenalty(raw.frequencyPenalty);
	if (fp !== undefined) out.frequencyPenalty = fp;
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
	const minimal = asInteger(raw.minimal);
	if (minimal !== undefined) out.minimal = minimal;
	const low = asInteger(raw.low);
	if (low !== undefined) out.low = low;
	const medium = asInteger(raw.medium);
	if (medium !== undefined) out.medium = medium;
	const high = asInteger(raw.high);
	if (high !== undefined) out.high = high;
	const xhigh = asInteger(raw.xhigh);
	if (xhigh !== undefined) out.xhigh = xhigh;
	return Object.keys(out).length > 0 ? out : undefined;
}

function extractEffortByLevel(raw: unknown): ThinkingQuirks["effortByLevel"] | undefined {
	if (!isRecord(raw)) return undefined;
	const out: NonNullable<ThinkingQuirks["effortByLevel"]> = {};
	if (typeof raw.off === "string" && raw.off.length > 0) out.off = raw.off;
	if (typeof raw.minimal === "string" && raw.minimal.length > 0) out.minimal = raw.minimal;
	if (typeof raw.low === "string" && raw.low.length > 0) out.low = raw.low;
	if (typeof raw.medium === "string" && raw.medium.length > 0) out.medium = raw.medium;
	if (typeof raw.high === "string" && raw.high.length > 0) out.high = raw.high;
	if (typeof raw.xhigh === "string" && raw.xhigh.length > 0) out.xhigh = raw.xhigh;
	return Object.keys(out).length > 0 ? out : undefined;
}

function extractChatTemplateKwargs(raw: unknown): ChatTemplateKwargsQuirks | undefined {
	if (!isRecord(raw)) return undefined;
	const out: ChatTemplateKwargsQuirks = {};

	if (isRecord(raw.static)) {
		const staticMap: Record<string, ChatTemplateKwargValue> = {};
		for (const [k, v] of Object.entries(raw.static)) {
			if (typeof v === "boolean") {
				staticMap[k] = v;
			} else if (typeof v === "number" && Number.isFinite(v)) {
				staticMap[k] = v;
			} else if (typeof v === "string" && v.length > 0) {
				staticMap[k] = v;
			}
		}
		if (Object.keys(staticMap).length > 0) out.static = staticMap;
	}

	if (isRecord(raw.byLevel)) {
		const byLevelRaw = raw.byLevel;
		if (typeof byLevelRaw.key === "string" && byLevelRaw.key.trim().length > 0 && isRecord(byLevelRaw.values)) {
			const values: Partial<Record<ThinkingLevel, string | number>> = {};
			for (const level of VALID_THINKING_LEVELS) {
				const val = byLevelRaw.values[level];
				if (typeof val === "string" && val.length > 0) {
					values[level] = val;
				} else if (typeof val === "number" && Number.isFinite(val)) {
					values[level] = val;
				}
			}
			if (Object.keys(values).length > 0) {
				const byLevel: ChatTemplateKwargsByLevel = {
					key: byLevelRaw.key.trim(),
					values,
				};
				if (typeof byLevelRaw.lmstudio === "string" && byLevelRaw.lmstudio.trim().length > 0) {
					byLevel.lmstudio = byLevelRaw.lmstudio.trim();
				}
				out.byLevel = byLevel;
			}
		}
	}

	if (typeof raw.lmstudio === "string" && raw.lmstudio.trim().length > 0) {
		out.lmstudio = raw.lmstudio.trim();
	} else if (isRecord(raw.lmstudio)) {
		const lmstudioMap: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw.lmstudio)) {
			if (typeof v === "string" && v.trim().length > 0) {
				lmstudioMap[k] = v.trim();
			}
		}
		if (Object.keys(lmstudioMap).length > 0) {
			out.lmstudio = lmstudioMap;
		}
	}

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
	const chatTemplateKwargs = extractChatTemplateKwargs(raw.chatTemplateKwargs);
	if (chatTemplateKwargs) out.chatTemplateKwargs = chatTemplateKwargs;
	return out;
}

/**
 * Pull the engine-visible quirks slice out of a free-form catalog quirks
 * record. Returns `undefined` when nothing engine-relevant is configured so
 * `model.clioCoder.quirks` only gets attached when it carries information.
 */
export function extractLocalModelQuirks(raw: unknown): LocalModelQuirks | undefined {
	if (!isRecord(raw)) return undefined;
	const out: LocalModelQuirks = {};
	const sampling = extractSampling(raw.sampling);
	if (sampling) out.sampling = sampling;
	const thinking = extractThinkingQuirks(raw.thinking);
	if (thinking) out.thinking = thinking;
	const chatTemplateKwargs =
		extractChatTemplateKwargs(raw.chatTemplateKwargs) ??
		extractChatTemplateKwargs(isRecord(raw.thinking) ? raw.thinking.chatTemplateKwargs : undefined) ??
		extractChatTemplateKwargs(isRecord(raw.request) ? raw.request.chatTemplateKwargs : undefined);
	if (chatTemplateKwargs) out.chatTemplateKwargs = chatTemplateKwargs;
	return Object.keys(out).length > 0 ? out : undefined;
}
