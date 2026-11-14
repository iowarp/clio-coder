import type { UsageReport } from "../../contracts/reports.js";
import { countText } from "../telemetry/quantity-model.js";
import { cacheReportsOf } from "./usage-model.js";

/** Session prompt-cache telemetry is a separate observation, never another token or cost total. */
export function usageCacheEvidence(report: UsageReport) {
	const reports = cacheReportsOf(report);
	return {
		total: reports.length,
		omitted: Math.max(0, reports.length - 24),
		rows: reports.slice(0, 24).map((cache) => ({
			key: cache.sessionId,
			session: cache.sessionId,
			uncached: cache.uncachedPrefill.display,
			reprocessed: cache.rePrefilled.display,
			breaks: countText(cache.breaks.length),
			verdicts: (["hot", "partial", "cold", "small", "unknown"] as const)
				.map((verdict) => `${verdict}: ${countText(cache.verdicts[verdict])}`)
				.join(" · "),
		})),
	};
}
