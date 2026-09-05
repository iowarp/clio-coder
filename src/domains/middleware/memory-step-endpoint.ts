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
 * `src/interactive/turn-prewarm.ts`). Publishing from the usage sink instead
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
import { registerForegroundStream } from "../providers/endpoint-capacity.js";

/** What the announcer needs: somewhere to publish, and the route to name. */
export interface MemoryStepEndpointAnnouncerDeps {
	bus: Pick<SafeEventBus, "emit"> | null;
	/** Canonical endpoint the step calls, or null when the route has none. */
	endpointKey: string | null;
	targetId: string;
}

/**
 * Wrap one background memory `complete` so every request that leaves the
 * process holds one endpoint slot and publishes its endpoint exactly once,
 * whatever the call does next.
 *
 * A route with no canonical endpoint key is unchanged. A null bus suppresses
 * the announcement but still counts capacity for a route whose key is known.
 */
export function announceMemoryStepEndpoint<Request, Response>(
	deps: MemoryStepEndpointAnnouncerDeps,
	complete: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
	const { bus, endpointKey, targetId } = deps;
	if (endpointKey === null) return complete;
	return async (request: Request): Promise<Response> => {
		// The production client rechecks capacity after asynchronous preparation,
		// immediately before calling this wrapper. Register synchronously so no
		// local foreground launch can interleave between that check and this hold.
		const releaseEndpointSlot = registerForegroundStream(endpointKey);
		try {
			return await complete(request);
		} finally {
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
