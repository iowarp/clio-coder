import type { RetrySettings } from "../core/defaults.js";
import { DEFAULT_RETRY_SETTINGS } from "../domains/session/retry.js";

type RawRetrySettings = Partial<RetrySettings> | null | undefined;

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function normalizeRetrySettings(raw: RawRetrySettings): RetrySettings {
	return {
		enabled: raw?.enabled ?? DEFAULT_RETRY_SETTINGS.enabled,
		maxRetries: normalizeNonNegativeInteger(raw?.maxRetries, DEFAULT_RETRY_SETTINGS.maxRetries),
		baseDelayMs: normalizeNonNegativeInteger(raw?.baseDelayMs, DEFAULT_RETRY_SETTINGS.baseDelayMs),
		maxDelayMs: normalizeNonNegativeInteger(raw?.maxDelayMs, DEFAULT_RETRY_SETTINGS.maxDelayMs),
	};
}
