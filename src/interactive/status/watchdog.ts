import type { WatchdogTier } from "./types.js";

export const TIER_THRESHOLDS_MS = {
	tier1: 10_000,
	tier2: 30_000,
	tier3: 90_000,
	tier4: 180_000,
	stuck: 180_000,
	postAbortCeiling: 300_000,
} as const;

export function stuckThresholdMs(): number {
	const override = Number(process.env.CLIO_STATUS_STUCK_MS);
	if (Number.isFinite(override) && override > 0) return override;
	return TIER_THRESHOLDS_MS.stuck;
}

export function computeWatchdogTier(elapsedMs: number, stuckMs = stuckThresholdMs()): WatchdogTier {
	if (elapsedMs >= stuckMs) return 4;
	if (elapsedMs >= TIER_THRESHOLDS_MS.tier3) return 3;
	if (elapsedMs >= TIER_THRESHOLDS_MS.tier2) return 2;
	if (elapsedMs >= TIER_THRESHOLDS_MS.tier1) return 1;
	return 0;
}
