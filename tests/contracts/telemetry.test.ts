import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateMetrics } from "../../src/domains/observability/metrics.js";
import { createTelemetry, DEFAULT_HISTOGRAM_CAPACITY } from "../../src/domains/observability/telemetry.js";

describe("contracts/telemetry bounded histograms", () => {
	it("caps stored histogram samples at the default capacity", () => {
		const telemetry = createTelemetry();
		for (let i = 0; i < 10_000; i++) {
			telemetry.record("histogram", "dispatch.duration_ms", i);
		}
		const snap = telemetry.snapshot();
		const samples = snap.histograms["dispatch.duration_ms"];
		ok(samples !== undefined);
		strictEqual(samples.length, DEFAULT_HISTOGRAM_CAPACITY);
	});

	it("keeps the newest samples when the ring overflows", () => {
		const telemetry = createTelemetry(4);
		for (const value of [1, 2, 3, 4, 5, 6]) {
			telemetry.record("histogram", "h", value);
		}
		const samples = [...(telemetry.snapshot().histograms.h ?? [])].sort((a, b) => a - b);
		// Capacity 4 with newest-wins keeps 3,4,5,6 (1 and 2 evicted).
		strictEqual(samples.length, 4);
		strictEqual(samples[0], 3);
		strictEqual(samples[3], 6);
	});

	it("aggregateMetrics still derives percentiles from a bounded snapshot", () => {
		const telemetry = createTelemetry(100);
		for (let i = 1; i <= 5_000; i++) {
			telemetry.record("histogram", "dispatch.duration_ms", i);
		}
		telemetry.record("counter", "dispatch.completed", 3);
		const metrics = aggregateMetrics(telemetry.snapshot());
		const hist = metrics.histograms["dispatch.duration_ms"];
		ok(hist !== undefined);
		// Only the last 100 samples (4901..5000) survive, so every percentile sits
		// in that window and the count reflects the bound, not the 5000 records.
		strictEqual(hist.count, 100);
		ok(hist.p50 >= 4901 && hist.p50 <= 5000, `p50 ${hist.p50} out of window`);
		ok(hist.p95 >= 4901 && hist.p95 <= 5000, `p95 ${hist.p95} out of window`);
		strictEqual(metrics.dispatchesCompleted, 3);
	});

	it("leaves counter behavior unchanged and reset clears both stores", () => {
		const telemetry = createTelemetry(8);
		telemetry.record("counter", "tokens.total", 100);
		telemetry.record("counter", "tokens.total", 50);
		telemetry.record("histogram", "h", 1);
		let snap = telemetry.snapshot();
		strictEqual(snap.counters["tokens.total"], 150);
		strictEqual(snap.histograms.h?.length, 1);

		telemetry.reset();
		snap = telemetry.snapshot();
		strictEqual(snap.counters["tokens.total"], undefined);
		strictEqual(snap.histograms.h, undefined);
	});
});
