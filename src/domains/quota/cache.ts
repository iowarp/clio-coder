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

/** Upper bound on a provider's Retry-After, so a malformed header cannot silence a provider for days. */
const QUOTA_RETRY_AFTER_CAP_MS = 24 * 60 * 60_000;

/** How long a failed read is held: the failure backoff, or the provider's Retry-After when that asks for longer. */
function failureHoldMs(ttlMs: number, retryAfterSeconds: number | null | undefined): number {
	const backoff = Math.min(ttlMs, QUOTA_FAILURE_BACKOFF_MS);
	if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds)) return backoff;
	return Math.max(backoff, Math.min(retryAfterSeconds * 1000, QUOTA_RETRY_AFTER_CAP_MS));
}

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
	 * any other failure for QUOTA_FAILURE_BACKOFF_MS or the provider's
	 * Retry-After, whichever is longer.
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

/** A failed read of an endpoint several adapters share, which holds that endpoint for all of them. */
interface EndpointHold {
	storedAtMs: number;
	holdMs: number;
	message: string | null;
	retryAfterSeconds: number | null;
}

export function createQuotaCache(options: QuotaCacheOptions = {}): QuotaCache {
	const ttlMs = options.ttlMs ?? DEFAULT_QUOTA_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	const entries = new Map<string, CacheEntry>();
	// Failed reads are held too. Without this, every read of a provider without credentials fetched and journaled
	// again, and a surface that re-reads on each journal update polled in a closed loop.
	const misses = new Map<string, MissEntry>();
	// Adapters on one endpoint (anthropic-max and claude-code both read Anthropic's usage endpoint) poll one at a
	// time, and a failure holds the endpoint for every one of them: both used to send a request together and both
	// drew a 429.
	const endpointHolds = new Map<string, EndpointHold>();
	const endpointLanes = new Map<string, Promise<unknown>>();

	const fresh = (entry: CacheEntry | undefined): boolean => entry !== undefined && now() - entry.storedAtMs < ttlMs;
	const missAnswer = (cached: CacheEntry | undefined, snapshot: UsageSnapshot): UsageSnapshot =>
		cached === undefined
			? snapshot
			: { ...cached.snapshot, stale: true, message: snapshot.message ?? cached.snapshot.message ?? null };

	const resolveOne = async (provider: QuotaProvider): Promise<UsageSnapshot> => {
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
		const endpoint = provider.endpoint;
		const hold = endpoint === undefined ? undefined : endpointHolds.get(endpoint);
		if (hold !== undefined && now() - hold.storedAtMs < hold.holdMs) {
			const remainingMs = hold.holdMs - (now() - hold.storedAtMs);
			const answer = missAnswer(cached, {
				providerId: provider.id,
				displayName: provider.displayName,
				status: "error",
				windows: [],
				message: hold.message,
				retryAfterSeconds: hold.retryAfterSeconds === null ? null : Math.ceil(remainingMs / 1000),
				fetchedAt: null,
			});
			misses.set(provider.id, { answer, status: "error", storedAtMs: now(), holdMs: remainingMs });
			return answer;
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
			if (endpoint !== undefined) endpointHolds.delete(endpoint);
			return snapshot;
		}
		const answer = missAnswer(cached, snapshot);
		const holdMs = snapshot.status === "no_credentials" ? ttlMs : failureHoldMs(ttlMs, snapshot.retryAfterSeconds);
		misses.set(provider.id, { answer, status: snapshot.status, storedAtMs: now(), holdMs });
		// An expired token or a missing credential belongs to one adapter; any other failure is the endpoint's.
		if (endpoint !== undefined && snapshot.status === "error") {
			endpointHolds.set(endpoint, {
				storedAtMs: now(),
				holdMs,
				message: snapshot.message ?? null,
				retryAfterSeconds: snapshot.retryAfterSeconds ?? null,
			});
		}
		return answer;
	};

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
				endpointHolds.clear();
			} else {
				entries.delete(providerId);
				misses.delete(providerId);
			}
		},

		async resolve(provider) {
			const endpoint = provider.endpoint;
			if (endpoint === undefined) return resolveOne(provider);
			const previous = endpointLanes.get(endpoint) ?? Promise.resolve();
			const turn = previous.then(() => resolveOne(provider));
			const settled = turn.catch(() => undefined);
			endpointLanes.set(endpoint, settled);
			void settled.then(() => {
				if (endpointLanes.get(endpoint) === settled) endpointLanes.delete(endpoint);
			});
			return turn;
		},
	};
}
