import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";

/** Return the durable final assistant text carried by a worker event. */
export function assistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event).trim();
}

export { runGatewayRoutingLabel, runResponseModelIdObservationLabel } from "../domains/dispatch/run-upstream.js";
