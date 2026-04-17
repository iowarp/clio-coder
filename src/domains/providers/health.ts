/**
 * Provider health types and pure state updater. Network-backed probes arrive
 * in Phase 6+; Phase 4 only models the state transitions.
 */

export type HealthStatus = "healthy" | "degraded" | "unknown" | "down";

export interface ProviderHealth {
	providerId: string;
	status: HealthStatus;
	lastCheckAt: string | null;
	lastError: string | null;
	latencyMs: number | null;
}

export function initialHealth(providerId: string): ProviderHealth {
	return {
		providerId,
		status: "unknown",
		lastCheckAt: null,
		lastError: null,
		latencyMs: null,
	};
}

export function applyProbeResult(
	prev: ProviderHealth,
	probe: { ok: boolean; latencyMs?: number; error?: string; at?: string },
): ProviderHealth {
	const at = probe.at ?? new Date().toISOString();
	if (probe.ok) {
		const latency = probe.latencyMs ?? null;
		const degraded = typeof latency === "number" && latency > 2_000;
		return {
			providerId: prev.providerId,
			status: degraded ? "degraded" : "healthy",
			lastCheckAt: at,
			lastError: null,
			latencyMs: latency,
		};
	}
	return {
		providerId: prev.providerId,
		status: "down",
		lastCheckAt: at,
		lastError: probe.error ?? "probe failed",
		latencyMs: probe.latencyMs ?? null,
	};
}
