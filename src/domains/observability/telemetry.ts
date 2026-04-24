/**
 * In-memory telemetry store. Counters increment; histograms keep every sample
 * so metrics.ts can derive p50/p95 on demand. No I/O, no persistence. The
 * process exiting discards the state.
 */

export type MetricKind = "counter" | "histogram";

export interface TelemetrySnapshot {
	counters: Record<string, number>;
	histograms: Record<string, ReadonlyArray<number>>;
}

export interface Telemetry {
	record(kind: MetricKind, name: string, value: number): void;
	snapshot(): TelemetrySnapshot;
	reset(): void;
}

export function createTelemetry(): Telemetry {
	const counters = new Map<string, number>();
	const histograms = new Map<string, number[]>();

	return {
		record(kind, name, value) {
			if (kind === "counter") {
				counters.set(name, (counters.get(name) ?? 0) + value);
				return;
			}
			const bucket = histograms.get(name) ?? [];
			bucket.push(value);
			histograms.set(name, bucket);
		},
		snapshot() {
			const c: Record<string, number> = {};
			for (const [k, v] of counters) c[k] = v;
			const h: Record<string, ReadonlyArray<number>> = {};
			for (const [k, v] of histograms) h[k] = [...v];
			return { counters: c, histograms: h };
		},
		reset() {
			counters.clear();
			histograms.clear();
		},
	};
}
