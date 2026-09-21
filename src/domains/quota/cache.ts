/**
 * TTL cache for the last good usage snapshot of each quota provider.
 *
 * Refresh is lazy by design. Per the quota decision log there is no
 * standalone background timer: a caller asks for a snapshot, and the cache
 * either serves a fresh one or spends one provider read. The cache lives in
 * memory for this slice; persisting it across sessions is a later concern.
 */

import type { QuotaProvider, UsageSnapshot } from "./types.js";

export const DEFAULT_QUOTA_CACHE_TTL_MS = 5 * 60_000;

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
	 * marked stale, so a transient outage does not erase known usage.
	 */
	resolve(provider: QuotaProvider): Promise<UsageSnapshot>;
}

interface CacheEntry {
	snapshot: UsageSnapshot;
	storedAtMs: number;
}

export function createQuotaCache(options: QuotaCacheOptions = {}): QuotaCache {
	const ttlMs = options.ttlMs ?? DEFAULT_QUOTA_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	const entries = new Map<string, CacheEntry>();

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
		},

		clear(providerId) {
			if (providerId === undefined) entries.clear();
			else entries.delete(providerId);
		},

		async resolve(provider) {
			const cached = entries.get(provider.id);
			if (fresh(cached) && cached !== undefined) return cached.snapshot;

			const snapshot = await provider.fetch();
			if (snapshot.status === "ok") {
				entries.set(provider.id, { snapshot, storedAtMs: now() });
				return snapshot;
			}
			if (cached === undefined) return snapshot;
			return {
				...cached.snapshot,
				stale: true,
				message: snapshot.message ?? cached.snapshot.message ?? null,
			};
		},
	};
}
