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
