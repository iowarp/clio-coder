/**
 * Assignment-scoped event stream.
 *
 * An assignment owns the terminal receipt, so it must also own the event
 * stream. A consumer handed only attempt 1's frames accumulates state from a
 * run the terminal receipt does not describe: on a successful failover it
 * reports the failed attempt's partial output as the answer. This fans every
 * attempt's frames into one ordered stream, separated by a synthetic
 * `attempt_start` frame so consumers can reset accumulated state, and ends
 * when the assignment settles.
 *
 * Backpressure matches `event-pump.ts`: one consumer, bounded drop-oldest
 * replay. Ingestion never awaits the consumer, so a slow reader degrades live
 * display and cannot stall a worker. Every receipt-bearing fact was already
 * folded by the per-attempt pump before it reached here.
 */

import { EVENT_TEE_LIMIT } from "./event-pump.js";

/** Synthetic boundary frame published between two attempts of one assignment. */
export interface AssignmentAttemptStartEvent {
	type: "attempt_start";
	attempt: number;
	runId: string;
	previousRunId: string;
	reason: string;
}

export interface AssignmentEventStream {
	/** Single-consumer bounded replay spanning every attempt, oldest first. */
	events: AsyncIterableIterator<unknown>;
	/**
	 * Forward one attempt's frames, preceded by `prelude` when given. Sources
	 * drain in attach order, so a prelude publishes after every earlier attempt
	 * rather than the moment it is handed over.
	 */
	attach(source: AsyncIterable<unknown>, prelude?: unknown): void;
	/** No further attempts; the stream ends once attached sources drain. */
	close(): void;
	/** End now. In-flight sources keep draining but publish nothing further. */
	abort(): void;
	/** Frames dropped from the tee because no consumer kept pace. */
	droppedEvents(): number;
}

export function createAssignmentEventStream(
	options: { limit?: number; onError?: (error: unknown) => void } = {},
): AssignmentEventStream {
	const limit = options.limit ?? EVENT_TEE_LIMIT;
	const pending: unknown[] = [];
	const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
	let finished = false;
	let abandoned = false;
	let closed = false;
	let dropped = 0;
	// Sources drain sequentially so attempt N's frames never interleave with
	// attempt N+1's, and so `close()` observes every attach that preceded it.
	let chain: Promise<void> = Promise.resolve();

	const push = (value: unknown): void => {
		if (abandoned || finished) return;
		const waiter = waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return;
		}
		pending.push(value);
		while (pending.length > limit) {
			pending.shift();
			dropped += 1;
		}
	};

	const end = (): void => {
		if (finished) return;
		finished = true;
		while (waiters.length > 0) {
			waiters.shift()?.({ value: undefined, done: true });
		}
	};

	const events: AsyncIterableIterator<unknown> = {
		next(): Promise<IteratorResult<unknown>> {
			if (pending.length > 0) {
				return Promise.resolve({ value: pending.shift(), done: false });
			}
			if (finished || abandoned) return Promise.resolve({ value: undefined, done: true });
			return new Promise<IteratorResult<unknown>>((resolve) => {
				waiters.push(resolve);
			});
		},
		return(): Promise<IteratorResult<unknown>> {
			abandoned = true;
			pending.length = 0;
			while (waiters.length > 0) {
				waiters.shift()?.({ value: undefined, done: true });
			}
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
			return this;
		},
	};

	return {
		events,
		attach(source: AsyncIterable<unknown>, prelude?: unknown): void {
			// An abandoned consumer still needs the attempt tee drained: the source
			// is the per-attempt pump's bounded buffer, not the worker channel. The
			// trailing catch keeps the chain settled so one failing source cannot
			// strand every later attempt.
			chain = chain
				.then(async () => {
					if (prelude !== undefined) push(prelude);
					for await (const event of source) push(event);
				})
				.catch((error) => {
					options.onError?.(error);
				});
		},
		close(): void {
			if (closed) return;
			closed = true;
			void chain.then(end, end);
		},
		abort(): void {
			closed = true;
			end();
		},
		droppedEvents: () => dropped,
	};
}
