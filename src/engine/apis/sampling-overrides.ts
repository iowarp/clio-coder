import type { SamplingProfile } from "../../domains/providers/types/local-model-quirks.js";

export const CLIO_SAMPLING_OVERRIDES_ENV = "CLIO_SAMPLING_OVERRIDES";

function numberField(record: Record<string, unknown>, key: keyof SamplingProfile): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function samplingOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): SamplingProfile | undefined {
	const raw = env[CLIO_SAMPLING_OVERRIDES_ENV]?.trim();
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
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
		const value = numberField(record, key);
		if (value !== undefined) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function mergeSamplingOverride(
	profile: SamplingProfile | undefined,
	override: SamplingProfile | undefined = samplingOverridesFromEnv(),
): SamplingProfile | undefined {
	if (!override) return profile;
	return { ...(profile ?? {}), ...override };
}
