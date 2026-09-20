/**
 * Aligns high-frequency narrative and reasoning deltas with the browser's paint
 * cadence. Control events are never held for a later frame: they flush any
 * preceding text first and are delivered in the same ordered batch.
 */

import type { Event } from "../../contracts/events.js";

/** Hard ceiling on events held for one frame; a burst past it delivers at once. */
export const MAX_FRAME_EVENT_BATCH = 128;
/** A hidden tab gets no animation frames, so deliveries fall back to this interval. */
export const HIDDEN_FLUSH_INTERVAL_MS = 250;

export interface FrameClock {
	request(callback: () => void): number;
	cancel(handle: number): void;
}

const paintClock: FrameClock = {
	request: (callback) => requestAnimationFrame(callback),
	cancel: (handle) => cancelAnimationFrame(handle),
};

const hiddenClock: FrameClock = {
	request: (callback) => setTimeout(callback, HIDDEN_FLUSH_INTERVAL_MS) as unknown as number,
	cancel: (handle) => clearTimeout(handle),
};

/** Only stream deltas may wait for paint; everything else is a control event. */
function mayWaitForPaint(event: Event): boolean {
	return event.type === "turn.text" || event.type === "turn.thought";
}

export interface FrameEventBufferOptions {
	readonly paint?: FrameClock;
	readonly hidden?: FrameClock;
	readonly maximumBatch?: number;
	readonly isHidden?: () => boolean;
}

export class FrameEventBuffer {
	readonly #deliver: (events: readonly Event[]) => void;
	readonly #paint: FrameClock;
	readonly #hidden: FrameClock;
	readonly #maximumBatch: number;
	readonly #isHidden: () => boolean;
	#pending: Event[] = [];
	#handle: number | null = null;
	#onHiddenClock = false;
	#closed = false;

	constructor(deliver: (events: readonly Event[]) => void, options: FrameEventBufferOptions = {}) {
		const maximumBatch = options.maximumBatch ?? MAX_FRAME_EVENT_BATCH;
		if (!Number.isSafeInteger(maximumBatch) || maximumBatch < 1)
			throw new Error("Frame event batch size must be a positive safe integer.");
		this.#deliver = deliver;
		this.#paint = options.paint ?? paintClock;
		this.#hidden = options.hidden ?? hiddenClock;
		this.#maximumBatch = maximumBatch;
		this.#isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
	}

	push(event: Event): void {
		if (this.#closed) return;
		this.#pending.push(event);
		// Tool, permission, fleet, lifecycle, and transport events stay immediate.
		// Any text already waiting precedes them in this same delivery.
		if (!mayWaitForPaint(event) || this.#pending.length >= this.#maximumBatch) {
			this.flush();
			return;
		}
		const hidden = this.#isHidden();
		if (this.#handle !== null) {
			if (hidden === this.#onHiddenClock) return;
			this.#cancel();
		}
		this.#onHiddenClock = hidden;
		this.#handle = (hidden ? this.#hidden : this.#paint).request(() => {
			this.#handle = null;
			this.#deliverPending();
		});
	}

	flush(): void {
		if (this.#closed) return;
		this.#cancel();
		this.#deliverPending();
	}

	/** Terminal: the unpainted batch is dropped because the tree it targeted is gone. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cancel();
		this.#pending = [];
	}

	#cancel(): void {
		if (this.#handle === null) return;
		(this.#onHiddenClock ? this.#hidden : this.#paint).cancel(this.#handle);
		this.#handle = null;
	}

	#deliverPending(): void {
		if (this.#pending.length === 0) return;
		const events = this.#pending;
		this.#pending = [];
		this.#deliver(events);
	}
}
