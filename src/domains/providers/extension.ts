import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import { PROVIDER_CATALOG, type ProviderId } from "./catalog.js";
import type { ProviderListEntry, ProvidersContract } from "./contract.js";
import { type CredentialStore, credentialsPresent, openCredentialStore } from "./credentials.js";
import { discoverProviders } from "./discovery.js";
import { type ProviderHealth, applyProbeResult, initialHealth } from "./health.js";
import type { RuntimeAdapter } from "./runtime-contract.js";
import { RUNTIME_ADAPTERS } from "./runtimes/index.js";

export function createProvidersBundle(context: DomainContext): DomainBundle<ProvidersContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) {
		throw new Error("providers domain requires 'config' contract");
	}
	const config: ConfigContract = maybeConfig;

	let credStore: CredentialStore | null = null;
	const healthState = new Map<ProviderId, ProviderHealth>();

	function adapterById(id: ProviderId): RuntimeAdapter | null {
		return RUNTIME_ADAPTERS.find((a) => a.id === id) ?? null;
	}

	function computeList(): ReadonlyArray<ProviderListEntry> {
		const settings = config.get();
		const present = credentialsPresent();
		const avail = discoverProviders({ settings, credentialsPresent: present });
		const byId = new Map(avail.map((a) => [a.id, a]));
		return PROVIDER_CATALOG.map((spec) => {
			const a = byId.get(spec.id);
			const h = healthState.get(spec.id) ?? initialHealth(spec.id);
			return {
				id: spec.id,
				displayName: spec.displayName,
				tier: spec.tier,
				available: a?.available ?? false,
				reason: a?.reason ?? "unknown",
				health: h,
			};
		});
	}

	const extension: DomainExtension = {
		async start() {
			credStore = openCredentialStore();
			for (const adapter of RUNTIME_ADAPTERS) {
				healthState.set(adapter.id, adapter.initialHealth());
			}
			// Compute initial availability so discovery side-effects (if any future
			// ones arise) are exercised at boot. Discovery itself is pure today.
			const settings = config.get();
			const present = credentialsPresent();
			discoverProviders({ settings, credentialsPresent: present });
		},
		async stop() {
			// no-op; credential store has no close handle
		},
	};

	const contract: ProvidersContract = {
		list() {
			return computeList();
		},
		getAdapter(id: ProviderId): RuntimeAdapter | null {
			return adapterById(id);
		},
		async probeAll(): Promise<void> {
			const present = credentialsPresent();
			for (const adapter of RUNTIME_ADAPTERS) {
				const started = Date.now();
				const result = await adapter.probe({ credentialsPresent: present });
				const latency = result.latencyMs ?? Math.max(0, Date.now() - started);
				const prev = healthState.get(adapter.id) ?? initialHealth(adapter.id);
				const probe: { ok: boolean; latencyMs: number; error?: string } = {
					ok: result.ok,
					latencyMs: latency,
				};
				if (result.error !== undefined) probe.error = result.error;
				const next = applyProbeResult(prev, probe);
				healthState.set(adapter.id, next);
				context.bus.emit(BusChannels.ProviderHealth, { providerId: adapter.id, health: next });
			}
		},
		credentials: {
			hasKey(providerId: ProviderId): boolean {
				if (!credStore) return false;
				return credStore.get(providerId) !== null;
			},
			set(providerId: ProviderId, key: string): void {
				if (!credStore) throw new Error("providers domain not started");
				credStore.set(providerId, key);
			},
			remove(providerId: ProviderId): void {
				if (!credStore) return;
				credStore.remove(providerId);
			},
		},
	};

	return { extension, contract };
}
