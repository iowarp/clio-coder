/**
 * Runtime adapter contract. Adapters expose a pure config check via
 * canSatisfy() and may optionally expose a live probe that performs real I/O.
 * The legacy probe() method stays for compatibility.
 */

import type { EndpointSpec } from "../../core/defaults.js";
import type { ProviderId } from "./catalog.js";
import type { ProviderHealth } from "./health.js";

export interface CanSatisfyResult {
	ok: boolean;
	reason: string;
}

export interface RuntimeProbeResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
}

export interface ProbeLiveResult {
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
	}): CanSatisfyResult;
	/** Reports initial health without network call (used at boot). */
	initialHealth(): ProviderHealth;
	/**
	 * Compatibility probe. Adapters that expose a real live probe should route
	 * callers to probeLive(). Explicit config-only stubs may keep delegating to
	 * canSatisfy() so older callers continue to see the legacy behavior.
	 */
	probe(opts?: ProbeOptions): Promise<RuntimeProbeResult>;
	/** Real liveness check. May perform network I/O or spawn subprocesses. */
	probeLive?(opts?: ProbeOptions): Promise<ProbeLiveResult>;
	/** Per-endpoint probes — only implemented by local-engine adapters. */
	probeEndpoints?(endpoints: Record<string, EndpointSpec>): Promise<EndpointProbeResult[]>;
}
