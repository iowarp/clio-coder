/**
 * Runtime adapter contract. Each provider in the catalog has a matching
 * adapter that reports readiness WITHOUT issuing network traffic. Phase 4
 * ships stubs; real provider calls land in Phase 6+ for native/sdk tiers.
 */

import type { ProviderId } from "./catalog.js";
import type { ProviderHealth } from "./health.js";

export interface RuntimeProbeResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
}

export interface RuntimeAdapter {
	id: ProviderId;
	tier: "native" | "sdk" | "cli";
	/** Reports whether the adapter can satisfy a request WITHOUT actually making one. */
	canSatisfy(input: {
		modelId: string;
		credentialsPresent: ReadonlySet<string>;
	}): { ok: boolean; reason: string };
	/** Reports initial health without network call (used at boot). */
	initialHealth(): ProviderHealth;
	/** Lightweight sync probe. v0.1: returns ok=true if canSatisfy passes, else ok=false.
	 *  A real HTTP probe lands in Phase 6+ for native/sdk. */
	probe(opts?: { credentialsPresent?: ReadonlySet<string> }): Promise<RuntimeProbeResult>;
}
