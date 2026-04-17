/**
 * Thin reducer over TelemetrySnapshot. Produces a view the TUI + /cost overlay
 * consume. Stays pure so tests can hand-roll snapshots and assert the shape.
 */

import type { TelemetrySnapshot } from "./telemetry.js";

export interface MetricsView {
	dispatchesCompleted: number;
	dispatchesFailed: number;
	safetyClassifications: number;
	totalTokens: number;
	histograms: Record<string, { count: number; avg: number; p50: number; p95: number }>;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx] ?? 0;
}

export function aggregateMetrics(snap: TelemetrySnapshot): MetricsView {
	const histograms: MetricsView["histograms"] = {};
	for (const [name, values] of Object.entries(snap.histograms)) {
		const sorted = [...values].sort((a, b) => a - b);
		const count = sorted.length;
		const avg = count > 0 ? sorted.reduce((s, v) => s + v, 0) / count : 0;
		histograms[name] = { count, avg, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
	}
	return {
		dispatchesCompleted: snap.counters["dispatch.completed"] ?? 0,
		dispatchesFailed: snap.counters["dispatch.failed"] ?? 0,
		safetyClassifications: snap.counters["safety.classified"] ?? 0,
		totalTokens: snap.counters["tokens.total"] ?? 0,
		histograms,
	};
}
