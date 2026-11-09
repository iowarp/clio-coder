/**
 * TTL cache for the last good usage snapshot of each quota provider.
 *
 * Refresh is lazy by design. Per the quota decision log there is no
 * standalone background timer: a caller asks for a snapshot, and the cache
 * either serves a fresh one or spends one provider read. The cache lives in
 * memory for this slice; persisting it across sessions is a later concern.
 */

import { noteQuotaRead } from "./observed.js";
import { journalPolledQuota } from "./reading.js";
import type { QuotaProvider, UsageSnapshot } from "./types.js";

export const DEFAULT_QUOTA_CACHE_TTL_MS = 5 * 60_000;

/**
 * How long a failed read (error, expired) is served before the provider is asked again. Shorter than the TTL so an
 * outage clears quickly, but long enough that a surface re-reading on every update never turns into a poll loop.
 */
export const QUOTA_FAILURE_BACKOFF_MS = 60_000;

export interface QuotaCacheOptions {
	ttlMs?: number;
	/** Clock source in milliseconds, injected so tests can advance time. */
	now?: () => number;
}

export interface QuotaCache {
	/** The cached snapshot when it is still inside the TTL, otherwise null. */
	read(providerId: string): UsageSnapshot | null;
	/** The last good snapshot regardless of age, marked stale when expired. */
	readLastGood(providerId: string): UsageSnapshot | null;
	/** Store a successful snapshot as the new last good value. */
	write(snapshot: UsageSnapshot): void;
	/** Drop one provider's entry, or every entry when no id is given. */
	clear(providerId?: string): void;
	/**
	 * Serve a fresh snapshot, reading from the provider only when the cached
	 * value has expired. A failed read falls back to the last good snapshot
	 * marked stale, so a transient outage does not erase known usage, and is
	 * itself held: a missing credential until one is detected (or the TTL),
	 * any other failure for QUOTA_FAILURE_BACKOFF_MS.
	 */
	resolve(provider: QuotaProvider): Promise<UsageSnapshot>;
}

interface CacheEntry {
	snapshot: UsageSnapshot;
	storedAtMs: number;
}

/** A read that did not return usage: what resolve answered, and how long to keep answering it. */
interface MissEntry {
	answer: UsageSnapshot;
	status: UsageSnapshot["status"];
	storedAtMs: number;
	holdMs: number;
}

export function createQuotaCache(options: QuotaCacheOptions = {}): QuotaCache {
	const ttlMs = options.ttlMs ?? DEFAULT_QUOTA_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	const entries = new Map<string, CacheEntry>();
	// Failed reads are held too. Without this, every read of a provider without credentials fetched and journaled
	// again, and a surface that re-reads on each journal update polled in a closed loop.
	const misses = new Map<string, MissEntry>();

	const fresh = (entry: CacheEntry | undefined): boolean => entry !== undefined && now() - entry.storedAtMs < ttlMs;

	return {
		read(providerId) {
			const entry = entries.get(providerId);
			return fresh(entry) && entry !== undefined ? entry.snapshot : null;
		},

		readLastGood(providerId) {
			const entry = entries.get(providerId);
			if (entry === undefined) return null;
			return fresh(entry) ? entry.snapshot : { ...entry.snapshot, stale: true };
		},

		write(snapshot) {
			entries.set(snapshot.providerId, { snapshot, storedAtMs: now() });
			noteQuotaRead(snapshot, ttlMs, now());
		},

		clear(providerId) {
			if (providerId === undefined) {
				entries.clear();
				misses.clear();
			} else {
				entries.delete(providerId);
				misses.delete(providerId);
			}
		},

		async resolve(provider) {
			const cached = entries.get(provider.id);
			if (fresh(cached) && cached !== undefined) return cached.snapshot;
			const miss = misses.get(provider.id);
			if (miss !== undefined && now() - miss.storedAtMs < miss.holdMs) {
				// A missing credential holds until one appears; detect() is a local credential read, so a login (in
				// this process or another) is picked up on the next read without spending a usage request.
				if (miss.status !== "no_credentials") return miss.answer;
				const detected = await provider.detect().catch(() => false);
				if (!detected) return miss.answer;
			}

			const snapshot = await provider.fetch();
			noteQuotaRead(snapshot, ttlMs, now());
			journalPolledQuota(
				snapshot.status !== "ok" && cached
					? {
							...cached.snapshot,
							...snapshot,
							windows: cached.snapshot.windows,
							credits: cached.snapshot.credits ?? null,
							plan: cached.snapshot.plan ?? null,
							stale: true,
						}
					: snapshot,
				now(),
			);
			if (snapshot.status === "ok") {
				misses.delete(provider.id);
				entries.set(provider.id, { snapshot, storedAtMs: now() });
				return snapshot;
			}
			const answer =
				cached === undefined
					? snapshot
					: { ...cached.snapshot, stale: true, message: snapshot.message ?? cached.snapshot.message ?? null };
			misses.set(provider.id, {
				answer,
				status: snapshot.status,
				storedAtMs: now(),
				holdMs: snapshot.status === "no_credentials" ? ttlMs : Math.min(ttlMs, QUOTA_FAILURE_BACKOFF_MS),
			});
			return answer;
		},
	};
}
