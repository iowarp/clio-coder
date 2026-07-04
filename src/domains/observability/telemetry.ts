/**
 * In-memory telemetry store. Counters increment; histograms keep the newest N
 * samples so metrics.ts can derive p50/p95 on demand. No I/O, no persistence.
 * The process exiting discards the state.
 *
 * Histogram sample storage is bounded by a ring buffer (default
 * {@link DEFAULT_HISTOGRAM_CAPACITY}). A long-lived interactive session records
 * a histogram sample per dispatch duration and per completed assistant stream,
 * so an unbounded array would grow without limit; the ring keeps the most
 * recent samples, which is what p50/p95 over a rolling window wants anyway.
 */

export type MetricKind = "counter" | "histogram";

/**
 * Default number of samples retained per histogram. Percentiles are computed
 * over this rolling window, so the value trades window length against the
 * fixed per-histogram memory ceiling.
 */
export const DEFAULT_HISTOGRAM_CAPACITY = 256;

export interface TelemetrySnapshot {
	counters: Record<string, number>;
	histograms: Record<string, ReadonlyArray<number>>;
}

export interface Telemetry {
	record(kind: MetricKind, name: string, value: number): void;
	snapshot(): TelemetrySnapshot;
	reset(): void;
}

/**
 * Fixed-capacity sample ring. Before the ring fills it appends; once full it
 * overwrites the oldest sample. `values()` returns a copy in no guaranteed
 * chronological order, which is fine because every consumer (metrics.ts) sorts
 * before deriving percentiles.
 */
class BoundedSamples {
	private readonly buffer: number[] = [];
	private writeIndex = 0;

	constructor(private readonly capacity: number) {}

	push(value: number): void {
		if (this.buffer.length < this.capacity) {
			this.buffer.push(value);
			return;
		}
		this.buffer[this.writeIndex] = value;
		this.writeIndex = (this.writeIndex + 1) % this.capacity;
	}

	values(): number[] {
		return [...this.buffer];
	}
}

export function createTelemetry(histogramCapacity: number = DEFAULT_HISTOGRAM_CAPACITY): Telemetry {
	const capacity = Math.max(1, Math.floor(histogramCapacity));
	const counters = new Map<string, number>();
	const histograms = new Map<string, BoundedSamples>();

	return {
		record(kind, name, value) {
			if (kind === "counter") {
				counters.set(name, (counters.get(name) ?? 0) + value);
				return;
			}
			let bucket = histograms.get(name);
			if (!bucket) {
				bucket = new BoundedSamples(capacity);
				histograms.set(name, bucket);
			}
			bucket.push(value);
		},
		snapshot() {
			const c: Record<string, number> = {};
			for (const [k, v] of counters) c[k] = v;
			const h: Record<string, ReadonlyArray<number>> = {};
			for (const [k, v] of histograms) h[k] = v.values();
			return { counters: c, histograms: h };
		},
		reset() {
			counters.clear();
			histograms.clear();
		},
	};
}
