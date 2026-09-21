/**
 * Session-facing quota reader.
 *
 * Refresh stays lazy, as the decision log requires: no background timer.
 * A surface asks for snapshots, and the service either serves cached ones
 * or spends one read per provider. Every provider is read concurrently
 * because they are independent accounts, and a slow one must not hold up
 * the others.
 *
 * Nothing here throws. A provider that fails contributes a snapshot whose
 * status says so, which is what the surfaces render.
 */

import { createQuotaCache, DEFAULT_QUOTA_CACHE_TTL_MS, type QuotaCache } from "./cache.js";
import { localQuotaSnapshot } from "./presentation.js";
import { buildQuotaProviders } from "./registry.js";
import type { QuotaProvider, UsageSnapshot } from "./types.js";

export interface QuotaServiceOptions {
	providers?: QuotaProvider[];
	cache?: QuotaCache;
	ttlMs?: number;
	/** Include the free local-inference row; surfaces that list paid accounts only can opt out. */
	includeLocal?: boolean;
	localRuntimeLabel?: string;
}

export interface QuotaService {
	/** Cached snapshots without spending a read, for a first paint. */
	peek(): UsageSnapshot[];
	/** Snapshots, refreshing any provider whose cached value has expired. */
	read(): Promise<UsageSnapshot[]>;
	/** Providers holding usable credentials, without spending a usage read. */
	detected(): Promise<QuotaProvider[]>;
}

export function createQuotaService(options: QuotaServiceOptions = {}): QuotaService {
	const providers = options.providers ?? buildQuotaProviders();
	const cache = options.cache ?? createQuotaCache({ ttlMs: options.ttlMs ?? DEFAULT_QUOTA_CACHE_TTL_MS });
	const includeLocal = options.includeLocal ?? true;

	const withLocal = (snapshots: UsageSnapshot[]): UsageSnapshot[] => {
		if (!includeLocal) return snapshots;
		const local = options.localRuntimeLabel
			? localQuotaSnapshot({ runtimeLabel: options.localRuntimeLabel })
			: localQuotaSnapshot();
		return [...snapshots, local];
	};

	return {
		peek(): UsageSnapshot[] {
			const cached: UsageSnapshot[] = [];
			for (const provider of providers) {
				const snapshot = cache.readLastGood(provider.id);
				if (snapshot !== null) cached.push(snapshot);
			}
			return withLocal(cached);
		},

		async read(): Promise<UsageSnapshot[]> {
			const settled = await Promise.all(
				providers.map(async (provider) => {
					try {
						return await cache.resolve(provider);
					} catch (error) {
						return {
							providerId: provider.id,
							displayName: provider.displayName,
							status: "error" as const,
							windows: [],
							message: error instanceof Error ? error.message : String(error),
							fetchedAt: null,
						};
					}
				}),
			);
			return withLocal(settled.filter((snapshot) => snapshot.status !== "no_credentials"));
		},

		async detected(): Promise<QuotaProvider[]> {
			const flags = await Promise.all(
				providers.map(async (provider) => {
					try {
						return await provider.detect();
					} catch {
						return false;
					}
				}),
			);
			return providers.filter((_, index) => flags[index] === true);
		},
	};
}
