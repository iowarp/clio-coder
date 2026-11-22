/**
 * Fresh provider quota denials at worker admission (R3: inform only, no spending ledger).
 *
 * Admission refuses a route only on the provider's own deny status for the pool (`access: "denied"`, which the quota
 * adapter maps from the provider's signal only when no credits or overage can pay past the limit), and only while that
 * reading is fresh. A window at 100% used is not a denial by itself: Codex credits and overage
 * keep serving past it. Stale, failed, missing, expired, unknown or unparseable evidence never refuses, and it is never
 * read as unlimited either: it simply does not bind admission. Nothing here reads a file or the network.
 */

import { quotaDenial } from "../quota/pool-reading.js";
import { quotaReadingFromSnapshot } from "../quota/reading.js";
import type { UsageSnapshot } from "../quota/types.js";

export interface FreshQuotaDenial {
	providerId: string;
	displayName: string;
	/** The provider's label of the binding window, or null when the provider denied without naming one. */
	window: string | null;
	/** The binding window's used percentage, when measured. */
	usedPct: number | null;
	/** ISO instant the denial lifts, or null when the provider gave none. */
	resetsAt: string | null;
	fetchedAt: string;
	ageMs: number;
}

/**
 * The binding denial a snapshot carries, or null. Fresh means a successful read (`status` ok, not marked stale)
 * fetched within `ttlMs` and not ahead of the clock; a denial whose reset has passed no longer binds. The binding
 * window is the one S5b's `quotaDenial` names: the window the provider denied, else one it measured full.
 */
export function freshQuotaDenial(snapshot: UsageSnapshot, nowMs: number, ttlMs: number): FreshQuotaDenial | null {
	if (snapshot.status !== "ok" || snapshot.stale === true || snapshot.fetchedAt === null) return null;
	const fetchedMs = Date.parse(snapshot.fetchedAt);
	const ageMs = nowMs - fetchedMs;
	if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= ttlMs) return null;
	const evidence = {
		providerId: snapshot.providerId,
		displayName: snapshot.displayName,
		fetchedAt: snapshot.fetchedAt,
		ageMs,
	};
	const reading = quotaReadingFromSnapshot(snapshot, new Date(fetchedMs).toISOString(), ttlMs);
	const denial = quotaDenial(reading, nowMs);
	if (denial === null || !denial.fresh) return null;
	const binding = denial.window;
	const window = binding === null ? undefined : snapshot.windows.find((entry) => entry.key === binding.key);
	// The reading keeps only canonical resets, so judge the reset the provider supplied: dropping a past or malformed
	// one would read as "no reset" and bind.
	const supplied = window?.resetsAt ?? snapshot.resetsAt ?? null;
	const resetsAt = supplied === null ? denial.resetsAt : resetAhead(supplied, nowMs);
	if (resetsAt === undefined || (resetsAt !== null && Date.parse(resetsAt) <= nowMs)) return null;
	return {
		...evidence,
		window: binding === null ? null : (binding.label ?? binding.key),
		usedPct: window?.usedPct ?? null,
		resetsAt,
	};
}

/** The supplied reset as an ISO instant while it is ahead; undefined when it is unparseable or past. */
function resetAhead(resetsAt: string, nowMs: number): string | undefined {
	const resetMs = Date.parse(resetsAt);
	return Number.isFinite(resetMs) && resetMs > nowMs ? new Date(resetMs).toISOString() : undefined;
}
