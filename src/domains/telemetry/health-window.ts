import type { EventLoopUtilization } from "node:perf_hooks";
import { createHistogram, performance as perf } from "node:perf_hooks";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { JournalHealth } from "./call-journal.js";

/** How often each open session writer receives a health.sampled (#428, #434). */
export const HEALTH_WINDOW_MS = 10_000;
/** The lag sampler's interval; each tick records how late it ran past this (#428). */
const LAG_RESOLUTION_MS = 10;

const ms = (nanoseconds: number) => Math.round(nanoseconds / 1e3) / 1e3;

/**
 * Event-loop lag, RSS and writer pressure per window, sampled only while a session writer is open. Lag comes from an
 * interval that keeps its baseline across windows: monitorEventLoopDelay drops the first interval after every
 * reset(), so a stall that straddled a window boundary would never be measured (#428, #434).
 */
export function createHealthWindows(input: {
	writers: () => ReadonlyArray<{ sessionId: string; health: JournalHealth }>;
	record: (sessionId: string, data: EventPayload<"health.sampled">) => void;
	/** The window's full distribution, for writers whose mode keeps health.samples_captured (#434). */
	recordSamples?: (sessionId: string, data: EventPayload<"health.samples_captured">) => void;
	/** Whether any open writer would keep health.samples_captured, so standard mode never assembles them. */
	samplesWanted?: (sessionId: string) => boolean;
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
		const shared = {
			windowMs: now - windowStart,
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
		};
		for (const { sessionId, health } of writers)
			input.record(sessionId, { ...shared, writer: { queueDepth: health.queueDepth, dropped: health.dropped } });
		const sampled = input.recordSamples
			? writers.filter(({ sessionId }) => input.samplesWanted?.(sessionId) ?? false)
			: [];
		const elu = perf.eventLoopUtilization(utilization);
		utilization = perf.eventLoopUtilization();
		if (sampled.length > 0 && input.recordSamples) {
			const memory = process.memoryUsage();
			const samples: EventPayload<"health.samples_captured"> = {
				windowMs: shared.windowMs,
				lagPercentiles: lag.count > 0 ? [...lag.percentiles].slice(0, 64).map(([p, value]) => ({ p, ms: ms(value) })) : [],
				eventLoopUtilization: Math.min(1, Math.max(0, elu.utilization)),
				heapUsedBytes: memory.heapUsed,
				externalBytes: memory.external,
			};
			for (const { sessionId } of sampled) input.recordSamples(sessionId, samples);
		}
		lag.reset();
		windowStart = now;
		if (writers.length === 0) stop();
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
