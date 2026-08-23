import { responseModelIdObservationFromRecord } from "../core/response-model-id.js";
import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
import type { RunReceipt } from "../domains/dispatch/types.js";

/** Return the durable final assistant text carried by a worker event. */
export function assistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event).trim();
}

/** Human projection of the response model-id observations carried by a receipt. */
export function receiptResponseModelIdObservationLabel(receipt: Pick<RunReceipt, "upstreamResponses">): string | null {
	const responses = receipt.upstreamResponses ?? [];
	if (responses.length === 0) return null;
	const labels = responses.map((response) => {
		const observation = responseModelIdObservationFromRecord(
			response as unknown as Record<string, unknown>,
			"legacy-difference-only",
		);
		if (observation.state === "reported") return `reported:${observation.reportedModelId}`;
		if (observation.state === "not-reported") return "not-reported";
		if (observation.state === "not-observed") return "not-observed";
		return `legacy-difference-only:${observation.differingModelId ?? "none"}`;
	});
	return `response_model_id_observation=${labels.join(",")}`;
}
