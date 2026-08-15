/** Largest delay Node can schedule without overflowing to an approximately 1 ms timer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Normalize optional/disable-capable timer inputs. Nonpositive and NaN values
 * disable the timer; oversized and infinite values cap at Node's real limit.
 */
export function clampTimerDelayMs(value: number): number {
	if (Number.isNaN(value) || value <= 0) return 0;
	return value >= MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : Math.floor(value);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let negativeDurations = 0;

/**
 * Elapsed between two reads of the same clock, signed.
 *
 * A negative result means the clock moved backwards between the two reads —
 * an NTP correction, a resume, or a duration derived across two hosts — and it
 * is a bug in the caller, not a value to be silently swallowed. Clamping with
 * `Math.max(0, …)` hides that, so the clamp belongs at the render boundary and
 * nothing else. Every occurrence is counted; nothing is written to stderr,
 * because the TUI owns that stream and this sits on hot measurement paths.
 */
export function rawDurationMs(start: number, end: number): number {
	const elapsed = end - start;
	if (elapsed < 0) negativeDurations += 1;
	return elapsed;
}

/** How many negative durations this process has produced since it started. */
export function negativeDurationCount(): number {
	return negativeDurations;
}
