/**
 * Aligns high-frequency narrative/reasoning projection with the browser's
 * actual paint cadence. Control events are never held for a later frame: they
 * flush any preceding text first and are delivered in the same ordered batch.
 */

import type { ServerEvent } from "./protocol.ts";

export const MAX_FRAME_EVENT_BATCH = 128;

export interface FrameClock {
	request(callback: FrameRequestCallback): number;
	cancel(handle: number): void;
}

const browserFrameClock: FrameClock = {
	request: (callback) => requestAnimationFrame(callback),
	cancel: (handle) => cancelAnimationFrame(handle),
};

function mayWaitForPaint(event: ServerEvent): boolean {
	return event.kind === "turn.text" || event.kind === "turn.thought";
}

export class FrameEventBuffer {
	readonly #deliver: (events: readonly ServerEvent[]) => void;
	readonly #clock: FrameClock;
	readonly #maximumBatch: number;
	#pending: ServerEvent[] = [];
	#frameHandle: number | null = null;
	#closed = false;

	constructor(
		deliver: (events: readonly ServerEvent[]) => void,
		clock: FrameClock = browserFrameClock,
		maximumBatch = MAX_FRAME_EVENT_BATCH,
	) {
		if (!Number.isSafeInteger(maximumBatch) || maximumBatch < 1) {
			throw new Error("Frame event batch size must be a positive safe integer.");
		}
		this.#deliver = deliver;
		this.#clock = clock;
		this.#maximumBatch = maximumBatch;
	}

	push(event: ServerEvent): void {
		if (this.#closed) return;
		this.#pending.push(event);

		// Tool, approval, terminal, state, and error events remain immediate. Any
		// text already waiting precedes them in this same delivery.
		if (!mayWaitForPaint(event) || this.#pending.length >= this.#maximumBatch) {
			this.flush();
			return;
		}

		if (this.#frameHandle !== null) return;
		this.#frameHandle = this.#clock.request(() => {
			this.#frameHandle = null;
			this.#deliverPending();
		});
	}

	flush(): void {
		if (this.#closed) return;
		this.#cancelFrame();
		this.#deliverPending();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cancelFrame();
		this.#pending = [];
	}

	#cancelFrame(): void {
		if (this.#frameHandle === null) return;
		this.#clock.cancel(this.#frameHandle);
		this.#frameHandle = null;
	}

	#deliverPending(): void {
		if (this.#pending.length === 0) return;
		const events = this.#pending;
		this.#pending = [];
		this.#deliver(events);
	}
}
