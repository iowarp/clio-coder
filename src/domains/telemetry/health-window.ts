import type { EventLoopUtilization } from "node:perf_hooks";
import { createHistogram, performance as perf } from "node:perf_hooks";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { JournalHealth } from "./call-journal.js";

/** How often the process records a health.sampled while a session writer is open (#428, #434). */
export const HEALTH_WINDOW_MS = 10_000;
/** The lag sampler's interval; each tick records how late it ran past this (#428). */
const LAG_RESOLUTION_MS = 10;

const ms = (nanoseconds: number) => Math.round(nanoseconds / 1e3) / 1e3;

/**
 * Event-loop lag, RSS and writer pressure per window, sampled only while a session writer is open and recorded once
 * per process, because they are the process's facts. Lag comes from an interval that keeps its baseline across
 * windows: monitorEventLoopDelay drops the first interval after every reset(), so a stall that straddled a window
 * boundary would never be measured (#428, #434).
 */
export function createHealthWindows(input: {
	/** Whether a session writer is open; the first window that finds none stops the sampler. */
	active: () => boolean;
	/** Every journal writer this process holds open, the process journal's own included. */
	writers: () => ReadonlyArray<JournalHealth>;
	record: (data: EventPayload<"health.sampled">) => void;
	/** The window's full distribution, when the process journal's mode keeps health.samples_captured (#434). */
	recordSamples?: (data: EventPayload<"health.samples_captured">) => void;
	/** Whether health.samples_captured would be kept, so standard mode never assembles it. */
	samplesWanted?: () => boolean;
	windowMs?: number;
}) {
	const lag = createHistogram();
	let sampler: NodeJS.Timeout | undefined;
	let windows: NodeJS.Timeout | undefined;
	let lastTick = 0;
	let windowStart = 0;
	let utilization: EventLoopUtilization | undefined;
	const stop = () => {
		clearInterval(sampler);
		clearInterval(windows);
		sampler = windows = undefined;
	};
	const close = () => {
		const now = performance.now();
		const writers = input.writers();
		const windowMs = now - windowStart;
		input.record({
			windowMs,
			...(lag.count > 0
				? {
						loopLag: {
							samples: lag.count,
							p50Ms: ms(lag.percentile(50)),
							p99Ms: ms(lag.percentile(99)),
							maxMs: ms(lag.max),
						},
					}
				: {}),
			rssBytes: process.memoryUsage.rss(),
			writer: {
				queueDepth: writers.reduce((sum, health) => sum + health.queueDepth, 0),
				dropped: writers.reduce((sum, health) => sum + health.dropped, 0),
			},
		});
		const elu = perf.eventLoopUtilization(utilization);
		utilization = perf.eventLoopUtilization();
		if (input.recordSamples && (input.samplesWanted?.() ?? false)) {
			const memory = process.memoryUsage();
			input.recordSamples({
				windowMs,
				lagPercentiles: lag.count > 0 ? [...lag.percentiles].slice(0, 64).map(([p, value]) => ({ p, ms: ms(value) })) : [],
				eventLoopUtilization: Math.min(1, Math.max(0, elu.utilization)),
				heapUsedBytes: memory.heapUsed,
				externalBytes: memory.external,
			});
		}
		lag.reset();
		windowStart = now;
		if (!input.active()) stop();
	};
	return {
		/** A writer opened. The sampler runs until a window finds none open (#434). */
		start(): void {
			if (sampler) return;
			lag.reset();
			utilization = perf.eventLoopUtilization();
			lastTick = windowStart = performance.now();
			sampler = setInterval(() => {
				const tick = performance.now();
				lag.record(Math.max(1, Math.round((tick - lastTick - LAG_RESOLUTION_MS) * 1e6)));
				lastTick = tick;
			}, LAG_RESOLUTION_MS);
			sampler.unref();
			windows = setInterval(close, input.windowMs ?? HEALTH_WINDOW_MS);
			windows.unref();
		},
		stop,
	};
}
