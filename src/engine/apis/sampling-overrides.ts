import { runOverrides } from "../../core/run-overrides.js";
import type { SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";

function numberField(record: Record<string, number | undefined>, key: keyof SamplingProfile): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow the run-scoped sampling override (core/run-overrides.ts) to the
 * sampling keys the API layers understand. Unknown keys are dropped.
 */
export function runSamplingOverrides(env: NodeJS.ProcessEnv = process.env): SamplingProfile | undefined {
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

export function mergeSamplingOverride(
	profile: SamplingProfile | undefined,
	override: SamplingProfile | undefined = runSamplingOverrides(),
): SamplingProfile | undefined {
	if (!override) return profile;
	return { ...(profile ?? {}), ...override };
}
