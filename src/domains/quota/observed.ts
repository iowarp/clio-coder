/**
 * The newest quota reading this process holds for each provider.
 *
 * Every surface builds its own quota service and cache, so no single cache
 * answers "what does Clio know about this account right now". Each cache
 * reports its reads here, and the background memory budget reads the result
 * without ever spending a usage read of its own. Nothing here fetches.
 */

import type { UsageSnapshot } from "./types.js";

interface ObservedEntry {
	/** Last successful read, or null when every read so far failed. */
	snapshot: UsageSnapshot | null;
	storedAtMs: number;
	/** Freshness window of the cache that made the read. */
	ttlMs: number;
	/** Epoch instant a 429 from the usage endpoint said to wait until. */
	retryUntilMs: number | null;
}

/** What one provider's newest reading says, as of the instant asked about. */
export interface ObservedQuota {
	snapshot: UsageSnapshot | null;
	/** True when the reading is older than the freshness window of the cache that made it. */
	stale: boolean;
	/** ISO instant a live 429 asked callers to wait until, or null. */
	retryUntil: string | null;
}

const observed = new Map<string, ObservedEntry>();

/** Record one usage read as a cache made it. A failed read keeps the last good snapshot. */
export function noteQuotaRead(snapshot: UsageSnapshot, ttlMs: number, nowMs: number): void {
	const previous = observed.get(snapshot.providerId);
	if (snapshot.status === "ok") {
		observed.set(snapshot.providerId, { snapshot, storedAtMs: nowMs, ttlMs, retryUntilMs: null });
		return;
	}
	const retryAfterSeconds = snapshot.retryAfterSeconds;
	if (retryAfterSeconds === null || retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) return;
	const readAtMs = snapshot.fetchedAt === null ? Number.NaN : Date.parse(snapshot.fetchedAt);
	observed.set(snapshot.providerId, {
		snapshot: previous?.snapshot ?? null,
		storedAtMs: previous?.storedAtMs ?? nowMs,
		ttlMs: previous?.ttlMs ?? ttlMs,
		retryUntilMs: (Number.isFinite(readAtMs) ? readAtMs : nowMs) + retryAfterSeconds * 1000,
	});
}

/** The newest reading for one provider, or null when this process never read it. */
export function observedQuota(providerId: string, nowMs: number): ObservedQuota | null {
	const entry = observed.get(providerId);
	if (entry === undefined) return null;
	return {
		snapshot: entry.snapshot,
		stale: entry.snapshot === null || entry.snapshot.stale === true || nowMs - entry.storedAtMs >= entry.ttlMs,
		retryUntil:
			entry.retryUntilMs !== null && entry.retryUntilMs > nowMs ? new Date(entry.retryUntilMs).toISOString() : null,
	};
}
