import { runOverrides } from "../../core/run-overrides.js";
import type { LocalModelQuirks, SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";

export function pickSamplingProfile(
	quirks: LocalModelQuirks | undefined,
	thinkingActive: boolean,
): SamplingProfile | undefined {
	const sampling = quirks?.sampling;
	return mergeSamplingOverride(thinkingActive ? (sampling?.thinking ?? sampling?.instruct) : sampling?.instruct);
}

/** Pi passes these keys through; native Ollama uses the same sampler names as llama.cpp. */
export function samplingParamsFromProfile(profile: SamplingProfile, runtimeId: string): Record<string, number> {
	const repeatPenaltyKey = runtimeId === "vllm" || runtimeId === "sglang" ? "repetition_penalty" : "repeat_penalty";
	return {
		...(profile.topP !== undefined ? { top_p: profile.topP } : {}),
		...(profile.topK !== undefined ? { top_k: profile.topK } : {}),
		...(profile.minP !== undefined ? { min_p: profile.minP } : {}),
		...(profile.repeatPenalty !== undefined ? { [repeatPenaltyKey]: profile.repeatPenalty } : {}),
		...(profile.presencePenalty !== undefined ? { presence_penalty: profile.presencePenalty } : {}),
		...(profile.frequencyPenalty !== undefined ? { frequency_penalty: profile.frequencyPenalty } : {}),
	};
}

function numberField(record: Record<string, number | undefined>, key: keyof SamplingProfile): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow the run-scoped sampling override (core/run-overrides.ts) to the
 * sampling keys the API layers understand. Unknown keys are dropped.
 */
function runSamplingOverrides(env: NodeJS.ProcessEnv = process.env): SamplingProfile | undefined {
	const sampling = runOverrides(env).sampling;
	if (!sampling) return undefined;
	const out: SamplingProfile = {};
	for (const key of [
		"temperature",
		"topP",
		"topK",
		"minP",
		"repeatPenalty",
		"presencePenalty",
		"frequencyPenalty",
	] as const) {
		const value = numberField(sampling, key);
		if (value !== undefined) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function mergeSamplingOverride(
	profile: SamplingProfile | undefined,
	override: SamplingProfile | undefined = runSamplingOverrides(),
): SamplingProfile | undefined {
	if (!override) return profile;
	return { ...(profile ?? {}), ...override };
}
