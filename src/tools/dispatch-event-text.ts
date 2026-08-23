import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
import type { RunReceipt } from "../domains/dispatch/types.js";

/** Return the durable final assistant text carried by a worker event. */
export function assistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event).trim();
}

/** Human projection of the response model facts carried by a new receipt. */
export function receiptServedModelLabel(receipt: Pick<RunReceipt, "upstreamResponses">): string | null {
	const responses = receipt.upstreamResponses?.filter((response) => Object.hasOwn(response, "servedModel")) ?? [];
	if (responses.length === 0) return null;
	return `served=${responses.map((response) => response.servedModel ?? "unknown").join(",")}`;
}
