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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, clampTimerDelayMs(ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Resolve after the event loop turns once. I/O callbacks that queued while the
 * caller held the loop, terminal input and signals among them, run first; this
 * resolves from the check phase that follows them.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A queue that runs each task in its own event-loop iteration, in the order given.
 *
 * `setImmediate` callbacks queued together all run in the same check phase, so their costs add up to one block in
 * which no key is read: four after-paint tasks held a real session's first keystrokes for 640 ms. Chained, the loop
 * polls for input between every pair.
 */
export function immediateSequence(): (task: () => void) => void {
	const queue: Array<() => void> = [];
	let scheduled = false;
	const step = (): void => {
		const task = queue.shift();
		scheduled = queue.length > 0;
		// Queued before the task runs, so a task that throws does not strand the ones behind it.
		if (scheduled) setImmediate(step);
		task?.();
	};
	return (task) => {
		queue.push(task);
		if (scheduled) return;
		scheduled = true;
		setImmediate(step);
	};
}

/**
 * Elapsed between two reads of the same clock, signed.
 *
 * A negative result means the clock moved backwards between the two reads —
 * an NTP correction, a resume, or a duration derived across two hosts — and it
 * is a bug in the caller, not a value to be silently swallowed. Clamping with
 * `Math.max(0, …)` hides that, so the clamp belongs at the render boundary and
 * nothing else.
 */
export function rawDurationMs(start: number, end: number): number {
	return end - start;
}
