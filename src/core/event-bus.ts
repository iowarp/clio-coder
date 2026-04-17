/**
 * Listener invoked by {@link SafeEventBus.emit}.
 *
 * Listener-duration invariant: emit() fan-out runs synchronously on the
 * emitter's stack. Keep listeners short and non-blocking. A long-running
 * synchronous listener blocks every subsequent listener on the channel AND
 * the emit() caller until it returns.
 *
 * For async work, return a Promise: the bus does not await it, but it
 * installs a .catch() so rejections route through the same error-reporting
 * path as synchronous throws. The emitter is not blocked on the Promise
 * settling, so side effects that must happen before the next emit() must be
 * completed synchronously.
 *
 * Phase 2+ registers domain listeners here; violate the invariant and
 * shutdown.* ordering or banner timing will drift.
 */
export type SafeEventListener = (payload: unknown) => void | Promise<void>;

export interface SafeEventBus {
	emit(channel: string, payload: unknown): void;
	on(channel: string, listener: SafeEventListener): () => void;
	listeners(channel: string): SafeEventListener[];
	clear(): void;
}

function reportListenerError(channel: string, error: unknown): void {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	console.error(`[clio:event-bus] Listener crashed on ${channel}: ${message}`);
}

export function createSafeEventBus(): SafeEventBus {
	const registry = new Map<string, Set<SafeEventListener>>();

	const deliver = (channel: string, payload: unknown): void => {
		const ls = registry.get(channel);
		if (!ls) return;
		// Synchronous fan-out. "Safe" means listener errors never reach the
		// emitter; it does not mean deferred delivery. Deferred delivery would
		// drop shutdown.* events when process.exit runs before the Promise
		// microtask chain resolves (observed during diag-interactive).
		// Iterating a snapshot so re-entrant emit()/on()/off() inside a listener
		// is safe; registration changes take effect on the next emit().
		for (const listener of [...ls]) {
			try {
				const result = listener(payload);
				if (result && typeof (result as Promise<void>).then === "function") {
					(result as Promise<void>).catch((error) => reportListenerError(channel, error));
				}
			} catch (error) {
				reportListenerError(channel, error);
			}
		}
	};

	const bus: SafeEventBus = {
		emit(channel, payload) {
			deliver(channel, payload);
		},
		on(channel, listener) {
			const set = registry.get(channel) ?? new Set<SafeEventListener>();
			set.add(listener);
			registry.set(channel, set);
			return () => {
				const current = registry.get(channel);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) registry.delete(channel);
			};
		},
		listeners(channel) {
			return [...(registry.get(channel) ?? [])];
		},
		clear() {
			registry.clear();
		},
	};

	return bus;
}
