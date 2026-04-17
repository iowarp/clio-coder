import type { ProviderId, ProviderTier } from "./catalog.js";
import type { ProviderHealth } from "./health.js";
import type { EndpointProbeResult, RuntimeAdapter } from "./runtime-contract.js";

export interface ProviderEndpointEntry {
	name: string;
	url: string;
	defaultModel?: string;
	probe?: EndpointProbeResult;
}

export interface ProviderListEntry {
	id: ProviderId;
	displayName: string;
	tier: ProviderTier;
	available: boolean;
	reason: string;
	health: ProviderHealth;
	endpoints?: ReadonlyArray<ProviderEndpointEntry>;
}

export interface ProvidersContract {
	/** All configured providers with availability and health. */
	list(): ReadonlyArray<ProviderListEntry>;

	/** Lookup a specific adapter by id. Null if not in RUNTIME_ADAPTERS. */
	getAdapter(id: ProviderId): RuntimeAdapter | null;

	/** Trigger a config-only readiness sweep across all enabled providers. Async. */
	probeAll(): Promise<void>;

	/** Probe every configured endpoint of every local-engine provider. */
	probeEndpoints(): Promise<void>;

	/** Trigger the live probe path across all enabled providers. Async. */
	probeAllLive(): Promise<void>;

	/** Explicit alias for the live endpoint sweep. */
	probeEndpointsLive(): Promise<void>;

	/** Credentials store access for /providers overlay (TUI in slice 8). */
	credentials: {
		hasKey(providerId: ProviderId): boolean;
		set(providerId: ProviderId, key: string): void;
		remove(providerId: ProviderId): void;
	};
}
