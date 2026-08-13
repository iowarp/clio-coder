import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/**
 * Budget for one uninterrupted slice of indexing work. pi-tui throttles frames
 * to a 16 ms floor, so half a frame leaves the render path room to build and
 * write a frame between slices. Indexing that respects this never shows up as
 * a dropped frame, however long the whole scan takes.
 */
export const INDEX_SLICE_MS = 8;

export interface CooperativeSlicer {
	/**
	 * Hand the event loop a turn when the current slice has spent its budget.
	 * A no-op await otherwise, so hot loops can call it every iteration.
	 */
	tick(): Promise<void>;
	/** Number of yields taken. Diagnostics only. */
	readonly yields: number;
}

const settled = Promise.resolve();

/**
 * Chunk a long synchronous walk into event-loop-sized slices.
 *
 * The codewiki scan is unavoidably thousands of `statSync` and parse calls; the
 * problem was never their total cost but that they ran as one turn, which froze
 * a mounted TUI for seconds and queued keystrokes silently. Slicing keeps the
 * total the same and makes the freeze disappear.
 */
export function createSlicer(sliceMs: number = INDEX_SLICE_MS): CooperativeSlicer {
	let deadline = performance.now() + sliceMs;
	let yields = 0;
	return {
		tick(): Promise<void> {
			if (performance.now() < deadline) return settled;
			yields += 1;
			return yieldToEventLoop().then(() => {
				deadline = performance.now() + sliceMs;
			});
		},
		get yields(): number {
			return yields;
		},
	};
}
