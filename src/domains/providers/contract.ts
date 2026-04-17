import type { ProviderId, ProviderTier } from "./catalog.js";
import type { ProviderHealth } from "./health.js";
import type { RuntimeAdapter } from "./runtime-contract.js";

export interface ProviderListEntry {
	id: ProviderId;
	displayName: string;
	tier: ProviderTier;
	available: boolean;
	reason: string;
	health: ProviderHealth;
}

export interface ProvidersContract {
	/** All configured providers with availability and health. */
	list(): ReadonlyArray<ProviderListEntry>;

	/** Lookup a specific adapter by id. Null if not in RUNTIME_ADAPTERS. */
	getAdapter(id: ProviderId): RuntimeAdapter | null;

	/** Trigger a single probe across all enabled providers. Async. */
	probeAll(): Promise<void>;

	/** Credentials store access for /providers overlay (TUI in slice 8). */
	credentials: {
		hasKey(providerId: ProviderId): boolean;
		set(providerId: ProviderId, key: string): void;
		remove(providerId: ProviderId): void;
	};
}
