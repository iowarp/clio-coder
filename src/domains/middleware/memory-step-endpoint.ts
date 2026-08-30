/**
 * Publishing the endpoint disturbance a background memory step causes.
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
 * So the announcement lives here, wrapped around the client's `complete`, in a
 * `finally`: it fires on resolve, on timeout and on any transport throw, and
 * never for a boundary that skipped the model altogether (`endpoint_busy`, no
 * configured route), because those never call `complete`.
 */

import { BusChannels } from "../../core/bus-events.js";
import type { SafeEventBus } from "../../core/event-bus.js";

/** What the announcer needs: somewhere to publish, and the route to name. */
export interface MemoryStepEndpointAnnouncerDeps {
	bus: Pick<SafeEventBus, "emit"> | null;
	/** Canonical endpoint the step calls, or null when the route has none. */
	endpointKey: string | null;
	targetId: string;
}

/**
 * Wrap one background memory `complete` so every request that leaves the
 * process publishes its endpoint exactly once, whatever the call does next.
 *
 * A null bus or a route with no canonical endpoint key announces nothing: there
 * is no endpoint the turn context could match against.
 */
export function announceMemoryStepEndpoint<Request, Response>(
	deps: MemoryStepEndpointAnnouncerDeps,
	complete: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
	const { bus, endpointKey, targetId } = deps;
	if (bus === null || endpointKey === null) return complete;
	return async (request: Request): Promise<Response> => {
		try {
			return await complete(request);
		} finally {
			// Bookkeeping never changes memory behavior, and a crashing subscriber
			// must not turn a resolved step into a failed one.
			try {
				bus.emit(BusChannels.MemoryStepCompleted, { endpointKey, targetId });
			} catch {
				// The safe bus already contains listener errors; this covers the rest.
			}
		}
	};
}
