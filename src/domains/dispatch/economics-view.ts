/**
 * Projections behind `context(scope="budget")`'s economics view (S16). Pure: the host reads the cached quota state
 * and the spend admission counts, and these shape what the caller may see. Nothing here reads a file or the network.
 */

import { quotaReadingFromSnapshot } from "../quota/reading.js";
import type { UsageSnapshot } from "../quota/types.js";
import type { BudgetEconomicsView, BudgetPoolView } from "./contract.js";
import type { RunLimits } from "./run-limits.js";

/**
 * A cached quota snapshot as the provider reported it, through the same reading the journal records (S5b), so access,
 * overage and freshness mean what they mean there. Plan, balance text, pool pseudonym and account identity stay out.
 */
export function budgetPoolView(
	snapshot: UsageSnapshot,
	nowMs: number,
	ttlMs: number,
): BudgetPoolView | { status: "none"; reason: string } {
	if (snapshot.status !== "ok" || snapshot.fetchedAt === null)
		return { status: "none", reason: `last quota read: ${snapshot.status}` };
	const fetchedMs = Date.parse(snapshot.fetchedAt);
	if (!Number.isFinite(fetchedMs)) return { status: "none", reason: "last quota read has no valid time" };
	const reading = quotaReadingFromSnapshot(snapshot, new Date(fetchedMs).toISOString(), ttlMs);
	const validUntil = reading.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);
	return {
		status: "reading",
		provider: reading.provider,
		access: reading.access ?? "unknown",
		overage: reading.overage ?? "unknown",
		// Every window the provider reported, an allowance with no percentage included: a verdict is never hidden.
		windows: reading.windows.map((window) => ({
			label: window.label ?? window.key,
			usedPct: window.usedPct.kind === "measured" ? window.usedPct.value : null,
			...(window.unlimited ? { unlimited: true as const } : {}),
			resetsAt: window.resetsAt ?? null,
			access: window.access ?? null,
		})),
		creditsUsedPct: reading.credits?.usedPct.kind === "measured" ? reading.credits.usedPct.value : null,
		observedAt: reading.observedAt,
		ageMs: Math.max(0, nowMs - fetchedMs),
		fresh: validUntil > nowMs && reading.stale !== true,
	};
}

/** A worker's view: its own sealed envelope only; the session's spend and every pool read withheld, not zero. */
export function workerEconomicsView(limits: RunLimits | undefined): BudgetEconomicsView {
	return {
		scope: "worker",
		envelope:
			limits === undefined
				? null
				: {
						toolCalls: limits.tools.ceiling,
						retries: limits.retries.max,
						wallMs: limits.time.wallMs,
						deadlineAt: new Date(limits.time.deadlineAt).toISOString(),
						responseMs: limits.time.responseMs,
					},
		spend: "withheld",
		pool: "withheld",
	};
}
