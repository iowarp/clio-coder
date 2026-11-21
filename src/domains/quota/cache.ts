/**
 * TTL cache for the last good usage snapshot of each quota provider.
 *
 * Refresh is lazy by design. Per the quota decision log there is no
 * standalone background timer: a caller asks for a snapshot, and the cache
 * either serves a fresh one or spends one provider read. With a shared state
 * file the readings and holds outlive the process, so a fresh process serves
 * what another one read instead of polling every provider again.
 */

import { noteQuotaRead } from "./observed.js";
import { journalPolledQuota } from "./reading.js";
import {
	type CacheEntry,
	emptySharedQuotaState,
	mergeSharedQuotaState,
	QUOTA_HOLD_CAP_MS,
	readSharedQuotaState,
	type SharedQuotaState,
	updateSharedQuotaState,
} from "./shared-state.js";
import type { QuotaProvider, UsageSnapshot } from "./types.js";

export const DEFAULT_QUOTA_CACHE_TTL_MS = 5 * 60_000;

/**
 * How long a failed read (error, expired) is served before the provider is asked again. Shorter than the TTL so an
 * outage clears quickly, but long enough that a surface re-reading on every update never turns into a poll loop.
 */
export const QUOTA_FAILURE_BACKOFF_MS = 60_000;

/** The longest one adapter's turn holds the next adapter on its endpoint: past the 15 s request timeout. */
const DEFAULT_LANE_TURN_MS = 20_000;

/** How long a failed read is held: the failure backoff, or the provider's Retry-After when that asks for longer. */
function failureHoldMs(ttlMs: number, retryAfterSeconds: number | null | undefined): number {
	const backoff = Math.min(ttlMs, QUOTA_FAILURE_BACKOFF_MS);
	if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds)) return backoff;
	return Math.max(backoff, Math.min(retryAfterSeconds * 1000, QUOTA_HOLD_CAP_MS));
}

export interface QuotaCacheOptions {
	ttlMs?: number;
	/** Clock source in milliseconds, injected so tests can advance time. */
	now?: () => number;
	/**
	 * A file through which this cache shares the readings and held failures of credential-scoped providers with every
	 * other process; without one the cache lives in memory only.
	 */
	sharedStatePath?: string;
	/** The longest one adapter's turn may hold the next adapter on the same endpoint. */
	laneTurnMs?: number;
}

export interface QuotaCache {
	/** The cached snapshot when it is still inside the TTL, otherwise null. */
	read(providerId: string): UsageSnapshot | null;
	/** The last good snapshot regardless of age, marked stale when expired. */
	readLastGood(providerId: string): UsageSnapshot | null;
	/** Store a successful snapshot as the new last good value. */
	write(snapshot: UsageSnapshot): void;
	/** Drop one provider's reading and hold, or every one when no id is given, here and in the shared file. */
	clear(providerId?: string): void;
	/**
	 * Serve a fresh snapshot, reading from the provider only when the cached
	 * value has expired. A failed read falls back to the last good snapshot
	 * marked stale, so a transient outage does not erase known usage, and is
	 * itself held: a missing credential until one is detected (or the TTL),
	 * any other failure for QUOTA_FAILURE_BACKOFF_MS or the provider's
	 * Retry-After, whichever is longer. Readings and holds count only for the
	 * credential that made them.
	 */
	resolve(provider: QuotaProvider): Promise<UsageSnapshot>;
}

