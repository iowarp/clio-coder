/**
 * Publishing and accounting for the endpoint a background memory step uses.
 *
 * A proactive-memory step that runs on the chat target's own endpoint moves
 * that server's prefix cache, so the next turn is cold for a reason Clio caused
 * and can name. The turn context turns {@link BusChannels.MemoryStepCompleted}
 * into the `background_memory` expected-cold reason; without it `/context`
 * reports the turn as an unexplained provider re-prefill.
 *
 * The disturbance is a property of the request having left the process, not of
 * the answer coming back. A step that times out still had its whole trajectory
 * prefilled into the single prefix slot, because aborting the HTTP request does
 * not stop a llama.cpp prefill (the measurement is recorded in
 * `src/session-control/turn-prewarm.ts`). Publishing from the usage sink instead
 * missed exactly that case, since usage is only assigned once the call resolves.
 *
 * The same request also occupies real endpoint capacity. Both responsibilities
 * live here around the client's `complete`: the slot is registered only after
 * the middleware's `endpoint_busy` admission check, so a step never sees its
 * own slot, then released in the `finally` that also announces the disturbance.
 * Both happen on resolve, timeout, and transport throw, and neither happens for
 * a boundary that skipped the model altogether (`endpoint_busy`, no configured
 * route), because those never call `complete`.
 */

import { BusChannels } from "../../core/bus-events.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import { TaskMemoryEndpointBusyError, TaskMemoryEndpointPreemptedError } from "../memory/task-memory-policy.js";
import { registerBackgroundStream } from "../providers/endpoint-capacity.js";

/** What the announcer needs: somewhere to publish, and the route to name. */
export interface MemoryStepEndpointAnnouncerDeps {
	bus: Pick<SafeEventBus, "emit"> | null;
	/** Canonical endpoint the step calls, or null when the route has none. */
	endpointKey: string | null;
	targetId: string;
	/**
	 * Synchronous admission against current occupancy. Called in the same
	 * synchronous step that registers the hold, so no other local request can
	 * claim the last slot between the check and the reservation. Absent means
	 * the caller already admitted.
	 */
	admit?: () => boolean;
	/** Bound the step was admitted under; a foreground claim past it preempts the step. */
	admissionLimit?: number;
}

/**
 * Wrap one background memory `complete` so every request that leaves the
 * process holds one endpoint slot and publishes its endpoint exactly once,
 * whatever the call does next.
 *
 * A route with no canonical endpoint key is unchanged. A null bus suppresses
 * the announcement but still counts capacity for a route whose key is known.
 */
export function announceMemoryStepEndpoint<Request extends { signal: AbortSignal }, Response>(
	deps: MemoryStepEndpointAnnouncerDeps,
	complete: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
	const { bus, endpointKey, targetId } = deps;
	if (endpointKey === null) return complete;
	return async (request: Request): Promise<Response> => {
		if (deps.admit !== undefined && !deps.admit()) {
			throw new TaskMemoryEndpointBusyError("background memory endpoint is busy");
		}
		// Preemption aborts only this transport. The policy's own signal still
		// owns cancellation for reset and shutdown.
		const transport = new AbortController();
		const forward = () => transport.abort(request.signal.reason);
		if (request.signal.aborted) forward();
		else request.signal.addEventListener("abort", forward, { once: true });
		let preempted = false;
		// Registered synchronously after admission: no local foreground launch can
		// interleave between that check and this hold.
		const releaseEndpointSlot = registerBackgroundStream(endpointKey, {
			limit: deps.admissionLimit ?? 1,
			preempt: () => {
				preempted = true;
				transport.abort(new TaskMemoryEndpointPreemptedError("foreground request claimed the memory endpoint"));
			},
		});
		try {
			return await complete({ ...request, signal: transport.signal });
		} catch (error) {
			if (preempted && !request.signal.aborted) {
				throw new TaskMemoryEndpointPreemptedError("foreground request claimed the memory endpoint");
			}
			throw error;
		} finally {
			request.signal.removeEventListener("abort", forward);
			// Local occupancy is released once the transport settled, never on the
			// preempt signal itself. Settlement is not proof the server stopped: an
			// aborted llama.cpp prefill can still be running upstream.
			releaseEndpointSlot();
			// Bookkeeping never changes memory behavior, and a crashing subscriber
			// must not turn a resolved step into a failed one.
			if (bus !== null) {
				try {
					bus.emit(BusChannels.MemoryStepCompleted, { endpointKey, targetId });
				} catch {
					// The safe bus already contains listener errors; this covers the rest.
				}
			}
		}
	};
}
