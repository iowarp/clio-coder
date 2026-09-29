/**
 * Warm-first, bounded fan-out for the requests of one call.
 *
 * Every request of a call carries the same state prefix. The first one runs
 * alone so the server prefills that prefix once and commits it to its cache;
 * the rest then start together and reuse it. Without the wait, servers whose
 * prefix cache commits only after prefill (vLLM) would prefill the same state
 * once per concurrent request. Concurrency after the warm request is bounded
 * by what the endpoint can serve, never by the number of questions.
 */

export interface Scheduler {
	/** `warm` is true for exactly one call: the request that ran alone first. */
	run<T>(fn: (warm: boolean) => Promise<T>): Promise<T>;
}

export function createScheduler(capacity: number): Scheduler {
	const limit = Math.max(1, Math.floor(capacity));
	let warmed: Promise<void> | null = null;
	let active = 0;
	const waiting: Array<() => void> = [];

	const acquire = (): Promise<void> => {
		if (active < limit) {
			active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => waiting.push(resolve));
	};
	const release = (): void => {
		const next = waiting.shift();
		// The slot passes straight to the next waiter, so `active` stays put.
		if (next) next();
		else active -= 1;
	};

	return {
		async run<T>(fn: (warm: boolean) => Promise<T>): Promise<T> {
			if (warmed === null) {
				let done!: () => void;
				warmed = new Promise<void>((resolve) => {
					done = resolve;
				});
				try {
					return await fn(true);
				} finally {
					// Waiters proceed whether or not the warm request succeeded.
					done();
				}
			}
			await warmed;
			await acquire();
			try {
				return await fn(false);
			} finally {
				release();
			}
		},
	};
}
