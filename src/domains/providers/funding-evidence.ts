import type { FundingObservation, FundingSignal } from "../../core/funding-config.js";
import { makeFundingObservation } from "../../core/funding-config.js";
import { openAuthStorage, resolveAuthTarget } from "./auth/index.js";
import { getRuntimeRegistry } from "./registry.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

export const FUNDING_SIGNAL_LABELS: Record<FundingSignal, string> = {
	"local-native": "local-native runtime",
	"oauth-login": "stored OAuth login; billing unverified",
};

/** Read only the selected target's local route and credential state. Never refresh a login or query a provider. */
export function targetFundingEvidence(
	target: TargetDescriptor,
	runtime = getRuntimeRegistry().get(target.runtime),
): { hint: string; observation?: FundingObservation } {
	if (!runtime) return { hint: "unknown runtime" };
	if (runtime.tier === "local-native") {
		return {
			hint: FUNDING_SIGNAL_LABELS["local-native"],
			observation: makeFundingObservation("local-native", runtime.id, target.url),
		};
	}
	if (runtime.auth === "none" || runtime.auth === "claude-cli") {
		return { hint: runtime.tier === "subscription" ? "external subscription login; identity unverified" : "unknown" };
	}
	const auth = openAuthStorage();
	const authTarget = resolveAuthTarget(target, runtime);
	const status = auth.statusForTarget(authTarget, { includeFallback: false });
	if (status.available && status.source === "stored-oauth") {
		const ref = status.storedRef ?? authTarget.providerId;
		const stored = auth.get(ref);
		// A refreshed credential is also a new local revision. Without account proof, do not carry the old detection.
		if (auth.damageReason() === null && stored?.type === "oauth" && stored.expires > Date.now()) {
			return {
				hint: FUNDING_SIGNAL_LABELS["oauth-login"],
				observation: makeFundingObservation("oauth-login", runtime.id, target.url, {
					ref,
					updatedAt: stored.updatedAt,
					expires: stored.expires,
				}),
			};
		}
	}
	if (runtime.tier === "subscription") return { hint: "subscription runtime; login unverified" };
	if (runtime.auth === "oauth") return { hint: "OAuth runtime; login unverified" };
	if (status.available && status.credentialType === "api_key") return { hint: "API credential; payer unverified" };
	return { hint: "unknown" };
}
