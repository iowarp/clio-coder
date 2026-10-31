import { writeDiagnostic } from "../diagnostics.js";
import type { TelemetryContext } from "./context.js";
import type { EventName, EventPayload, PreimageData, PreimageEventName } from "./events.js";

/**
 * Listener invoked by {@link TelemetryHub.emit}.
 *
 * Listener-duration invariant: fan-out runs synchronously on the emitter's stack. Keep listeners short and
 * non-blocking. A long-running synchronous listener blocks every later listener of the event AND the emit() caller
 * until it returns.
 *
 * For async work, return a Promise: the hub does not await it, but it installs a .catch() so rejections route
 * through the same error-reporting path as synchronous throws. The emitter is not blocked on the Promise settling,
 * so side effects that must happen before the next emit() must complete synchronously.
 *
 * Violate the invariant and shutdown.* ordering or banner timing will drift.
 */
/**
 * The process scope as an emit target: the record goes to this process's journal whatever session or run the async
 * context names, because it describes the process or the account rather than one session (#434).
 */
export const PROCESS_SCOPE = "process";
export type TelemetryScope = TelemetryContext | typeof PROCESS_SCOPE;

export type TelemetryListener<N extends EventName = EventName> = (payload: EventPayload<N>) => void | Promise<void>;

/**
 * The one emit path (#434). `emit` delivers the payload to in-process subscribers and, for a journal event, also
 * enqueues it to the sink of the scope its context names (the given ctx, else the async context); a live event
 * ignores ctx. It returns true
 * only when a journal record was enqueued. Payloads are typed at compile time only; subscribers consuming data that
 * crossed a process boundary keep their runtime validation. A journal payload is owned by its sink once emitted, so
 * subscribers read it and never mutate it.
 */
export interface TelemetryHub {
	emit<N extends EventName>(name: N, payload: EventPayload<N>, ctx?: TelemetryScope): boolean;
	/**
	 * Enqueue a content-bearing research record whose preimage the writer stores, reserves against the research cap
	 * and cites before the record is written. The caller hands over ownership of `preimage` (#434).
	 */
	emitContent<N extends PreimageEventName>(
		name: N,
		payload: PreimageData<N>,
		preimage: unknown,
		ctx?: TelemetryScope,
	): boolean;
	subscribe<N extends EventName>(name: N, listener: TelemetryListener<N>): () => void;
	listeners(name: EventName): TelemetryListener[];
	clear(): void;
}

/**
 * How a journal event reaches its sink. The producer attaches it when it loads, so the hub, which Stage 0 loads
 * through termination, never pulls the registry's schemas into the first frame (#434). Before the producer loads no
 * sink can be registered, so nothing a journal would have kept is lost.
 */
export interface JournalRoute {
	journal(name: EventName, payload: unknown, preimage: unknown, ctx: TelemetryScope | undefined): boolean;
}

let journalRoute: JournalRoute | null = null;

export function attachJournalRoute(route: JournalRoute): void {
	journalRoute = route;
}

/** Internal erased listener shape; payloads are typed at the hub seam only. */
type StoredListener = (payload: never) => void | Promise<void>;

function reportListenerError(name: string, error: unknown): void {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeDiagnostic(`[clio-coder:telemetry-hub] Listener crashed on ${name}: ${message}`, "error");
}

export function createTelemetryHub(): TelemetryHub {
	const registry = new Map<string, Set<StoredListener>>();

	const deliver = (name: string, payload: unknown): void => {
		const ls = registry.get(name);
		if (!ls) return;
		// Synchronous fan-out. A listener's error never reaches the emitter, but delivery is not deferred: deferred
		// delivery would drop shutdown.* events when process.exit runs before the microtask chain resolves.
		// Iterating a snapshot keeps re-entrant emit()/subscribe() inside a listener safe; registration changes take
		// effect on the next emit().
		for (const listener of [...ls]) {
			try {
				const result = listener(payload as never);
				if (result && typeof (result as Promise<void>).then === "function") {
					(result as Promise<void>).catch((error) => reportListenerError(name, error));
				}
			} catch (error) {
				reportListenerError(name, error);
			}
		}
	};

	return {
		emit(name, payload, ctx) {
			const journaled = journalRoute?.journal(name, payload, undefined, ctx) ?? false;
			deliver(name, payload);
			return journaled;
		},
		// Content reaches the writer alone, never a subscriber: consent and the research cap govern it there (#434).
		emitContent(name, payload, preimage, ctx) {
			return journalRoute?.journal(name, payload, preimage, ctx) ?? false;
		},
		subscribe(name, listener) {
			const set = registry.get(name) ?? new Set<StoredListener>();
			set.add(listener as StoredListener);
			registry.set(name, set);
			return () => {
				const current = registry.get(name);
				if (!current) return;
				current.delete(listener as StoredListener);
				if (current.size === 0) registry.delete(name);
			};
		},
		listeners(name) {
			return [...(registry.get(name) ?? [])] as TelemetryListener[];
		},
		clear() {
			registry.clear();
		},
	};
}

let processHub: TelemetryHub | null = null;

/** The process-wide hub. */
export function telemetryHub(): TelemetryHub {
	if (!processHub) processHub = createTelemetryHub();
	return processHub;
}
