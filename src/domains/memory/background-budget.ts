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

import type { MemorySurfaceId } from "../../core/side-surfaces.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { EffectivePricing } from "../providers/catalog.js";
import { calculatePricingCostUsd } from "../providers/catalog.js";
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
export type BackgroundSkipReason =
	| "cost_ceiling"
	| "quota_unknown"
	| "quota_window"
	| "quota_retry"
	| "endpoint_busy"
	| "time_budget"
	/** The session's automatic memory spend is over `context.memory.sideShare` of its main spend. */
	| "side_share";

export const BACKGROUND_SKIP_REASONS: ReadonlySet<BackgroundSkipReason> = new Set([
	"cost_ceiling",
	"quota_unknown",
	"quota_window",
	"quota_retry",
	"endpoint_busy",
	"time_budget",
	"side_share",
]);

export interface BackgroundRouteFacts {
	/** Who priced the route (`resolveEffectivePricing`). */
	pricedBy: EffectivePricing["pricedBy"];
	/** Resolved USD rates per million tokens, or null when nothing priced the route. */
	rates: Pick<NonNullable<EffectivePricing["rates"]>, "input" | "output" | "tiers"> | null;
	runtime: Pick<RuntimeDescriptor, "auth" | "tier">;
	/** The quota adapter that reads this runtime's account, or null when Clio reads none. */
	quotaProviderId: string | null;
}

