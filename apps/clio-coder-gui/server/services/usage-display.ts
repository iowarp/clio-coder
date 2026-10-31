import type { Static } from "typebox";
import type { TelemetryQuota } from "../../contracts/telemetry.js";
import type { SessionUsage } from "../../contracts/usage.js";
import { renderFact } from "../clio/http-shims.js";

/**
 * The usage read with its quota shares worded on the server (#434). The read model's quota fold carries its own
 * displays; the v1 shares are worded here by the canonical renderer as the fallback for an agent that sends none.
 */
export function withQuotaDisplay(
	usage: SessionUsage,
	telemetryQuota: Static<typeof TelemetryQuota> | undefined,
): SessionUsage {
	const percent = (value: number) => renderFact({ kind: "measured", value, source: "provider" }, "percent");
	return {
		...usage,
		...(telemetryQuota ? { telemetryQuota } : {}),
		quotaDisplay:
			usage.quota.status === "read"
				? usage.quota.providers.map((provider) => ({
						windows: provider.windows.map((window) => percent(window.usedPct)),
						credits: provider.credits?.usedPct == null ? null : percent(provider.credits.usedPct),
					}))
				: [],
	};
}
