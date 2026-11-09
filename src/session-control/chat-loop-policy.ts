import type { RetrySettings } from "../core/defaults.js";
import type { RuntimeTier } from "../domains/providers/index.js";
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
		streamStallMs: normalizeNonNegativeInteger(raw?.streamStallMs, DEFAULT_RETRY_SETTINGS.streamStallMs),
		firstTokenStallMs: normalizeNonNegativeInteger(raw?.firstTokenStallMs, DEFAULT_RETRY_SETTINGS.firstTokenStallMs),
	};
}

/**
 * The silence a call may keep before its first token, or null for no limit. The long first-token window exists for a
 * self-hosted server that slept and must reload and prefill cold; a hosted service has no model to load, so its first
 * token is held to the mid-stream window and a call that never starts is reported long before a run's own timeout.
 */
export function firstTokenStallLimitMs(retry: RetrySettings, tier: RuntimeTier | undefined): number | null {
	if (retry.streamStallMs <= 0 || retry.firstTokenStallMs <= 0) return null;
	if (tier === "cloud" || tier === "subscription") return retry.streamStallMs;
	return Math.max(retry.firstTokenStallMs, retry.streamStallMs);
}