function backgroundRouteKind(route: BackgroundRouteFacts): BackgroundRouteKind {
	const subscription =
		route.runtime.auth === "oauth" || route.runtime.auth === "claude-cli" || route.runtime.tier === "subscription";
	if (subscription && route.quotaProviderId !== null) return "quota";
	if (route.pricedBy === "free") return "local";
	// Chat and System One admission treat a Pi catalog estimate as paid, so an
	// api-key cloud target without declared pricing is metered here too.
	const priced = route.pricedBy === "target-rates" || route.pricedBy === "catalog";
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
	/** The side-share governor's facts for this call; absent where no session journal is read, which admits. */
	sideShare?: SideShareFacts;
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
	// The governor refuses before any route check; it is decided here when the caller folded its facts.
	if (facts.sideShare !== undefined && sideShareRefuses(facts.sideShare))
		return { admit: false, kind, reason: "side_share" };
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
			const projectedUsd = calculatePricingCostUsd(rates, { input: facts.inputTokens, output: facts.maxOutputTokens });
			return sessionCeilingReached(facts.session.spendUsd + projectedUsd, facts.session.ceilingUsd)
				? skip("cost_ceiling")
				: admit(facts.timeoutCapMs);
		}
		case "quota": {
			// OAI-1 / #423: optional work waits for trustworthy subscription evidence.
			const quota = facts.quota;
			if (quota?.retryUntil != null && Date.parse(quota.retryUntil) > facts.nowMs) {
				return skip("quota_retry", quota.retryUntil);
			}
			if (quota === null || quota.stale || quota.snapshot === null || quota.snapshot.status !== "ok") {
				return skip("quota_unknown");
			}
			const windows = quota.snapshot.windows.filter(
				(window) =>
					Number.isFinite(window.usedPct) &&
					window.usedPct >= 0 &&
					window.usedPct <= 100 &&
					(window.resetsAt === null || Date.parse(window.resetsAt) > facts.nowMs),
			);
			if (windows.length === 0) return skip("quota_unknown");
			const binding = primaryWindow({ ...quota.snapshot, windows });
			if (binding === null || !windowAtWarning(binding)) return admit(facts.timeoutCapMs);
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

/**
 * The side-share governor's view of one session (memory design 4.1). It is a governor, not a spend ceiling: the first
 * {@link SIDE_SHARE_FREE_CALLS} automatic memory calls run, and later ones are refused while the session's memory output
 * is over `share` of its main output. 15% is a design assumption, not a measured optimum.
 */
export interface SideShareFacts {
	/** `context.memory.sideShare`; 0 turns the governor off. */
	share: number;
	/** False for a call the operator asked for (`SIDE_SHARE_EXEMPT`), which the governor never refuses. */
	automatic: boolean;
	/** Automatic memory calls this session already made, those in flight included. */
	automaticCalls: number;
	/** Settled memory output tokens, plus the request `maxTokens` of each call in flight or settled without usage. */
	sideOutputTokens: number;
	/** Settled main-role output tokens. */
	mainOutputTokens: number;
	/** Premium units of settled memory and main calls when the route reports them; null when none reported any. */
	premium: { side: number; main: number } | null;
}

/** Automatic calls a session makes before the share applies. */
export const SIDE_SHARE_FREE_CALLS = 3;

/**
 * Memory calls the operator asked for in that turn: the classifier after an explicit "remember" and the explicit
 * consolidation pass. Everything automatic is governed, so the governor can refuse a call that would have helped.
 */
export const SIDE_SHARE_EXEMPT: ReadonlySet<MemorySurfaceId> = new Set(["memory.classify", "memory.consolidate"]);

/** True when the governor refuses: past the free calls, and over the share on tokens or, when reported, premium units. */
function sideShareRefuses(facts: SideShareFacts): boolean {
	if (!(facts.share > 0) || !facts.automatic || facts.automaticCalls < SIDE_SHARE_FREE_CALLS) return false;
	// A zero main denominator admits only the free calls.
	const over = (side: number, main: number): boolean => !(main > 0) || side / main > facts.share;
	return (
		over(facts.sideOutputTokens, facts.mainOutputTokens) ||
		(facts.premium !== null && over(facts.premium.side, facts.premium.main))
	);
}

/** An admitted memory call this process still holds; its own attempt has not settled. */
export interface SideShareHeld {
	purpose: MemorySurfaceId;
	maxTokens: number;
}

/**
 * Fold the governor's counters from the session's own call journal, so a resumed session continues its count, plus the
 * calls this process holds in flight. Only settled attempts are read from the journal: an attempt still open there is
 * either held here, and counted once from `held`, or the call being decided, which never counts itself. A never-sent
 * attempt spent nothing and is not a call. A settled memory attempt without measured output counts `unknownOutputTokens`,
 * the configured memory output budget, never zero.
 */
export function foldSideShare(
	records: readonly TelemetryRecord[],
	held: readonly SideShareHeld[],
	unknownOutputTokens: number,
): Omit<SideShareFacts, "share" | "automatic"> {
	const value = (fact: Fact<number> | undefined): number | null =>
		fact !== undefined && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : null;
	const calls = new Set<string>();
	let sideOutputTokens = 0;
	let mainOutputTokens = 0;
	const premium = { side: 0, main: 0 };
	let premiumReported = false;
	for (const record of records) {
		if (record.k !== "call.settled") continue;
		const role = record.ctx.agent.role;
		if (role !== "memory" && role !== "main") continue;
		const data = record.data;
		if (data.disposition === "never_sent") continue;
		const output = value(data.usage?.output);
		const units = value(data.billing?.premiumRequests);
		if (units !== null) premiumReported = true;
		if (role === "main") {
			mainOutputTokens += output ?? 0;
			premium.main += units ?? 0;
			continue;
		}
		// A memory call journaled before purposes existed was automatic; only a named operator purpose is exempt.
		if (data.purpose === undefined || !SIDE_SHARE_EXEMPT.has(data.purpose as MemorySurfaceId)) calls.add(data.callId);
		sideOutputTokens += output ?? unknownOutputTokens;
		premium.side += units ?? 0;
	}
	for (const call of held) {
		sideOutputTokens += call.maxTokens;
	}
	return {
		automaticCalls: calls.size + held.filter((call) => !SIDE_SHARE_EXEMPT.has(call.purpose)).length,
		sideOutputTokens,
		mainOutputTokens,
		premium: premiumReported ? premium : null,
	};
}
