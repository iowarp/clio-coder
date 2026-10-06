/**
 * The budget one background memory step is admitted against.
 *
 * Since 0.6.2 the memory tier runs on the active chat route whenever no
 * dedicated memory route is set, so every attended session makes background
 * calls. Capacity alone gated them, and one dollar gate would be wrong for
 * most routes: a subscription spends plan windows, a local server spends GPU
 * time the operator's own turn needs. The budget follows what the route
 * actually costs, and every limit comes from settings, resolved pricing,
 * provider quota readings or measured endpoint speed.
 *
 * Pure: callers read the facts (spend, quota reading, stream counts, measured
 * rates, the clock) and pass them in. A refused step costs nothing and is not
 * retried here; the next cadence tick decides again.
 */

import type { CostProvenance } from "../providers/types/cost-provenance.js";
import type { RuntimeDescriptor } from "../providers/types/runtime-descriptor.js";
import { primaryWindow, windowAtWarning } from "../quota/severity.js";
import type { UsageSnapshot } from "../quota/types.js";
import { sessionCeilingReached } from "../scheduling/budget.js";

/**
 * How a route bills a background step.
 *
 * `metered` pays per token at a resolved rate; `quota` spends a subscription
 * window Clio reads usage for; `local` is known to be free; `unpriced` has no
 * resolved price at all (a LiteLLM proxy without declared `pricing`) and is
 * budgeted like a local endpoint rather than given an invented dollar figure.
 */
export type BackgroundRouteKind = "metered" | "quota" | "local" | "unpriced";

/** Why a step was refused before any request left the process. */
export type BackgroundSkipReason = "cost_ceiling" | "quota_window" | "quota_retry" | "endpoint_busy" | "time_budget";

export const BACKGROUND_SKIP_REASONS: ReadonlySet<BackgroundSkipReason> = new Set([
	"cost_ceiling",
	"quota_window",
	"quota_retry",
	"endpoint_busy",
	"time_budget",
]);

export interface BackgroundRouteFacts {
	/** Provenance of the resolved pricing (`resolveEffectivePricing`). */
	provenance: CostProvenance;
	/** Resolved USD rates per million tokens, or null when nothing priced the route. */
	rates: { input: number; output: number } | null;
	runtime: Pick<RuntimeDescriptor, "auth" | "tier">;
	/** The quota adapter that reads this runtime's account, or null when Clio reads none. */
	quotaProviderId: string | null;
}

export function backgroundRouteKind(route: BackgroundRouteFacts): BackgroundRouteKind {
	const subscription =
		route.runtime.auth === "oauth" || route.runtime.auth === "claude-cli" || route.runtime.tier === "subscription";
	if (subscription && route.quotaProviderId !== null) return "quota";
	if (route.provenance === "known_free") return "local";
	// Chat and System One admission treat a Pi catalog estimate as paid, so an
	// api-key cloud target without declared pricing is metered here too.
	const priced = route.provenance === "known" || route.provenance === "estimated";
	if (priced && route.rates !== null && (route.rates.input > 0 || route.rates.output > 0)) return "metered";
	return "unpriced";
}

export interface BackgroundStepFacts {
	route: BackgroundRouteFacts;
	/** Estimated prompt tokens of this step's request. */
	inputTokens: number;
	/** `context.memory.maxOutputTokens`. */
	maxOutputTokens: number;
	/** `context.memory.timeoutMs`, the most any step may take. */
	timeoutCapMs: number;
	nowMs: number;
	/** Priced session spend and `safety.limits.sessionCostUsd` (0 means no ceiling). */
	session: { spendUsd: number; ceilingUsd: number };
	/** The newest reading the quota domain holds for the route's account, or null when it holds none. */
	quota: { snapshot: UsageSnapshot | null; stale: boolean; retryUntil: string | null } | null;
	endpoint: {
		/** Requests holding the endpoint now: foreground streams, worker leases and held reservations. */
		occupied: number;
		/** `backgroundMemoryAdmissionLimit` for the endpoint; one slot unless capacity is proven. */
		admissionLimit: number;
		prefillTokensPerSecond: number | null;
		generationTokensPerSecond: number | null;
	};
}

export type BackgroundStepDecision =
	| { admit: true; kind: BackgroundRouteKind; timeoutMs: number }
	| { admit: false; kind: BackgroundRouteKind; reason: BackgroundSkipReason; resumeAt?: string };

export function decideBackgroundStep(facts: BackgroundStepFacts): BackgroundStepDecision {
	const kind = backgroundRouteKind(facts.route);
	const admit = (timeoutMs: number): BackgroundStepDecision => ({ admit: true, kind, timeoutMs });
	const skip = (reason: BackgroundSkipReason, resumeAt?: string | null): BackgroundStepDecision => {
		// Providers write reset instants in their own ISO dialects; the ledger keeps one.
		const resumeMs = resumeAt ? Date.parse(resumeAt) : Number.NaN;
		return {
			admit: false,
			kind,
			reason,
			...(Number.isFinite(resumeMs) ? { resumeAt: new Date(resumeMs).toISOString() } : {}),
		};
	};
	switch (kind) {
		case "metered": {
			const rates = facts.route.rates;
			if (rates === null) return admit(facts.timeoutCapMs);
			const projectedUsd = (facts.inputTokens * rates.input + facts.maxOutputTokens * rates.output) / 1_000_000;
			return sessionCeilingReached(facts.session.spendUsd + projectedUsd, facts.session.ceilingUsd)
				? skip("cost_ceiling")
				: admit(facts.timeoutCapMs);
		}
		case "quota": {
			// Clio never invents a limit: no reading, or one past its freshness window,
			// admits the step.
			const quota = facts.quota;
			if (quota?.retryUntil != null && Date.parse(quota.retryUntil) > facts.nowMs) {
				return skip("quota_retry", quota.retryUntil);
			}
			if (quota === null || quota.stale || quota.snapshot === null || quota.snapshot.status !== "ok") {
				return admit(facts.timeoutCapMs);
			}
			const binding = primaryWindow(quota.snapshot);
			if (binding === null || !windowAtWarning(binding)) return admit(facts.timeoutCapMs);
			// A window whose reset has passed is no longer the window the reading measured.
			if (binding.resetsAt !== null && Date.parse(binding.resetsAt) <= facts.nowMs) return admit(facts.timeoutCapMs);
			return skip("quota_window", binding.resetsAt);
		}
		case "local":
		case "unpriced": {
			// The endpoint is the budget: memory takes a free slot or none, and the
			// preemptible hold the client registers yields to a foreground claim.
			if (facts.endpoint.occupied >= facts.endpoint.admissionLimit) return skip("endpoint_busy");
			const { prefillTokensPerSecond: prefill, generationTokensPerSecond: generation } = facts.endpoint;
			if (prefill === null || generation === null || prefill <= 0 || generation <= 0) {
				return admit(facts.timeoutCapMs);
			}
			const neededMs = Math.ceil(
				(facts.inputTokens / prefill) * 1000 + (Math.max(0, facts.maxOutputTokens) / generation) * 1000,
			);
			return neededMs > facts.timeoutCapMs ? skip("time_budget") : admit(Math.max(1, neededMs));
		}
	}
}
