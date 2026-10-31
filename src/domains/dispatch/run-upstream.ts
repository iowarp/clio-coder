import { gatewayRoutingObservationFromRecord, gatewayRoutingObservationLabel } from "../../core/gateway-routing.js";
import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import { callLevelUpstreamResponses, type RunResult } from "./types.js";

/** Each distinct label once, in first-seen order, with how many calls carried it when more than one did. */
function countedLabels(labels: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
}

/** Human projection of the response model-id observations a run's calls carried, each distinct one once. */
export function runResponseModelIdObservationLabel(result: Pick<RunResult, "upstreamResponses">): string | null {
	const responses = callLevelUpstreamResponses(result.upstreamResponses ?? []);
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
	return `response_model_id_observation=${countedLabels(labels).join(",")}`;
}

/** Human projection of the gateway routes a run's calls took, each distinct route once. */
export function runGatewayRoutingLabel(result: Pick<RunResult, "upstreamResponses">): string | null {
	const observations = callLevelUpstreamResponses(result.upstreamResponses ?? [])
		.map((response) => gatewayRoutingObservationFromRecord(response as unknown as Record<string, unknown>))
		.filter((observation) => observation !== null);
	if (observations.length === 0) return null;
	return countedLabels(observations.map(gatewayRoutingObservationLabel)).join(" | ");
}
