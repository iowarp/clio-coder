/**
 * Runtime adapter contract. Each provider in the catalog has a matching
 * adapter that reports readiness WITHOUT issuing network traffic. Phase 4
 * ships stubs; real provider calls land in Phase 6+ for native/sdk tiers.
 */

import type { EndpointSpec } from "../../core/defaults.js";
import type { ProviderId } from "./catalog.js";
import type { ProviderHealth } from "./health.js";

export interface RuntimeProbeResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
}

export interface EndpointProbeResult {
	name: string;
	url: string;
	ok: boolean;
	latencyMs?: number;
	error?: string;
	models?: string[];
}

export interface ProbeOptions {
	credentialsPresent?: ReadonlySet<string>;
	endpoints?: Record<string, EndpointSpec> | undefined;
}

export interface RuntimeAdapter {
	id: ProviderId;
	tier: "native" | "sdk" | "cli";
	/** Reports whether the adapter can satisfy a request WITHOUT actually making one. */
	canSatisfy(input: {
		modelId: string;
		credentialsPresent: ReadonlySet<string>;
		endpoints?: Record<string, EndpointSpec>;
	}): { ok: boolean; reason: string };
	/** Reports initial health without network call (used at boot). */
	initialHealth(): ProviderHealth;
	/** Lightweight sync probe. v0.1: returns ok=true if canSatisfy passes, else ok=false.
	 *  Local-engine adapters MAY issue HTTP probes against each configured endpoint
	 *  (see probeEndpoints below) and aggregate the result. */
	probe(opts?: ProbeOptions): Promise<RuntimeProbeResult>;
	/** Per-endpoint probes — only implemented by local-engine adapters. */
	probeEndpoints?(endpoints: Record<string, EndpointSpec>): Promise<EndpointProbeResult[]>;
}
