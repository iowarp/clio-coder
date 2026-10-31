import type { CostReportV1, Quantity } from "../../core/telemetry/dto.js";

/** The known part of a read-model quantity: measured plus estimated, never a number for what went unknown. */
export function knownPart(quantity: Quantity | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return fact.measured + fact.estimated;
}

const partial = (quantity: Quantity): boolean =>
	"kind" in quantity.fact ? quantity.fact.kind === "unknown" : quantity.fact.unknownCount > 0;
/**
 * The contributions to a call count whose number is unknown. Only a worker run leaves one, by recording no call
 * telemetry, so it is v1's `unknownCallCoverageRuns`: a plain `calls` number never says it is short (#434 §11.3).
 */
export function unknownCallCoverage(calls: Quantity): number {
	return "kind" in calls.fact ? (calls.fact.kind === "unknown" ? 1 : 0) : calls.fact.unknownCount;
}

/** Free only when every priced call was free and nothing went unpriced. */
export function knownFree(pricedBy: CostReportV1["total"]["pricedBy"], usd: Quantity): boolean {
	const { free, ...priced } = pricedBy;
	return free > 0 && !partial(usd) && Object.values(priced).every((count) => count === 0);
}
