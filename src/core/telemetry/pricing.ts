import type { Fact } from "./fact.js";
import type { PricedBy, Pricing } from "./schemas.js";

export type { PricedBy, Pricing };

const notObserved: Fact<number> = { kind: "unknown", reason: "not-observed" };

/**
 * A USD amount as the Pricing it carries (#434). A provider's own cost and declared target rates are measured, a free
 * target is a measured local zero, a catalog rate is a guess at someone else's price list and stays estimated, and
 * an amount nobody priced is unknown, never zero.
 */
export function pricedUsd(pricedBy: PricedBy, usd: number | null): Pricing {
	if (pricedBy === "free") return { usd: { kind: "measured", value: 0, source: "local-count" }, pricedBy };
	if (pricedBy === "none" || usd === null || !Number.isFinite(usd) || usd < 0)
		return { usd: notObserved, pricedBy: "none" };
	if (pricedBy === "catalog") return { usd: { kind: "estimated", value: usd, method: "catalog" }, pricedBy };
	return {
		usd: { kind: "measured", value: usd, source: pricedBy === "provider" ? "provider" : "local-count" },
		pricedBy,
	};
}

/** True when a target's rates put a number on a call, so its spend can be projected before it runs. */
export function pricesCalls(pricedBy: PricedBy): boolean {
	return pricedBy === "target-rates" || pricedBy === "catalog" || pricedBy === "provider";
}
