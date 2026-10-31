import type { Quantity } from "../../core/telemetry/dto.js";
import type { CostAggregate } from "../telemetry/cost.js";
import type { SessionUsageProjection } from "./contract.js";

/** A quantity's known part, measured plus estimated; an unknown contribution adds nothing. */
function knownPart(quantity: Quantity): number {
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return fact.measured + fact.estimated;
}

/** The usd quantity as the cost aggregate an older build reads: its known part, flagged estimated or partial. */
function legacyCost(usd: Quantity): CostAggregate {
	const fact = usd.fact;
	// The projection keeps no pricing source, so an all-local session reads as a known $0.00 rather than as free.
	if ("kind" in fact)
		return {
			knownUsd: knownPart(usd),
			hasEstimated: fact.kind === "estimated",
			hasUnknown: fact.kind === "unknown",
			allKnownFree: false,
			calls: fact.kind === "absent" ? 0 : 1,
		};
	return {
		knownUsd: knownPart(usd),
		hasEstimated: fact.coverage.estimated > 0,
		hasUnknown: fact.unknownCount > 0,
		allKnownFree: false,
		calls: fact.coverage.measured + fact.coverage.estimated + fact.unknownCount,
	};
}

/**
 * meta.json usage from the read model's whole-session quantities. The running-total fields beside them carry the
 * quantities' known part, so an older build sharing the state dir still reads a number and adds to it (#434 §10, #439).
 */
export function sessionUsageProjection(
	foldVersion: number,
	quantities: SessionUsageProjection["quantities"],
): SessionUsageProjection {
	return { foldVersion, quantities, tokens: knownPart(quantities.tokens), cost: legacyCost(quantities.usd) };
}

/**
 * The projected quantities when meta.json holds them. An older build that wrote after the projection replaced the
 * whole object with its running total, so a meta without them reads as that total (#439).
 */
export function projectedUsageQuantities(usage: unknown): SessionUsageProjection["quantities"] | null {
	const quantities = (usage as Partial<SessionUsageProjection> | null | undefined)?.quantities;
	return quantities?.tokens?.fact && quantities.usd?.fact ? quantities : null;
}