/** Wait for `previous`, but no longer than `ms`. */
function boundedWait(previous: Promise<unknown>, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		void previous.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

export function createQuotaCache(options: QuotaCacheOptions = {}): QuotaCache {
	const ttlMs = options.ttlMs ?? DEFAULT_QUOTA_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	const sharedStatePath = options.sharedStatePath;
	const laneTurnMs = options.laneTurnMs ?? DEFAULT_LANE_TURN_MS;
	// Failed reads are held too. Without this, every read of a provider without credentials fetched and journaled
	// again, and a surface that re-reads on each journal update polled in a closed loop.
	let state: SharedQuotaState = emptySharedQuotaState();
	// Adapters on one endpoint (anthropic-max and claude-code both read Anthropic's usage endpoint) poll one at a time.
	const endpointLanes = new Map<string, Promise<unknown>>();

	// A stamp ahead of the clock (a clock stepped back, a skewed writer) counts as expired, never as held.
	const within = (storedAtMs: number, spanMs: number): boolean => {
		const elapsed = now() - storedAtMs;
		return elapsed >= 0 && elapsed < spanMs;
	};
	const fresh = (entry: CacheEntry | undefined): entry is CacheEntry =>
		entry !== undefined && within(entry.storedAtMs, ttlMs);
	// An item belongs to a credential; a provider that names none (scope undefined) accepts only its own items.
	const owns = (item: { scope?: string | null }, scope: string | null | undefined): boolean => item.scope === scope;

	const adopt = (incoming: SharedQuotaState): void => {
		const before = state.entries;
		state = mergeSharedQuotaState(state, incoming);
		for (const [id, entry] of state.entries) {
			if (before.get(id) !== entry) noteQuotaRead(entry.snapshot, ttlMs, entry.storedAtMs);
		}
	};
	const publish = (): void => {
		if (sharedStatePath === undefined) return;
		const merged = updateSharedQuotaState(sharedStatePath, state, now());
		if (merged !== null) adopt(merged);
	};

	/** What resolve answers without spending a read, or null when the provider is due. */
	const heldAnswer = async (
		provider: QuotaProvider,
		scope: string | null | undefined,
	): Promise<UsageSnapshot | null> => {
		const cached = state.entries.get(provider.id);
		if (fresh(cached) && owns(cached, scope)) return cached.snapshot;
		const miss = state.misses.get(provider.id);
		if (miss === undefined || !owns(miss, scope) || !within(miss.storedAtMs, miss.holdMs)) return null;
		// A missing credential holds until one appears; detect() is a local credential read, so a login (in
		// this process or another) is picked up on the next read without spending a usage request.
		if (miss.status !== "no_credentials") return miss.answer;
		return (await provider.detect().catch(() => false)) ? null : miss.answer;
	};

	const resolveOne = async (provider: QuotaProvider): Promise<UsageSnapshot> => {
		const scope = provider.credentialScope === undefined ? undefined : await provider.credentialScope().catch(() => null);
		const known = await heldAnswer(provider, scope);
		if (known !== null) return known;
		const shared = sharedStatePath !== undefined && scope !== undefined;
		if (shared) {
			adopt(readSharedQuotaState(sharedStatePath, now()));
			const adopted = await heldAnswer(provider, scope);
			if (adopted !== null) return adopted;
		}

		const last = state.entries.get(provider.id);
		// Another credential's reading is never this one's fallback.
		const cached = last !== undefined && owns(last, scope) ? last : undefined;
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
		let answer: UsageSnapshot;
		if (snapshot.status === "ok") {
			state.misses.delete(provider.id);
			state.entries.set(provider.id, { snapshot, storedAtMs: now(), ...(scope !== undefined ? { scope } : {}) });
			answer = snapshot;
		} else {
			answer =
				cached === undefined
					? snapshot
					: { ...cached.snapshot, stale: true, message: snapshot.message ?? cached.snapshot.message ?? null };
			const holdMs = snapshot.status === "no_credentials" ? ttlMs : failureHoldMs(ttlMs, snapshot.retryAfterSeconds);
			state.misses.set(provider.id, {
				answer,
				status: snapshot.status,
				storedAtMs: now(),
				holdMs,
				...(scope !== undefined ? { scope } : {}),
			});
		}
		if (shared) publish();
		return answer;
	};

	return {
		read(providerId) {
			const entry = state.entries.get(providerId);
			return fresh(entry) ? entry.snapshot : null;
		},

		readLastGood(providerId) {
			const entry = state.entries.get(providerId);
			if (entry === undefined) return null;
			return within(entry.storedAtMs, ttlMs) ? entry.snapshot : { ...entry.snapshot, stale: true };
		},

		write(snapshot) {
			state.misses.delete(snapshot.providerId);
			state.entries.set(snapshot.providerId, { snapshot, storedAtMs: now() });
			noteQuotaRead(snapshot, ttlMs, now());
		},

		clear(providerId) {
			if (providerId === undefined && sharedStatePath !== undefined) adopt(readSharedQuotaState(sharedStatePath, now()));
			const ids =
				providerId === undefined ? [...new Set([...state.entries.keys(), ...state.misses.keys()])] : [providerId];
			const at = now();
			for (const id of ids) {
				state.entries.delete(id);
				state.misses.delete(id);
				state.cleared.set(id, at);
			}
			// The clear stamp travels with the file, so another process cannot write the cleared reading or hold back.
			publish();
		},

		async resolve(provider) {
			const endpoint = provider.endpoint;
			if (endpoint === undefined) return resolveOne(provider);
			const previous = endpointLanes.get(endpoint);
			const turn = (previous === undefined ? Promise.resolve() : boundedWait(previous, laneTurnMs)).then(() =>
				resolveOne(provider),
			);
			const settled = turn.catch(() => undefined);
			endpointLanes.set(endpoint, settled);
			void settled.then(() => {
				if (endpointLanes.get(endpoint) === settled) endpointLanes.delete(endpoint);
			});
			return turn;
		},
	};
}
